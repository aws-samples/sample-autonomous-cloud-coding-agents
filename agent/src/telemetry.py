"""Telemetry: metrics, trajectory writer, and disk usage."""

from __future__ import annotations

import json
import os
import subprocess
import time
from typing import TYPE_CHECKING

from config import AGENT_WORKSPACE

if TYPE_CHECKING:
    from collections.abc import Callable

    from models import TokenUsage


def get_disk_usage(path: str = AGENT_WORKSPACE) -> float:
    """Return disk usage in bytes for the given path."""
    try:
        result = subprocess.run(
            ["du", "-sb", path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return int(result.stdout.split()[0]) if result.returncode == 0 else 0
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return 0


def format_bytes(size: float) -> str:
    """Human-readable byte size."""
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size) < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def _emit_metrics_to_cloudwatch(json_payload: dict) -> None:
    """Write the METRICS_REPORT JSON event directly to CloudWatch Logs.

    Writes the log event directly to the APPLICATION_LOGS log group using the
    CloudWatch Logs API, ensuring metrics are reliably available for dashboard
    Logs Insights queries regardless of container stdout routing.
    """
    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    try:
        import contextlib

        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("logs", region_name=region)

        task_id = json_payload.get("task_id", "unknown")
        log_stream = f"metrics/{task_id}"

        # Create the log stream (ignore if it already exists)
        with contextlib.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=log_stream)

        client.put_log_events(
            logGroupName=log_group,
            logStreamName=log_stream,
            logEvents=[
                {
                    "timestamp": int(time.time() * 1000),
                    "message": json.dumps(json_payload),
                }
            ],
        )
    except ImportError:
        print("[metrics] boto3 not available — skipping CloudWatch write", flush=True)
    except Exception as e:
        exc_type = type(e).__name__
        print(f"[metrics] CloudWatch Logs write failed (best-effort): {exc_type}: {e}", flush=True)
        if "Credential" in exc_type or "Endpoint" in exc_type or "AccessDenied" in str(e):
            print(
                "[metrics] WARNING: This may indicate a deployment misconfiguration "
                "(IAM role, VPC endpoint, or credentials). Dashboard data will be missing.",
                flush=True,
            )


class _TrajectoryWriter:
    """Write per-turn trajectory events to CloudWatch Logs.

    Follows the same pattern as ``_emit_metrics_to_cloudwatch()``: lazy boto3
    import, best-effort error handling, ``contextlib.suppress`` for idempotent
    stream creation.  Log stream: ``trajectory/{task_id}`` (parallel to the
    existing ``metrics/{task_id}`` stream).

    Events are progressively truncated to stay under the CloudWatch Logs 262 KB
    event-size limit: large fields (thinking, tool result content) are truncated
    first, then a hard byte-level safety-net truncation is applied.

    --trace accumulator (design §10.1)
    ----------------------------------
    When ``accumulate=True`` (set only for ``--trace`` tasks), each event is
    also appended in-memory so it can be dumped as a single gzipped JSONL
    artifact on terminal state (``dump_gzipped_jsonl``). The accumulator
    is bounded at ``_ACCUMULATOR_MAX_BYTES`` — further events are dropped
    silently (but ``dump_gzipped_jsonl`` reports the drop in the header)
    so a runaway task does not OOM the container.
    """

    _CW_MAX_EVENT_BYTES = 262_144  # CloudWatch limit per event

    # Bound the in-memory accumulator. Expected worst case: ~100 turns
    # x ~10 events/turn x 4 KB trace preview ~= 4 MB. 50 MB is a 10x
    # margin before the container starts thinking about memory.
    _ACCUMULATOR_MAX_BYTES = 50 * 1024 * 1024

    _MAX_FAILURES = 3

    def __init__(self, task_id: str, accumulate: bool = False) -> None:
        self._task_id = task_id
        self._log_group = os.environ.get("LOG_GROUP_NAME")
        self._client = None
        self._disabled = False
        self._failure_count = 0
        # --trace accumulator state. ``_accumulated_bytes`` is tracked
        # separately so ``dump_gzipped_jsonl`` can report how much it
        # serialized vs. how much was dropped — without re-walking
        # ``_events`` to re-measure.
        self._accumulate = accumulate
        self._events: list[dict] = []
        self._accumulated_bytes = 0
        self._accumulator_dropped = 0
        # K2 review Finding #3 — fire-once callback when the accumulator
        # cap first trips, so the pipeline can emit a user-visible
        # ``trace_truncated`` milestone in ``TaskEventsTable`` (surfaced
        # by ``bgagent watch``) rather than users discovering the
        # truncation only after downloading + inspecting the header.
        self._truncation_callback: Callable[[int, int], None] | None = None
        self._truncation_announced = False

    def set_truncation_callback(self, cb) -> None:
        """Register a callback fired once when the accumulator cap trips.

        Signature: ``cb(max_bytes: int, first_dropped_so_far: int) -> None``.
        Called at most one time per writer lifetime. Errors in the
        callback are swallowed — a broken callback must not stop event
        capture or derail the pipeline.
        """
        self._truncation_callback = cb

    def _ensure_client(self):
        """Lazily create the CloudWatch Logs client and log stream."""
        if self._client is not None:
            return
        if not self._log_group:
            self._disabled = True
            return

        import contextlib

        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        self._client = boto3.client("logs", region_name=region)

        log_stream = f"trajectory/{self._task_id}"
        with contextlib.suppress(self._client.exceptions.ResourceAlreadyExistsException):
            self._client.create_log_stream(logGroupName=self._log_group, logStreamName=log_stream)

    def _put_event(self, payload: dict) -> None:
        """Serialize *payload* to JSON, truncate if needed, and write."""
        # --trace accumulator: capture BEFORE any CW-specific truncation
        # or the disabled short-circuit, so the S3 artifact is independent
        # of CloudWatch health. We serialize to measure size and then
        # keep the original dict (the serialization happens again at
        # dump time) so bytes stay small and JSON-encodable.
        if self._accumulate:
            try:
                event_json = json.dumps(payload, default=str)
                event_size = len(event_json.encode("utf-8"))
                if self._accumulated_bytes + event_size <= self._ACCUMULATOR_MAX_BYTES:
                    self._events.append(payload)
                    self._accumulated_bytes += event_size
                else:
                    self._accumulator_dropped += 1
                    # Fire-once user-visible signal the first time we
                    # drop. Subsequent drops increment the counter but
                    # do not re-announce (debounce — one milestone is
                    # enough, the downloaded artifact's header has the
                    # exact final drop count).
                    if not self._truncation_announced and self._truncation_callback is not None:
                        self._truncation_announced = True
                        try:
                            self._truncation_callback(
                                self._ACCUMULATOR_MAX_BYTES,
                                self._accumulator_dropped,
                            )
                        except Exception as cb_exc:
                            print(
                                f"[trajectory/accumulator] truncation callback "
                                f"raised (swallowed): {type(cb_exc).__name__}: "
                                f"{cb_exc}",
                                flush=True,
                            )
            except (TypeError, ValueError) as e:
                # A non-JSON-encodable payload can't be serialized at
                # dump time either — drop it here so CloudWatch still
                # gets whatever it can write (the CW path does its own
                # ``default=str`` handling below).
                print(
                    f"[trajectory/accumulator] drop non-serializable event: "
                    f"{type(e).__name__}: {e}",
                    flush=True,
                )

        if not self._log_group or self._disabled:
            return
        try:
            self._ensure_client()
            if self._client is None:
                self._disabled = True
                return

            message = json.dumps(payload, default=str)

            # Safety-net: hard byte-level truncation
            encoded = message.encode("utf-8")
            if len(encoded) > self._CW_MAX_EVENT_BYTES:
                print(
                    f"[trajectory] WARNING: Event exceeded CW limit even after field "
                    f"truncation ({len(encoded)} bytes). Hard-truncating — event JSON "
                    f"will be invalid.",
                    flush=True,
                )
                message = (
                    encoded[: self._CW_MAX_EVENT_BYTES - 100].decode("utf-8", errors="ignore")
                    + " [TRUNCATED]"
                )

            self._client.put_log_events(
                logGroupName=self._log_group,
                logStreamName=f"trajectory/{self._task_id}",
                logEvents=[
                    {
                        "timestamp": int(time.time() * 1000),
                        "message": message,
                    }
                ],
            )
        except ImportError:
            self._disabled = True
            print("[trajectory] boto3 not available — skipping", flush=True)
        except Exception as e:
            self._failure_count += 1
            exc_type = type(e).__name__
            if self._failure_count >= self._MAX_FAILURES:
                self._disabled = True
                print(
                    f"[trajectory] CloudWatch write failed {self._failure_count} times, "
                    f"disabling trajectory: {exc_type}: {e}",
                    flush=True,
                )
            else:
                print(
                    f"[trajectory] CloudWatch write failed ({self._failure_count}/"
                    f"{self._MAX_FAILURES}): {exc_type}: {e}",
                    flush=True,
                )
            if "Credential" in exc_type or "Endpoint" in exc_type or "AccessDenied" in str(e):
                print(
                    "[trajectory] WARNING: This may indicate a deployment misconfiguration "
                    "(IAM role, VPC endpoint, or credentials). Trajectory data will be missing.",
                    flush=True,
                )

    @staticmethod
    def _truncate_field(value: str, max_len: int = 4000) -> str:
        """Truncate a large string field for trajectory events."""
        if not value or len(value) <= max_len:
            return value
        return value[:max_len] + f"... [truncated, {len(value)} chars total]"

    def write_turn(
        self,
        turn: int,
        model: str,
        thinking: str,
        text: str,
        tool_calls: list[dict],
        tool_results: list[dict],
    ) -> None:
        """Write a TRAJECTORY_TURN event for one agent turn."""
        # Truncate large fields to stay under CloudWatch event limit
        truncated_thinking = self._truncate_field(thinking)
        truncated_text = self._truncate_field(text)
        truncated_results = []
        for tr in tool_results:
            entry = dict(tr)
            if isinstance(entry.get("content"), str):
                entry["content"] = self._truncate_field(entry["content"], 2000)
            truncated_results.append(entry)

        self._put_event(
            {
                "event": "TRAJECTORY_TURN",
                "task_id": self._task_id,
                "turn": turn,
                "model": model,
                "thinking": truncated_thinking,
                "text": truncated_text,
                "tool_calls": tool_calls,
                "tool_results": truncated_results,
            }
        )

    def write_result(
        self,
        subtype: str,
        num_turns: int,
        cost_usd: float | None,
        duration_ms: int,
        duration_api_ms: int,
        session_id: str,
        usage: TokenUsage | None,
    ) -> None:
        """Write a TRAJECTORY_RESULT summary event at session end."""
        self._put_event(
            {
                "event": "TRAJECTORY_RESULT",
                "task_id": self._task_id,
                "subtype": subtype,
                "num_turns": num_turns,
                "cost_usd": cost_usd,
                "duration_ms": duration_ms,
                "duration_api_ms": duration_api_ms,
                "session_id": session_id,
                "usage": usage.model_dump() if usage else None,
            }
        )

    def write_policy_decision(
        self, tool_name: str, allowed: bool, reason: str, duration_ms: float
    ) -> None:
        """Write a POLICY_DECISION event for a tool-use policy evaluation."""
        self._put_event(
            {
                "event": "POLICY_DECISION",
                "task_id": self._task_id,
                "tool_name": tool_name,
                "allowed": allowed,
                "reason": reason,
                "duration_ms": duration_ms,
            }
        )

    def write_output_screening_decision(
        self, tool_name: str, findings: list[str], redacted: bool, duration_ms: float
    ) -> None:
        """Write an OUTPUT_SCREENING event for a post-tool-use output scan."""
        self._put_event(
            {
                "event": "OUTPUT_SCREENING",
                "task_id": self._task_id,
                "tool_name": tool_name,
                "findings": findings,
                "redacted": redacted,
                "duration_ms": duration_ms,
            }
        )

    def dump_gzipped_jsonl(self) -> bytes | None:
        """Serialize accumulated events as gzipped JSONL for --trace upload.

        Returns ``None`` if the writer was not constructed with
        ``accumulate=True`` or if no events were captured. Otherwise
        returns gzip-compressed bytes — one JSON object per line, plus
        a synthetic header event that records any accumulator drops so
        a consumer can tell a truncated trace from a complete one.
        """
        if not self._accumulate or not self._events:
            return None

        # Peak memory ~= accumulator size + gzip output buffer. With the default
        # 50 MB cap and typical ~8x JSONL compression, the transient peak is
        # ~55-60 MB during dump. Raising the cap needs matching container
        # memory headroom.
        import gzip
        import io

        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
            # Header: self-describing so ``zcat | head -1`` tells you
            # the shape. ``dropped`` > 0 means later events didn't
            # make it into the artifact (accumulator hit its cap).
            header = {
                "event": "TRAJECTORY_ARTIFACT_HEADER",
                "task_id": self._task_id,
                "accumulated_events": len(self._events),
                "accumulated_bytes": self._accumulated_bytes,
                "dropped": self._accumulator_dropped,
                "max_bytes": self._ACCUMULATOR_MAX_BYTES,
            }
            gz.write((json.dumps(header, default=str) + "\n").encode("utf-8"))
            for event in self._events:
                gz.write((json.dumps(event, default=str) + "\n").encode("utf-8"))
        return buf.getvalue()


def upload_trace_to_s3(
    task_id: str,
    user_id: str,
    body: bytes,
) -> str | None:
    """Upload *body* (gzipped JSONL) to the --trace artifact bucket.

    Fail-open: any error logs a warning and returns ``None`` so the
    caller can continue to terminal state. Only called when the task
    was submitted with ``--trace`` and has a non-empty ``user_id``
    (design §10.1). Returns the ``s3://bucket/key`` URI on success.

    Contract enforcement (K2 Stage 3 review Finding #1):
      - Empty ``user_id`` is treated as a programming bug at the call
        site — this function WARNs and returns ``None`` rather than
        writing to ``traces//<task_id>.jsonl.gz`` (an unreachable key:
        no Cognito caller has an empty ``sub``, so the
        ``get-trace-url`` handler's per-caller-prefix guard would 403
        every download attempt).
    """
    if not task_id:
        print("[trace/upload] skip: empty task_id", flush=True)
        return None
    if not user_id:
        print(
            f"[trace/upload] skip: empty user_id (would have produced "
            f"an unreachable key). task_id={task_id!r}",
            flush=True,
        )
        return None

    bucket = os.environ.get("TRACE_ARTIFACTS_BUCKET_NAME")
    if not bucket:
        print(
            f"[trace/upload] skip: TRACE_ARTIFACTS_BUCKET_NAME unset. task_id={task_id!r}",
            flush=True,
        )
        return None

    key = f"traces/{user_id}/{task_id}.jsonl.gz"
    try:
        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("s3", region_name=region)
        # Intentionally omit ContentEncoding=gzip: Node's fetch (undici) auto-
        # decompresses responses whose metadata declares gzip encoding, which
        # violates the CLI's `-o <file>` "raw gzipped bytes" contract and
        # breaks the default stdout gunzip path (Z_DATA_ERROR). We store the
        # actual gzipped bytes and describe them honestly as application/gzip.
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/gzip",
        )
        return f"s3://{bucket}/{key}"
    except ImportError:
        print("[trace/upload] boto3 not available — skipping", flush=True)
        return None
    except Exception as e:
        exc_type = type(e).__name__
        print(
            f"[trace/upload] S3 put_object failed: {exc_type}: {e}. "
            f"task_id={task_id!r} bucket={bucket!r} key={key!r}",
            flush=True,
        )
        if "Credential" in exc_type or "AccessDenied" in str(e):
            print(
                "[trace/upload] WARNING: IAM misconfiguration likely — trace artifact is lost.",
                flush=True,
            )
        return None


# Values under these keys may contain tool stderr, paths, or incidental secrets.
_METRICS_REDACT_KEYS = frozenset({"error"})


def _metrics_payload_for_logging(metrics: dict) -> dict:
    """Build metrics dict for stdout / CloudWatch JSON (redacts sensitive fields)."""
    out: dict = {}
    for k, v in metrics.items():
        if k in _METRICS_REDACT_KEYS:
            out[k] = None if v is None else "[redacted]"
            continue
        if isinstance(v, (bool, int, float, type(None))):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def print_metrics(metrics: dict):
    """Emit a METRICS_REPORT event and print a human-readable summary.

    Writes the JSON event directly to CloudWatch Logs via
    ``_emit_metrics_to_cloudwatch()`` for dashboard querying, and prints a
    human-readable table to stdout for operator console inspection.

    Native types (int, float, bool, None) are preserved in the JSON payload.
    None values become JSON ``null`` and are excluded by ``ispresent()``
    filters in the dashboard queries. Raw ``error`` text is never logged verbatim.
    """
    safe = _metrics_payload_for_logging(metrics)
    json_payload: dict = {"event": "METRICS_REPORT", **safe}

    # Write directly to CloudWatch Logs (reliable — doesn't depend on stdout capture)
    _emit_metrics_to_cloudwatch(json_payload)

    # Also print to stdout for operator console visibility
    print(json.dumps(json_payload), flush=True)

    # Human-readable banner only; do not print keys/values from ``metrics`` (taints logging sinks).
    print("\n" + "=" * 60)
    print("METRICS REPORT")
    print("=" * 60)
    print(
        "  See structured JSON on the previous line — table omitted so metric "
        "keys are not echoed next to log sinks.",
        flush=True,
    )
    print("=" * 60)
