# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Bounded, payload-free lifecycle diagnostics shared with callback threads."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

_ACTIVE: ContextVar[HookDiagnostics | None] = ContextVar("microvm_hook_diagnostics", default=None)
_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_OUTPUT_LOCK = threading.Lock()


def _error_identity(error: BaseException | None) -> dict[str, str]:
    if error is None:
        return {}
    name = type(error).__name__
    identity = {"error_type": name if _IDENTIFIER.fullmatch(name) else "Error"}
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        for source, field, target in [
            ("Error", "Code", "aws_error_code"),
            ("ResponseMetadata", "RequestId", "aws_request_id"),
        ]:
            section = response.get(source)
            value = section.get(field) if isinstance(section, dict) else None
            if isinstance(value, str) and _IDENTIFIER.fullmatch(value):
                identity[target] = value
    return identity


class HookDiagnostics:
    """One HTTP invocation; copied thread contexts retain this same correlation id.

    Logging cannot authorize a transition. Callback threads may outlive a timeout;
    their subsequent records are marked late, never a successful HTTP acknowledgment.
    """

    def __init__(self, action: str, snapshot: Callable[[], dict[str, Any]]) -> None:
        self.action = action
        self.hook_id = str(uuid.uuid4())
        self._snapshot = snapshot
        self._started = time.monotonic()
        self._stage = "body-read"
        self._closed = False
        self._lock = threading.Lock()

    def emit(self, event: str, **fields: Any) -> None:
        # Snapshot only safe local facts. Never include request bodies, SDK messages,
        # approval records, tool arguments, credentials, or exception tracebacks.
        try:
            snapshot = self._snapshot()
            safe = {
                key: value
                for key, value in snapshot.items()
                if not isinstance(value, str) or _IDENTIFIER.fullmatch(value)
            }
            with self._lock:
                record = {
                    **safe,
                    "event": event,
                    "level": "WARN" if event.endswith("_failed") else "INFO",
                    "action": self.action,
                    "hook_id": self.hook_id,
                    "pid": os.getpid(),
                    "timestamp_ms": int(time.time() * 1000),
                    "elapsed_ms": round((time.monotonic() - self._started) * 1000),
                    "stage": self._stage,
                    "late": self._closed,
                    **fields,
                }
                # Concurrent hooks and their callback threads must not interleave
                # the JSON and newline writes of these records.
                with _OUTPUT_LOCK:
                    print(json.dumps(record), flush=True)
        except Exception:  # noqa: S110 — failure in the logging sink cannot safely log to itself.
            # Diagnostics are best effort; a broken stdout must not change the
            # response or bypass the controller's generation/barrier checks.
            pass

    def stage(self, name: str) -> None:
        with self._lock:
            if not self._closed:
                self._stage = name
        self.emit("microvm_hook_stage", callback_stage=name)

    def finish(self, status: int | None, code: str, error: BaseException | None = None) -> None:
        with self._lock:
            self._closed = True
        self.emit(
            "microvm_hook_finished",
            http_status=status,
            code=code,
            late=False,
            level="INFO" if code == "acknowledged" else "WARN",
            **_error_identity(error),
        )


@contextmanager
def hook_diagnostics(action: str, snapshot: Callable[[], dict[str, Any]]):
    diagnostics = HookDiagnostics(action, snapshot)
    token = _ACTIVE.set(diagnostics)
    try:
        diagnostics.emit("microvm_hook_started")
        yield diagnostics
    finally:
        _ACTIVE.reset(token)


@contextmanager
def lifecycle_stage(name: str):
    """Record entry before potentially blocking work, including inside to_thread."""
    diagnostics = _ACTIVE.get()
    if diagnostics:
        diagnostics.stage(name)
    try:
        yield
    except BaseException as error:
        if diagnostics:
            diagnostics.emit(
                "microvm_hook_stage_failed", callback_stage=name, **_error_identity(error)
            )
        raise
    else:
        if diagnostics:
            diagnostics.emit("microvm_hook_stage_finished", callback_stage=name)
