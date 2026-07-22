"""Jira issue-comment and workflow-transition helpers for Jira-origin tasks.

Posts a "starting" comment on the originating Jira issue at task start — the
Jira analogue of ``linear_reactions`` (Linear uses emoji reactions; Jira's
REST API has no lightweight reaction primitive, so comments are the right
tool).

It also moves the originating issue across its board as the task progresses
(issue #572): To Do → In Progress on start, → In Review on PR, via the Jira
transitions API. Like comments, transitions are best-effort — logged and
swallowed on any failure, sharing the same auth circuit breaker — so the Jira
board never gates the task. See the "Workflow transitions" section below.

The *terminal* status comment is NOT posted from here: since issue #573 the
deterministic fan-out plane (``cdk/src/handlers/fanout-task-events.ts``
``dispatchToJira``) owns it, so it carries cost/turns/duration and fires even
when this agent crashes before completing. This module only owns the start
comment.

Why a direct REST call instead of MCP: Atlassian's Remote MCP
(``mcp.atlassian.com``) requires an interactive, browser-based OAuth 2.1
authorization flow with dynamic client registration — it does NOT accept the
stored Jira REST OAuth token as a ``Bearer`` header, and a headless background
agent cannot complete the interactive handshake. The MCP path therefore fails
to connect in the runtime (``claude mcp list`` → "Failed to connect"). The
Jira *REST* API, by contrast, accepts the same stored OAuth access token (it
carries ``write:jira-work``), so we post comments via
``POST /rest/api/3/issue/{key}/comment`` on the cross-region
``api.atlassian.com/ex/jira/{cloudId}`` base. This is the "Plan B REST shim"
the ``channel_mcp`` module's comments anticipated.

Gating: every function is a no-op unless ``channel_source == 'jira'`` and the
issue key + cloud id are present in ``channel_metadata``. All network / auth
errors are logged and swallowed — a transient Jira API failure must never fail
the task itself (comments are advisory UX, not load-bearing).

See: ``agent/src/channel_mcp.py`` for the (non-functional) MCP gate, and
``agent/src/linear_reactions.py`` for the parallel Linear shim.
"""

from __future__ import annotations

import os
import threading
from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import requests

from shell import log

#: Atlassian cross-region REST base. The ``{cloudId}`` segment scopes the
#: call to the tenant; ``JIRA_API_TOKEN`` (populated by
#: ``config.resolve_jira_oauth_token``) authorizes it.
JIRA_API_BASE = "https://api.atlassian.com/ex/jira"

#: Request timeout — comments are fire-and-forget status UX; never block the
#: task pipeline for more than a couple of seconds.
REQUEST_TIMEOUT_SECONDS = 5.0

#: Auth-failure circuit breaker. Mirrors ``linear_reactions``: after this many
#: consecutive 401/403s the breaker opens and later calls short-circuit
#: without hitting the network (avoids flooding CloudWatch when a token is
#: revoked). A successful 2xx resets the counter.
_AUTH_FAILURE_THRESHOLD = 3
_consecutive_auth_failures: int = 0
_auth_circuit_open: bool = False
_auth_state_lock = threading.Lock()


def _circuit_open() -> bool:
    """True if the auth circuit breaker is open (short-circuit further calls)."""
    with _auth_state_lock:
        return _auth_circuit_open


def _note_auth_status(status_code: int) -> None:
    """Feed a response status into the shared 401/403 circuit breaker.

    A 401/403 increments the consecutive-failure counter and opens the breaker
    once it hits ``_AUTH_FAILURE_THRESHOLD``; any other 2xx-ish success resets
    it. Comments and transitions share this state so a revoked token trips the
    breaker once for all outbound Jira calls in the container.
    """
    global _consecutive_auth_failures, _auth_circuit_open

    if status_code in (401, 403):
        with _auth_state_lock:
            _consecutive_auth_failures += 1
            opened = (
                _consecutive_auth_failures >= _AUTH_FAILURE_THRESHOLD and not _auth_circuit_open
            )
            if opened:
                _auth_circuit_open = True
                failures = _consecutive_auth_failures
        if opened:
            log(
                "ERROR",
                "jira_reactions: auth circuit OPEN after "
                f"{failures} consecutive {status_code}s — Jira token likely "
                "revoked/expired without a working refresh. Suppressing further "
                "Jira calls for this container.",
            )
        else:
            log("WARN", f"jira_reactions: HTTP {status_code} from Jira (auth)")
        return

    with _auth_state_lock:
        _consecutive_auth_failures = 0


def _enabled(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> tuple[str, str] | None:
    """Return ``(cloud_id, issue_key)`` if comments should fire, else None.

    Gating mirrors ``channel_mcp.configure_channel_mcp`` — the same
    ``channel_source == 'jira'`` check, plus a metadata presence check so we
    don't fire REST calls we can't address.
    """
    if channel_source != "jira":
        return None
    if not channel_metadata:
        return None
    cloud_id = channel_metadata.get("jira_cloud_id")
    issue_key = channel_metadata.get("jira_issue_key")
    if not cloud_id or not issue_key:
        return None
    return cloud_id, issue_key


def _adf(text: str) -> dict[str, Any]:
    """Wrap plain text in a minimal Atlassian Document Format comment body."""
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]},
        ],
    }


def _post_comment(cloud_id: str, issue_key: str, text: str) -> bool:
    """POST a comment to the issue. Return True on success, False on any failure.

    Swallows network / auth / schema errors with a WARN log — comments are
    advisory and never gate the pipeline. After ``_AUTH_FAILURE_THRESHOLD``
    consecutive auth failures the module-level circuit breaker opens and later
    calls short-circuit without hitting the network.
    """
    if _circuit_open():
        log("DEBUG", "jira_reactions: auth circuit still open; short-circuiting call")
        return False

    token = os.environ.get("JIRA_API_TOKEN", "")
    if not token:
        log("WARN", "jira_reactions: JIRA_API_TOKEN not set; skipping comment")
        return False

    # URL-encode both path segments. cloud_id and issue_key originate from the
    # verified webhook payload (stamped into channel_metadata by the
    # processor), but encoding them keeps an unexpected value from injecting
    # extra path segments into the gateway URL. `safe=""` so even "/" encodes.
    url = (
        f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
        f"/rest/api/3/issue/{quote(issue_key, safe='')}/comment"
    )
    try:
        resp = requests.post(
            url,
            json={"body": _adf(text)},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        log("WARN", f"jira_reactions: request failed ({type(e).__name__}): {e}")
        # nosemgrep: py-silent-success-masking -- Jira comments are best-effort on network blips
        return False

    if resp.status_code in (401, 403):
        _note_auth_status(resp.status_code)
        return False

    # Jira returns 201 Created on a successful comment.
    if resp.status_code not in (200, 201):
        log("WARN", f"jira_reactions: HTTP {resp.status_code} from Jira: {resp.text[:200]}")
        return False

    _note_auth_status(resp.status_code)
    return True


def comment_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Post a "starting" comment on the Jira issue. No-op for non-Jira tasks."""
    target = _enabled(channel_source, channel_metadata)
    if not target:
        return
    cloud_id, issue_key = target
    ok = _post_comment(
        cloud_id,
        issue_key,
        "🤖 ABCA picked up this issue and started working on it. "
        "I'll comment again when the pull request is ready.",
    )
    log("TASK", f"jira_reactions: comment_task_started issue={issue_key} ok={ok}")


# NOTE: there is deliberately no ``comment_task_finished`` here. Since issue
# #573 the deterministic fan-out plane
# (``cdk/src/handlers/fanout-task-events.ts`` ``dispatchToJira``) owns the Jira
# terminal comment — it carries cost/turns/duration and, crucially, fires even
# when the agent crashes before completing (max-turns, OOM). The agent only
# posts the *start* comment (``comment_task_started`` above); posting a terminal
# comment here too would double-comment on the issue.


# ── Workflow transitions (issue #572) ──────────────────────────────────────────
#
# Move the originating Jira card across its board as the task progresses so the
# board reflects reality: To Do → In Progress on start, → In Review on PR. Jira
# status can only change via the transitions API (``PUT issue`` ignores status),
# and valid transition IDs are workflow- and current-status-specific, so we
# resolve them per-issue at call time — never configure or hard-code IDs.
#
# Best-effort, exactly like comments: short timeout, errors logged and
# swallowed, sharing the 401/403 circuit breaker above. A transition failure
# must never fail, block, or retry the task.

#: Jira ``statusCategory.key`` for the "In Progress" band. The start transition
#: falls back to this category so standard workflows work with no per-project
#: config. (Categories: ``new`` = To Do, ``indeterminate`` = In Progress,
#: ``done`` = Done — the only three, and they are stable API values.)
_IN_PROGRESS_CATEGORY = "indeterminate"

#: Ordinal rank of the three status categories, low → high. Used to skip a
#: transition that would move the card *backward* (e.g. a re-triggered task on
#: an issue that's already In Review must not drag it back to In Progress).
_CATEGORY_RANK = {"new": 0, "indeterminate": 1, "done": 2}

#: Preferred destination *name* for the start transition (matched
#: case-insensitively before the category fallback). Both ``In Progress`` and
#: ``Blocked`` share the ``indeterminate`` category, so a name match is what
#: keeps a category-only heuristic from landing on ``Blocked`` (#605).
_START_STATUS_NAME = "in progress"

#: Preferred destination names for the PR-opened transition, tried in order.
#: Mirrors Linear's "In Review → In Progress" fallback while also matching
#: common review-column names, so a "Code Review" column isn't silently skipped
#: and a stock board (no review status) still advances to / stays at In Progress
#: rather than no-opping (#605). Ends with In Progress as the safe fallback.
_REVIEW_STATUS_NAMES = (
    "in review",
    "code review",
    "review",
    "peer review",
    "reviewing",
    _START_STATUS_NAME,
)

#: Destination names the category fallback must never auto-pick. ``Blocked``
#: shares the ``indeterminate`` category with ``In Progress``; a bare
#: first-indeterminate heuristic could land there (#605), which is never what
#: "move to In Progress" means. A configured override can still target it.
_CATEGORY_FALLBACK_DENY = ("blocked",)


def _get_issue_transitions(
    cloud_id: str, issue_key: str, token: str
) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    """GET the issue's current status + the transitions valid from it.

    Fetches ``?fields=status&expand=transitions`` so a single call yields both
    the current ``status`` (to skip moving a card backward, #605) and the
    ``transitions`` list. Returns ``(current_status, transitions)`` on success,
    or ``None`` on any failure. An empty transitions list is normal — Jira
    returns one when the OAuth user lacks the *Transition Issues* permission —
    and callers treat it as "nothing to do", not an error.
    """
    url = (
        f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
        f"/rest/api/3/issue/{quote(issue_key, safe='')}?fields=status&expand=transitions"
    )
    try:
        resp = requests.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        log("WARN", f"jira_reactions: issue GET failed ({type(e).__name__}): {e}")
        # nosemgrep: py-silent-success-masking -- Jira transitions are best-effort on network blips
        return None

    if resp.status_code in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
        _note_auth_status(resp.status_code)
        return None
    if resp.status_code != HTTPStatus.OK:
        log("WARN", f"jira_reactions: issue GET HTTP {resp.status_code}: {resp.text[:200]}")
        return None

    _note_auth_status(resp.status_code)
    try:
        payload = resp.json()
    except ValueError as e:
        log("WARN", f"jira_reactions: issue GET returned non-JSON: {e}")
        # nosemgrep: py-silent-success-masking -- Jira transitions are best-effort on bad responses
        return None
    # A well-formed response is a JSON object. Guard against valid-but-unexpected
    # JSON (``null``, a bare list, a scalar) — ``.get`` would raise
    # AttributeError, which is NOT best-effort: it propagates out of the pipeline
    # hook and flips the task to FAILED (#605).
    if not isinstance(payload, dict):
        log("WARN", "jira_reactions: issue GET returned non-object JSON — skipping")
        return None
    current_status = (payload.get("fields") or {}).get("status") or {}
    transitions = payload.get("transitions", [])
    if not isinstance(current_status, dict):
        current_status = {}
    if not isinstance(transitions, list):
        transitions = []
    return current_status, transitions


def _to_name(t: dict[str, Any]) -> str:
    """Lowercased destination status name of a transition, or ``""``."""
    return ((t.get("to") or {}).get("name") or "").strip().lower()


def _to_category(t: dict[str, Any]) -> str | None:
    """``statusCategory.key`` of a transition's destination, or ``None``."""
    return ((t.get("to") or {}).get("statusCategory") or {}).get("key")


def _usable(t: dict[str, Any]) -> bool:
    """A transition we can execute unattended.

    ``hasScreen`` transitions may demand required fields we can't supply, so we
    skip them — a missing field would 400 the POST.
    """
    return isinstance(t, dict) and not t.get("hasScreen", False)


def _select_transition(
    transitions: list[dict[str, Any]],
    *,
    override: str | None,
    prefer_names: tuple[str, ...],
    fallback_category: str | None,
) -> dict[str, Any] | None:
    """Pick a transition by the resolution ladder, or ``None`` if nothing fits.

    Ladder (first match wins), mirroring the Linear reference this feature is
    modeled on (``prompt_builder.py``):

    1. ``override`` — a per-project configured status name, matched
       case-insensitively against the destination name. An override that isn't
       reachable is a deliberate skip (no fallback — the user asked for a
       specific status).
    2. ``prefer_names`` — preferred destination names in priority order (e.g.
       ``In Progress`` on start; ``In Review`` → ``Code Review`` → … on PR).
       This is what stops a category-only heuristic from landing on ``Blocked``
       (which shares the ``indeterminate`` category with ``In Progress``).
    3. ``fallback_category`` — any usable transition whose destination is in
       this ``statusCategory`` (keeps stock boards working with no config).

    Screen-gated transitions are skipped throughout.
    """
    usable = [t for t in transitions if _usable(t)]

    if override:
        wanted = override.strip().lower()
        return next((t for t in usable if _to_name(t) == wanted), None)

    for name in prefer_names:
        match = next((t for t in usable if _to_name(t) == name), None)
        if match:
            return match

    if fallback_category:
        return next(
            (
                t
                for t in usable
                if _to_category(t) == fallback_category
                and _to_name(t) not in _CATEGORY_FALLBACK_DENY
            ),
            None,
        )
    return None


def _post_transition(cloud_id: str, issue_key: str, token: str, transition_id: str) -> bool:
    """POST a transition. Return True on success (204), False on any failure."""
    url = (
        f"{JIRA_API_BASE}/{quote(cloud_id, safe='')}"
        f"/rest/api/3/issue/{quote(issue_key, safe='')}/transitions"
    )
    try:
        resp = requests.post(
            url,
            json={"transition": {"id": transition_id}},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        log("WARN", f"jira_reactions: transition POST failed ({type(e).__name__}): {e}")
        # nosemgrep: py-silent-success-masking -- Jira transitions are best-effort on network blips
        return False

    if resp.status_code in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
        _note_auth_status(resp.status_code)
        return False
    # Jira returns 204 No Content on a successful transition.
    if resp.status_code != HTTPStatus.NO_CONTENT:
        log("WARN", f"jira_reactions: transition POST HTTP {resp.status_code}: {resp.text[:200]}")
        return False

    _note_auth_status(resp.status_code)
    return True


def _transition(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
    *,
    lifecycle: str,
    override: str | None,
    prefer_names: tuple[str, ...],
    fallback_category: str | None,
    max_source_rank: int | None,
) -> None:
    """Shared best-effort transition path. No-op for non-Jira tasks.

    Resolves ``(cloud_id, issue_key)``, fetches the current status + valid
    transitions, skips if the card is already at/past the target band
    (``max_source_rank``), selects a transition via the resolution ladder, and
    POSTs it. Every failure mode — disabled, open circuit, missing token, empty
    transition list, no match, network / HTTP error — is logged and swallowed
    so the pipeline is never affected.
    """
    target = _enabled(channel_source, channel_metadata)
    if not target:
        return
    cloud_id, issue_key = target

    if _circuit_open():
        log("DEBUG", "jira_reactions: auth circuit open; skipping transition")
        return

    token = os.environ.get("JIRA_API_TOKEN", "")
    if not token:
        log("WARN", "jira_reactions: JIRA_API_TOKEN not set; skipping transition")
        return

    result = _get_issue_transitions(cloud_id, issue_key, token)
    if result is None:
        log("WARN", f"jira_reactions: could not read issue {issue_key} — skipping {lifecycle}")
        return
    current_status, transitions = result

    # Don't move the card backward. If the current status is already at or past
    # the highest category this lifecycle point should advance to, skip — a
    # re-triggered task on an already-In-Review issue must not drag it back to
    # In Progress (mirrors Linear's "already in a later state" skip).
    if max_source_rank is not None:
        current_category = (current_status.get("statusCategory") or {}).get("key")
        current_rank = _CATEGORY_RANK.get(current_category)
        if current_rank is not None and current_rank >= max_source_rank:
            log(
                "TASK",
                f"jira_reactions: {lifecycle} skip issue={issue_key} — already at "
                f"{current_status.get('name')!r} (category {current_category!r})",
            )
            return

    if not transitions:
        # [] (no permission / no transitions) — a normal skip.
        log(
            "WARN",
            f"jira_reactions: no available transitions for {lifecycle} "
            f"issue={issue_key} — skipping",
        )
        return

    chosen = _select_transition(
        transitions,
        override=override,
        prefer_names=prefer_names,
        fallback_category=fallback_category,
    )
    if not chosen:
        log(
            "WARN",
            f"jira_reactions: no matching {lifecycle} transition for issue={issue_key} "
            f"(override={override!r} names={prefer_names} category={fallback_category!r}) "
            "— skipping",
        )
        return

    to_name = (chosen.get("to") or {}).get("name")
    ok = _post_transition(cloud_id, issue_key, token, str(chosen.get("id")))
    log(
        "TASK",
        f"jira_reactions: transition {lifecycle} issue={issue_key} → {to_name!r} ok={ok}",
    )


def transition_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Move the Jira issue to an in-progress status at task start.

    Resolution: ``jira_status_on_start`` override → a destination named
    ``In Progress`` → any ``indeterminate``-category destination. Skips if the
    issue is already In Progress or later (won't move a card backward).
    Best-effort; no-op for non-Jira tasks.
    """
    override = (channel_metadata or {}).get("jira_status_on_start")
    _transition(
        channel_source,
        channel_metadata,
        lifecycle="start",
        override=override,
        prefer_names=() if override else (_START_STATUS_NAME,),
        fallback_category=None if override else _IN_PROGRESS_CATEGORY,
        # Skip if already In Progress (indeterminate) or Done. An override is a
        # deliberate instruction, so honor it regardless of current status.
        max_source_rank=None if override else _CATEGORY_RANK[_IN_PROGRESS_CATEGORY],
    )


def transition_pr_opened(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> None:
    """Move the Jira issue to a review status once a PR is opened.

    Resolution: ``jira_status_on_pr`` override → a destination named
    ``In Review`` (or a common review-column synonym) → any
    ``indeterminate``-category destination (Linear's In Review→In Progress
    fallback, so a stock board isn't silently skipped, #605). Skips only if the
    issue is already Done. Best-effort; no-op for non-Jira tasks.
    """
    override = (channel_metadata or {}).get("jira_status_on_pr")
    _transition(
        channel_source,
        channel_metadata,
        lifecycle="pr_opened",
        override=override,
        prefer_names=() if override else _REVIEW_STATUS_NAMES,
        fallback_category=None if override else _IN_PROGRESS_CATEGORY,
        # Only skip if already Done — moving In Progress → In Review is forward.
        max_source_rank=None if override else _CATEGORY_RANK["done"],
    )


def _reset_state_for_testing() -> None:
    """Test-only: reset the auth circuit-breaker module state."""
    global _consecutive_auth_failures, _auth_circuit_open
    with _auth_state_lock:
        _consecutive_auth_failures = 0
        _auth_circuit_open = False
