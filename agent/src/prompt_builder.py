"""System prompt construction and project config discovery."""

import glob
import os

from config import AGENT_WORKSPACE
from prompts import get_system_prompt
from shell import log
from system_prompt import SYSTEM_PROMPT


def build_system_prompt(
    config: dict,
    setup: dict,
    hydrated_context: dict | None,
    overrides: str,
) -> str:
    """Assemble the system prompt with task-specific values and memory context."""
    task_type = config.get("task_type", "new_task")
    try:
        system_prompt = get_system_prompt(task_type)
    except ValueError:
        log("ERROR", f"Unknown task_type {task_type!r} — falling back to default system prompt")
        system_prompt = SYSTEM_PROMPT
    system_prompt = system_prompt.replace("{repo_url}", config["repo_url"])
    system_prompt = system_prompt.replace("{task_id}", config["task_id"])
    system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
    system_prompt = system_prompt.replace("{branch_name}", setup["branch"])
    default_branch = setup.get("default_branch", "main")
    system_prompt = system_prompt.replace("{default_branch}", default_branch)
    system_prompt = system_prompt.replace("{max_turns}", str(config.get("max_turns", 100)))
    setup_notes = (
        "\n".join(f"- {n}" for n in setup["notes"])
        if setup["notes"]
        else "All setup steps completed successfully."
    )
    system_prompt = system_prompt.replace("{setup_notes}", setup_notes)

    # Inject memory context from orchestrator hydration
    memory_context_text = "(No previous knowledge available for this repository.)"
    if hydrated_context and hydrated_context.get("memory_context"):
        mc = hydrated_context["memory_context"]
        mc_parts = []
        if mc.get("repo_knowledge"):
            mc_parts.append("**Repository knowledge:**")
            for item in mc["repo_knowledge"]:
                mc_parts.append(f"- {item}")
        if mc.get("past_episodes"):
            mc_parts.append("\n**Past task episodes:**")
            for item in mc["past_episodes"]:
                mc_parts.append(f"- {item}")
        if mc_parts:
            memory_context_text = "\n".join(mc_parts)
    system_prompt = system_prompt.replace("{memory_context}", memory_context_text)

    # Substitute PR-specific placeholders
    pr_number_val = config.get("pr_number", "")
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

    return system_prompt


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
