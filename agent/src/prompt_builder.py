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
      * inbound context — the issue title/description, recent human comments,
        project wiki-document CONTENT, and attachments are ALREADY pre-hydrated
        into the task description + ``attachments`` at admission time
        (linear-webhook-processor + linear-attachments.ts +
        linear-feedback.fetchRecentComments + linear-issue-context-probe's doc
        fetch). There is nothing to fetch at runtime.
      * outbound status — 👀/✅/❌ reactions and Backlog→In Progress→In Review
        state transitions are posted deterministically by ``linear_reactions.py``;
        the "🤖 Starting" and PR-opened comments are posted at the Lambda tier;
        the terminal ✅/⚠️/❌ summary (cost/turns/PR link) is posted by the
        fan-out plane. So the addendum's whole job now is to tell the agent to
        do the code work and NOT attempt any Linear calls.

    Jira-origin tasks intentionally get NO addendum: Atlassian's Remote MCP
    requires an interactive OAuth flow a headless agent can't complete, so the
    MCP tools never load. Instructing the agent to use them just wastes turns.
    Jira progress comments are posted out-of-band by ``jira_reactions`` through
    the configured Forge app actor (or the legacy OAuth migration fallback),
    not by the coding agent.
    """
    if config.channel_source != "linear":
        return ""
    # A synthetic orchestration integration node (#247) has NO real Linear
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
        "human comments, the reporter's uploaded files (inline images and "
        "paperclip attachments), and the content of any project wiki documents "
        "have been pre-fetched and included in your task description (see the "
        "`## Project documents` and `## Recent comments` sections if present) + "
        "attachments. You have no way to fetch more from Linear, so work from "
        "what you've been given. If the task clearly references material that "
        "ISN'T in your context (an external link, a file you can't see, or a doc "
        "noted as present-but-not-included), don't guess — say so in the PR and "
        "proceed with best effort on what you have.\n"
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
