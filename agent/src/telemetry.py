"""Telemetry: metrics, trajectory writer, and disk usage."""

from __future__ import annotations

import json
import os
import subprocess
import time
from typing import TYPE_CHECKING

from config import AGENT_WORKSPACE

if TYPE_CHECKING:
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
    """

    _CW_MAX_EVENT_BYTES = 262_144  # CloudWatch limit per event

    _MAX_FAILURES = 3

    def __init__(self, task_id: str) -> None:
        self._task_id = task_id
        self._log_group = os.environ.get("LOG_GROUP_NAME")
        self._client = None
        self._disabled = False
        self._failure_count = 0

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
