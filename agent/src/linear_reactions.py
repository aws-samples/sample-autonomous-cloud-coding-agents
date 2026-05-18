"""Linear issue-level reaction helper for Linear-origin tasks.

Posts a 👀 reaction on the originating Linear issue at task start, then
swaps it for ✅/❌ on terminal status — mirroring the Slack integration's
terminal-emoji status signal (👀 → ✅/❌, no lingering "watching" marker).

Implementation: ``react_task_started`` captures the reaction id returned by
``reactionCreate`` and hands it back to the caller, which passes it into
``react_task_finished`` so we can ``reactionDelete`` the 👀 before posting
the terminal emoji.

Gating: every function is a no-op unless ``channel_source == 'linear'``
and the Linear issue id is present in ``channel_metadata``. All network
errors are logged and swallowed — a transient Linear API failure must
never fail the task itself (reactions are advisory UX, not load-bearing).

Why a direct GraphQL call instead of MCP: Linear's MCP v1 does not expose
a reactions tool (confirmed 2026-05-06). Once an MCP ``create_reaction``
tool ships, this module should be retired in favour of a prompt addendum
that has the agent call it directly.

See: ``agent/src/channel_mcp.py`` for the parallel MCP gate, and
``~/.claude/plans/linear-mcp-findings.md`` for the locked spec.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

import requests

from shell import log

#: Linear GraphQL endpoint. The same auth flow the MCP server uses.
LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"

#: Request timeout — reactions are fire-and-forget status UX; never block
#: the task pipeline for more than a couple of seconds.
REQUEST_TIMEOUT_SECONDS = 5.0

#: Reactions in emoji short-code form (Linear accepts both emoji chars and
#: short codes; short codes are more portable in logs).
EMOJI_STARTED = "eyes"
EMOJI_SUCCESS = "white_check_mark"
EMOJI_FAILURE = "x"

_CREATE_MUTATION = """
mutation ReactIssue($issueId: String!, $emoji: String!) {
  reactionCreate(input: { issueId: $issueId, emoji: $emoji }) {
    success
    reaction { id }
  }
}
""".strip()

_DELETE_MUTATION = """
mutation UnreactIssue($id: String!) {
  reactionDelete(id: $id) { success }
}
""".strip()

#: Fetch reactions on an issue plus each reaction's emoji + owning user id —
#: enough to filter by viewer (the API-token owner) and emoji on re-runs.
_ISSUE_REACTIONS_QUERY = """
query IssueReactions($issueId: String!) {
  issue(id: $issueId) {
    reactions {
      id
      emoji
      user { id }
    }
  }
}
""".strip()

#: Resolve the API-token owner so the sweep only deletes our own reactions
#: and never touches reactions a human added.
_VIEWER_QUERY = """
query Viewer { viewer { id } }
""".strip()

#: Reactions we own and want to clear before a fresh run.
_BGAGENT_EMOJIS = frozenset({EMOJI_STARTED, EMOJI_SUCCESS, EMOJI_FAILURE})

#: Module-level cache of the API-token owner's id. Resolved once per
#: container lifetime (Linear's `viewer { id }` is stable for the token).
_viewer_id_cache: str | None = None

#: Auth-failure circuit breaker. Linear API tokens can be revoked mid-run;
#: without a circuit breaker, every subsequent ``_graphql`` call retries
#: (within its 5s timeout) and floods CloudWatch with WARNs while wasting
#: Linear's quota. After ``_AUTH_FAILURE_THRESHOLD`` consecutive 401/403
#: responses, ``_auth_circuit_open`` flips to True and all later calls
#: short-circuit (return None) without hitting the network. A successful
#: 2xx response resets the counter. The lock guards the read-modify-write
#: against the daemon sweep thread.
_AUTH_FAILURE_THRESHOLD = 3
# Annotated explicitly so ty doesn't narrow the initial values to
# `Literal[0]` / `Literal[False]` — that narrowing would reject the
# legitimate flips below (and any test that resets them).
_consecutive_auth_failures: int = 0
_auth_circuit_open: bool = False
_auth_state_lock = threading.Lock()


def _enabled(channel_source: str, channel_metadata: dict[str, str] | None) -> str | None:
    """Return the Linear issue id if reactions should fire, else None.

    Gating mirrors ``channel_mcp.configure_channel_mcp`` — the same
    ``channel_source == 'linear'`` check, plus a metadata presence check so
    we don't fire GraphQL calls we can't address.
    """
    if channel_source != "linear":
        return None
    if not channel_metadata:
        return None
    return channel_metadata.get("linear_issue_id") or None


def _graphql(query: str, variables: dict[str, Any]) -> dict[str, Any] | None:
    """POST a GraphQL query. Return parsed data on success, None on any failure.

    Swallows network / auth / schema errors with a WARN log — reactions are
    advisory and never gate the pipeline. After
    ``_AUTH_FAILURE_THRESHOLD`` consecutive auth failures (401/403), the
    module-level circuit breaker flips open and all later calls short-circuit
    without hitting the network. A successful 2xx response resets the counter.
    """
    global _consecutive_auth_failures, _auth_circuit_open

    with _auth_state_lock:
        circuit_open = _auth_circuit_open
    if circuit_open:
        log("DEBUG", "linear_reactions: auth circuit still open; short-circuiting call")
        return None

    token = os.environ.get("LINEAR_API_TOKEN", "")
    if not token:
        log("WARN", "linear_reactions: LINEAR_API_TOKEN not set; skipping reaction")
        return None

    try:
        resp = requests.post(
            LINEAR_GRAPHQL_URL,
            json={"query": query, "variables": variables},
            headers={
                "Authorization": token,
                "Content-Type": "application/json",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        log("WARN", f"linear_reactions: request failed ({type(e).__name__}): {e}")
        return None

    if resp.status_code in (401, 403):
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
                "linear_reactions: auth circuit OPEN after "
                f"{failures} consecutive {resp.status_code}s — "
                "API token likely revoked. Suppressing further Linear calls "
                "for this container.",
            )
        else:
            log("WARN", f"linear_reactions: HTTP {resp.status_code} from Linear (auth)")
        return None

    if resp.status_code != 200:
        log("WARN", f"linear_reactions: HTTP {resp.status_code} from Linear")
        return None

    # Successful 2xx — reset the auth failure counter so transient blips don't
    # accumulate toward the threshold.
    with _auth_state_lock:
        _consecutive_auth_failures = 0

    body = resp.json() if resp.content else {}
    if body.get("errors"):
        log("WARN", f"linear_reactions: GraphQL errors: {body['errors']}")
        return None

    return body.get("data") or {}


def _get_viewer_id() -> str | None:
    """Return the API-token owner's user id, cached for the container lifetime.

    Used by ``_sweep_stale_reactions`` to scope deletes to bgagent-owned
    reactions only — without this filter, a re-run would also wipe any 👀 / ✅
    / ❌ reactions a human user happened to add for unrelated reasons.
    """
    global _viewer_id_cache
    if _viewer_id_cache:
        return _viewer_id_cache
    data = _graphql(_VIEWER_QUERY, {})
    if not data:
        return None
    viewer_id = (data.get("viewer") or {}).get("id")
    if isinstance(viewer_id, str) and viewer_id:
        _viewer_id_cache = viewer_id
        return viewer_id
    return None


def _sweep_stale_reactions_safe(issue_id: str, exclude_id: str | None = None) -> None:
    """Top-level wrapper for the sweep daemon thread.

    Catches everything so an unexpected ``TypeError`` / ``AttributeError``
    inside ``_sweep_stale_reactions`` doesn't kill the thread silently —
    stderr from a daemon thread may not reach CloudWatch in containerized
    environments.
    """
    try:
        _sweep_stale_reactions(issue_id, exclude_id=exclude_id)
    except Exception as e:
        log(
            "ERROR",
            f"linear_reactions: sweep thread crashed ({type(e).__name__}): {e}",
        )


def _sweep_stale_reactions(issue_id: str, exclude_id: str | None = None) -> None:
    """Delete bgagent-owned 👀/✅/❌ reactions on the issue.

    Called from ``react_task_started`` *after* the new 👀 is posted, so
    re-runs (label removed and re-applied; or pre-container ❌ from the
    orchestrator/processor followed by a successful retry) don't accumulate
    stale terminal markers next to the new 👀. Running after the post
    means the user-visible 👀 lands fast even if the sweep's first call
    hits cold-connection latency on Linear's API.

    The just-posted 👀 must not be deleted by the sweep — pass its id as
    ``exclude_id`` so the filter skips it.

    Best-effort: any failure (viewer fetch, reactions query, individual
    reactionDelete) is logged and swallowed — sweep is post-👀 cleanup
    and never gates the pipeline.
    """
    sweep_start = time.monotonic()
    viewer_id = _get_viewer_id()
    if not viewer_id:
        log("WARN", "linear_reactions: skipping sweep — could not resolve viewer id")
        return

    viewer_ms = int((time.monotonic() - sweep_start) * 1000)
    reactions_start = time.monotonic()
    data = _graphql(_ISSUE_REACTIONS_QUERY, {"issueId": issue_id})
    reactions_ms = int((time.monotonic() - reactions_start) * 1000)
    if not data:
        log(
            "TASK",
            "linear_reactions: sweep skipped (reactions query failed) "
            f"viewer={viewer_ms}ms reactions={reactions_ms}ms",
        )
        return

    reactions = (data.get("issue") or {}).get("reactions") or []
    deletes = 0
    deletes_start = time.monotonic()
    for r in reactions:
        if not isinstance(r, dict):
            continue
        emoji = r.get("emoji")
        if emoji not in _BGAGENT_EMOJIS:
            continue
        user = r.get("user") or {}
        if user.get("id") != viewer_id:
            continue
        rid = r.get("id")
        if not rid:
            continue
        if exclude_id is not None and rid == exclude_id:
            # The 👀 we just posted — skip, it's the new marker.
            continue
        if _graphql(_DELETE_MUTATION, {"id": rid}) is not None:
            deletes += 1
    deletes_ms = int((time.monotonic() - deletes_start) * 1000)
    total_ms = int((time.monotonic() - sweep_start) * 1000)
    log(
        "TASK",
        f"linear_reactions: sweep done total={total_ms}ms viewer={viewer_ms}ms "
        f"reactions={reactions_ms}ms deletes={deletes}({deletes_ms}ms)",
    )


def react_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> str | None:
    """Post 👀 on the Linear issue. Return the reaction id (or None on failure/no-op).

    Order matters: the 👀 is posted *first*, then we sweep any stale
    bgagent-owned 👀/✅/❌ from prior runs (excluding the one we just
    posted). This keeps the user-visible signal fast — if Linear's API
    is slow on a cold connection, the 5s timeout falls on a sweep call
    and nobody waits, instead of falling on the 👀 post and gating it.

    Sweep is best-effort; failure leaves stale terminal markers next to
    the new 👀 (the visual-duplication bug we set out to fix), but the
    pipeline proceeds unaffected.
    """
    issue_id = _enabled(channel_source, channel_metadata)
    if not issue_id:
        return None
    log("TASK", f"linear_reactions: react_task_started ENTER issue_id={issue_id}")
    started_at = time.monotonic()

    # Post 👀 first — this is the user-visible signal.
    create_start = time.monotonic()
    data = _graphql(_CREATE_MUTATION, {"issueId": issue_id, "emoji": EMOJI_STARTED})
    create_ms = int((time.monotonic() - create_start) * 1000)
    if not data:
        total_ms = int((time.monotonic() - started_at) * 1000)
        log(
            "WARN",
            "linear_reactions: react_task_started EXIT (👀 failed) "
            f"total={total_ms}ms create={create_ms}ms",
        )
        return None
    rid = (data.get("reactionCreate") or {}).get("reaction", {}).get("id")
    eyes_ms = int((time.monotonic() - started_at) * 1000)
    log(
        "TASK",
        f"linear_reactions: 👀 posted reaction_id={rid} create={create_ms}ms "
        f"(eyes-visible at +{eyes_ms}ms)",
    )

    # Sweep prior bgagent reactions in a background thread so the agent
    # pipeline doesn't block on Linear API latency. Daemon=True so the
    # thread doesn't keep the container alive past the agent's terminal
    # status. The sweep filters out the just-posted reaction id so it
    # never deletes itself.
    threading.Thread(
        target=_sweep_stale_reactions_safe,
        args=(issue_id,),
        kwargs={"exclude_id": rid},
        daemon=True,
        name="linear-reactions-sweep",
    ).start()

    log(
        "TASK",
        f"linear_reactions: react_task_started EXIT (sweep dispatched) "
        f"total={eyes_ms}ms create={create_ms}ms reaction_id={rid}",
    )
    return rid


def react_task_finished(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
    success: bool,
    started_reaction_id: str | None = None,
) -> None:
    """Delete the 👀 (if we have its id) and post ✅/❌ as a replacement."""
    issue_id = _enabled(channel_source, channel_metadata)
    if not issue_id:
        return
    if started_reaction_id:
        _graphql(_DELETE_MUTATION, {"id": started_reaction_id})
    _graphql(
        _CREATE_MUTATION,
        {"issueId": issue_id, "emoji": EMOJI_SUCCESS if success else EMOJI_FAILURE},
    )
