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


_BYTES_PER_UNIT = 1024


def format_bytes(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size) < _BYTES_PER_UNIT:
            return f"{size:.1f} {unit}"
        size /= _BYTES_PER_UNIT
    return f"{size:.1f} TB"


def _emit_metrics_to_cloudwatch(json_payload: dict) -> None:
    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    try:
        import contextlib

        from aws_session import platform_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = platform_client("logs", region_name=region)

        task_id = json_payload.get("task_id", "unknown")
        log_stream = f"metrics/{task_id}"

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
    _CW_MAX_EVENT_BYTES = 262_144

    _ACCUMULATOR_MAX_BYTES = 50 * 1024 * 1024

    _MAX_FAILURES = 3

    def __init__(self, task_id: str, accumulate: bool = False) -> None:
        self._task_id = task_id
        self._log_group = os.environ.get("LOG_GROUP_NAME")
        self._client = None
        self._disabled = False
        self._failure_count = 0
        self._accumulate = accumulate
        self._events: list[dict] = []
        self._accumulated_bytes = 0
        self._accumulator_dropped = 0
        self._truncation_callback: Callable[[int, int], None] | None = None
        self._truncation_announced = False

    def set_truncation_callback(self, cb) -> None:
        """Register a callback fired once when the accumulator cap trips.

        Signature: ``cb(max_bytes: int, first_dropped_so_far: int) -> None``.
        Called at most one time per writer lifetime. Errors in the
        callback are swallowed.
        """
        self._truncation_callback = cb

    def _ensure_client(self):
        if self._client is not None:
            return
        if not self._log_group:
            self._disabled = True
            return

        import contextlib

        from aws_session import platform_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = platform_client("logs", region_name=region)

        log_stream = f"trajectory/{self._task_id}"
        with contextlib.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=self._log_group, logStreamName=log_stream)
        self._client = client

    def _put_event(self, payload: dict) -> None:
        if self._accumulate:
            try:
                event_json = json.dumps(payload, default=str)
                event_size = len(event_json.encode("utf-8"))
                if self._accumulated_bytes + event_size <= self._ACCUMULATOR_MAX_BYTES:
                    self._events.append(payload)
                    self._accumulated_bytes += event_size
                else:
                    self._accumulator_dropped += 1
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

    def write_tool_result(self, turn: int, tool_name: str, is_error: bool, content: str) -> None:
        self._put_event(
            {
                "event": "TRAJECTORY_TOOL_RESULT",
                "task_id": self._task_id,
                "turn": turn,
                "tool_name": tool_name,
                "is_error": is_error,
                "content": self._truncate_field(content, 2000),
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
        """Serialize accumulated events as gzipped JSONL.

        Returns ``None`` if the writer was not constructed with
        ``accumulate=True`` or if no events were captured. Otherwise
        returns gzip-compressed bytes — one JSON object per line, plus
        a synthetic header event that records any accumulator drops.
        """
        if not self._accumulate or not self._events:
            return None

        import gzip
        import io

        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
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

    Returns the ``s3://bucket/key`` URI on success. Fail-open: any error
    logs a warning and returns ``None``, as does an empty ``task_id`` or
    ``user_id``.
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
        from aws_session import tenant_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = tenant_client("s3", region_name=region)
        # Intentionally omit ContentEncoding=gzip: Node's fetch (undici) auto-
        # decompresses a response that declares gzip encoding, and the CLI gunzips it itself.
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/gzip",
        )
        return f"s3://{bucket}/{key}"
    except ImportError:
        print("[trace/upload] boto3 not available — skipping", flush=True)
        # nosemgrep: py-silent-success-masking -- trace upload optional; missing boto3 skips upload
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
        # nosemgrep: py-silent-success-masking -- S3 trace upload best-effort; failure logged
        return None


_METRICS_SCAN_KEYS = frozenset({"error"})


def _metrics_payload_for_logging(metrics: dict) -> dict:
    from output_scanner import scan_tool_output

    out: dict = {}
    for k, v in metrics.items():
        if k in _METRICS_SCAN_KEYS:
            if v is None:
                out[k] = None
            elif isinstance(v, (bool, int, float)):
                out[k] = v
            else:
                scanned = scan_tool_output(str(v))
                out[k] = scanned.redacted_content
            continue
        if isinstance(v, (bool, int, float, type(None))):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def print_metrics(metrics: dict):
    """Emit a METRICS_REPORT JSON event to CloudWatch Logs and to stdout.

    Native types (int, float, bool, None) are preserved in the JSON payload.
    None values become JSON ``null``. ``error`` text is logged after a scan that
    replaces secret patterns.
    """
    safe = _metrics_payload_for_logging(metrics)
    json_payload: dict = {"event": "METRICS_REPORT", **safe}

    _emit_metrics_to_cloudwatch(json_payload)

    print(json.dumps(json_payload), flush=True)

    print("\n" + "=" * 60)
    print("METRICS REPORT")
    print("=" * 60)
    print(
        "  See structured JSON on the previous line — table omitted so metric "
        "keys are not echoed next to log sinks.",
        flush=True,
    )
    print("=" * 60)
