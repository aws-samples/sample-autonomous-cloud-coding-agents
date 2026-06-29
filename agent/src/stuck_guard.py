"""Stuck/runaway guard — detect a repeating failing tool call and steer/bail.

Live-caught (ABCA-483, 2026-06-29): a one-line README task burned all 100 turns
(~22 min, $1.53) because the agent re-ran the SAME failing command
(``mise //cdk:test`` → JS-heap OOM, exit 134) over and over, yak-shaving the
build environment instead of finishing the task. Nothing noticed the loop until
the hard ``max_turns`` cap killed it — by which point the user had stared at a
silent issue for 22 minutes.

This module gives the agent a cheap, precise loop-breaker:

  1. ``record_tool_result`` is called from the PostToolUse hook for every tool
     call. It computes a coarse SIGNATURE — ``(tool_name, normalized command)``
     — and tracks how many times that exact signature has just FAILED in a row.
     A success (or a different signature) resets the streak for that signature.

  2. ``evaluate`` is called from a between-turns (Stop) hook. When any signature
     has failed ``STEER_THRESHOLD`` times in a row it returns a STEER action
     (inject a one-time message telling the agent to stop retrying and either
     work around the failure or finish with what it has). If the SAME signature
     keeps failing up to ``BAIL_THRESHOLD`` after steering, it returns a BAIL
     action (end the turn loop with a clear reason) so the task fails fast with
     an honest message instead of grinding to the turn cap.

Design choices (deliberately conservative — over-steering is cheap, a
false-positive bail is not):

  - We key on a REPEATING FAILURE, not a raw turn count. A genuinely large task
    that makes steady progress (each turn a different, succeeding tool call)
    never trips this — only a true spin loop does.
  - "Failure" is detected from the tool RESPONSE text via small, well-known
    signals (non-zero exit, "command not found", OOM/heap markers, common error
    prefixes). We err toward NOT flagging — an unrecognized response counts as
    success so we never punish a healthy turn.
  - Steering is injected at most ONCE per signature (a process-lifetime dedup
    set), mirroring the nudge hook's ``_INJECTED_NUDGES`` guard, so we don't
    re-steer every turn.

Pure + dependency-free (no boto3 / SDK imports) so it unit-tests trivially; the
hook wiring in ``hooks.py`` owns all I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Consecutive identical failures before we INJECT a steering message. Three is
# enough to distinguish a real loop ("I keep running the same broken command")
# from a normal retry-after-fix ("ran it, fixed a thing, ran it again").
STEER_THRESHOLD = 3

# Consecutive identical failures (total) before we BAIL the task. Past this the
# agent has ignored the steer and is still spinning — fail fast with a reason
# rather than burn the rest of the turn budget.
BAIL_THRESHOLD = 6

# Max chars of the offending command surfaced in the steer/bail message. Short:
# this is a hint, not a log dump (and the command is untrusted repo content).
_CMD_PREVIEW_LEN = 80

# Substrings that mark a tool response as a FAILURE. Conservative + well-known;
# an unrecognized response is treated as success (never punish a healthy turn).
_FAILURE_MARKERS = (
    "command not found",
    "no such file or directory",
    "exit code 1",
    "exit code 2",
    "exit code 127",
    "exit 134",  # SIGABRT (OOM/abort) — the ABCA-483 signal
    "exit 137",  # SIGKILL (OOM-killer)
    "fatal:",
    "javascript heap out of memory",
    "out of memory",
    "allocation failure",
    "traceback (most recent call last)",
    "error: failed to push",
)

# A reported exit code embedded in the response, e.g. "FAILED (exit 134)" or
# "Exit code 1". A non-zero match is a failure signal.
_EXIT_CODE_RE = re.compile(r"\bexit(?:\s+code)?\s+(\d+)\b", re.IGNORECASE)


def _signature(tool_name: str, tool_input: object) -> str:
    """Coarse, stable signature for a tool call: ``tool_name|normalized-cmd``.

    For Bash, the command drives the signature (whitespace-collapsed); other
    tools fall back to their name + a normalized repr of the input so that
    e.g. editing the same file repeatedly is also detectable. The signature is
    intentionally coarse: we want "the agent keeps doing the same thing", not
    byte-exact identity.
    """
    cmd = ""
    if isinstance(tool_input, dict):
        cmd = str(tool_input.get("command") or tool_input.get("file_path") or "")
    elif isinstance(tool_input, str):
        cmd = tool_input
    normalized = re.sub(r"\s+", " ", cmd).strip().lower()
    return f"{tool_name}|{normalized}"


def _command_preview(tool_input: object) -> str:
    """Short human preview of the offending command for the steer/bail text."""
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
    """Heuristic: did this tool call fail? Conservative (unknown → not failed)."""
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


@dataclass
class _SigState:
    """Per-signature streak tracking."""

    fail_streak: int = 0
    last_preview: str = ""


@dataclass
class StuckAction:
    """What the between-turns hook should do this turn."""

    kind: str  # 'none' | 'steer' | 'bail'
    signature: str = ""
    message: str = ""


@dataclass
class StuckGuard:
    """Tracks repeating failing tool calls for ONE task (process-lifetime).

    Not thread-safe by itself; the agent's hook callbacks for a single task run
    serially on the asyncio loop / one PostToolUse at a time, which is the only
    access pattern. One instance per task.
    """

    _sigs: dict[str, _SigState] = field(default_factory=dict)
    _steered: set[str] = field(default_factory=set)
    _last_failing_sig: str | None = None

    def record_tool_result(self, tool_name: str, tool_input: object, tool_response: str) -> None:
        """Called from PostToolUse for every tool call. Updates failure streaks."""
        sig = _signature(tool_name, tool_input)
        state = self._sigs.setdefault(sig, _SigState())
        if _looks_failed(tool_response):
            state.fail_streak += 1
            state.last_preview = _command_preview(tool_input)
            self._last_failing_sig = sig
        else:
            # A success on this signature breaks ITS streak. We don't reset
            # other signatures — an A/B/A/B flip-flop between two failing
            # commands still accrues on each independently.
            state.fail_streak = 0
            if self._last_failing_sig == sig:
                self._last_failing_sig = None

    def evaluate(self) -> StuckAction:
        """Called from a between-turns hook. Decide steer / bail / none.

        BAIL takes precedence over STEER. STEER fires at most once per signature.
        """
        sig = self._last_failing_sig
        if not sig:
            return StuckAction(kind="none")
        state = self._sigs.get(sig)
        if state is None:
            return StuckAction(kind="none")

        if state.fail_streak >= BAIL_THRESHOLD:
            return StuckAction(
                kind="bail",
                signature=sig,
                message=(
                    f"Stuck: `{state.last_preview}` failed {state.fail_streak} times in a row "
                    "and the agent kept retrying it instead of making progress on the task."
                ),
            )

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

        return StuckAction(kind="none")
