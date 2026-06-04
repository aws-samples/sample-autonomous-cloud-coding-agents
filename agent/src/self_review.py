"""Self-review orchestration: LLM critiques its own diff before PR creation."""

from __future__ import annotations

import asyncio
import subprocess
from typing import TYPE_CHECKING

from prompts.self_review import SELF_REVIEW_PROMPT
from shell import log

if TYPE_CHECKING:
    from models import AgentResult, RepoSetup, TaskConfig
    from progress_writer import _ProgressWriter
    from telemetry import _TrajectoryWriter

# Diff truncation limit (characters). Large diffs are cut at hunk boundaries.
_MAX_DIFF_CHARS = 60_000

# Minimal system prompt for the self-review agent invocation.
_REVIEW_SYSTEM_PROMPT = """\
You are a code reviewer working inside the repository {repo_url} on branch {branch_name}.
Your working directory is {repo_dir}.

You have full access to the filesystem and can run commands. Fix any issues you \
find directly — edit files, run the build, and commit fixes. Keep changes minimal \
and focused.

Do NOT open a pull request or push. Just fix issues and commit locally.
"""


def _get_diff(repo_dir: str, default_branch: str) -> str:
    """Generate the cumulative diff of the branch vs origin/{default_branch}."""
    try:
        result = subprocess.run(
            ["git", "diff", f"origin/{default_branch}...HEAD"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            log("WARN", f"self_review: git diff failed (exit {result.returncode})")
            return ""
        return result.stdout
    except (subprocess.TimeoutExpired, OSError) as e:
        log("WARN", f"self_review: git diff error: {type(e).__name__}: {e}")
        return ""


def _truncate_diff(diff: str, max_chars: int = _MAX_DIFF_CHARS) -> str:
    """Truncate diff at a hunk boundary if it exceeds max_chars.

    Cuts at the last complete hunk (line starting with '@@') that fits
    within the limit, appending a truncation notice.
    """
    if len(diff) <= max_chars:
        return diff

    # Find the last hunk header that starts before max_chars
    truncated = diff[:max_chars]
    last_hunk = truncated.rfind("\n@@")
    if last_hunk > 0:
        # Cut just before this hunk header
        truncated = truncated[:last_hunk]
    else:
        # No hunk boundary found — hard-cut at max_chars
        last_newline = truncated.rfind("\n")
        if last_newline > 0:
            truncated = truncated[:last_newline]

    total_lines = diff.count("\n")
    kept_lines = truncated.count("\n")
    truncated += (
        f"\n\n... [diff truncated: showing ~{kept_lines} of ~{total_lines} lines; "
        f"{len(diff) - len(truncated)} chars omitted] ..."
    )
    return truncated


def _build_review_system_prompt(config: TaskConfig, setup: RepoSetup) -> str:
    """Build a minimal system prompt for the self-review agent."""
    return _REVIEW_SYSTEM_PROMPT.format(
        repo_url=config.repo_url,
        branch_name=setup.branch,
        repo_dir=setup.repo_dir,
    )


def run_self_review(
    config: TaskConfig,
    setup: RepoSetup,
    agent_result: AgentResult,
    trajectory: _TrajectoryWriter,
    progress: _ProgressWriter,
) -> AgentResult | None:
    """Run the self-review phase: LLM critiques its own diff and fixes issues.

    Returns the AgentResult from the review phase, or None if skipped.
    Fail-open: errors are logged but never block the pipeline.
    """
    # Skip condition: feature disabled
    if not config.self_review_enabled:
        log("TASK", "self_review: disabled (self_review_enabled=False)")
        return None

    # Skip condition: read-only workflows produce no diff to review
    if config.read_only:
        log("TASK", "self_review: skipped for read-only workflow")
        return None

    # Compute remaining turns
    used_turns = agent_result.turns or 0
    remaining_turns = config.max_turns - used_turns
    review_turns = min(remaining_turns, config.self_review_max_turns)
    if review_turns <= 0:
        log("TASK", f"self_review: no remaining turns (used={used_turns}, max={config.max_turns})")
        return None

    # Compute remaining budget
    review_budget: float | None = None
    if config.max_budget_usd is not None:
        used_cost = agent_result.cost_usd or 0.0
        remaining_budget = config.max_budget_usd - used_cost
        if remaining_budget <= 0:
            log(
                "TASK",
                f"self_review: no remaining budget "
                f"(used=${used_cost:.2f}, max=${config.max_budget_usd:.2f})",
            )
            return None
        review_budget = remaining_budget

    # Get the diff
    diff = _get_diff(setup.repo_dir, setup.default_branch)
    if not diff.strip():
        log("TASK", "self_review: no diff found — skipping")
        return None

    # Truncate if needed
    diff = _truncate_diff(diff)

    # Build the review prompt
    task_desc = config.task_description or f"Issue #{config.issue_number}"
    user_prompt = SELF_REVIEW_PROMPT.format(diff=diff, task_description=task_desc)
    system_prompt = _build_review_system_prompt(config, setup)

    # Build a modified config for the review run
    review_config = config.model_copy(
        update={
            "max_turns": review_turns,
            "max_budget_usd": review_budget,
        }
    )

    log(
        "TASK",
        f"self_review: starting (turns={review_turns}, "
        f"budget={'$' + f'{review_budget:.2f}' if review_budget else 'unlimited'}, "
        f"diff_chars={len(diff)})",
    )
    progress.write_agent_milestone(
        "self_review_started",
        f"turns={review_turns} diff_chars={len(diff)}",
    )

    try:
        from runner import run_agent

        review_result = asyncio.run(
            run_agent(
                user_prompt,
                system_prompt,
                review_config,
                cwd=setup.repo_dir,
                trajectory=trajectory,
            )
        )
    except Exception as e:
        # Fail-open: self-review errors never block the pipeline
        log("WARN", f"self_review: agent execution failed: {type(e).__name__}: {e}")
        progress.write_agent_milestone(
            "self_review_complete",
            f"status=error error={type(e).__name__}: {e}",
        )
        return None

    log(
        "TASK",
        f"self_review: complete (status={review_result.status}, "
        f"turns={review_result.turns}, cost=${review_result.cost_usd or 0:.4f})",
    )
    progress.write_agent_milestone(
        "self_review_complete",
        f"status={review_result.status} turns={review_result.turns}",
    )
    return review_result
