"""System prompt construction and project config discovery."""

from __future__ import annotations

import glob
import os
from typing import TYPE_CHECKING

from config import AGENT_WORKSPACE, NEEDS_INPUT_MARKER
from prompts import get_system_prompt
from sanitization import sanitize_external_content as sanitize_memory_content
from shell import log

if TYPE_CHECKING:
    from models import HydratedContext, RepoSetup, TaskConfig


def build_system_prompt(
    config: TaskConfig,
    setup: RepoSetup,
    hydrated_context: HydratedContext | None,
    overrides: str,
) -> str:
    """Assemble the system prompt with task-specific values and memory context."""
    workflow_id = (config.resolved_workflow or {}).get("id", "coding/new-task-v1")
    system_prompt = get_system_prompt(workflow_id)
    system_prompt = system_prompt.replace("{repo_url}", config.repo_url)
    system_prompt = system_prompt.replace("{task_id}", config.task_id)
    system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
    system_prompt = system_prompt.replace("{branch_name}", setup.branch)
    system_prompt = system_prompt.replace("{default_branch}", setup.default_branch)
    system_prompt = system_prompt.replace("{max_turns}", str(config.max_turns))
    # Clarify-before-spend (UX #4): the new_task workflow references this marker
    # in its "ask instead of guess" branch. Harmless no-op for prompts that don't
    # contain the placeholder.
    system_prompt = system_prompt.replace("{needs_input_marker}", NEEDS_INPUT_MARKER)
    setup_notes = (
        "\n".join(f"- {n}" for n in setup.notes)
        if setup.notes
        else "All setup steps completed successfully."
    )
    system_prompt = system_prompt.replace("{setup_notes}", setup_notes)

    # #299 plan-mode T2 (warm digest): a revise-round decompose task carries the
    # PRIOR run's repo_digest in channel_metadata (a NON-guardrail-screened
    # channel — task_description is screened, this isn't; see create-task-core).
    # Inject it so the agent starts from the cached structural understanding
    # instead of re-deriving it. Cache-key discipline: the prior run recorded the
    # sha it cloned to (decompose_repo_digest_sha); if the repo has since moved,
    # the agent is told the digest may be stale for changed areas and to re-verify
    # there (drift handling, agent-side — the platform has no GitHub token to
    # pre-check, by P5 least-privilege design). Harmless no-op for a prompt
    # without the placeholder or a round-0 task with no prior digest.
    system_prompt = system_prompt.replace(
        "{prior_repo_digest}",
        _render_prior_repo_digest(config, setup),
    )
    # #299 BLOCKER-1 (revise-forgets-edits): on a REVISION round the task carries
    # the CURRENT breakdown (in the guardrail-screened task_description, as
    # "Earlier proposed breakdown") plus the reviewer's requested change. Without
    # explicit framing the decompose prompt reads as "plan this issue from
    # scratch", so the agent re-derives from the issue text and silently reverts
    # edits the reviewer had already accepted (a dropped node reappears, a reworded
    # title snaps back). This directive — injected ONLY on a revision — reframes
    # the task as EDIT-the-current-plan: apply only the requested change, keep
    # everything else verbatim. It lives in the trusted system prompt (NOT the
    # screened task_description, which can't carry imperatives without tripping
    # PROMPT_ATTACK — Bug #1a). Empty on round 0. NOTE: only the ESCALATION path
    # reaches this agent now — most revises are applied deterministically in the
    # webhook (interpret → edit the stored plan in code, no clone, no re-derive).
    system_prompt = system_prompt.replace(
        "{revision_directive}",
        _render_revision_directive(config),
    )
    # #299 plan-mode T2: the sha the repo was cloned to, echoed into the plan
    # JSON's ``repo_digest_sha`` so a later revise run can drift-check the cached
    # digest. Empty when unknown (best-effort — the platform's sha-shape guard
    # then just treats the digest as un-versioned). Harmless no-op without the
    # placeholder.
    system_prompt = system_prompt.replace("{repo_head_sha}", setup.head_sha_before or "")

    # Inject memory context from orchestrator hydration
    memory_context_text = "(No previous knowledge available for this repository.)"
    if hydrated_context and hydrated_context.memory_context:
        mc = hydrated_context.memory_context
        mc_parts: list[str] = []
        if mc.repo_knowledge:
            mc_parts.append("**Repository knowledge:**")
            for item in mc.repo_knowledge:
                mc_parts.append(f"- {sanitize_memory_content(item)}")
        if mc.past_episodes:
            mc_parts.append("\n**Past task episodes:**")
            for item in mc.past_episodes:
                mc_parts.append(f"- {sanitize_memory_content(item)}")
        if mc_parts:
            memory_context_text = "\n".join(mc_parts)
    system_prompt = system_prompt.replace("{memory_context}", memory_context_text)

    # Substitute PR-specific placeholders
    pr_number_val = config.pr_number
    if pr_number_val:
        system_prompt = system_prompt.replace("{pr_number}", str(pr_number_val))
    elif "{pr_number}" in system_prompt:
        log("WARN", "System prompt contains {pr_number} placeholder but no pr_number in config")
        system_prompt = system_prompt.replace("{pr_number}", "(unknown)")

    # Append Blueprint system_prompt_overrides after all placeholder
    # substitutions (avoids double-substitution if overrides contain
    # template placeholders like {repo_url}).
    if overrides:
        system_prompt += f"\n\n## Additional instructions\n\n{overrides}"
        n = len(overrides)
        log("TASK", f"Applied system prompt overrides ({n} chars)")

    # Channel-specific guidance (appended last so channel instructions sit
    # close to the end of the prompt, where the model weights recency).
    channel_addendum = _channel_prompt_addendum(config)
    if channel_addendum:
        system_prompt += channel_addendum

    return system_prompt


def build_repoless_system_prompt(
    config: TaskConfig,
    hydrated_context: HydratedContext | None,
    overrides: str,
) -> str:
    """Assemble the system prompt for a repo-less workflow (#248 Phase 3).

    The repo-bound :func:`build_system_prompt` requires a ``RepoSetup`` (branch,
    default_branch, setup notes); a repo-less task has none. This builds the
    repo-less template (no git/branch/PR placeholders), substituting only
    task_id/workspace/max_turns and the rendered memory context, then appends the
    same Blueprint overrides + channel guidance as the repo-bound path.
    """
    workflow_id = (config.resolved_workflow or {}).get("id", "default/agent-v1")
    system_prompt = get_system_prompt(workflow_id, repo_less=True)
    system_prompt = system_prompt.replace("{task_id}", config.task_id)
    system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
    system_prompt = system_prompt.replace("{max_turns}", str(config.max_turns))
    system_prompt = system_prompt.replace(
        "{memory_context}", _render_memory_context(hydrated_context)
    )

    if overrides:
        system_prompt += f"\n\n## Additional instructions\n\n{overrides}"
        log("TASK", f"Applied system prompt overrides ({len(overrides)} chars)")

    channel_addendum = _channel_prompt_addendum(config)
    if channel_addendum:
        system_prompt += channel_addendum

    return system_prompt


def _render_prior_repo_digest(config: TaskConfig, setup: RepoSetup) -> str:
    """#299 plan-mode T2 — render the cached prior repo digest into the decompose
    prompt, or empty string when there is none (round-0 plan / non-decompose).

    A revise-round ``coding/decompose-v1`` task carries the previous run's
    ``repo_digest`` + the sha it was built at in ``channel_metadata`` (keys
    ``decompose_repo_digest`` / ``decompose_repo_digest_sha``). channel_metadata is
    NOT guardrail-screened (unlike task_description), so a large structural blob
    rides here safely. We inject it as reference DATA so the agent starts from the
    prior structural understanding rather than re-deriving it — the exploration is
    the expensive part of a revise round, and structural facts rarely change
    between rounds.

    Drift: the prior run recorded the sha it cloned to. If the repo has since moved
    (``head_sha_before`` differs), the digest may be stale for changed areas, so we
    say so and tell the agent to re-verify there. The platform can't pre-check the
    sha (no GitHub token — P5 least-privilege), so this agent-side compare IS the
    drift handling. A blank prior sha (older task) is treated as "unknown → trust
    but re-verify if anything looks off".
    """
    cm = config.channel_metadata or {}
    digest = (cm.get("decompose_repo_digest") or "").strip()
    if not digest:
        return ""  # round-0 or no cached digest → the agent explores fresh
    prior_sha = (cm.get("decompose_repo_digest_sha") or "").strip()
    current_sha = (setup.head_sha_before or "").strip()
    if prior_sha and current_sha and prior_sha != current_sha:
        freshness = (
            "NOTE: the repository has changed since this digest was captured "
            f"(digest @ {prior_sha[:8]}, repo now @ {current_sha[:8]}). Treat it as "
            "a starting map, and re-verify any area your plan touches that may have "
            "moved."
        )
    else:
        freshness = (
            "This reflects the repository at its current state; use it as your "
            "starting map and only re-read files where this revision's feedback "
            "requires deeper detail."
        )
    return (
        "\n   **Prior exploration of this repository (reuse this — don't re-derive "
        "from scratch):**\n"
        f"   {freshness}\n"
        "   ```\n"
        f"   {digest}\n"
        "   ```"
    )


def _render_revision_directive(config: TaskConfig) -> str:
    """#299 BLOCKER-1 — render the revise-in-place directive for a REVISION round,
    or empty string for a first-time plan.

    A revise-round ``coding/decompose-v1`` task carries the CURRENT breakdown in
    its (guardrail-screened) task_description as reference data, plus the
    reviewer's requested change. Without explicit framing the decompose prompt
    reads as "plan this issue from scratch" and the agent re-derives the whole
    breakdown, silently reverting edits the reviewer had already accepted (dropped
    nodes reappear, reworded titles snap back — the customer-caught BLOCKER 1).

    This directive reframes the task as an EDIT of the current plan: start FROM it,
    apply ONLY the requested change, keep every other sub-issue verbatim. It must
    live in the trusted system prompt — the screened task_description can't carry
    imperatives ("start from this plan and change only X") without tripping the
    PROMPT_ATTACK filter (Bug #1a). Gated on ``decompose_revision_round`` (set by
    the webhook only on a revise dispatch); a blank/zero/absent value → round 0 →
    empty (no-op).

    NOTE: most revises never reach this agent — the webhook interprets the change
    into structured edits and applies them to the stored plan DETERMINISTICALLY
    (no clone, no re-derive). This directive only governs the ESCALATION path,
    where a change genuinely needs the repo (feasibility / new scope). The
    reviewer-facing "what changed" line is computed by the platform from the
    before→after diff — the agent does NOT self-report it (an earlier cut had the
    agent describe its own changes and it fabricated a justification for a
    silently re-added dropped node).
    """
    cm = config.channel_metadata or {}
    raw_round = (cm.get("decompose_revision_round") or "").strip()
    try:
        revision_round = int(raw_round)
    except ValueError:
        revision_round = 0
    if revision_round <= 0:
        return ""
    return (
        "\n**This is a REVISION of an existing breakdown, not a fresh plan.** The "
        "current breakdown and the reviewer's requested change are given below "
        '(under "Earlier proposed breakdown" and "Requested changes"). Treat '
        "the current breakdown as your starting point: apply ONLY the change the "
        "reviewer asked for and keep every other sub-issue EXACTLY as it is — same "
        "titles, scopes, sizes, and dependencies — unless their change requires "
        "touching it. Do NOT re-derive the whole breakdown from the issue text and "
        "do NOT silently undo edits already reflected in the current breakdown "
        "(e.g. a sub-issue that was dropped stays dropped; a reworded title stays "
        "reworded).\n"
    )


def _render_memory_context(hydrated_context: HydratedContext | None) -> str:
    """Render the memory-context block shared by repo-bound and repo-less prompts."""
    if not (hydrated_context and hydrated_context.memory_context):
        return "(No previous knowledge available.)"
    mc = hydrated_context.memory_context
    mc_parts: list[str] = []
    if mc.repo_knowledge:
        mc_parts.append("**Prior knowledge:**")
        for item in mc.repo_knowledge:
            mc_parts.append(f"- {sanitize_memory_content(item)}")
    if mc.past_episodes:
        mc_parts.append("\n**Past task episodes:**")
        for item in mc.past_episodes:
            mc_parts.append(f"- {sanitize_memory_content(item)}")
    return "\n".join(mc_parts) if mc_parts else "(No previous knowledge available.)"


def _channel_prompt_addendum(config: TaskConfig) -> str:
    """Return channel-specific prompt guidance, or empty string.

    For Linear-origin tasks, instruct the agent to post progress comments and
    transition state using the already-loaded Linear MCP tools. The tool names
    are stated explicitly so the agent doesn't grope for them.

    Jira-origin tasks intentionally get NO addendum: Atlassian's Remote MCP
    requires an interactive OAuth flow a headless agent can't complete, so the
    MCP tools never load. Instructing the agent to use them just wastes turns.
    Jira progress comments are posted out-of-band by ``jira_reactions`` (a REST
    shim wired into the pipeline), not by the agent.
    """
    if config.channel_source != "linear":
        return ""
    # #247 UX.16: a synthetic orchestration integration node has NO real Linear
    # sub-issue — `linear_issue_id` is intentionally omitted from its
    # channel_metadata (see orchestration-release.ts). Without a target issue
    # the agent would grope via the MCP and post its "Starting"/"PR opened"
    # comments onto the PARENT epic, cluttering the maturing panel (which
    # already shows the integration row + combined PR + preview). Skip the
    # progress addendum entirely for these nodes — the panel is the surface.
    if not config.channel_metadata.get("linear_issue_id"):
        return ""
    issue_identifier = config.channel_metadata.get("linear_issue_identifier") or ""
    issue_ref = f" (`{issue_identifier}`)" if issue_identifier else ""
    issue_id = config.channel_metadata.get("linear_issue_id") or ""
    project_id = config.channel_metadata.get("linear_project_id") or ""

    # iteration-UX: a comment-iteration (pr-iteration-v1, triggered by an
    # @bgagent comment) is surfaced by the platform's single maturing threaded
    # reply (👀 On it → 🔄 Working → ✅/💬 + cost). The agent's own top-level
    # "🤖 Starting" / "🔗 PR opened" comments would just re-clutter the issue
    # with the comments we removed (ABCA-430). So for iterations, suppress the
    # progress-comment instructions and post ONLY the context-discovery half +
    # the state-transition guidance. (new_task keeps its headline comments — they
    # ARE the issue's first signal.)
    workflow_id = (config.resolved_workflow or {}).get("id", "")

    # #299 agent-native planning: a coding/decompose-v1 task PLANS, it doesn't
    # change the repo. The platform posts the plan proposal (🗂️) from the agent's
    # artifact and owns the whole approval conversation, so the agent must NOT do
    # the coding-task Linear choreography: no "🤖 Starting" comment, no state
    # transition (a planning run shouldn't move the issue to In Progress), no PR
    # steps, no "task completed". Those cluttered the plan thread (live-caught on
    # ABCA-510). MCP stays loaded for on-demand context discovery only.
    if workflow_id == "coding/decompose-v1":
        return (
            "\n\n## Linear issue (planning only)\n\n"
            f"This is a DECOMPOSITION-PLANNING task on Linear issue{issue_ref}. You are "
            "planning how to break the work down; you are NOT changing the repo. The "
            "platform posts your plan and runs the approval conversation. So do NOT "
            "post any Linear comments (no 'Starting', no 'task completed'), and do NOT "
            "transition the issue's state — just emit the plan JSON as your final "
            "message per your workflow instructions. The Linear MCP is loaded ONLY for "
            "on-demand context discovery below (read attachments / comments / documents "
            "if you need them to plan).\n" + _linear_context_discovery_section(issue_id, project_id)
        )

    is_comment_iteration = workflow_id == "coding/pr-iteration-v1"
    if is_comment_iteration:
        return (
            "\n\n## Linear issue progress (iteration)\n\n"
            f"This is a follow-up iteration on Linear issue{issue_ref}, triggered "
            "by a comment. The platform posts a single threaded status reply under "
            "that comment (it shows progress + cost), so **do NOT post your own "
            "'Starting' / 'PR opened' / 'task completed' Linear comments** — they "
            "duplicate the platform reply and clutter the issue. The Linear MCP is "
            "still loaded; use it ONLY for the on-demand context discovery below "
            "(fetching attachments / comments / documents when you need them). Do "
            "the code work and let the platform narrate it.\n"
            + _linear_context_discovery_section(issue_id, project_id)
        )

    return (
        "\n\n## Linear issue progress updates (REQUIRED)\n\n"
        f"This task was submitted from Linear issue{issue_ref}. The Linear MCP "
        "server is loaded. You MUST perform these updates; they are part of "
        "the task contract, not optional:\n\n"
        "**State transitions — important.** Different Linear teams configure "
        "different workflow states. Many teams do NOT have an `In Review` "
        "state at all (e.g. only Backlog/Todo/In Progress/Done). When you "
        "pass a state name that doesn't exist on the team's workflow, "
        "`mcp__linear-server__save_issue` silently no-ops — it returns 200 "
        "with the issue body unchanged, so it LOOKS like it worked but the "
        "state never moves. To avoid this:\n"
        "  - Call `mcp__linear-server__list_issue_statuses` once at the start "
        "of the task and cache the names you got back.\n"
        "  - Before each transition, check whether the target name is in the "
        "cached list. If not, pick the closest available state per the "
        "fallbacks below.\n"
        "  - After each `save_issue`, look at the returned `state.name` field "
        "in the response — if it's not what you asked for, the transition "
        "didn't happen and you should NOT claim it did.\n\n"
        "**Comment image rendering — important.** Do NOT embed "
        "`uploads.linear.app/...` URLs in `save_comment` bodies. Linear's CDN "
        "signed URLs work in the original poster's context but render as a "
        "broken-image icon when re-embedded in a comment from a different "
        "author. If you need to reference an image the user attached, link to "
        "it in the GitHub PR (where GitHub's image proxy caches the bytes) or "
        "describe it in words. Other URL hosts (imgur, github user-content) "
        "are fine to embed.\n\n"
        "1. **At start** — call `mcp__linear-server__save_comment` with a short "
        '"🤖 Starting on this issue…" message, then call '
        "`mcp__linear-server__list_issue_statuses` once to get the state map, "
        "then call `mcp__linear-server__save_issue` to transition to "
        "`In Progress` (fall back to `Todo` if that state doesn't exist). If "
        "the issue is already in `In Progress` or any later state (`In Review`, "
        "`Done`), skip the transition. If neither exists, skip — the comment "
        "alone is enough. Do not invent state names.\n"
        "2. **When you open the PR** — call `mcp__linear-server__save_comment` "
        "with the PR URL, then call `mcp__linear-server__save_issue` to "
        "transition to `In Review`. Use the cached state map from step 1. If "
        "the team has no `In Review` state, fall back to leaving it at "
        "`In Progress` — DO NOT silently fail by claiming you transitioned "
        "when the response shows the state didn't change. Acknowledge in the "
        "PR comment that the team workflow has no In-Review-equivalent.\n\n"
        "**Do NOT post a final 'task completed' or 'task failed' comment.** "
        "The platform fan-out plane (issue #239) posts a structured "
        "✅/⚠️/❌ summary on terminal events with cost / turns / duration / "
        "PR-link metrics that you don't have visibility into. A redundant "
        "agent-side completion comment would just stack two near-identical "
        "comments on the issue.\n\n"
        "Keep the start + PR-opened comments concise. Do not mirror the full "
        "agent transcript back to Linear.\n\n"
        + _linear_context_discovery_section(issue_id, project_id)
    )


def _linear_context_discovery_section(issue_id: str, project_id: str) -> str:
    """The on-demand Linear MCP context-discovery guidance.

    Shared by the new-task progress addendum and the iteration addendum (where
    the start/PR-opened comments are suppressed but context discovery still
    applies). Pure string-builder.
    """
    return (
        "## Linear context discovery (on demand)\n\n"
        "The same Linear MCP exposes tools for fetching extra context on the "
        "issue when you need it. Use them sparingly — only when the task "
        "description references material you don't have, when the description "
        "is ambiguous and project-level context would clarify, or when a "
        "decision point benefits from a fresh look at the issue thread. Do "
        "NOT call these on every task; the issue title + description are "
        "usually sufficient.\n\n"
        f"- **Issue + paperclip attachments.** Call `mcp__linear-server__get_issue` "
        f'with `id: "{issue_id}"` to fetch the full issue, including its '
        "`attachments` connection (paperclip-icon files like PDFs, logs, "
        "spec docs that aren't embedded as markdown images). Read the "
        "attachment titles first; for each one that looks relevant, call "
        "`mcp__linear-server__get_attachment` with that attachment id. Skip "
        "ones that look unrelated (e.g. screenshots from prior debugging "
        "sessions).\n"
        "- **Embedded images.** Description and comment images that look "
        "like `![alt](https://uploads.linear.app/…)` may have stale signed "
        "URLs by the time you run. If you need to actually look at one, call "
        "`mcp__linear-server__extract_images` to get fresh signed URLs, then "
        "use the built-in `WebFetch` tool to download. (The screened "
        "description-image path runs at task-creation time and is separate "
        "from this — you don't need to re-screen.)\n"
        "- **Project documents.** When the issue belongs to a project and "
        "the task is ambiguous enough that project-level context (specs, "
        "design docs, RFCs) would help, call "
        f"`mcp__linear-server__list_documents` filtered to "
        f'`projectId: "{project_id}"` (skip if the issue has no project). '
        "Read the titles. For documents that clearly relate to your task, "
        "call `mcp__linear-server__get_document` to read the body. Don't "
        "fetch every document.\n"
        "- **Comments posted after task start.** Comments left while you're "
        "running (e.g. clarifications, approve/deny signals from the "
        "requester) are not in your task description. Before opening the PR, "
        f"and again before merging if asked, call `mcp__linear-server__list_comments` "
        f'with `issueId: "{issue_id}"` and look for new comments since '
        "task start. Respect any clear approve / deny / block / hold signals "
        "from the original requester (the issue creator or the person who "
        "applied the trigger label) — if they say stop, stop and post a "
        "comment explaining why."
    )


def discover_project_config(repo_dir: str) -> dict[str, list[str]]:
    """Scan the cloned repo for project-level configuration files.

    Returns a dict mapping config categories to lists of file paths found.
    """
    project_config: dict[str, list[str]] = {}
    try:
        # CLAUDE.md instructions
        for md in ["CLAUDE.md", os.path.join(".claude", "CLAUDE.md")]:
            if os.path.isfile(os.path.join(repo_dir, md)):
                project_config.setdefault("instructions", []).append(md)
        # .claude/rules/*.md
        rules_dir = os.path.join(repo_dir, ".claude", "rules")
        if os.path.isdir(rules_dir):
            for p in glob.glob(os.path.join(rules_dir, "*.md")):
                project_config.setdefault("rules", []).append(os.path.relpath(p, repo_dir))
        # .claude/settings.json
        settings = os.path.join(repo_dir, ".claude", "settings.json")
        if os.path.isfile(settings):
            project_config["settings"] = [".claude/settings.json"]
        # .claude/agents/*.md
        agents_dir = os.path.join(repo_dir, ".claude", "agents")
        if os.path.isdir(agents_dir):
            for p in glob.glob(os.path.join(agents_dir, "*.md")):
                project_config.setdefault("agents", []).append(os.path.relpath(p, repo_dir))
        # .mcp.json
        mcp = os.path.join(repo_dir, ".mcp.json")
        if os.path.isfile(mcp):
            project_config["mcp_servers"] = [".mcp.json"]
    except OSError as e:
        log("WARN", f"Error scanning project config: {e}")
    return project_config
