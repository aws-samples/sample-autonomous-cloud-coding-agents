"""System prompt construction and project config discovery."""

from __future__ import annotations

import glob
import os
from typing import TYPE_CHECKING

from config import AGENT_WORKSPACE
from prompts import get_system_prompt
from sanitization import sanitize_external_content as sanitize_memory_content
from shell import log
from system_prompt import SYSTEM_PROMPT

if TYPE_CHECKING:
    from models import HydratedContext, RepoSetup, TaskConfig


def build_system_prompt(
    config: TaskConfig,
    setup: RepoSetup,
    hydrated_context: HydratedContext | None,
    overrides: str,
) -> str:
    """Assemble the system prompt with task-specific values and memory context."""
    task_type = config.task_type
    try:
        system_prompt = get_system_prompt(task_type)
    except ValueError:
        log("ERROR", f"Unknown task_type {task_type!r} — falling back to default system prompt")
        system_prompt = SYSTEM_PROMPT
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


def _channel_prompt_addendum(config: TaskConfig) -> str:
    """Return channel-specific prompt guidance, or empty string.

    For Linear-origin tasks, instruct the agent to post progress comments and
    transition state using the already-loaded Linear MCP tools. The tool names
    are stated explicitly so the agent doesn't grope for them.
    """
    if config.channel_source != "linear":
        return ""
    issue_identifier = config.channel_metadata.get("linear_issue_identifier") or ""
    issue_ref = f" (`{issue_identifier}`)" if issue_identifier else ""
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
        "names or loop on `list_issue_statuses`.\n"
        "3. **On completion or failure** — call `mcp__linear-server__save_comment` "
        "with the final status (succeeded / failed + short reason).\n\n"
        "Keep comments concise. Do not mirror the full agent transcript back to "
        "Linear. Even small tasks must post all three updates — users rely on "
        "them to track progress."
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
