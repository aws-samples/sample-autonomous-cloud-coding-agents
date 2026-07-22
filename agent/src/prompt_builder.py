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

    Linear-origin tasks (ADR-016 "Linear is fully deterministic"): the agent has
    NO Linear MCP and NO Linear write access. All Linear I/O is handled by the
    platform, not the agent:
      * inbound context — the issue title/description, recent human comments, and
        attachments are ALREADY pre-hydrated into the task description +
        ``attachments`` at admission time (linear-webhook-processor +
        linear-attachments.ts + linear-feedback.fetchRecentComments). There is
        nothing to fetch at runtime.
      * outbound status — 👀/✅/❌ reactions and Backlog→In Progress→In Review
        state transitions are posted deterministically by ``linear_reactions.py``;
        the "🤖 Starting" and PR-opened comments are posted at the Lambda tier;
        the terminal ✅/⚠️/❌ summary (cost/turns/PR link) is posted by the
        fan-out plane. So the addendum's whole job now is to tell the agent to
        do the code work and NOT attempt any Linear calls.

    Jira-origin tasks intentionally get NO addendum: Atlassian's Remote MCP
    requires an interactive OAuth flow a headless agent can't complete, so the
    MCP tools never load. Jira progress comments are posted out-of-band by
    ``jira_reactions`` (a REST shim wired into the pipeline), not by the agent.
    """
    if config.channel_source != "linear":
        return ""
    # #247 UX.16: a synthetic orchestration integration node has NO real Linear
    # sub-issue — `linear_issue_id` is intentionally omitted from its
    # channel_metadata (see orchestration-release.ts). Without a target issue
    # there is nothing issue-specific to say; the parent panel is the surface.
    if not config.channel_metadata.get("linear_issue_id"):
        return ""
    issue_identifier = config.channel_metadata.get("linear_issue_identifier") or ""
    issue_ref = f" (`{issue_identifier}`)" if issue_identifier else ""

    return (
        "\n\n## Linear issue\n\n"
        f"This task was submitted from Linear issue{issue_ref}. The platform "
        "manages ALL Linear interaction for you — you have no Linear tools and "
        "must not try to call any:\n\n"
        "- **Context is already here.** The issue title, description, recent "
        "human comments, and any attachments the reporter added have been "
        "pre-fetched and included in your task description + attachments. There "
        "is nothing to fetch from Linear — work from what you've been given.\n"
        "- **Status is automatic.** The platform posts the issue reactions "
        "(👀 on start, ✅/❌ on finish), moves the issue through its workflow "
        "states (In Progress → In Review), posts the start + PR-opened comments, "
        "and posts the final ✅/⚠️/❌ summary with cost/PR-link metrics. Do NOT "
        "post Linear comments or change the issue state yourself — you'd only "
        "duplicate the platform's messages.\n\n"
        "Just do the code work: make the change, open the PR, and let the "
        "platform narrate it. Reference issues/PRs in your GitHub PR description "
        "as usual.\n"
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
