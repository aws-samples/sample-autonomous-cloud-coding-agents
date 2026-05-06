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
    advisory and never gate the pipeline.
    """
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

    if resp.status_code != 200:
        log("WARN", f"linear_reactions: HTTP {resp.status_code} from Linear")
        return None

    body = resp.json() if resp.content else {}
    if body.get("errors"):
        log("WARN", f"linear_reactions: GraphQL errors: {body['errors']}")
        return None

    return body.get("data") or {}


def react_task_started(
    channel_source: str,
    channel_metadata: dict[str, str] | None,
) -> str | None:
    """Post 👀 on the Linear issue. Return the reaction id (or None on failure/no-op)."""
    issue_id = _enabled(channel_source, channel_metadata)
    if not issue_id:
        return None
    data = _graphql(_CREATE_MUTATION, {"issueId": issue_id, "emoji": EMOJI_STARTED})
    if not data:
        return None
    return (data.get("reactionCreate") or {}).get("reaction", {}).get("id")


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
