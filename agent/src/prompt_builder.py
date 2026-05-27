"""System prompt construction and project config discovery."""

from __future__ import annotations

import glob
import os
from typing import TYPE_CHECKING

from config import AGENT_WORKSPACE
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
    return (
        "\n\n## Linear issue progress updates (REQUIRED)\n\n"
        f"This task was submitted from Linear issue{issue_ref}. The Linear MCP "
        "server is loaded. You MUST perform these updates; they are part of "
        "the task contract, not optional:\n\n"
        "1. **At start** — call `mcp__linear-server__save_comment` with a short "
        '"🤖 Starting on this issue…" message, then call '
        "`mcp__linear-server__save_issue` to transition the issue state. Use "
        "`mcp__linear-server__list_issue_statuses` first if you don't already "
        "know the state ids; pick the one named `In Progress` (fall back to "
        "`Todo` if that state doesn't exist). If the issue is already in "
        "`In Progress` or any later state (`In Review`, `Done`), skip the "
        "transition. If neither exists, skip — the comment alone is enough. "
        "Do not invent state names or loop on `list_issue_statuses`.\n"
        "2. **When you open the PR** — call `mcp__linear-server__save_comment` "
        "with the PR URL, then call `mcp__linear-server__save_issue` to "
        "transition the issue state to `In Review` (fall back to `In Progress` "
        "if that state doesn't exist). If neither exists, skip the state "
        "transition — the PR comment alone is enough. Do not invent state "
        "names or loop on `list_issue_statuses`.\n\n"
        "**Do NOT post a final 'task completed' or 'task failed' comment.** "
        "The platform fan-out plane (issue #239) posts a structured "
        "✅/⚠️/❌ summary on terminal events with cost / turns / duration / "
        "PR-link metrics that you don't have visibility into. A redundant "
        "agent-side completion comment would just stack two near-identical "
        "comments on the issue.\n\n"
        "Keep the start + PR-opened comments concise. Do not mirror the full "
        "agent transcript back to Linear.\n\n"
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
