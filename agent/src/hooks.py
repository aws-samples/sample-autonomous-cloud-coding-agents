"""PreToolUse, PostToolUse, PostToolUseFailure, and Stop hook callbacks.

- PreToolUse: three-outcome Cedar policy enforcement (ALLOW / DENY /
  REQUIRE_APPROVAL). The REQUIRE_APPROVAL path asks the trusted approval
  service to create a pending row and atomically transition the task to
  AWAITING_APPROVAL, polls for a
  human decision, then resumes / denies per the user's input. See
  ``docs/design/CEDAR_HITL_GATES.md``.
- PostToolUse: output scanner for secrets/PII.
- PostToolUse and PostToolUseFailure: the egress-denial detector and the
  stuck guard, which see every tool result, of a call that completed or failed.
- Stop: between-turns hook dispatcher. Cancel → nudge → denial injection
  in that order (cancel-wins semantics). Each producer appends synthetic
  user-message strings that get reinjected via the SDK's
  ``decision: "block"`` mechanism.

A module-level registry ``between_turns_hooks`` lets other producers
(nudges, denial injections) append additional synthetic-message
producers without touching the Stop hook callback itself.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import nudge_reader
import task_state
from microvm_lifecycle import ApprovalRecord, get_context
from nudge_reader import _xml_escape
from output_scanner import _PATTERNS, scan_tool_output
from policy import (
    APPROVAL_RATE_LIMIT,
    FLOOR_TIMEOUT_S,
    Outcome,
    _sha256_tool_input,
    approval_deadline_epoch,
)
from progress_writer import _generate_ulid
from shared_constants import SHARED_CONSTANTS
from shell import log, log_error_cw, redact_secrets
from stuck_guard import StuckGuard

if TYPE_CHECKING:
    from policy import PolicyEngine
    from telemetry import _TrajectoryWriter

# ---------------------------------------------------------------------------
# Approval-gate constants
# ---------------------------------------------------------------------------

FLOOR_30S: int = FLOOR_TIMEOUT_S  # minimum approval window; sourced from contracts/constants.json
CLEANUP_MARGIN_120S: int = 120  # lifetime-margin reserve for cleanup
# Poll cadence: 2s for the first 30s, 5s thereafter. Exact counts vary with
# ``timeout_s``; these pin the user-observable "fast for a bit, then slack off"
# behavior.
POLL_FAST_INTERVAL_S: float = 2.0
POLL_FAST_DURATION_S: float = 30.0
POLL_SLOW_INTERVAL_S: float = 5.0
POLL_DEGRADED_FAILS: int = 3  # emit approval_poll_degraded at this many consecutive failures
POLL_MAX_CONSECUTIVE_FAILS: int = 10  # treat as TIMED_OUT at this many consecutive failures
TOOL_INPUT_PREVIEW_MAX: int = 256  # cap for the strip-ANSI, truncated input preview
PERMISSION_REASON_MAX: int = 500  # cap for the reason a denied tool call returns
ELLIPSIS_LEN: int = 3  # chars reserved for the "..." truncation marker


@dataclass(frozen=True)
class _ApprovalDeadline:
    """One gate's deadline, retained across polling and a possible VM sleep.

    UTC counts elapsed time even if the guest's monotonic clock freezes. The monotonic
    cap prevents a backward UTC correction from extending the original window.
    Create this with the approval row, before database writes or notifications;
    never recreate it on resume.
    """

    wall_deadline: float
    monotonic_deadline: float

    @classmethod
    def from_recorded(cls, created_at: str, timeout_s: int) -> _ApprovalDeadline:
        wall_deadline = float(approval_deadline_epoch(created_at, timeout_s))
        remaining = max(0.0, min(timeout_s, wall_deadline - time.time()))
        return cls(wall_deadline, time.monotonic() + remaining)

    def remaining_s(self) -> float:
        return max(
            0.0,
            min(self.monotonic_deadline - time.monotonic(), self.wall_deadline - time.time()),
        )


# ANSI CSI / OSC escape sequence stripper for ``tool_input_preview`` +
# ``permissionDecisionReason`` fields, so persisted/logged reasons can't carry
# terminal-escape injection. Kept local to avoid a cross-module dependency for
# one regex.
_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])")


def _strip_ansi(text: str) -> str:
    """Remove ANSI CSI / OSC sequences to prevent terminal injection."""
    return _ANSI_ESCAPE_RE.sub("", text)


def _truncate(text: str | None, max_len: int) -> str:
    """Truncate ``text`` to ``max_len`` chars with an ellipsis marker."""
    if text is None:
        return ""
    if len(text) <= max_len:
        return text
    # Reserve 3 chars for the ellipsis so the returned string never
    # exceeds ``max_len``. For very small ``max_len`` (<= 3) there is no
    # room for the ellipsis and ``max_len - 3`` would slice negatively
    # (dropping characters off the END), so fall back to a plain prefix.
    if max_len <= ELLIPSIS_LEN:
        return text[:max_len]
    return text[: max_len - ELLIPSIS_LEN] + "..."


def _tool_input_preview(tool_input: dict) -> str:
    """Return an ANSI-stripped, truncated preview of ``tool_input`` for DDB.

    Uses ``json.dumps`` so the input renders as stable JSON rather than
    Python repr (avoids leaking ``OrderedDict(...)`` wrappers etc.).
    """
    return _truncate(_strip_ansi(json.dumps(tool_input, default=str)), TOOL_INPUT_PREVIEW_MAX)


# ---------------------------------------------------------------------------
# Egress-denial detection
# ---------------------------------------------------------------------------
#
# Best-effort, heuristic scan of a tool's output for the signatures a blocked
# outbound connection leaves behind — a non-allowlisted host hitting the DNS
# Firewall, a refused connection, or a name-resolution failure. When one
# matches we emit an ``egress_denied`` blocker naming the host to allowlist.
# This is intentionally a string-signature scan (not a network probe): the
# model's Bash tool calls (``npm install``, ``git clone``, ``curl``) surface
# their stderr here, and those tools use stable, well-known phrasings. Patterns
# that capture a host use a named ``host`` group; detection-only patterns omit
# it (host stays None → the event still fires, just without ``resource``).
_EGRESS_DENIAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    # curl / libcurl, git-over-https
    re.compile(r"[Cc]ould not resolve host:?\s+(?P<host>[A-Za-z0-9._-]+)"),
    re.compile(r"[Ff]ailed to connect to\s+(?P<host>[A-Za-z0-9._-]+)"),
    # Node (npm/yarn), python (requests/urllib), getaddrinfo
    re.compile(r"getaddrinfo (?:ENOTFOUND|EAI_AGAIN)\s+(?P<host>[A-Za-z0-9._-]+)"),
    # requests/urllib3: the real host appears in ``HTTPSConnectionPool(host='x')``
    # or after ``Failed to resolve 'x'``. Match those anchors specifically —
    # a bare ``NameResolutionError.*?<fqdn>`` lazy-match would instead capture
    # the ``urllib3.connection.HTTPSConnection`` class path that precedes the host.
    re.compile(r"HTTPS?ConnectionPool\(host='(?P<host>[A-Za-z0-9._-]+)'"),
    re.compile(r"Failed to resolve '(?P<host>[A-Za-z0-9._-]+)'"),
    re.compile(
        r"nodename nor servname provided|Temporary failure in name resolution"
        r"|Name or service not known|Connection refused|Network is unreachable"
        r"|NameResolutionError|Failed to establish a new connection",
    ),
)

# The machine itself, in the spellings a failed connection names it by: any
# 127.x.x.x address, and the all-zero address that a dev server prints as the
# one it listens on.
_LOOPBACK_HOST_RE = re.compile(r"localhost|127(?:\.\d+){3}|0(?:\.0){3}", re.IGNORECASE)

# The built-in tools through which a task opens outbound connections. Of all
# tool output, only theirs can make a blocked host the terminal reason, and
# that of a fetch only when the fetch failed. The rest is content: a file, a
# search hit, a fetched page or an MCP server's answer can quote a failed
# connection that this task never attempted.
_NETWORK_TOOLS = frozenset(("Bash", "WebFetch"))


# The most recent agent-detected blocker, as a canonical ``BLOCKED[<kind>]: …``
# reason string (see ``format_blocker_reason``). Blockers are detected mid-turn
# in the hooks (egress in PostToolUse, fail-closed in PreToolUse) but the
# terminal ``error_message`` is assembled later in the pipeline. This latch
# bridges the two: the pipeline promotes it into ``TaskResult.error`` ONLY when
# the task errored without a more specific reason, so the error classifier
# surfaces a precise remedy. Process-lifetime (== one task) like
# ``_INJECTED_NUDGES``; last-writer-wins is fine — the most recent blocker is
# the most relevant to a terminal failure.
# Correct only for one task at a time per process (``docs/design/COMPUTE.md``).
# Key the latch by task id before a process may run two tasks at once.
_LAST_BLOCKER_REASON: str | None = None


def _record_blocker_reason(kind: str, detail: str, resource: str | None = None) -> None:
    """Latch the canonical reason for the most recent agent-detected blocker."""
    global _LAST_BLOCKER_REASON
    from progress_writer import format_blocker_reason

    _LAST_BLOCKER_REASON = format_blocker_reason(kind, detail, resource)


def last_blocker_reason() -> str | None:
    """Return the latched canonical blocker reason for terminal promotion."""
    return _LAST_BLOCKER_REASON


def reset_blocker_reason() -> None:
    """Clear the in-process blocker latch.

    Called at the start of each ``run_task`` (the latch is a process-scalar,
    not task_id-keyed, so it must be reset per task to avoid leaking a prior
    task's blocker) and by test fixtures for isolation.
    """
    global _LAST_BLOCKER_REASON
    _LAST_BLOCKER_REASON = None


# Latch of the stuck-guard's "why it's spinning" summary, refreshed with every
# tool result. Read by the pipeline's terminal path so a max_turns
# failure can say WHY it capped ("Exceeded max turns — spinning on failing tool
# calls: git push → invalid credentials") vs. a task that genuinely used its
# turns. Process-lifetime (one task), last-writer-wins (the most recent window
# is the most relevant to the cap). Distinct from the blocker latch: this is a
# SOFT diagnostic (advisory), not a canonical BLOCKED[…] terminal reason.
_LAST_STUCK_SUMMARY: str | None = None


def _screened(text: str) -> str:
    """Return *text* as it may be quoted outside the tool call it belongs to.

    What the scanner of tool output hides is replaced, and what the redaction
    of the log lines hides. Both know most credentials only whole: screen a
    text before cutting it.
    """
    return redact_secrets(scan_tool_output(text).redacted_content)


def last_stuck_summary() -> str | None:
    """Return the latched stuck-guard summary for the max_turns terminal reason.

    The summary quotes a command and a piece of its output and ends up in the
    task's error message. Both were screened before the guard cut them (see
    ``_observe_tool_result``); the summary is screened once more here.
    """
    if not _LAST_STUCK_SUMMARY:
        return _LAST_STUCK_SUMMARY
    return _screened(_LAST_STUCK_SUMMARY)


def reset_stuck_summary() -> None:
    """Clear the stuck-summary latch (per-task, alongside the blocker latch)."""
    global _LAST_STUCK_SUMMARY
    _LAST_STUCK_SUMMARY = None


def detect_egress_denial(text: str) -> tuple[bool, str | None]:
    """Scan tool output for an egress-denial signature.

    Returns ``(detected, host_or_None)``: ``(True, host)`` on the first matching
    signature (``host`` populated when a pattern captured one so the emitted
    ``egress_denied`` event can name the exact domain to allowlist; ``None`` for
    detection-only signatures), or ``(False, None)`` when nothing matches.

    Best-effort and deliberately conservative: it only fires on the
    well-known phrasings the common CLIs (curl/git/npm/pip) emit, so a task
    log that merely *mentions* "connection refused" in prose could produce a
    false positive — acceptable for an observability signal that never blocks.
    """
    if not text:
        return False, None
    for pattern in _EGRESS_DENIAL_PATTERNS:
        match = pattern.search(text)
        if match:
            host = match.groupdict().get("host") if match.groupdict() else None
            return True, host
    return False, None


def _deny_response(reason: str) -> dict:
    """Build a PreToolUse DENY response with a sanitized reason.

    Guaranteed surface: ``permissionDecisionReason`` is ANSI-stripped and
    truncated to ``PERMISSION_REASON_MAX`` chars so it can never carry
    terminal-escape injection or overflow a log line.
    """
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": _truncate(
                _strip_ansi(reason or "denied"), PERMISSION_REASON_MAX
            ),
        }
    }


def _allow_response(reason: str = "permitted") -> dict:
    """Build a PreToolUse ALLOW response."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": reason,
        }
    }


# Workspace-integrity guard. The repo is ALREADY cloned and checked out at the
# agent's cwd (``repo_dir``); the platform tracks that dir for
# commit/branch/PR/push. In practice the agent sometimes ran its OWN
# ``gh repo clone``/``git clone`` of the SAME repo into a sibling dir
# (``/workspace/<repo-name>``) and did all its work there, leaving repo_dir empty
# → the platform saw no commits (delivery gate: ``deliverable=lost``) and, for a
# stacked child, the successor had no branch to stack on. The industry norm is a
# filesystem sandbox that makes a divergent clone impossible; lacking that (raw
# Bash + bypassPermissions + open GitHub egress), a harness-enforced deny of the
# re-clone is the closest robust analog — and Claude Code hook denies fire even
# under bypassPermissions and survive prompt-injection. We match ONLY a re-clone
# of the TASK's OWN repo (not legitimate dependency/submodule clones), keyed off
# the ``owner/repo`` slug in any of the URL forms gh/git accept.
#
# The clone verb must appear as an actual COMMAND — at the start of the string or
# right after a shell separator (``&&``, ``||``, ``|``, ``;``, newline, ``(``) —
# NOT as text buried inside a quoted argument. Without that anchoring, a
# ``gh pr create --body "…do not run gh repo clone…"`` was wrongly blocked because
# the phrase appeared inside the PR body. Anchoring to command position (and, in
# ``_is_self_reclone``, truncating at the first argument that carries free text)
# removes that false positive while still catching every real re-clone.
_CLONE_CMD_RE = re.compile(
    r"(?:^|[;&|\n(]|&&|\|\|)\s*(?:gh\s+repo\s+clone|git\s+(?:-C\s+\S+\s+)?clone)\b",
    re.IGNORECASE,
)

# Arguments after which the rest of the command is free-form TEXT (a PR/issue/
# commit body or title), where a mention of "gh repo clone" is prose, not a
# command. Used to ignore text that merely QUOTES a clone command.
#
# NOTE ``-b`` is deliberately here (``gh pr create -b`` is ``--body``) AND is
# ``git clone``'s own ``--branch`` short form. So this list can only be applied
# to the text FOLLOWING a clone verb, never to the text preceding it: truncating
# the command at the first match before looking for the verb let
# ``git clone -b main <own repo>`` through entirely, because the truncation cut
# the command off ahead of the verb it was meant to find.
# Shell separators that start a fresh command. Splitting on these means a
# free-text argument can only swallow the rest of ITS OWN segment, so a clone
# chained after an unrelated ``-m`` is still seen.
#
# A bare newline is deliberately NOT a separator here. A multi-line ``--body`` /
# ``-m`` value is the normal way an agent writes a PR or commit body, and its
# quoted text routinely contains a clone command as documentation. Splitting on
# ``\n`` put that quoted line in its own segment with no preceding free-text
# flag, so the guard blocked a legitimate ``gh pr create`` — the exact
# false-positive the free-text list exists to prevent. A line break that ENDS a
# command does separate: see ``_command_lines``.
# A backslash at end-of-line continues the SAME command onto the next line.
_LINE_CONTINUATION_RE = re.compile(r"\\[ \t]*\r?\n[ \t]*")

_SHELL_SEPARATOR_RE = re.compile(r"(?:&&|\|\||[;&|])")

# The operator of a here-document and its word: ``<<EOF``, ``<<-'EOF'``.
_HEREDOC_RE = re.compile(r"<<-?[ \t]*(['\"]?)(\w+)\1")

# What one line holds that opens no string: taken out of the line, a quote that
# is left opens a string that goes on in the next line.
_CLOSED_TEXT_RE = re.compile(
    r"""
    \\.                    # an escaped character
    | (?<!\S)\#.*          # a comment, to the end of the line
    | '[^']*'              # a string in single quotes
    | "(?:[^"\\]|\\.)*"    # a string in double quotes
    """,
    re.VERBOSE,
)

_FREE_TEXT_ARG_RE = re.compile(
    r"(?:^|\s)(?:-m|--message|--body|--body-file|-b|--title|-t|-F|--field|--raw-field)\b",
    re.IGNORECASE,
)


def _repo_slug_variants(repo_url: str) -> list[str]:
    """Return the ``owner/repo`` slug forms a clone command could name.

    ``config.repo_url`` is the canonical ``owner/repo``. A clone command may
    reference it as ``owner/repo``, ``https://github.com/owner/repo(.git)``, or
    ``git@github.com:owner/repo(.git)`` — all normalize to the same slug, so we
    just need the bare ``owner/repo`` (with and without ``.git``) to substring-
    match against the command text after normalization."""
    slug = (repo_url or "").strip().removesuffix(".git").strip("/").lower()
    if not slug:
        return []
    return [slug, f"{slug}.git"]


def _command_lines(command: str) -> list[str]:
    """Split *command* at the line breaks that end a command.

    A line break inside quotes belongs to the string (a ``--body`` or ``-m``
    value written over several lines). The lines below ``<<EOF``, up to and with
    the line that is ``EOF``, belong to the command that reads them, whatever
    quotes they hold; an operator whose word is no line further down begins no
    such text (a shift in an arithmetic expression, ``<<`` in a quoted body).
    """
    lines = command.split("\n")
    last = {line.strip(): number for number, line in enumerate(lines)}
    commands: list[list[str]] = []
    quote = ""  # the quote of a string that the lines so far leave open
    word = None  # the word that ends the here-document the line stands in
    for number, line in enumerate(lines):
        if quote or word is not None:
            commands[-1].append(line)
        else:
            commands.append([line])
        if word is not None:
            if line.strip() == word:
                word = None
            continue
        # Also in a line that stands inside a string: ``"$(cat <<'EOF'``.
        operator = _HEREDOC_RE.search(line)
        if operator and last.get(operator[2], -1) > number:
            word = operator[2]
        # With the quote of an open string in front, the line closes it or not.
        opener = re.search("['\"]", _CLOSED_TEXT_RE.sub("", quote + line))
        quote = opener[0] if opener else ""
    return ["\n".join(one) for one in commands]


def _is_self_reclone(command: str, repo_url: str) -> bool:
    """True when *command* clones the task's OWN repo (any URL form).

    Deliberately narrow on two axes so legitimate commands pass:
      * the clone verb must be in COMMAND position (start / after a shell
        separator), not inside a quoted argument — see ``_CLONE_CMD_RE``; and
      * the scan stops at the first free-text argument (``--body``/``-m``/…), so a
        PR/commit body that merely QUOTES "gh repo clone" is not treated as a
        clone; and
      * a clone of a DIFFERENT repo (dependency, fixture, example) is allowed —
        only a re-clone of the TASK repo threatens the workspace invariant."""
    if not command or not repo_url:
        return False
    # Check each shell segment on its own. A free-text argument only swallows the
    # REST OF ITS OWN segment, so `git commit -m wip && gh repo clone <own repo>`
    # must still be caught: the `-m` belongs to the commit, not to the clone.
    #
    # Within a segment, find the clone verb FIRST and only then ask whether it
    # sits inside free text. Truncating at the first free-text flag *before*
    # searching is what let `git clone -b main <own repo>` through: `-b` is both
    # gh's `--body` and git clone's `--branch`, so the cut landed ahead of the
    # very verb it was meant to find.
    variants = _repo_slug_variants(repo_url)
    if not variants:
        return False
    # Join backslash-continuations first: ``git clone \`` + newline + url is ONE
    # command, and leaving the break in place separated the verb from the repo so
    # the slug was never found in the verb's segment — a wrapped self re-clone
    # walked straight through.
    normalized = _LINE_CONTINUATION_RE.sub(" ", command)
    # A line break that ends a command separates like ``;``: the ``-b`` of a
    # ``git checkout -b`` on the line above does not make a clone prose.
    normalized = ";".join(_command_lines(normalized))
    for segment in _SHELL_SEPARATOR_RE.split(normalized):
        clone = _CLONE_CMD_RE.search(segment)
        if clone is None:
            continue
        free_text = _FREE_TEXT_ARG_RE.search(segment)
        if free_text is not None and free_text.start() < clone.start():
            # The verb appears inside a --body/-m/--title value: prose, not a run.
            continue
        # The repo of a real clone always follows its verb. Normalize the URL
        # punctuation to the bare slug space so `.../owner/repo.git` and
        # `git@github.com:owner/repo` both reduce to text carrying `owner/repo`.
        haystack = segment[clone.start() :].lower().replace("git@github.com:", "github.com/")
        # The slug has to stand alone: `owner/repo-docs` and `bigowner/repo`
        # are other repositories.
        if any(re.search(rf"(?<![\w.-]){re.escape(v)}(?![\w.-])", haystack) for v in variants):
            return True
    return False


# What the screening of tool output puts in place of what it hides from the
# model: ``[REDACTED-<LABEL>]`` from the scanner, and the two fail-closed texts.
_REDACTION_MARKER_RE = re.compile(
    r"\[REDACTED-(?:" + "|".join(re.escape(label) for label, _ in _PATTERNS) + r")\]"
    r"|\[Output redacted: [^\]\n]*\]"
)

# How much of a file is read to see which markers it holds already. The
# screening looks at the first 5 MB of an output as well.
_MARKER_FILE_LIMIT = 5_000_000


def _introduced_marker(tool_name: Any, tool_input: dict, cwd: Any) -> str | None:
    """Return a redaction marker that a Write or an Edit would add to a file.

    The model is shown a marker where a file holds a value that the screening
    hides. Written back, the marker would take the place of that value. A marker
    that the file holds already (a test of the scanner, its documentation) may
    stay: only one that the call adds is returned. A file that cannot be read
    counts as empty.
    """
    if tool_name == "Write":
        new = tool_input.get("content")
    elif tool_name == "Edit":
        new = tool_input.get("new_string")
    else:
        return None
    if not isinstance(new, str):
        return None
    markers = _REDACTION_MARKER_RE.findall(new)
    if not markers:
        return None
    old = tool_input.get("old_string")
    if tool_name == "Write":
        old = ""
        path = os.path.join(str(cwd or ""), str(tool_input.get("file_path") or ""))
        # A regular file only: a pipe or a device would not return.
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    old = fh.read(_MARKER_FILE_LIMIT)
            except OSError as exc:
                log("WARN", f"redaction-marker guard cannot read {path}: {type(exc).__name__}")
    if not isinstance(old, str):
        old = ""
    # Counted per marker text, not aligned line by line: a call that drops one
    # marker the file holds and adds one for a hidden value passes. Comparing
    # with the screened text of the file, line by line, would close that.
    return next((m for m in markers if new.count(m) > old.count(m)), None)


def _redaction_marker_denial(
    tool_name: Any, tool_input: dict, cwd: Any, trajectory: _TrajectoryWriter | None
) -> dict | None:
    """Return the DENY for a Write or an Edit that would add a redaction marker to a file."""
    marker = _introduced_marker(tool_name, tool_input, cwd)
    if marker is None:
        return None
    path = _truncate(str(tool_input.get("file_path") or ""), 160)
    log("POLICY", f"DENIED {tool_name} of {path}: it would write the redaction marker {marker}")
    if trajectory:
        trajectory.write_policy_decision(tool_name, False, "redaction_marker_blocked", 0)
    return _deny_response(
        f"This {tool_name} would write the redaction marker '{marker}' into the file. "
        "The marker is not content of the file: in the output you were shown it "
        "stands for a value that is hidden from you, and the real value is still "
        "in the file on disk. Do not write the marker and do not guess the value. "
        "Leave that line as it is and change the file around it, with an Edit "
        "whose old_string and new_string do not include the line."
    )


async def pre_tool_use_hook(
    hook_input: Any,
    tool_use_id: str | None,
    _hook_context: Any,
    *,
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str | None = None,
    user_id: str | None = None,
    progress: Any = None,
    task_state_module: Any = None,
    repo_url: str | None = None,
) -> dict:
    """PreToolUse hook: three-outcome Cedar policy enforcement.

    Returns a dict with hookSpecificOutput containing:
    - permissionDecision: "allow" or "deny"
    - permissionDecisionReason: explanation string

    The REQUIRE_APPROVAL path pauses here: the trusted service creates a pending
    approval row and atomically transitions the task to AWAITING_APPROVAL, then
    the worker polls for a
    human decision with 2s→5s backoff, then returns allow / deny based on
    the decision. On TIMED_OUT a ConditionCheckFailed from the best-effort
    status write triggers a re-read — if the user's decision landed between
    our poll and write, we honor it instead of falsely denying.

    ``task_id`` / ``user_id`` / ``progress`` are optional to preserve the
    older test call shape. Without them the REQUIRE_APPROVAL path falls
    through to fail-closed DENY (state-write infrastructure is missing), so
    legacy callers still see coherent behaviour. ``task_state_module`` is a
    test seam for injecting a mocked ``task_state`` namespace; production
    callers rely on the default.
    """
    ts_module = task_state_module if task_state_module is not None else task_state

    if not isinstance(hook_input, dict):
        log("WARN", "PreToolUse hook received non-dict input — denying")
        return _deny_response("invalid hook input")

    tool_name = hook_input.get("tool_name", "unknown")
    tool_input = hook_input.get("tool_input", {})
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except (json.JSONDecodeError, TypeError):
            log("WARN", f"PreToolUse hook failed to parse tool_input — denying {tool_name}")
            return _deny_response("unparseable tool input")

    # Fail-closed contract: every downstream consumer (Cedar evaluation,
    # the approval-row builder, the SHA-256 cache key) assumes ``tool_input``
    # is a JSON object. A bare list/scalar (e.g. ``"[1,2]"`` or ``"\"foo\""``
    # decoded by the branch above, or a non-dict passed in directly) would
    # otherwise raise an AttributeError deep in the engine and rely on the
    # SDK-boundary wrapper to catch it. Make the rejection explicit here so
    # the deny reason names the malformed input rather than a stack trace.
    if not isinstance(tool_input, dict):
        log("WARN", f"PreToolUse hook received non-dict tool_input — denying {tool_name}")
        return _deny_response("tool input is not an object")

    # Block a Bash re-clone of the task's OWN repo before Cedar eval. The repo is
    # already checked out at the agent's cwd; a self-reclone into a sibling dir
    # strands the work off the platform-tracked branch (the delivery gate then
    # fails it as ``deliverable=lost``). Deny it here with a redirect so the agent
    # works in place instead. Scoped to the task repo only (dependency/fixture
    # clones pass). Fires even under bypassPermissions.
    if tool_name == "Bash" and repo_url:
        command = tool_input.get("command", "")
        if isinstance(command, str) and _is_self_reclone(command, repo_url):
            reason = (
                f"The repository '{repo_url}' is ALREADY cloned and checked out in "
                "your working directory — do NOT clone it again or work in another "
                "directory. Your commits must land in the current working directory "
                "so the platform can open the pull request on the correct branch. "
                "Remove the clone command and work in place (edit, commit, and push "
                "from where you already are)."
            )
            log("POLICY", f"DENIED self-reclone of {repo_url}: {_screened(command)[:160]}")
            if trajectory:
                trajectory.write_policy_decision("Bash", False, "self_reclone_blocked", 0)
            return _deny_response(reason)

    # A redaction marker that a Write or an Edit would add to a file takes the
    # place of the value that the screening hid from the model, in the repository
    # and in the pull request. Refused before the policy is asked, like the
    # re-clone above, and under bypassPermissions as well.
    denial = _redaction_marker_denial(tool_name, tool_input, hook_input.get("cwd"), trajectory)
    if denial:
        return denial

    decision = engine.evaluate_tool_use(tool_name, tool_input)

    # Telemetry: ALLOW "permitted" is the quiet happy path; everything else
    # is worth a trajectory event. Treat REQUIRE_APPROVAL as "not allowed"
    # for the legacy ``allowed=False`` field so the trajectory schema stays
    # coherent — the specific outcome is already on the ``reason`` string.
    if trajectory and decision.reason != "permitted":
        trajectory.write_policy_decision(
            tool_name, decision.allowed, decision.reason, decision.duration_ms
        )

    if decision.outcome == Outcome.ALLOW:
        return _allow_response(decision.reason or "permitted")

    if decision.outcome == Outcome.DENY:
        # When the DENY arrived from the recent-decision cache, emit a
        # ``policy_decision`` milestone with
        # ``decision_source="recent_decision_cache"`` to TaskEventsTable so
        # cache-driven denies are visible in the live stream + retained audit
        # record. No new approval row is written and the gate counter is NOT
        # bumped — the original gate already accounted for the decision.
        if decision.cache_hit_metadata is not None:
            _try_progress(
                progress,
                "write_policy_decision_cached",
                **decision.cache_hit_metadata,
            )
        # A fail-closed deny means the Cedar engine errored or was unavailable —
        # an ENVIRONMENTAL fault (misconfiguration), NOT an intentional hard-deny.
        # Emit a ``policy_fail_closed`` blocker event so it renders distinctly and
        # carries a remediation hint. We branch on the structured
        # ``decision.fail_closed`` flag, never a reason-string prefix. Intentional
        # hard-denies / cache-denies (fail_closed=False) never emit. Emitted
        # strictly BEFORE the deny; the deny itself is unchanged, so this adds
        # observability without altering the outcome.
        if getattr(decision, "fail_closed", False):
            _record_blocker_reason("policy_fail_closed", decision.reason)
            _try_progress(
                progress,
                "write_agent_blocked",
                kind="policy_fail_closed",
                detail=decision.reason,
                remediation_hint=(
                    "The Cedar policy engine errored or was unavailable "
                    "(fail-closed). Check the agent policy-engine logs and the "
                    "policy bundle; this is a misconfiguration, not an "
                    "intentional deny."
                ),
                retryable=False,
            )
        log("POLICY", f"DENIED: {tool_name} — {decision.reason}")
        return _deny_response(decision.reason)

    # -- REQUIRE_APPROVAL path ----------------------------------------------
    return await _handle_require_approval(
        decision=decision,
        tool_name=tool_name,
        tool_input=tool_input,
        engine=engine,
        task_id=task_id,
        user_id=user_id,
        progress=progress,
        ts=ts_module,
        tool_use_id=tool_use_id,
    )


async def _handle_require_approval(  # noqa: C901 -- 24, down from 35 when the ceiling of 15 was set; must not grow
    *,
    decision: Any,
    tool_name: str,
    tool_input: dict,
    engine: PolicyEngine,
    task_id: str | None,
    user_id: str | None,
    progress: Any,
    ts: Any,
    tool_use_id: str | None = None,
) -> dict:
    """REQUIRE_APPROVAL branch of ``pre_tool_use_hook``.

    Split out of the main hook for readability — the control flow is long
    enough that inlining it obscures the top-level three-way branch.
    """
    # Missing task infrastructure → fail closed with a clear reason. Every
    # exceptional branch here ends in DENY.
    if not task_id:
        log("WARN", "REQUIRE_APPROVAL hit without task_id — fail-closed deny")
        return _deny_response("approval system unavailable (no task_id)")

    request_id = _generate_ulid()

    # Step 1 — per-task cap. Cap exceeded fails closed, and the
    # cap_exceeded milestone carries the configured cap so dashboards
    # reflect the blueprint override.
    if engine.approval_gate_count >= engine.approval_gate_cap:
        _try_progress(
            progress,
            "write_approval_cap_exceeded",
            request_id=request_id,
            count=engine.approval_gate_count,
            cap=engine.approval_gate_cap,
        )
        return _deny_response(f"approval-gate cap exceeded ({engine.approval_gate_cap}/task)")

    # Step 2 — per-minute rate limit. ``approvals_in_last_minute`` prunes
    # on read so the comparison is against the current sliding window.
    rate = engine.approvals_in_last_minute
    if rate >= APPROVAL_RATE_LIMIT:
        _try_progress(
            progress,
            "write_approval_rate_limit_exceeded",
            request_id=request_id,
            rate=rate,
            limit=APPROVAL_RATE_LIMIT,
        )
        return _deny_response(f"approval-gate rate limit exceeded ({APPROVAL_RATE_LIMIT}/min)")

    # Step 3 — effective timeout with floor/ceiling math. Emit
    # ``approval_timeout_capped`` when the caller's ask is clipped so the
    # user can see why.
    remaining_lifetime = _remaining_maxlifetime_s()
    effective_timeout, clip_reason, requested_timeout = _compute_effective_timeout(
        decision_timeout_s=decision.timeout_s,
        task_default_timeout_s=engine.task_default_timeout_s,
        remaining_lifetime_s=remaining_lifetime,
    )
    if clip_reason is not None:
        _try_progress(
            progress,
            "write_approval_timeout_capped",
            request_id=request_id,
            requested_timeout_s=requested_timeout,
            effective_timeout_s=effective_timeout,
            reason=clip_reason,
            matching_rule_ids=(
                list(decision.matching_rule_ids) if clip_reason == "rule_annotation" else None
            ),
        )
    # Once per task, surface the "gates will have small windows from here
    # on" ceiling-shrinking milestone when the remaining lifetime is
    # approaching the 2x-task-default threshold.
    if (
        remaining_lifetime is not None
        and remaining_lifetime - CLEANUP_MARGIN_120S < 2 * engine.task_default_timeout_s
        and engine.mark_ceiling_shrinking_emitted()
    ):
        _try_progress(
            progress,
            "write_approval_ceiling_shrinking",
            request_id=request_id,
            max_lifetime_remaining_s=remaining_lifetime,
            cleanup_margin_s=CLEANUP_MARGIN_120S,
            task_default_timeout_s=engine.task_default_timeout_s,
        )

    # Step 4 — insufficient lifetime remaining for a valid approval.
    # Below the floor we DENY immediately without writing the approval
    # row; no point waking the user to a guaranteed-dead gate.
    if remaining_lifetime is not None and remaining_lifetime - CLEANUP_MARGIN_120S < FLOOR_30S:
        return _deny_response(
            f"insufficient maxLifetime remaining ({remaining_lifetime}s) for approval"
        )

    # Step 5 — build the approval row.
    tool_input_sha256 = _sha256_tool_input(tool_input)
    row = {
        "task_id": task_id,
        "request_id": request_id,
        "tool_name": tool_name,
        "tool_input_preview": _tool_input_preview(tool_input),
        "tool_input_sha256": tool_input_sha256,
        "reason": decision.reason,
        "severity": decision.severity or "medium",
        "matching_rule_ids": list(decision.matching_rule_ids),
        "status": "PENDING",
        "created_at": _iso_now(),
        "timeout_s": effective_timeout,
        "user_id": user_id or "",
        "repo": engine.repo,
    }
    row["deadline_epoch"] = approval_deadline_epoch(row["created_at"], effective_timeout)
    # DynamoDB expiry for the row and its tool-input preview: the retention main
    # always had (deadline plus the cleanup margin), on every backend.
    row["ttl"] = row["deadline_epoch"] + CLEANUP_MARGIN_120S
    deadline = _ApprovalDeadline.from_recorded(row["created_at"], effective_timeout)

    # Step 6 — bump counters BEFORE the write so cap/rate checks on
    # subsequent gates reflect the attempt even if the DDB write itself
    # fails. The session counter survives within the task; the failure
    # path below emits ``approval_write_failed`` so the lost row is
    # visible.
    engine.increment_approval_gate_count()
    engine.record_approval_gate_timestamp()

    # Best-effort atomic increment of the persisted ``approval_gate_count``
    # on TaskTable. The session counter enforces the cap within THIS
    # container; the persisted counter exists so a restarted container
    # re-seeds from a non-zero value instead of re-exposing the user to
    # another ``approval_gate_cap`` worth of gates. Failure is best-effort —
    # the counter is a safety bound, not a correctness bound — so we keep
    # going on error and accept the (bounded) restart-retry amplification.
    await asyncio.to_thread(ts.increment_approval_gate_count_in_ddb, task_id)

    # Step 7 — cross-table atomic transition.
    try:
        await asyncio.to_thread(ts.transact_write_approval_request, task_id, request_id, row)
    except ts.ApprovalWriteError as exc:
        _try_progress(
            progress,
            "write_approval_write_failed",
            request_id=request_id,
            error=f"cancelled: {exc.cancellation_reasons}",
        )
        return _deny_response("approval system unavailable (write cancelled)")
    except ts.ApprovalTablesUnavailable as exc:
        _try_progress(
            progress,
            "write_approval_write_failed",
            request_id=request_id,
            error=f"tables unavailable: {exc}",
        )
        return _deny_response("approval system unavailable (tables unconfigured)")
    except Exception as exc:
        log(
            "ERROR",
            f"approval request write failed: {type(exc).__name__}: {exc}",
        )
        _try_progress(
            progress,
            "write_approval_write_failed",
            request_id=request_id,
            error=f"{type(exc).__name__}: {exc}",
        )
        return _deny_response("approval system unavailable")

    # Step 8 — ``approval_requested`` milestone so the user's stream
    # shows the gate immediately.
    _try_progress(
        progress,
        "write_approval_requested",
        request_id=request_id,
        tool_name=tool_name,
        input_preview=row["tool_input_preview"],
        reason=decision.reason,
        severity=row["severity"],
        timeout_s=effective_timeout,
        matching_rule_ids=list(decision.matching_rule_ids),
    )

    # Step 9 — register the exact persisted gate and its ORIGINAL deadline.
    # The SDK wrapper already tracks this tool; direct/legacy callers without a
    # lifecycle context keep their existing approval behavior.
    lifecycle = get_context(task_id)
    park = (
        lifecycle.park_approval(
            request_id,
            tool_use_id,
            deadline,
            record=ApprovalRecord(
                user_id=row["user_id"],
                repo=row["repo"],
                created_at=row["created_at"],
                timeout_s=effective_timeout,
            ),
        )
        if lifecycle
        else None
    )
    try:
        outcome = await _poll_for_decision(
            task_id=task_id,
            request_id=request_id,
            deadline=deadline,
            progress=progress,
            ts=ts,
        )
    finally:
        if lifecycle and park:
            # Clear the safe point before ANY approval/task-state mutation or
            # hook return. A concurrent suspend owns the barrier until resume.
            await lifecycle.leave_approval(park)

    # Step 10 — VM-throttle + late-approval race. Best-effort flip to
    # TIMED_OUT; if ConditionCheckFailed, the user beat us — read and honor.
    if outcome["status"] == "TIMED_OUT":
        try:
            wrote = await asyncio.to_thread(
                ts.best_effort_update_approval_status,
                task_id,
                request_id,
                "TIMED_OUT",
                reason=outcome.get("reason"),
            )
        except Exception as exc:
            log("WARN", f"approval TIMED_OUT write raised: {type(exc).__name__}: {exc}")
            # Fall into the re-read path. A transient DDB write error MUST
            # NOT bypass the late-approval check — the user's APPROVED
            # decision may already be on the row, and skipping the re-read
            # would falsely deny their tool call. Setting ``wrote = False``
            # triggers the ConsistentRead below; if the row still says
            # PENDING the re-read is a no-op and we keep the TIMED_OUT
            # outcome. If it says APPROVED/DENIED, ``_reconcile_late_decision``
            # honors the user's choice.
            wrote = False
        if not wrote:
            # User's decision beat our timer; re-read with ConsistentRead.
            try:
                row_reread = await asyncio.to_thread(
                    ts.get_approval_row,
                    task_id,
                    request_id,
                    consistent_read=True,
                )
            except Exception as exc:
                log("WARN", f"approval re-read raised: {type(exc).__name__}: {exc}")
                row_reread = None
            outcome = _reconcile_late_decision(outcome, row_reread, progress, request_id)

    # Step 11 — resume transition (RUNNING). The ``awaiting_approval_request_id``
    # condition prevents resuming a cancelled task or racing with another
    # approval.
    try:
        await asyncio.to_thread(ts.transact_resume_from_approval, task_id, request_id)
    except ts.ApprovalResumeError as exc:
        _try_progress(
            progress,
            "write_approval_resume_failed",
            request_id=request_id,
            error=f"cancelled: {exc.cancellation_reasons}",
        )
        return _deny_response("task no longer awaiting approval")
    except Exception as exc:
        log("WARN", f"approval resume raised: {type(exc).__name__}: {exc}")
        _try_progress(
            progress,
            "write_approval_resume_failed",
            request_id=request_id,
            error=f"{type(exc).__name__}: {exc}",
        )
        return _deny_response("approval resume failed")

    # Step 12 — terminal branches.
    status = outcome.get("status")
    if status == "APPROVED":
        scope = outcome.get("scope") or "this_call"
        for grant in _allowlist_scopes(scope, tool_name):
            try:
                engine.allowlist.add(grant)
            except ValueError as exc:
                # Malformed scope from the API — log loudly but still
                # allow this one call (the user did approve it).
                log("WARN", f"invalid approved scope {scope!r}: {exc}")
        _try_progress(
            progress,
            "write_approval_granted",
            request_id=request_id,
            scope=scope,
            decided_at=outcome.get("decided_at"),
            # Propagate the row's ``created_at`` so the
            # ApprovalMetricsPublisher can compute decision latency.
            created_at=row.get("created_at"),
        )
        return _allow_response(f"User approved ({scope})")

    # DENIED or TIMED_OUT — cache + queue injection.
    cache_decision = "DENIED" if status == "DENIED" else "TIMED_OUT"
    # Thread the user's ``decided_at`` into the cache entry so subsequent
    # cache-hit events surface the ORIGINAL decision timestamp, not the
    # wall-clock time the cache was populated (which is ~the same but
    # technically wrong). ``decided_at`` for TIMED_OUT is the agent-side
    # clock moment the timeout fired; for DENIED it's the user's deny
    # timestamp from the Lambda audit row.
    engine.recent_decisions.record(
        tool_name,
        tool_input_sha256,
        decision=cache_decision,
        # A timed-out row carries ``reason: None``; never let it reach a message.
        reason=outcome.get("reason") or "",
        original_decision_ts=outcome.get("decided_at"),
    )

    # Rule-level cache: on DENIED, record an entry per matching_rule_id
    # so semantic retries — same rule, different input — get fast-denied
    # without a new approval round-trip. Only populate on DENIED because
    # TIMED_OUT is ambiguous (user was away, not actively refusing);
    # TIMED_OUT cache entries stay input-hash-scoped.
    if status == "DENIED":
        for rule_id in decision.matching_rule_ids:
            engine.recent_decisions.record_rule_decision(
                tool_name,
                rule_id,
                decision="DENIED",
                reason=outcome.get("reason", ""),
                original_decision_ts=outcome.get("decided_at"),
            )

    if status == "DENIED":
        engine.queue_denial_injection(
            request_id=request_id,
            reason=outcome.get("reason", ""),
            decided_at=outcome.get("decided_at"),
        )
        _try_progress(
            progress,
            "write_approval_denied",
            request_id=request_id,
            reason=outcome.get("reason", ""),
            decided_at=outcome.get("decided_at"),
            # Propagate the row's ``created_at`` so the
            # ApprovalMetricsPublisher can compute decision latency.
            created_at=row.get("created_at"),
        )
    else:
        _try_progress(
            progress,
            "write_approval_timed_out",
            request_id=request_id,
            timeout_s=effective_timeout,
            # Propagate the row's ``created_at`` + ``matching_rule_ids`` +
            # the post-clip effective timeout so the
            # ApprovalMetricsPublisher can emit the decision latency + the
            # ``ApprovalTimeoutBreakdown`` histogram with a normalized
            # ``rule_id`` dimension.
            created_at=row.get("created_at"),
            effective_timeout_s=effective_timeout,
            matching_rule_ids=list(decision.matching_rule_ids),
        )

    # Guaranteed surface: truncated reason even when denial injection is
    # pre-empted by a concurrent cancel. Wrap the user's reason in
    # authoritative stop-language — end-to-end testing showed the agent
    # treating a bare "User denied" as "try a different approach" and
    # burning through max_turns retrying the same rule with trivial
    # variations. The explicit AUTHORITATIVE-prefixed wording, combined
    # with the rule-level recent-deny cache, makes retries fail fast with
    # clear feedback.
    raw_reason = outcome.get("reason") or f"User {status.lower() if status else 'denied'}"
    if status == "DENIED":
        rule_hint = (
            f" (matching rule{'s' if len(decision.matching_rule_ids) != 1 else ''}: "
            f"{', '.join(decision.matching_rule_ids)})"
            if decision.matching_rule_ids
            else ""
        )
        prefix = "AUTHORITATIVE DENY from human reviewer: "
        stop_language = (
            ". Do NOT retry this class of action with trivial variations; "
            "the same rule will fast-deny subsequent attempts. Find an "
            "alternative task strategy or report back to the user explaining "
            "why progress is blocked."
        )
        # ``_deny_response`` cuts the text at PERMISSION_REASON_MAX, and that cut
        # must not fall in the stop-language: the room beside the fixed text
        # goes to the rule names first, and the reviewer's reason is shortened
        # to the rest. ANSI is stripped before the cut: a cut inside an escape
        # sequence leaves a fragment that the strip in ``_deny_response`` does
        # not recognise.
        room = PERMISSION_REASON_MAX - len(prefix) - len(stop_language)
        rule_hint = _truncate(rule_hint, room)
        reason = _truncate(_strip_ansi(raw_reason), room - len(rule_hint))
        reason_text = prefix + reason + rule_hint + stop_language
    else:
        reason_text = raw_reason
    return _deny_response(reason_text)


def _allowlist_scopes(scope: str, tool_name: str) -> list[str]:
    """Return what an approval given with *scope* adds to the allowlist.

    ``tool_type_session`` and ``tool_group_session`` name no tool: they stand
    for the tool of the call that was approved and for the groups that tool is
    in. A tool in no group gets nothing beyond the call itself.
    """
    from policy import TOOL_GROUPS

    if scope == "this_call":
        return []
    if scope == "tool_type_session":
        return [f"tool_type:{tool_name}"]
    if scope == "tool_group_session":
        groups = [group for group, tools in TOOL_GROUPS.items() if tool_name in tools]
        if not groups:
            log("WARN", f"tool_group_session approved for {tool_name}, which is in no tool group")
        return [f"tool_group:{group}" for group in groups]
    return [scope]


def _reconcile_late_decision(
    outcome: dict,
    row: dict | None,
    progress: Any,
    request_id: str,
) -> dict:
    """Rebuild outcome from a re-read row after a TIMED_OUT race.

    - ``row["status"] == "APPROVED"`` → rebuild as APPROVED (allow flow).
    - ``row["status"] == "DENIED"`` → rebuild as DENIED (deny flow).
    - ``row["status"] == "CANCELLED"`` → close the wait without resuming the task.
    - Anything else (row gone, still PENDING) → fall through with the
      original TIMED_OUT (the fail-closed branch).

    Emits ``approval_late_win`` for APPROVED or DENIED races so operator
    telemetry can count them.
    """
    if row is None:
        return outcome
    status = row.get("status")
    if status == "APPROVED":
        _try_progress(
            progress,
            "write_approval_late_win",
            request_id=request_id,
            outcome="APPROVED",
            reason="user decision landed during TIMED_OUT write",
        )
        return {
            "status": "APPROVED",
            "scope": row.get("scope"),
            "decided_at": row.get("decided_at"),
            "decided_by": row.get("user_id"),
        }
    if status == "CANCELLED":
        return {"status": "CANCELLED", "reason": row.get("cancellation_reason")}
    if status == "DENIED":
        _try_progress(
            progress,
            "write_approval_late_win",
            request_id=request_id,
            outcome="DENIED",
            reason="user decision landed during TIMED_OUT write",
        )
        return {
            "status": "DENIED",
            "reason": row.get("deny_reason") or "denied",
            "decided_at": row.get("decided_at"),
        }
    return outcome


async def _poll_for_decision(
    *,
    task_id: str,
    request_id: str,
    deadline: _ApprovalDeadline,
    progress: Any,
    ts: Any,
) -> dict:
    """Poll the approval row until terminal or timeout.

    Cadence: ``POLL_FAST_INTERVAL_S`` for ``POLL_FAST_DURATION_S``, then
    ``POLL_SLOW_INTERVAL_S``. Each iteration uses ConsistentRead; after
    ``POLL_DEGRADED_FAILS`` consecutive failures we emit
    ``approval_poll_degraded``; at ``POLL_MAX_CONSECUTIVE_FAILS`` we
    fall through as TIMED_OUT with a distinct reason.

    Uses the deadline captured with the original approval row, including time
    spent writing/notifying or suspended. Returns an outcome dict mirroring
    the approval row's terminal fields.
    """
    start = time.monotonic()
    consecutive_fails = 0
    degraded_emitted = False

    lifecycle = get_context(task_id)
    while True:
        async with lifecycle.approval_poll() if lifecycle else nullcontext():
            if deadline.remaining_s() <= 0:
                return {"status": "TIMED_OUT", "reason": None}

            try:
                row = await asyncio.to_thread(
                    ts.get_approval_row,
                    task_id,
                    request_id,
                    consistent_read=True,
                )
                consecutive_fails = 0
            except Exception as exc:
                consecutive_fails += 1
                log(
                    "WARN",
                    f"approval poll get_item raised ({consecutive_fails}/"
                    f"{POLL_MAX_CONSECUTIVE_FAILS}): {type(exc).__name__}: {exc}",
                )
                if consecutive_fails >= POLL_DEGRADED_FAILS and not degraded_emitted:
                    if progress is not None:
                        _try_progress(
                            progress,
                            "write_approval_poll_degraded",
                            request_id=request_id,
                            consecutive_failures=consecutive_fails,
                        )
                    degraded_emitted = True
                if consecutive_fails >= POLL_MAX_CONSECUTIVE_FAILS:
                    return {
                        "status": "TIMED_OUT",
                        "reason": f"poll failed {consecutive_fails} consecutive times",
                    }
                row = None  # force sleep below

            if row is not None:
                status = row.get("status")
                if status == "APPROVED":
                    return {
                        "status": "APPROVED",
                        "scope": row.get("scope"),
                        "decided_at": row.get("decided_at"),
                        "decided_by": row.get("user_id"),
                    }
                if status == "DENIED":
                    return {
                        "status": "DENIED",
                        "reason": row.get("deny_reason") or "denied",
                        "decided_at": row.get("decided_at"),
                    }
                if status == "CANCELLED":
                    return {
                        "status": "CANCELLED",
                        "reason": row.get("cancellation_reason"),
                    }

        # Compute sleep interval based on elapsed since poll started.
        elapsed = time.monotonic() - start
        interval = POLL_FAST_INTERVAL_S if elapsed < POLL_FAST_DURATION_S else POLL_SLOW_INTERVAL_S
        # Clamp sleep against remaining deadline so we don't oversleep.
        sleep_for = min(interval, deadline.remaining_s())
        if sleep_for <= 0:
            return {"status": "TIMED_OUT", "reason": None}
        await asyncio.sleep(sleep_for)


def _compute_effective_timeout(
    *,
    decision_timeout_s: int | None,
    task_default_timeout_s: int,
    remaining_lifetime_s: int | None,
) -> tuple[int, str | None, int]:
    """Compute the effective approval timeout.

    ``min(rule-annotation timeout, task default, remaining lifetime -
    cleanup margin)``, floored at FLOOR_30S. The engine's
    ``_merge_annotations`` already applies ``min(rule_annotation,
    task_default)`` — decision.timeout_s reaches us pre-clipped against
    those two. Here we apply the remaining-lifetime ceiling and report
    whichever source pulled the effective timeout below the task
    default, so the user sees "your gate was clipped because ..." rather
    than silent clipping.

    Returns ``(effective, clip_reason, requested)``:
    - ``requested`` — the user-visible "would have liked" value (task
      default for display purposes; the rule's ask was already merged).
    - ``clip_reason`` — ``"rule_annotation"`` when the rule's annotation
      pulled the decision below the task default; ``"maxLifetime_ceiling"``
      when the remaining-lifetime ceiling is the tightest bound; ``None``
      when nothing clipped.
    """
    requested = task_default_timeout_s
    decision_value = (
        decision_timeout_s if decision_timeout_s is not None else task_default_timeout_s
    )

    # Start with the decision value (already clipped by rule vs task default
    # in the engine) and apply the remaining-lifetime ceiling here.
    effective = decision_value
    clip_reason: str | None = None

    # Rule annotation clipped below task default — surface that first so a
    # later lifetime-ceiling clip can override with a more specific reason.
    if decision_value < requested:
        clip_reason = "rule_annotation"

    if remaining_lifetime_s is not None:
        ceiling = remaining_lifetime_s - CLEANUP_MARGIN_120S
        if ceiling < effective:
            effective = ceiling
            clip_reason = "maxLifetime_ceiling"

    # Floor: if clipping pushed below the hard floor, the effective value
    # is floored (so the user can still respond) but the clip reason is
    # still the tightest-binding input. Floor is a safety net, not a user
    # concept.
    if effective < FLOOR_30S:
        effective = FLOOR_30S

    return effective, clip_reason, requested


def _remaining_maxlifetime_s() -> int | None:
    """Compute remaining AgentCore maxLifetime seconds.

    Reads ``AGENTCORE_MAX_LIFETIME_S`` (default 8h) and ``TASK_STARTED_AT``
    (ISO 8601, optional). Returns ``None`` if the start timestamp is
    unavailable; the hook treats this as "unknown, don't clip" so the
    gate still fires with the task default (fail-open on the optional
    signal rather than pre-DENY when unknown). These are wired from the
    task launch path when available; otherwise they are optional hints.
    """
    try:
        max_lifetime = int(os.environ.get("AGENTCORE_MAX_LIFETIME_S", "28800"))
    except ValueError:
        max_lifetime = 28800
    started_at = os.environ.get("TASK_STARTED_AT")
    if not started_at:
        return None
    try:
        # Support both ISO 8601 (YYYY-MM-DDTHH:MM:SSZ) and raw epoch seconds.
        if started_at.isdigit():
            started_epoch = int(started_at)
        else:
            # The orchestrator sends Date.toISOString(), which has milliseconds
            # ("2026-11-16T10:00:00.123Z"). A stamp without a zone is UTC too:
            # .timestamp() would otherwise read it in the container's local
            # TZ, skewing remaining-lifetime math by the UTC offset.
            started = datetime.fromisoformat(started_at)
            if started.tzinfo is None:
                started = started.replace(tzinfo=UTC)
            started_epoch = int(started.timestamp())
    except (ValueError, AttributeError):
        # nosemgrep: py-silent-success-masking -- start unknown: the gate gets no lifetime ceiling
        return None
    elapsed = int(time.time()) - started_epoch
    remaining = max_lifetime - elapsed
    return max(0, remaining)


def _iso_now() -> str:
    """ISO 8601 UTC timestamp in the ``YYYY-MM-DDTHH:MM:SSZ`` form."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# Per-method consecutive-failure counters for ``_try_progress``.
# Progress writes are best-effort, but a hard infrastructure failure
# (DDB throttle, IAM regression, missing table) would otherwise be
# masked as a stream of WARN lines with no escalation. After
# ``_TRY_PROGRESS_ESCALATE_AFTER`` consecutive failures of the same
# method the next failure is logged at ERROR via ``log_error_cw`` so
# it lands in APPLICATION_LOGS / TaskDashboard, and the counter
# resets so escalations don't spam. Per-method state because a
# single failing method shouldn't suppress visibility into other
# kinds of progress writes that might still be working.
_TRY_PROGRESS_ESCALATE_AFTER = 5
_try_progress_consecutive_failures: dict[str, int] = {}


def _try_progress(progress: Any, method_name: str, /, **kwargs: Any) -> None:
    """Call a progress-writer method, swallowing errors.

    Progress is best-effort observability; a throttled DDB write must not
    break the approval flow, and a milestone that cannot be written must not
    hold back the nudge, the denial or the advisory that it reports.
    ``progress`` may be ``None`` (a hook that runs without a writer): it has
    no such method, so the event is skipped with a DEBUG line.

    Escalation: repeated consecutive failures of the same ``method_name``
    are tracked per-process and escalated to ERROR after
    ``_TRY_PROGRESS_ESCALATE_AFTER`` so a silent live-stream outage
    becomes operator-visible.
    """
    # Only skip when ``_disabled`` is explicitly True on a real ProgressWriter.
    # ``getattr(..., False)`` is not safe — ``MagicMock`` returns an auto-mock
    # attribute for any access, which evaluates truthy.
    if getattr(progress, "_disabled", False) is True:
        log("WARN", f"progress {method_name!r} skipped: circuit breaker open")
        return
    method = getattr(progress, method_name, None)
    if method is None:
        log("DEBUG", f"progress missing {method_name!r}; skipping")
        return
    try:
        method(**kwargs)
    except Exception as exc:  # defensive, writers never raise
        prev = _try_progress_consecutive_failures.get(method_name, 0)
        count = prev + 1
        if count >= _TRY_PROGRESS_ESCALATE_AFTER:
            log_error_cw(
                f"progress {method_name!r} has failed {count} consecutive times; "
                f"latest: {type(exc).__name__}: {exc}",
            )
            _try_progress_consecutive_failures[method_name] = 0  # reset to avoid spam
        else:
            log("WARN", f"progress {method_name!r} raised: {type(exc).__name__}: {exc}")
            _try_progress_consecutive_failures[method_name] = count
        return
    # Success path — reset the consecutive-failure count.
    if _try_progress_consecutive_failures.get(method_name):
        _try_progress_consecutive_failures[method_name] = 0


async def post_tool_use_hook(
    hook_input: Any,
    _tool_use_id: str | None,
    _hook_context: Any,
    *,
    trajectory: _TrajectoryWriter | None = None,
    stuck_guard: StuckGuard | None = None,
    progress: Any = None,
) -> dict:
    """PostToolUse hook: screen tool output for secrets/PII.

    Returns a dict with hookSpecificOutput.  When sensitive content is
    detected the response includes ``updatedToolOutput``: the tool response
    in its own shape, with the secrets in its strings redacted (steered
    enforcement — content is sanitized, not blocked). A response in which
    the scanner fails on a string is blanked as a whole (fail-closed, see
    ``_fail_closed_output``).

    ``progress`` is optional (preserves the older test call shape). When
    present, an egress-denial signature in the tool output emits an
    ``egress_denied`` blocker event — best-effort observability, never
    alters the screening decision.

    When a ``stuck_guard`` is supplied, every tool result is recorded, and
    its one-time advisory about a repeating failing command (a spin loop) is
    returned as ``additionalContext``. Best-effort; it never alters the
    screening outcome.
    """
    _PASS_THROUGH: dict = {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}

    if not isinstance(hook_input, dict):
        log("WARN", "PostToolUse hook received non-dict input — passing through")
        return _PASS_THROUGH

    tool_name = hook_input.get("tool_name", "unknown")

    if "tool_response" not in hook_input:
        log("WARN", f"PostToolUse hook: missing 'tool_response' key for {tool_name}")
        return _PASS_THROUGH

    tool_response = hook_input["tool_response"]
    output: dict = {"hookEventName": "PostToolUse"}

    steer = _observe_tool_result(
        tool_name,
        hook_input.get("tool_input"),
        tool_response,
        progress=progress,
        stuck_guard=stuck_guard,
        # A call that completed has not failed. Only a Bash command can hide
        # a failure behind its exit status (``yarn build | tail``).
        failed=None if tool_name == "Bash" else False,
    )
    if steer:
        output["additionalContext"] = steer

    findings: list[str] = []
    marker = "[Output redacted: screening error — fail-closed]"

    def _screen(text: str) -> str:
        try:
            result = scan_tool_output(text)
        except Exception as exc:
            finding = f"SCANNER_ERROR: {type(exc).__name__}"
            if finding not in findings:
                log("ERROR", f"Output scanner failed for {tool_name}: {type(exc).__name__}: {exc}")
                findings.append(finding)
            return marker
        findings.extend(found for found in result.findings if found not in findings)
        return result.redacted_content if result.has_sensitive_content else text

    started = time.monotonic()
    screened = _map_strings(tool_response, _screen)
    redacted = True
    if any(found.startswith("SCANNER_ERROR") for found in findings):
        # Fail closed: a response that could not be screened in full is blanked
        # in full. That the CLI takes the answer is known for an MCP tool and
        # for the tools that _SCHEMA_FIXED names; for any other tool no
        # redaction is claimed.
        screened = _fail_closed_output(tool_name, tool_response, marker)
        redacted = str(tool_name).startswith("mcp__") or str(tool_name) in _SCHEMA_FIXED
    if findings:
        if trajectory:
            trajectory.write_output_screening_decision(
                tool_name,
                findings,
                redacted=redacted,
                duration_ms=(time.monotonic() - started) * 1000,
            )
        outcome = "OUTPUT REDACTED" if redacted else "OUTPUT NOT SCREENED"
        log("POLICY", f"{outcome}: {tool_name} — {', '.join(findings)}")
        output["updatedToolOutput"] = screened

    return {"hookSpecificOutput": output}


async def post_tool_use_failure_hook(
    hook_input: Any,
    _tool_use_id: str | None,
    _hook_context: Any,
    *,
    stuck_guard: StuckGuard | None = None,
    progress: Any = None,
) -> dict:
    """PostToolUseFailure hook: show a failed tool call to the observers.

    The CLI fires this event, and no PostToolUse, for a tool call that fails —
    for Bash, a command that exits non-zero, unless the CLI reads that status
    as an answer (1 from ``grep`` without a match) — with the text of the
    failure under ``error``. A blocked host and a repeating failing command
    show up here. Returns the stuck guard's advisory as ``additionalContext``
    when there is one, else an empty answer.
    """
    if not isinstance(hook_input, dict):
        log("WARN", "PostToolUseFailure hook received non-dict input — ignoring")
        return {}

    steer = _observe_tool_result(
        hook_input.get("tool_name", "unknown"),
        hook_input.get("tool_input"),
        str(hook_input.get("error", "")),
        progress=progress,
        stuck_guard=stuck_guard,
    )
    if not steer:
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUseFailure",
            "additionalContext": steer,
        }
    }


def _observe_tool_result(
    tool_name: str,
    tool_input: Any,
    response: Any,
    *,
    progress: Any,
    stuck_guard: StuckGuard | None,
    failed: bool | None = None,
) -> str | None:
    """Show one tool result to the egress detector and the stuck guard.

    *response* is the response of a call that completed (PostToolUse) or the
    error of a call that failed (PostToolUseFailure, which is what a failing
    Bash command fires instead of PostToolUse). Best-effort observability.
    *failed* tells the observers how the call ended where the caller knows.
    From a call known not to have failed (``False``) the detector latches no
    host; with ``None`` the guard reads the response for the signs of a
    failure.

    Returns the stuck guard's advisory when this result completes a spin, for
    the caller to hand to the model as ``additionalContext`` with the result:
    an agent that keeps calling tools never reaches the Stop hook.
    """
    global _LAST_STUCK_SUMMARY

    # The observers read the response as one text.
    text = response if isinstance(response, str) else str(response)

    # Best-effort egress-denial detection. A blocked outbound connection
    # (non-allowlisted host hitting the DNS Firewall, refused connection, name
    # resolution failure) surfaces in the tool's stderr here. Emit an
    # ``egress_denied`` blocker naming the host to allowlist. Observability
    # only — never changes what the caller answers.
    egress_detected, host = detect_egress_denial(text)
    if egress_detected:
        detail = (
            f"A connection to {host!r} was blocked"
            if host
            else "An outbound connection was blocked"
        ) + f" during {tool_name}."
        # Latch for terminal promotion ONLY when a host was captured. The latch
        # feeds the authoritative TaskResult.error carry-path, so a host-less,
        # detection-only signature ("Connection refused" / "Network is
        # unreachable") — which commonly fires for an internal localhost race,
        # not an egress denial — must not masquerade as the terminal cause. The
        # observability event below still fires unconditionally (it never blocks
        # and is clearly a heuristic signal in the live stream).
        # A loopback host is the same localhost race with a name on it (curl:
        # "Failed to connect to localhost port 3000"): no latch either.
        # Nor for a tool that opens no connection (see ``_NETWORK_TOOLS``): the
        # host it shows is quoted from a file or a server's answer. Nor for a
        # call known not to have failed: in the pinned CLI a fetch that cannot
        # connect fails, so a completed one returns the page, content as well.
        if (
            host
            and not _LOOPBACK_HOST_RE.fullmatch(host)
            and str(tool_name) in _NETWORK_TOOLS
            and failed is not False
        ):
            _record_blocker_reason("egress_denied", detail, host)
        _try_progress(
            progress,
            "write_agent_blocked",
            kind="egress_denied",
            detail=detail,
            remediation_hint=(
                f"Allowlist {host!r} in the DNS Firewall rule group"
                if host
                else "Allowlist the required host in the DNS Firewall rule group"
            )
            + " if it is a legitimate dependency. The agent never widens egress itself.",
            retryable=False,
            resource=host,
        )

    if stuck_guard is None:
        return None
    # Feed the stuck-guard and ask it at once (best-effort — a tracking error
    # must never block the caller).
    action = None
    try:
        # The guard quotes the command and the output of a failing call, each
        # cut to a preview: in its advisory, in the summary for a turn-limit
        # error, and through them in the stuck_steer milestone and a log line.
        # They are screened here, while a credential in them is still whole:
        # each string by itself, before the response becomes one text. In that
        # text a line break of the output is a backslash and an "n", which the
        # scanner reads as part of the word or of the URL beside it.
        # The guard never reads the output of a call that it is told completed.
        stuck_guard.record_tool_result(
            tool_name,
            _map_strings(tool_input, _screened),
            text if failed is False else str(_map_strings(response, _screened)),
            failed,
        )
        action = stuck_guard.evaluate()
        # Refresh the "why it's spinning" latch with every result. When the
        # trailing window is failure-dominated this is a one-liner; otherwise
        # None (which clears the latch — a task that recovered isn't "stuck").
        # Read by the terminal path so a later max_turns cap explains itself.
        _LAST_STUCK_SUMMARY = stuck_guard.recent_failure_summary()
    except Exception as exc:
        log("WARN", f"stuck-guard raised (ignored): {type(exc).__name__}: {exc}")
    if action is None or action.kind != "steer":
        return None
    _try_progress(
        progress,
        "write_agent_milestone",
        milestone="stuck_steer",
        details=action.message[:_NUDGE_PREVIEW_LEN],
    )
    # Screened as one text here: the guard was handed the strings of the input
    # screened one by one.
    log("NUDGE", f"stuck-guard STEER injected: {_screened(action.signature)}")
    return action.message


# Strings that the output schema of a built-in tool fixes to one of a few
# values, by the key they stand under. A fail-closed answer leaves them alone:
# the CLI checks a rewritten response against the schema of the tool and passes
# the ORIGINAL output on when it does not fit. Each tool named here was checked
# against the pinned CLI; for a tool that is not named the hook cannot tell
# whether its answer is taken.
_SCHEMA_FIXED: dict[str, tuple[str, ...]] = {
    # "gitOperation", which the CLI adds to the result of a command it takes
    # for a commit, a merge, a rebase or a pull request.
    "Bash": ("kind", "action"),
    "Edit": ("status",),
    "Glob": (),
    "Grep": ("mode",),
    "Read": ("type",),
    "WebFetch": (),
    "Write": ("type", "status"),
}


def _fail_closed_output(tool_name: Any, tool_response: Any, marker: str) -> Any:
    """Return what replaces a tool response that could not be screened.

    Every string that carries content becomes *marker*, in a form the CLI takes
    for the tool.
    """
    name = str(tool_name)
    if name.startswith("mcp__"):
        # The result of an MCP tool is a list of content blocks. A blanked
        # "type" is no block type, and the Messages API refuses a request that
        # holds one, for the rest of the task. The marker alone is taken.
        return marker
    if name == "Read" and isinstance(tool_response, dict) and tool_response.get("type") != "text":
        # An image, a PDF or a notebook: their blocks do not take blanked data.
        # The text form of a Read result instead.
        return {
            "type": "text",
            "file": {
                "filePath": marker,
                "content": marker,
                "numLines": 1,
                "startLine": 1,
                "totalLines": 1,
            },
        }
    return _map_strings(tool_response, lambda _text: marker, _SCHEMA_FIXED.get(name, ()))


def _map_strings(value: Any, fn: Callable[[str], str], keep: tuple[str, ...] = ()) -> Any:
    """Return *value* with *fn* applied to every string in it.

    A tool response is a string, or dicts and lists around strings. The CLI
    takes a rewritten response of a built-in tool only in the tool's own shape
    (``{"stdout": ..., "stderr": ...}`` for Bash) and otherwise keeps the
    original, so keys, nesting and non-string values stay as they are. What
    stands under a key named in *keep* is left alone as well.
    """
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, dict):
        return {
            key: item if key in keep else _map_strings(item, fn, keep)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_map_strings(item, fn, keep) for item in value]
    return value


# ---------------------------------------------------------------------------
# Between-turns hook registry (nudges, extensible for more producers)
# ---------------------------------------------------------------------------

# A hook takes a context dict (currently ``{"task_id": str}``) and returns a
# list of synthetic user-message strings to inject before the agent's next
# turn.  An empty list means "no injection — allow normal stop".
BetweenTurnsHook = Callable[[dict], list[str]]


# Process-lifetime dedup map: task_id -> set of nudge_ids already injected in
# this process.  Guards against infinite re-injection if ``mark_consumed``
# persistently fails (DDB throttling, IAM drift) — without this, the same
# nudge would be re-injected every Stop hook firing until ``max_turns`` is
# exhausted.  Lives for the duration of the process (== task) so it doesn't
# leak across tasks in the same runtime.
_INJECTED_NUDGES: dict[str, set[str]] = {}

# Preview length for the first nudge message in the milestone details
# string.  Kept short so the whole details line stays under ~120 chars
# (single terminal line in ``bgagent watch``).
_NUDGE_PREVIEW_LEN = 60


def _reset_injected_nudges_for_tests() -> None:
    """Test-only helper to clear the in-process injected-nudge dedup set."""
    global _INJECTED_NUDGES
    _INJECTED_NUDGES = {}


def _nudge_between_turns_hook(ctx: dict) -> list[str]:
    """Read pending nudges for the task and return them as XML user messages.

    Best-effort: marks each nudge consumed after formatting.  If
    ``mark_consumed`` fails we still inject (the conditional-update contract
    means at-most-once delivery on success, at-least-once on mark failures —
    better to over-steer than to drop a user instruction).

    Additionally, a process-lifetime dedup set (``_INJECTED_NUDGES``)
    prevents infinite re-injection of the same nudge across turns if
    ``mark_consumed`` repeatedly fails.

    Emits a ``nudge_acknowledged`` ``agent_milestone`` event **before**
    returning the injected user-message list (combined-turn ack) so the
    durable event stream records the ack in the same turn the nudge is
    consumed.  Emission is best-effort: if the progress writer's circuit
    breaker has tripped
    (repeated DDB write failures) or no ``progress`` ref is stamped on
    ``ctx``, the ack is logged but skipped and the injection still
    proceeds — better to steer the agent than block on a flaky event
    table.
    """
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []

    # Belt-and-braces second guard against the "cancel consumes nudges" hazard
    # Cancel-before-nudge short-circuit.  The primary guard is the loop-level
    # break in :func:`stop_hook` which short-circuits the dispatcher as soon as
    # any earlier hook sets ``_cancel_requested``.  That assumes
    # ``_cancel_between_turns_hook`` runs BEFORE this hook — true for the
    # module-level ``between_turns_hooks`` registry today, but a future
    # reorder (or a test that rebinds the list without preserving
    # order) would silently reintroduce the bug: ``read_pending`` +
    # ``mark_consumed`` would flip the DDB rows to consumed and stamp
    # ``_INJECTED_NUDGES`` for a dying agent that will never see the text.
    # Early-returning here makes the invariant structural — no nudges are
    # ever consumed once cancel is flagged, regardless of hook ordering.
    if ctx.get("_cancel_requested"):
        return []

    # The reader is fail-open: a DynamoDB error is logged there and comes back
    # as no pending nudges, so it cannot block the agent.
    pending = nudge_reader.read_pending(task_id)

    # Filter out any nudges already injected in this process (regardless of
    # whether mark_consumed succeeded previously).
    already = _INJECTED_NUDGES.get(task_id, set())
    pending = [n for n in pending if n.get("nudge_id") not in already]

    if not pending:
        return []

    formatted = nudge_reader.format_as_user_message(pending)

    # Record injection BEFORE mark_consumed so a persistent mark_consumed
    # failure cannot cause re-injection on a later turn.
    task_set = _INJECTED_NUDGES.setdefault(task_id, set())
    for n in pending:
        nid = n.get("nudge_id")
        if nid:
            task_set.add(nid)

    # Mark-consumed is best-effort: it logs a failure and returns False, and
    # the injection goes ahead.
    for n in pending:
        nudge_reader.mark_consumed(task_id, n["nudge_id"])

    count = len(pending)
    log("NUDGE", f"Injecting {count} nudge(s) for task {task_id}")

    # Short details string for the stream — preview the first nudge, total
    # count, and the nudge IDs for traceability.  Kept under ~120 chars so
    # it fits on a single terminal line.
    first_msg = (pending[0].get("message") or "")[:_NUDGE_PREVIEW_LEN]
    ids = ",".join(str(n.get("nudge_id", ""))[-8:] for n in pending)
    details = f"{count} nudge(s) acknowledged (ids=…{ids}): {first_msg}" + (
        "…" if count > 1 or len(first_msg) == _NUDGE_PREVIEW_LEN else ""
    )
    # Emit the ack BEFORE returning the injection list.
    _try_progress(
        ctx.get("progress"),
        "write_agent_milestone",
        milestone="nudge_acknowledged",
        details=details,
    )

    return [formatted] if formatted else []


def _denial_between_turns_hook(ctx: dict) -> list[str]:
    """Drain queued denial injections into ``<user_denial>`` XML blocks.

    Registered AFTER ``_cancel_between_turns_hook`` and
    ``_nudge_between_turns_hook`` (cancel-wins semantics). If cancel
    flagged this turn we early-return — denial injection is explicitly
    best-effort on cancelled tasks, and the guaranteed surface is the
    ``permissionDecisionReason`` that ``pre_tool_use_hook`` already
    returned on the deny response.

    ``ctx["engine"]`` is expected when the pipeline wires the approval
    engine through; absent it this hook is a no-op (call sites that don't
    thread an engine ref through still work).
    """
    if ctx.get("_cancel_requested"):
        return []
    engine = ctx.get("engine")
    if engine is None:
        return []
    # ``drain_denial_injections`` clears the queue; this is deliberate
    # so a transient SDK failure that drops the injection does not
    # re-inject the same denial on every subsequent Stop seam.
    pending = engine.drain_denial_injections()
    if not pending:
        return []

    blocks: list[str] = []
    request_ids: list[str] = []
    for entry in pending:
        rid = _xml_escape(str(entry.get("request_id", "")))
        reason = _xml_escape(str(entry.get("reason", "")))
        decided_at = _xml_escape(str(entry.get("decided_at", "") or ""))
        blocks.append(
            f'<user_denial request_id="{rid}" decided_at="{decided_at}">\n{reason}\n</user_denial>'
        )
        if entry.get("request_id"):
            request_ids.append(str(entry["request_id"]))

    count = len(pending)
    log("POLICY", f"Injecting {count} denial(s) for task {ctx.get('task_id', '')}")
    # Emit a single ``user_denial_injected`` milestone per Stop seam so
    # the durable event stream records the ack. Mirrors
    # ``nudge_acknowledged``; this is an additive milestone not in the
    # enumerated milestone list, so keep the name distinct from the
    # enumerated ``approval_*`` prefix.
    _try_progress(
        ctx.get("progress"),
        "write_agent_milestone",
        milestone="user_denial_injected",
        details=f"{count} denial(s) injected (ids={','.join(request_ids)})",
    )
    return ["\n".join(blocks)] if blocks else []


def _cancel_between_turns_hook(ctx: dict) -> list[str]:
    """Detect user-initiated cancellation and signal the Stop hook to halt.

    Reads the task record from DynamoDB each turn.  If ``status == "CANCELLED"``
    sets ``ctx["_cancel_requested"] = True`` so :func:`stop_hook` returns
    ``continue_=False`` and the SDK tears the agent down cleanly.

    Fail-open: a ``TaskFetchError`` (transient DDB failure) is treated as
    "no cancel detected" to avoid stranding running tasks on blips.  This is
    symmetric with ``_nudge_between_turns_hook`` (also fail-open for DDB).
    Worst case a cancel is missed for one turn; the next turn will catch it.

    Returns ``[]`` always — the cancel signal flows via the ctx sentinel, not
    via injected text.  Injecting text would cause the SDK to continue the
    conversation, which is the opposite of what cancel needs.
    """
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []
    try:
        record = task_state.get_task(task_id)
    except task_state.TaskFetchError as exc:
        log("WARN", f"cancel hook get_task raised: {type(exc).__name__}: {exc}")
        # nosemgrep: py-silent-success-masking -- fail-open cancel; DDB blip delays one turn
        return []
    if record and record.get("status") == "CANCELLED":
        ctx["_cancel_requested"] = True
        _try_progress(
            ctx.get("progress"),
            "write_agent_milestone",
            milestone="cancel_detected",
            details="Task cancelled by user; stopping agent after this turn.",
        )
    return []


# Global list of between-turns hooks.  Cancel MUST run first so it can
# short-circuit nudges on cancelled tasks (no point injecting nudges into a
# dying agent — worse, the nudge reader mutates DDB state that the agent will
# never act on).  The :func:`stop_hook`
# dispatcher breaks out of the loop as soon as ``_cancel_requested`` is set,
# and :func:`_nudge_between_turns_hook` early-returns when the flag is already
# present — belt-and-braces in case a future ``append`` reorders this list.
# Additional producers (e.g. approval gates) should ``append`` hooks AFTER the
# nudge reader to preserve cancel-wins semantics.
between_turns_hooks: list[BetweenTurnsHook] = [
    _cancel_between_turns_hook,
    _nudge_between_turns_hook,
    # Denial injection runs LAST so both cancel and nudge short-circuits
    # pre-empt it. The hook explicitly re-checks ``_cancel_requested`` so
    # re-ordering doesn't silently break cancel semantics (belt-and-braces,
    # matching ``_nudge_between_turns_hook``).
    _denial_between_turns_hook,
]


async def stop_hook(
    _hook_input: Any,
    _tool_use_id: str | None,
    _hook_context: Any,
    *,
    task_id: str,
    progress: Any = None,
    engine: Any = None,
) -> dict:
    """Stop hook: run registered between-turns hooks; block if they produce text.

    Returning ``{"decision": "block", "reason": "<text>"}`` tells the SDK to
    continue the conversation with *text* as the next user message rather
    than actually stopping.  If no hook produces text we return an empty
    dict (allow stop).

    Each between-turns hook is invoked via ``asyncio.to_thread`` so that
    sync boto3 calls inside the hook (DDB query + update) do not stall the
    asyncio loop driving ``client.receive_response()``.

    ``progress`` is an optional writer ref threaded into each hook's ``ctx``
    so hooks can emit their own milestone / progress events without holding
    a module-global reference to it. ``engine`` is threaded through for
    ``_denial_between_turns_hook`` which needs to drain queued denials;
    absent it the denial hook is a no-op (call paths that don't wire an
    engine through).
    """
    ctx = {
        "task_id": task_id,
        "progress": progress,
        "engine": engine,
    }

    # Cancel-before-nudge short-circuit.
    # Previously the loop ran ALL hooks before checking ``_cancel_requested``,
    # which meant the nudge hook's ``read_pending`` + ``mark_consumed`` path
    # executed even on cancelled tasks — flipping the DDB rows to consumed
    # and stamping ``_INJECTED_NUDGES`` for a dying agent.  The user saw a
    # 202 Accepted for their nudge but the injection was discarded when we
    # returned ``continue_=False`` below.  Breaking out of the loop as soon
    # as any hook sets ``_cancel_requested`` guarantees subsequent hooks
    # (notably the nudge reader) never run, so DDB state is never mutated
    # for work the agent will never do.  The registry keeps
    # ``_cancel_between_turns_hook`` first so this break fires before the
    # nudge hook gets a chance.  ``_nudge_between_turns_hook`` also carries
    # an internal cancel-check as belt-and-braces in case a future refactor
    # reorders the registry.
    chunks: list[str] = []
    for hook in between_turns_hooks:
        try:
            produced = await asyncio.to_thread(hook, ctx)
        except Exception as exc:
            log(
                "WARN",
                f"between-turns hook raised (task_id={task_id}): {type(exc).__name__}: {exc}",
            )
            continue
        if produced:
            chunks.extend(produced)
        if ctx.get("_cancel_requested"):
            # Any text produced by earlier hooks in this same loop iteration
            # is discarded below — the ``_cancel_requested`` branch returns
            # ``continue_=False`` and never reads ``chunks``.  This is
            # intentional: cancel wins, and we would rather drop a
            # simultaneous nudge than inject into a dying agent.
            break

    # Cancel takes precedence over nudge injection.  ``continue_: False`` tells
    # the SDK to end the turn loop and return control to the caller, which
    # lets the pipeline see the CANCELLED status and skip post-hooks.
    if ctx.get("_cancel_requested"):
        return {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }

    if not chunks:
        return {}

    reason = "\n\n".join(chunks)
    return {"decision": "block", "reason": reason}


async def _lifecycle_tool_started(lifecycle: Any, hook_input: Any, tool_use_id: str | None) -> None:
    """Register a tool with the MicroVM lifecycle barrier before its policy check."""
    await lifecycle.tool_started(tool_use_id)
    if isinstance(hook_input, dict):
        tool_input = hook_input.get("tool_input")
        # Legacy serialized inputs are normalized deeper in the policy hook.
        # Keep their tool behavior, but do not infer a safe foreground-only
        # execution from an opaque value here.
        if not isinstance(tool_input, dict) or tool_input.get("run_in_background"):
            lifecycle.disable_suspend()


def _lifecycle_tool_finished(lifecycle: Any, hook_input: Any, tool_use_id: str | None) -> None:
    """Release a tool from the MicroVM lifecycle barrier after it returns."""
    # Background Bash may be promoted after invocation. A returned background
    # identifier means the tool's post hook is not a reliable indication that
    # its child stopped.
    if isinstance(hook_input, dict):
        response = hook_input.get("tool_response")
        if isinstance(response, dict) and (
            response.get("backgroundTaskId") or response.get("background_task_id")
        ):
            lifecycle.disable_suspend()
    lifecycle.tool_finished(tool_use_id)


def build_hook_matchers(
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str = "",
    progress: Any = None,
    user_id: str = "",
    repo_url: str = "",
) -> dict:
    """Build hook matchers dict for ClaudeAgentOptions.

    Returns a dict mapping HookEvent strings to lists of HookMatcher
    instances, ready to pass as ``hooks=...`` to ClaudeAgentOptions.

    The SDK expects ``dict[HookEvent, list[HookMatcher]]``. PreToolUse also needs
    an explicit callback timeout: the CLI can otherwise cancel a live approval
    wait and return a generic denial without completing its approval record.

    ``progress`` is forwarded to both the PreToolUse hook (approval gate
    milestones) and the Stop hook (nudge/denial acks). ``user_id`` is
    written onto the approval row so ownership checks on the REST side
    can enforce that a user can only approve their own gates.
    """
    from claude_agent_sdk.types import (
        HookContext,
        HookInput,
        HookJSONOutput,
        HookMatcher,
        PostToolUseHookSpecificOutput,
        SyncHookJSONOutput,
    )

    # One stuck-guard per task (== per build_hook_matchers call). The
    # PostToolUse and PostToolUseFailure closures feed it every tool result and
    # hand its advisory about a repeating failing command to the model.
    _stuck_guard = StuckGuard()
    # Retain the controller even after registry removal. A late callback must
    # see its CLOSED barrier, not fall back to the non-MicroVM path.
    lifecycle = get_context(task_id)

    # Closure-based wrapper matches the HookCallback signature exactly:
    # (HookInput, str | None, HookContext) -> Awaitable[HookJSONOutput]
    async def _pre(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        # Fail-closed wrapper (mirrors _post and _stop). If the inner hook
        # or its dispatch path raises an unexpected exception (for example,
        # TypeError from a malformed payload), the
        # SDK's default behaviour for an unhandled hook exception is
        # undefined — we MUST NOT trust it to fail closed. Mapping every
        # uncaught exception to a DENY here makes the security posture
        # explicit at the SDK boundary. SDK cancellation propagates and still
        # releases the tool registration in finally.
        allowed = False
        try:
            if lifecycle:
                await _lifecycle_tool_started(lifecycle, hook_input, tool_use_id)
            result = await pre_tool_use_hook(
                hook_input,
                tool_use_id,
                ctx,
                engine=engine,
                trajectory=trajectory,
                task_id=task_id or None,
                user_id=user_id or None,
                progress=progress,
                repo_url=repo_url or None,
            )
            if result.get("hookSpecificOutput", {}).get("permissionDecision") == "allow":
                if lifecycle:
                    await lifecycle.wait_until_open()
                allowed = True
        except Exception as exc:
            log(
                "ERROR",
                f"PreToolUse wrapper crashed (task_id={task_id}): {type(exc).__name__}: {exc}",
            )
            log_error_cw(
                f"PreToolUse wrapper crashed: {type(exc).__name__}: {exc}",
                task_id=task_id or None,
            )
            return SyncHookJSONOutput(
                **_deny_response("Hook error — fail-closed deny"),
            )
        finally:
            if lifecycle and not allowed:
                lifecycle.tool_finished(tool_use_id)
        return SyncHookJSONOutput(**result)

    async def _post(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        try:
            result = await post_tool_use_hook(
                hook_input,
                tool_use_id,
                ctx,
                trajectory=trajectory,
                progress=progress,
                stuck_guard=_stuck_guard,
            )
            return SyncHookJSONOutput(**result)
        except Exception as exc:
            log("ERROR", f"PostToolUse wrapper crashed: {type(exc).__name__}: {exc}")
            marker = "[Output redacted: hook error — fail-closed]"
            fail_closed: PostToolUseHookSpecificOutput = {
                "hookEventName": "PostToolUse",
                # The response with its content blanked, in a form the CLI
                # takes for the tool (see ``_fail_closed_output``).
                "updatedToolOutput": _fail_closed_output(
                    hook_input.get("tool_name"), hook_input.get("tool_response", marker), marker
                ),
            }
            return SyncHookJSONOutput(hookSpecificOutput=fail_closed)
        finally:
            if lifecycle:
                _lifecycle_tool_finished(lifecycle, hook_input, tool_use_id)

    async def _post_failure(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        try:
            result = await post_tool_use_failure_hook(
                hook_input,
                tool_use_id,
                ctx,
                progress=progress,
                stuck_guard=_stuck_guard,
            )
            return SyncHookJSONOutput(**result)
        except Exception as exc:
            log("ERROR", f"PostToolUseFailure wrapper crashed: {type(exc).__name__}: {exc}")
            return SyncHookJSONOutput()
        finally:
            # A failed tool has left the MicroVM lifecycle barrier too.
            if lifecycle:
                lifecycle.tool_finished(tool_use_id)

    async def _stop(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        # Capture task_id up-front so it can be included in any wrapper
        # crash log for post-hoc correlation with user complaints.
        stop_task_id = task_id
        try:
            result = await stop_hook(
                hook_input,
                tool_use_id,
                ctx,
                task_id=stop_task_id,
                progress=progress,
                engine=engine,
            )
        except Exception as exc:
            log(
                "ERROR",
                f"Stop wrapper crashed (task_id={stop_task_id}): {type(exc).__name__}: {exc}",
            )
            return SyncHookJSONOutput()
        # Empty dict == allow stop.  SyncHookJSONOutput(**{}) is fine.
        return SyncHookJSONOutput(**result)

    # The SDK callback window must outlast the longest approval gate (the
    # contract's approval ceiling) plus cleanup. A frozen MicroVM's CLI timer
    # does not advance while suspended, so suspension cannot shorten it.
    callback_window_s = SHARED_CONSTANTS["approval_timeout_s"]["max"]
    return {
        "PreToolUse": [
            HookMatcher(
                matcher=None,
                hooks=[_pre],
                timeout=callback_window_s + CLEANUP_MARGIN_120S,
            )
        ],
        "PostToolUse": [HookMatcher(matcher=None, hooks=[_post])],
        "PostToolUseFailure": [HookMatcher(matcher=None, hooks=[_post_failure])],
        "Stop": [HookMatcher(matcher=None, hooks=[_stop])],
    }
