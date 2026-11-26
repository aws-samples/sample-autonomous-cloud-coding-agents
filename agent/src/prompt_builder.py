from __future__ import annotations

import glob
import os
from typing import TYPE_CHECKING

from config import (
    AGENT_WORKSPACE,
    DEFAULT_WORKFLOW_ID,
    NEEDS_INPUT_MARKER,
    REPO_LESS_DEFAULT_WORKFLOW_ID,
)
from post_hooks import DEFAULT_BUILD_COMMAND, DEFAULT_LINT_COMMAND
from prompts import get_system_prompt
from sanitization import sanitize_external_content
from shell import log

if TYPE_CHECKING:
    from models import HydratedContext, RepoSetup, TaskConfig


def build_system_prompt(
    config: TaskConfig,
    setup: RepoSetup,
    hydrated_context: HydratedContext | None,
    overrides: str,
) -> str:
    workflow_id = (config.resolved_workflow or {}).get("id", DEFAULT_WORKFLOW_ID)
    system_prompt = get_system_prompt(workflow_id)
    system_prompt = system_prompt.replace("{repo_url}", config.repo_url)
    system_prompt = system_prompt.replace("{task_id}", config.task_id)
    system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
    system_prompt = system_prompt.replace("{branch_name}", setup.branch)
    system_prompt = system_prompt.replace("{default_branch}", setup.default_branch)
    system_prompt = system_prompt.replace("{max_turns}", str(config.max_turns))
    build_command = config.build_command.strip() or DEFAULT_BUILD_COMMAND
    lint_command = config.lint_command.strip() or DEFAULT_LINT_COMMAND
    system_prompt = system_prompt.replace("{build_command}", build_command)
    system_prompt = system_prompt.replace("{lint_command}", lint_command)
    system_prompt = system_prompt.replace("{needs_input_marker}", NEEDS_INPUT_MARKER)
    setup_notes = (
        "\n".join(f"- {n}" for n in setup.notes)
        if setup.notes
        else "All setup steps completed successfully."
    )
    system_prompt = system_prompt.replace("{setup_notes}", setup_notes)

    memory_context_text = _render_memory_context(
        hydrated_context,
        heading="Repository knowledge",
        empty="(No previous knowledge available for this repository.)",
    )
    system_prompt = system_prompt.replace("{memory_context}", memory_context_text)

    pr_number_val = config.pr_number
    if pr_number_val:
        system_prompt = system_prompt.replace("{pr_number}", str(pr_number_val))
    elif "{pr_number}" in system_prompt:
        log("WARN", "System prompt contains {pr_number} placeholder but no pr_number in config")
        system_prompt = system_prompt.replace("{pr_number}", "(unknown)")

    return _append_task_sections(system_prompt, config, overrides)


def build_repoless_system_prompt(
    config: TaskConfig,
    hydrated_context: HydratedContext | None,
    overrides: str,
) -> str:
    """Assemble the system prompt for a repo-less workflow.

    This builds the repo-less template (no git/branch/PR placeholders),
    substituting only task_id/workspace/max_turns and the rendered memory context,
    then appends the same Blueprint overrides + channel guidance as the
    repo-bound path.
    """
    workflow_id = (config.resolved_workflow or {}).get("id", REPO_LESS_DEFAULT_WORKFLOW_ID)
    system_prompt = get_system_prompt(workflow_id, repo_less=True)
    system_prompt = system_prompt.replace("{task_id}", config.task_id)
    system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
    system_prompt = system_prompt.replace("{max_turns}", str(config.max_turns))
    system_prompt = system_prompt.replace(
        "{memory_context}", _render_memory_context(hydrated_context)
    )
    return _append_task_sections(system_prompt, config, overrides)


def _append_task_sections(system_prompt: str, config: TaskConfig, overrides: str) -> str:
    if overrides:
        system_prompt += f"\n\n## Additional instructions\n\n{overrides}"
        log("TASK", f"Applied system prompt overrides ({len(overrides)} chars)")

    channel_addendum = _channel_prompt_addendum(config)
    if channel_addendum:
        system_prompt += channel_addendum

    if config.resolved_assets:
        from registry.loader import build_skill_prompt_fragment

        system_prompt += build_skill_prompt_fragment(config.resolved_assets)

    return system_prompt


def _render_memory_context(
    hydrated_context: HydratedContext | None,
    *,
    heading: str = "Prior knowledge",
    empty: str = "(No previous knowledge available.)",
) -> str:
    if not (hydrated_context and hydrated_context.memory_context):
        return empty
    mc = hydrated_context.memory_context
    mc_parts: list[str] = []
    if mc.repo_knowledge:
        mc_parts.append(f"**{heading}:**")
        mc_parts.extend(f"- {sanitize_external_content(item)}" for item in mc.repo_knowledge)
    if mc.past_episodes:
        mc_parts.append("\n**Past task episodes:**")
        mc_parts.extend(f"- {sanitize_external_content(item)}" for item in mc.past_episodes)
    return "\n".join(mc_parts) if mc_parts else empty


def _channel_prompt_addendum(config: TaskConfig) -> str:
    if config.channel_source != "linear":
        return ""
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
        for md in ["CLAUDE.md", os.path.join(".claude", "CLAUDE.md")]:
            if os.path.isfile(os.path.join(repo_dir, md)):
                project_config.setdefault("instructions", []).append(md)
        rules_dir = os.path.join(repo_dir, ".claude", "rules")
        if os.path.isdir(rules_dir):
            for p in glob.glob(os.path.join(rules_dir, "*.md")):
                project_config.setdefault("rules", []).append(os.path.relpath(p, repo_dir))
        settings = os.path.join(repo_dir, ".claude", "settings.json")
        if os.path.isfile(settings):
            project_config["settings"] = [".claude/settings.json"]
        agents_dir = os.path.join(repo_dir, ".claude", "agents")
        if os.path.isdir(agents_dir):
            for p in glob.glob(os.path.join(agents_dir, "*.md")):
                project_config.setdefault("agents", []).append(os.path.relpath(p, repo_dir))
        mcp = os.path.join(repo_dir, ".mcp.json")
        if os.path.isfile(mcp):
            project_config["mcp_servers"] = [".mcp.json"]
    except OSError as e:
        log("WARN", f"Error scanning project config: {e}")
    return project_config
