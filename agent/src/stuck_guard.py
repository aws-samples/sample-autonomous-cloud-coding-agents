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
     — and tracks how many times that exact signature has just FAILED in a row
     WITH THE SAME OUTPUT. A success, a different signature, or a different
     failure output resets the streak.

  2. ``evaluate`` is called from a between-turns (Stop) hook. When a signature
     has failed ``STEER_THRESHOLD`` times in a row with identical output it
     returns a STEER action: inject a ONE-TIME advisory message telling the
     agent to stop retrying and either work around the failure or finish with
     what it has.

ADVISORY ONLY — by design this guard NEVER kills a task. An earlier version
could BAIL (end the turn loop), but distinguishing a true spin from a
legitimately-iterating agent (re-running the same test command as it fixes
failures one by one) from raw output is genuinely fragile, and a false-positive
KILL of a working agent is far worse than a false-positive nudge. So we dropped
the bail: the real runaway backstop is the platform's ``max_turns`` cap (which
now reports an honest "Exceeded max turns" reason via the error classifier). A
false-positive here costs exactly one extra advisory comment — nothing more.

Design choices (deliberately conservative):
  - Key on a REPEATING IDENTICAL FAILURE, not a raw turn count. A task making
    steady progress (different tool calls, or the same command failing
    DIFFERENTLY each time) never trips this — only a true spin does.
  - "Failure" is detected from the tool RESPONSE via small, well-known signals
    (non-zero exit, command-not-found, OOM markers). Unknown output counts as
    success — we never punish a healthy turn.
  - Steer at most ONCE per signature (process-lifetime dedup), mirroring the
    nudge hook's ``_INJECTED_NUDGES`` guard.

Pure + dependency-free (no boto3 / SDK imports) so it unit-tests trivially; the
hook wiring in ``hooks.py`` owns all I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Consecutive failures of the same command WITH IDENTICAL OUTPUT before we
# inject the one-time advisory steer. Three distinguishes a real spin ("I keep
# running the same broken command and getting the same error") from a normal
# retry-after-fix ("ran it, changed something, ran it again — different result").
STEER_THRESHOLD = 3

# ABCA-662: a SECOND spin shape the per-signature streak can't see — the agent
# tries a DIFFERENT command each turn toward the SAME failing goal (e.g. a git
# push that keeps failing on 'invalid credentials', retried via http.extraheader,
# then a token remote URL, then GITHUB_TOKEN env, then gh auth status …). Each is
# a distinct signature, so no single streak reaches STEER_THRESHOLD, and the run
# thrashes to the max_turns cap. We also track a TRAILING WINDOW of the last
# ``WINDOW`` tool outcomes: when at least ``WINDOW_FAIL_THRESHOLD`` of them FAILED
# (regardless of signature), the agent is stuck spinning on failures — steer, and
# expose a summary so a max_turns terminal reason can say WHY it capped ("spinning
# on failing tool calls: …") vs. a task that genuinely needed the turns.
WINDOW = 6
WINDOW_FAIL_THRESHOLD = 5

# Max chars of the offending command surfaced in the steer message. Short:
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


def _failure_fingerprint(tool_response: str) -> str:
    """Whitespace-collapsed prefix of the failure output, used to tell a true
    spin (same command, SAME error, over and over) from healthy iteration (same
    command, but a DIFFERENT error each run — fixed one thing, hit the next).

    We do NOT blur digits/paths/line-numbers: an earlier version normalized
    ``\\d+ → #`` to ignore volatile GC timings, but that ALSO collapsed
    ``test file_0`` and ``test file_1`` to the same fingerprint — i.e. it
    couldn't tell a volatile number from the meaningful "which test failed"
    progress signal, and would have nudged a legitimately-iterating agent. Since
    the guard is now advisory-only (a false nudge is cheap), we use the SIMPLE,
    honest comparison: two failures are "the same" only if their (collapsed)
    output prefix is identical. A working agent's output changes run-to-run, so
    it reads as progress and never reaches the steer threshold.
    """
    return re.sub(r"\s+", " ", (tool_response or "").strip())[:300]


@dataclass
class _SigState:
    """Per-signature streak tracking."""

    fail_streak: int = 0
    last_preview: str = ""
    # Output fingerprint of the LAST failure on this signature. The streak only
    # grows when a new failure matches it (same command failing the SAME way); a
    # different failure resets to 1 (the agent made progress).
    last_fingerprint: str = ""


@dataclass
class StuckAction:
    """What the between-turns hook should do this turn."""

    kind: str  # 'none' | 'steer'  (advisory only — never kills the task)
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
    # ABCA-662 trailing window: recent tool outcomes as (failed: bool, preview,
    # fingerprint), newest last, capped at WINDOW. Drives the window-based steer
    # (loop-of-variations) and the max_turns "why" summary.
    _window: list[tuple[bool, str, str]] = field(default_factory=list)
    _window_steered: bool = False

    def record_tool_result(self, tool_name: str, tool_input: object, tool_response: str) -> None:
        """Called from PostToolUse for every tool call. Updates failure streaks."""
        # Trailing-window bookkeeping (ABCA-662): record every outcome, newest
        # last, capped at WINDOW — signature-agnostic, so a loop of *different*
        # commands all failing is visible even though no single streak grows.
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
        if _looks_failed(tool_response):
            # Only grow the streak when the SAME command fails the SAME way. A
            # different failure fingerprint means the agent made progress (fixed
            # one error, hit the next) — that's healthy iteration, so reset to a
            # fresh streak of 1 rather than march toward a bail. This is the
            # guard against false-positives on a legitimately-iterating agent
            # (e.g. re-running the test suite as it fixes failures one by one).
            fp = _failure_fingerprint(tool_response)
            if fp == state.last_fingerprint:
                state.fail_streak += 1
            else:
                state.fail_streak = 1
            state.last_fingerprint = fp
            state.last_preview = _command_preview(tool_input)
            self._last_failing_sig = sig
        else:
            # A success on this signature breaks ITS streak. We don't reset
            # other signatures — an A/B/A/B flip-flop between two failing
            # commands still accrues on each independently.
            state.fail_streak = 0
            state.last_fingerprint = ""
            if self._last_failing_sig == sig:
                self._last_failing_sig = None

    def evaluate(self) -> StuckAction:
        """Called from a between-turns hook. Decide steer / none (advisory only).

        STEER fires at most once per signature. There is no bail — the guard
        never kills a task (see module docstring).
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

        # ABCA-662: window-based steer — the last WINDOW tool calls are dominated
        # by the SAME recurring failure even though the COMMANDS varied (a
        # loop-of-variations toward one failing goal, e.g. retrying git-push auth
        # every which way and getting "invalid credentials" each time). Requiring a
        # dominant repeated failure — not just N failures — is what keeps a healthy
        # iterate-and-fix loop (same command, a DIFFERENT test failing each run)
        # from tripping this (K10). Steer ONCE, and NOT if the per-signature path
        # already steered this same spin (avoid double-nudging one loop). Advisory.
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
        """If the trailing window is dominated by ONE recurring failure, return
        ``(fingerprint, last_matching_command_preview)``; else None.

        "Dominated" = the window is full AND at least ``WINDOW_FAIL_THRESHOLD`` of
        its entries are failures sharing the SAME failure fingerprint (the
        collapsed output prefix, NOT digit-blurred — see below). This is the
        signal-agnostic spin detector: the SAME error recurring across VARIED
        commands (662: 'invalid credentials' on every push variant), NOT a
        productive loop where each failure differs.

        Crucially we compare EXACT (whitespace-collapsed) fingerprints and do NOT
        blur digits: an earlier attempt normalized ``\\d+ → #`` to catch volatile
        suffixes, but that ALSO collapsed a healthy iterate-and-fix loop (same
        command, ``FAIL test/file_0``, ``file_1``, … — a DIFFERENT failing test
        each run, which is PROGRESS) into one fingerprint and false-steered it
        (K10). Requiring byte-identical failure output means only a genuinely
        stuck spin (the same error verbatim) trips this; a working agent whose
        output changes run-to-run never does."""
        if len(self._window) < WINDOW:
            return None
        # Count failures by EXACT fingerprint (no digit blur — see docstring).
        counts: dict[str, tuple[int, str]] = {}
        for failed, prev, fp in self._window:
            if not failed:
                continue
            n, _ = counts.get(fp, (0, prev))
            counts[fp] = (n + 1, prev)  # keep the latest preview for this fp
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
        bar the window-steer uses) — so a task that genuinely used its turns
        making progress yields no summary and its max_turns reason is unchanged.
        Names the dominant recent failing command + a short slice of its output.

        Deliberately states only WHAT was observed, not WHY it capped: the window
        is the last few tool calls, which can't tell a hard blocker from a long
        task that hit a recoverable snag near the end. So the platform can say
        "hit max turns; last tool calls repeated: <cmd> → <err>" and let the
        reader judge — it must NOT assert the task was "spinning" or that more
        turns wouldn't have helped.
        """
        dominant = self._dominant_window_failure()
        if dominant is None:
            return None
        _, prev = dominant
        # Recover a short slice of the actual (un-normalized) output for the last
        # failure matching the dominant command, for the human-readable detail.
        detail = ""
        for failed, p, fp in reversed(self._window):
            if failed and p == prev:
                detail = re.sub(r"\s+", " ", fp).strip()[:120]
                break
        base = f"last tool calls repeated: `{prev}`"
        return f"{base} — {detail}" if detail else base
