from __future__ import annotations

import os
import threading
import time
from http import HTTPStatus
from typing import Any

import requests

from shell import log

LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"

REQUEST_TIMEOUT_SECONDS = 5.0

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

_VIEWER_QUERY = """
query Viewer { viewer { id } }
""".strip()

_ISSUE_STATES_QUERY = """
query IssueStates($id: String!) {
  issue(id: $id) {
    state { id name type position }
    team { states(first: 50) { nodes { id name type position } } }
  }
}
""".strip()

_SET_STATE_MUTATION = """
mutation SetIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}
""".strip()

_STATE_TYPE_RANK = {
    "backlog": 0,
    "triage": 0,
    "unstarted": 1,
    "started": 2,
    "completed": 3,
    "canceled": 3,
}

_BGAGENT_EMOJIS = frozenset({EMOJI_STARTED, EMOJI_SUCCESS, EMOJI_FAILURE})

_viewer_id_cache: str | None = None

_AUTH_FAILURE_THRESHOLD = 3
_consecutive_auth_failures: int = 0
_auth_circuit_open: bool = False
_auth_state_lock = threading.Lock()


def _enabled(channel_source: str, channel_metadata: dict[str, str] | None) -> str | None:
    if channel_source != "linear":
        return None
    if not channel_metadata:
        return None
    return channel_metadata.get("linear_issue_id") or None


def _is_agent_session(channel_metadata: dict[str, str] | None) -> bool:
    return bool(channel_metadata and channel_metadata.get("linear_agent_session_id"))


def _masked(text: str, token: str) -> str:
    return text.replace(token, "***") if token else text


def _graphql(query: str, variables: dict[str, Any], token: str = "") -> dict[str, Any] | None:
    global _consecutive_auth_failures, _auth_circuit_open

    with _auth_state_lock:
        circuit_open = _auth_circuit_open
    if circuit_open:
        log("DEBUG", "linear_reactions: auth circuit still open; short-circuiting call")
        return None

    authorization = token or os.environ.get("LINEAR_API_TOKEN", "")
    if not authorization:
        log("WARN", "linear_reactions: LINEAR_API_TOKEN not set; skipping reaction")
        return None

    try:
        resp = requests.post(
            LINEAR_GRAPHQL_URL,
            json={"query": query, "variables": variables},
            headers={
                "Authorization": authorization,
                "Content-Type": "application/json",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        log("WARN", _masked(f"linear_reactions: request failed ({type(e).__name__}): {e}", token))
        # nosemgrep: py-silent-success-masking -- Linear reactions are best-effort on network blips
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

    if resp.status_code != HTTPStatus.OK:
        log("WARN", f"linear_reactions: HTTP {resp.status_code} from Linear")
        return None

    with _auth_state_lock:
        _consecutive_auth_failures = 0

    try:
        body = resp.json() if resp.content else {}
    except ValueError:
        body = None
    if not isinstance(body, dict):
        log("WARN", "linear_reactions: HTTP 200 from Linear without a JSON object in the body")
        return None

    if body.get("errors"):
        log("WARN", _masked(f"linear_reactions: GraphQL errors: {body['errors']}", token))
        return None

    return body.get("data") or {}


def _get_viewer_id(token: str) -> str | None:
    global _viewer_id_cache
    if _viewer_id_cache:
        return _viewer_id_cache
    data = _graphql(_VIEWER_QUERY, {}, token=token)
    if not data:
        return None
    viewer_id = (data.get("viewer") or {}).get("id")
    if isinstance(viewer_id, str) and viewer_id:
        _viewer_id_cache = viewer_id
        return viewer_id
    return None


def _transition_issue_state(issue_id: str, target_type: str, preferred_names: list[str]) -> None:
    data = _graphql(_ISSUE_STATES_QUERY, {"id": issue_id})
    if not data:
        return
    issue = data.get("issue") or {}
    states = ((issue.get("team") or {}).get("states") or {}).get("nodes") or []
    if not states:
        log("WARN", f"linear_reactions: no team states for issue {issue_id}; skipping transition")
        return

    of_type = [s for s in states if s.get("type") == target_type]
    if not of_type:
        log("DEBUG", f"linear_reactions: no '{target_type}' state on the team; skipping transition")
        return
    target = None
    lowered = [n.lower() for n in preferred_names]
    for name in lowered:
        target = next((s for s in of_type if (s.get("name") or "").lower() == name), None)
        if target:
            break
    if target is None:
        target = min(of_type, key=lambda s: s.get("position", 0))

    current = issue.get("state") or {}
    if current.get("id") == target.get("id"):
        return
    cur_rank = _STATE_TYPE_RANK.get(current.get("type", ""), 0)
    tgt_rank = _STATE_TYPE_RANK.get(target.get("type", ""), 0)
    backward = cur_rank > tgt_rank or (
        cur_rank == tgt_rank and current.get("position", 0) >= target.get("position", 0)
    )
    if backward:
        log(
            "TASK",
            f"linear_reactions: skipping backward state move "
            f"{current.get('name')!r} → {target.get('name')!r}",
        )
        return

    result = _graphql(_SET_STATE_MUTATION, {"id": issue_id, "stateId": target["id"]})
    if result is not None:
        log("TASK", f"linear_reactions: issue {issue_id} → {target.get('name')!r}")


def _sweep_stale_reactions_safe(issue_id: str, token: str, exclude_id: str | None = None) -> None:
    try:
        _sweep_stale_reactions(issue_id, token, exclude_id=exclude_id)
    except Exception as e:
        log(
            "ERROR",
            _masked(f"linear_reactions: sweep thread crashed ({type(e).__name__}): {e}", token),
        )


def _sweep_stale_reactions(issue_id: str, token: str, exclude_id: str | None = None) -> None:
    sweep_start = time.monotonic()
    viewer_id = _get_viewer_id(token)
    if not viewer_id:
        log("WARN", "linear_reactions: skipping sweep — could not resolve viewer id")
        return

    viewer_ms = int((time.monotonic() - sweep_start) * 1000)
    reactions_start = time.monotonic()
    data = _graphql(_ISSUE_REACTIONS_QUERY, {"issueId": issue_id}, token=token)
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
            continue
        if _graphql(_DELETE_MUTATION, {"id": rid}, token=token) is not None:
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
    transition_state: bool = False,
) -> str | None:
    """Post 👀 on the Linear issue. Return the reaction id (or None on failure/no-op)."""
    issue_id = _enabled(channel_source, channel_metadata)
    if not issue_id:
        return None
    if _is_agent_session(channel_metadata):
        if transition_state:
            _transition_issue_state(issue_id, "started", ["In Progress"])
        return None
    log("TASK", f"linear_reactions: react_task_started ENTER issue_id={issue_id}")
    started_at = time.monotonic()

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

    threading.Thread(
        target=_sweep_stale_reactions_safe,
        args=(issue_id, os.environ.get("LINEAR_API_TOKEN", "")),
        kwargs={"exclude_id": rid},
        daemon=True,
        name="linear-reactions-sweep",
    ).start()

    if transition_state:
        _transition_issue_state(issue_id, "started", ["In Progress"])

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
    transition_state: bool = False,
) -> None:
    """Delete the 👀 (if we have its id) and post ✅/❌ as a replacement."""
    issue_id = _enabled(channel_source, channel_metadata)
    if not issue_id:
        return
    if not _is_agent_session(channel_metadata):
        if started_reaction_id:
            _graphql(_DELETE_MUTATION, {"id": started_reaction_id})
        _graphql(
            _CREATE_MUTATION,
            {"issueId": issue_id, "emoji": EMOJI_SUCCESS if success else EMOJI_FAILURE},
        )
    if transition_state and success:
        _transition_issue_state(issue_id, "started", ["In Review"])
