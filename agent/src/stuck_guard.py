"""Stuck/runaway guard — detect a repeating failing tool call and steer."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

STEER_THRESHOLD = 3

WINDOW = 6
WINDOW_FAIL_THRESHOLD = 5

_CMD_PREVIEW_LEN = 80

_FAILURE_MARKERS = (
    "command not found",
    "no such file or directory",
    "exit code 1",
    "exit code 2",
    "exit code 127",
    "exit 134",  # SIGABRT
    "exit 137",  # SIGKILL
    "fatal:",
    "javascript heap out of memory",
    "out of memory",
    "allocation failure",
    "traceback (most recent call last)",
    "error: failed to push",
)

_EXIT_CODE_RE = re.compile(r"\bexit(?:\s+code)?\s+(\d+)\b", re.IGNORECASE)


def _signature(tool_name: str, tool_input: object) -> str:
    cmd = ""
    if isinstance(tool_input, dict):
        cmd = str(
            tool_input.get("command")
            or tool_input.get("file_path")
            or json.dumps(tool_input, sort_keys=True, default=str)
        )
    elif isinstance(tool_input, str):
        cmd = tool_input
    normalized = re.sub(r"\s+", " ", cmd).strip().lower()
    return f"{tool_name}|{normalized}"


def _command_preview(tool_input: object) -> str:
    cmd = ""
    if isinstance(tool_input, dict):
        cmd = str(tool_input.get("command") or tool_input.get("file_path") or "")
    elif isinstance(tool_input, str):
        cmd = tool_input
    cmd = re.sub(r"\s+", " ", cmd).strip()
    if not cmd:
        return "the same operation"
    return cmd if len(cmd) <= _CMD_PREVIEW_LEN else cmd[: _CMD_PREVIEW_LEN - 1] + "…"


def _looks_failed(tool_response: str) -> bool:
    s = (tool_response or "").lower()
    if any(marker in s for marker in _FAILURE_MARKERS):
        return True
    m = _EXIT_CODE_RE.search(s)
    if m:
        try:
            return int(m.group(1)) != 0
        except ValueError:
            return False
    return False


def _failure_fingerprint(tool_response: str) -> str:
    return re.sub(r"\s+", " ", (tool_response or "").strip())[:300]


@dataclass
class _SigState:
    fail_streak: int = 0
    last_preview: str = ""
    last_fingerprint: str = ""


@dataclass
class StuckAction:
    """What the hook that asked should do now."""

    kind: str
    signature: str = ""
    message: str = ""


@dataclass
class StuckGuard:
    """Tracks repeating failing tool calls for ONE task (process-lifetime).

    Not thread-safe. One instance per task.
    """

    _sigs: dict[str, _SigState] = field(default_factory=dict)
    _steered: set[str] = field(default_factory=set)
    _last_failing_sig: str | None = None
    _window: list[tuple[bool, str, str]] = field(default_factory=list)
    _window_steered: bool = False

    def record_tool_result(
        self, tool_name: str, tool_input: object, tool_response: str, failed: bool | None = None
    ) -> None:
        """Called for every tool result, completed or failed. Updates failure streaks.

        *failed* is given where the caller knows the outcome; otherwise the
        response is read for the signs of a failure. The guard quotes the input
        and the response of a failing call, cut to a preview, in its advisory
        and in its summary: the caller screens both for secrets first.
        """
        if failed is None:
            failed = _looks_failed(tool_response)
        self._window.append(
            (
                failed,
                _command_preview(tool_input),
                _failure_fingerprint(tool_response) if failed else "",
            )
        )
        if len(self._window) > WINDOW:
            self._window.pop(0)

        sig = _signature(tool_name, tool_input)
        state = self._sigs.setdefault(sig, _SigState())
        if failed:
            fp = _failure_fingerprint(tool_response)
            if fp == state.last_fingerprint:
                state.fail_streak += 1
            else:
                state.fail_streak = 1
            state.last_fingerprint = fp
            state.last_preview = _command_preview(tool_input)
            self._last_failing_sig = sig
        else:
            state.fail_streak = 0
            state.last_fingerprint = ""
            if self._last_failing_sig == sig:
                self._last_failing_sig = None

    def evaluate(self) -> StuckAction:
        """Called after each recorded result. Decide steer / none (advisory only).

        STEER fires at most once per signature. The guard never kills a task.
        """
        sig = self._last_failing_sig
        if not sig:
            return StuckAction(kind="none")
        state = self._sigs.get(sig)
        if state is None:
            return StuckAction(kind="none")

        if state.fail_streak >= STEER_THRESHOLD and sig not in self._steered:
            self._steered.add(sig)
            return StuckAction(
                kind="steer",
                signature=sig,
                message=(
                    f"⚠️ You have run `{state.last_preview}` and it has failed "
                    f"{state.fail_streak} times in a row. STOP retrying it. Either (a) work "
                    "around the failure (e.g. a different command, or skip the failing step if "
                    "it is an environment/tooling problem rather than your code), or (b) if you "
                    "cannot, finish now with what you have and clearly state in your summary what "
                    "failed and why. Do not run the same failing command again."
                ),
            )

        dominant = self._dominant_window_failure()
        if not self._window_steered and dominant is not None and sig not in self._steered:
            self._window_steered = True
            _, last_fail = dominant
            fail_count = sum(1 for failed, _, _ in self._window if failed)
            return StuckAction(
                kind="steer",
                signature="__window__",
                message=(
                    f"⚠️ {fail_count} of your last {len(self._window)} tool calls FAILED with "
                    f"the same error, across different commands (most recently `{last_fail}`) — "
                    "you are spinning on one failing operation without progress. STOP. If this is "
                    "an environment/tooling problem (auth, missing credentials, disk, network), it "
                    "will NOT resolve by retrying — finish now and state clearly in your summary "
                    "what failed and why, so a human can fix the environment."
                ),
            )

        return StuckAction(kind="none")

    def _dominant_window_failure(self) -> tuple[str, str] | None:
        if len(self._window) < WINDOW:
            return None
        counts: dict[str, tuple[int, str]] = {}
        for failed, prev, fp in self._window:
            if not failed:
                continue
            n, _ = counts.get(fp, (0, prev))
            counts[fp] = (n + 1, prev)
        if not counts:
            return None
        top_fp, (top_n, top_prev) = max(counts.items(), key=lambda kv: kv[1][0])
        if top_n >= WINDOW_FAIL_THRESHOLD:
            return (top_fp, top_prev)
        return None

    def recent_failure_summary(self) -> str | None:
        """A one-line NEUTRAL observation of the recent repeated failure, for a
        max_turns terminal reason.

        Returns None unless the trailing window is failure-dominated (the same
        bar the window-steer uses). Names the dominant recent failing command +
        a short slice of its output.
        """
        dominant = self._dominant_window_failure()
        if dominant is None:
            return None
        _, prev = dominant
        detail = ""
        for failed, p, fp in reversed(self._window):
            if failed and p == prev:
                detail = re.sub(r"\s+", " ", fp).strip()[:120]
                break
        base = f"last tool calls repeated: `{prev}`"
        return f"{base} — {detail}" if detail else base
