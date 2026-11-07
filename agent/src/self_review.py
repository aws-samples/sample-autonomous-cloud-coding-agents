"""Self-review orchestration: LLM critiques its own diff before PR creation."""

from __future__ import annotations

import asyncio
import contextlib
import os
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

# Default cap on review-loop turns when the ``self_review`` step omits max_turns.
_DEFAULT_REVIEW_MAX_TURNS = 5

# Minimal system prompt for the self-review agent invocation.
_REVIEW_SYSTEM_PROMPT = """\
You are a code reviewer working inside the repository {repo_url} on branch {branch_name}.
Your working directory is {repo_dir}.

You are a READ-ONLY reviewer. You may read files and run read-only commands to \
inspect the code, but do NOT modify any files, do NOT make commits, and do NOT \
attempt to fix the issues you find. Your sole job is to identify and report \
findings in the summary file described in the review instructions.

Do NOT open a pull request or push.
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
    window = diff[:max_chars]
    last_hunk = window.rfind("\n@@")
    # Cutting just before the last hunk header keeps whole hunks. But for a
    # large single-hunk diff (one big new file, or a hunk wider than the
    # window), the only marker sits near the top, so this cut would discard
    # the entire hunk body and leave only diff/index/---/+++ header lines —
    # the critic would then review an essentially empty diff. Detect that case
    # (does any hunk header start at offset 0, i.e. is the hunk body dropped?)
    # and fall back to the line-boundary hard-cut so we keep real content.
    first_hunk = window.find("\n@@")
    if last_hunk > 0 and last_hunk != first_hunk:
        # More than one hunk header fits — cut just before the last one.
        truncated = window[:last_hunk]
    else:
        # Single hunk (or none) in the window — hard-cut at a line boundary
        # so we keep the hunk body rather than discarding it to the header.
        last_newline = window.rfind("\n")
        truncated = window[:last_newline] if last_newline > 0 else window

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


def _render_review_prompt(prompt_template: str | None, diff: str, task_description: str) -> str:
    """Render the review user prompt from a workflow-supplied template.

    The template (the ``self_review`` step's ``prompt`` field) is rendered with
    ``{diff}`` and ``{task_description}`` placeholders. Fail-open: a template
    that is malformed (stray braces, unknown placeholders) or omits ``{diff}``
    — a review prompt that never shows the diff reviews nothing — falls back to
    the built-in ``SELF_REVIEW_PROMPT`` with a logged warning, so a bad
    workflow edit degrades the review rather than breaking it.
    """
    if prompt_template is not None:
        try:
            rendered = prompt_template.format(diff=diff, task_description=task_description)
            if diff in rendered:
                return rendered
            log("WARN", "self_review: custom prompt lacks {diff} — using built-in prompt")
        except (KeyError, IndexError, ValueError) as e:
            log(
                "WARN",
                f"self_review: custom prompt failed to render "
                f"({type(e).__name__}: {e}) — using built-in prompt",
            )
    return SELF_REVIEW_PROMPT.format(diff=diff, task_description=task_description)


def _milestone(progress: _ProgressWriter | None, name: str, detail: str) -> None:
    """Emit a progress milestone if a writer is wired up (no-op otherwise)."""
    if progress is not None:
        progress.write_agent_milestone(name, detail)


def run_self_review(
    config: TaskConfig,
    setup: RepoSetup,
    agent_result: AgentResult,
    trajectory: _TrajectoryWriter | None,
    progress: _ProgressWriter | None,
    *,
    max_turns: int = _DEFAULT_REVIEW_MAX_TURNS,
    prompt_template: str | None = None,
) -> AgentResult | None:
    """Run the self-review phase: LLM critiques its own diff and fixes issues.

    Invoked by the ``self_review`` workflow step handler. The step's presence in
    the resolved workflow is the enablement signal — there is no separate
    feature flag; ``max_turns`` comes from the step (``self_review.max_turns``,
    default 5) and caps the review loop within the task's remaining allowance.
    ``prompt_template`` (the step's ``prompt`` field) replaces the built-in
    review prompt when supplied — see ``_render_review_prompt`` for the
    placeholder contract and fail-open fallback.

    Returns the AgentResult from the review phase, or None if skipped.
    Fail-open: errors are logged but never block the pipeline.
    """
    # Skip condition: read-only workflows produce no diff to review
    if config.read_only:
        log("TASK", "self_review: skipped for read-only workflow")
        return None

    # Compute remaining turns
    used_turns = agent_result.turns or 0
    remaining_turns = config.max_turns - used_turns
    review_turns = min(remaining_turns, max_turns)
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
    user_prompt = _render_review_prompt(prompt_template, diff, task_desc)
    system_prompt = _build_review_system_prompt(config, setup)

    # Build a modified config for the review run.
    #
    # read_only=True makes the critic structurally read-only rather than relying
    # on prompt text alone: runner._resolve_allowed_tools drops Write/Edit, and
    # PolicyEngine is constructed with read_only=True so the read_only_forbid_write
    # / read_only_forbid_edit Cedar rules fire. Without this the critic inherits
    # the full coding tool surface (Bash/Write/Edit) under bypassPermissions, so
    # a prompt-injection payload embedded in the attacker-influenceable diff could
    # steer it into editing/committing tracked files that then land in the PR.
    review_config = config.model_copy(
        update={
            "max_turns": review_turns,
            "max_budget_usd": review_budget,
            "read_only": True,
        }
    )

    log(
        "TASK",
        f"self_review: starting (turns={review_turns}, "
        f"budget={'$' + f'{review_budget:.2f}' if review_budget else 'unlimited'}, "
        f"diff_chars={len(diff)})",
    )
    _milestone(
        progress,
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
        _milestone(
            progress,
            "self_review_complete",
            f"status=error error={type(e).__name__}: {e}",
        )
        return None

    log(
        "TASK",
        f"self_review: complete (status={review_result.status}, "
        f"turns={review_result.turns}, cost=${review_result.cost_usd or 0:.4f})",
    )
    _milestone(
        progress,
        "self_review_complete",
        f"status={review_result.status} turns={review_result.turns}",
    )
    return review_result


_SUMMARY_FILENAME = ".self-review-summary.md"


def read_self_review_summary(repo_dir: str) -> str | None:
    """Read and delete the self-review summary file.

    The self-review agent writes `.self-review-summary.md` in the repo root.
    This function reads the content, removes the file (so it never appears in
    the PR), and returns the content. Returns None if the file doesn't exist.
    """
    summary_path = os.path.join(repo_dir, _SUMMARY_FILENAME)
    if not os.path.isfile(summary_path):
        return None

    try:
        with open(summary_path) as f:
            content = f.read()
    except OSError as e:
        log("WARN", f"self_review: failed to read summary file: {type(e).__name__}: {e}")
        return None

    # Remove the file so it doesn't end up in the PR
    try:
        os.remove(summary_path)
    except OSError as e:
        log("WARN", f"self_review: failed to delete summary file: {type(e).__name__}: {e}")

    # If the file was staged by the agent, unstage it
    with contextlib.suppress(subprocess.TimeoutExpired, OSError):
        subprocess.run(
            ["git", "rm", "--cached", "--ignore-unmatch", "-f", _SUMMARY_FILENAME],
            cwd=repo_dir,
            capture_output=True,
            timeout=30,
        )

    return content.strip() if content.strip() else None
