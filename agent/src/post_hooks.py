"""Post-agent hooks: build/lint verification, commit, push, PR creation."""

from __future__ import annotations

import re
import subprocess
from typing import TYPE_CHECKING

from shell import log, run_cmd

if TYPE_CHECKING:
    from models import AgentResult, RepoSetup, TaskConfig


def verify_build(repo_dir: str) -> bool:
    """Run mise run build after agent completion to verify the build."""
    log("POST", "Running post-agent build verification (mise run build)...")
    try:
        result = run_cmd(
            ["mise", "run", "build"],
            label="mise-run-build-post",
            cwd=repo_dir,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "Post-agent build timed out — treating as failed")
        return False
    if result.returncode != 0:
        log("POST", "Post-agent build FAILED")
        return False
    log("POST", "Post-agent build: OK")
    return True


def verify_lint(repo_dir: str) -> bool:
    """Run mise run lint after agent completion to verify lint passes."""
    log("POST", "Running post-agent lint verification (mise run lint)...")
    try:
        result = run_cmd(
            ["mise", "run", "lint"],
            label="mise-run-lint-post",
            cwd=repo_dir,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "Post-agent lint timed out — treating as failed")
        return False
    if result.returncode != 0:
        log("POST", "Post-agent lint FAILED")
        return False
    log("POST", "Post-agent lint: OK")
    return True


def ensure_committed(repo_dir: str) -> bool:
    """Safety net: commit any uncommitted tracked changes before finalization.

    This catches work the agent wrote but forgot to commit (e.g. due to turn
    limit or timeout). Only stages tracked-but-modified files (git add -u) to
    avoid accidentally committing temp files or build artifacts.

    Returns True if a safety-net commit was created, False if nothing to commit
    or if git operations fail.
    """
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "git status timed out in safety-net commit")
        return False

    if result.returncode != 0:
        stderr = result.stderr.strip()[:200] if result.stderr else ""
        log("WARN", f"git status failed (exit {result.returncode}): {stderr}")
        return False
    if not result.stdout.strip():
        return False

    log("POST", "Uncommitted changes detected — creating safety-net commit")
    # Stage tracked-but-modified files only (not untracked files)
    try:
        add_result = subprocess.run(
            ["git", "add", "-u"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "git add -u timed out in safety-net commit")
        return False

    if add_result.returncode != 0:
        stderr = add_result.stderr.strip()[:200] if add_result.stderr else ""
        log("WARN", f"git add -u failed (exit {add_result.returncode}): {stderr}")
        return False

    # Check if there's anything staged after add -u
    staged = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo_dir,
        capture_output=True,
        timeout=30,
    )
    if staged.returncode == 0:
        # Nothing staged (changes were only untracked files) — skip
        log("POST", "No tracked file changes to commit")
        return False

    commit_result = subprocess.run(
        ["git", "commit", "-m", "chore(agent): save uncommitted work from session end"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if commit_result.returncode == 0:
        log("POST", "Safety-net commit created")
        return True
    log("POST", f"Safety-net commit failed: {commit_result.stderr.strip()[:200]}")
    return False


def ensure_pushed(repo_dir: str, branch: str) -> bool:
    """Push the branch if there are unpushed commits."""
    result = subprocess.run(
        ["git", "log", f"origin/{branch}..HEAD", "--oneline"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    # If the remote branch doesn't exist or there are unpushed commits
    if result.returncode != 0 or result.stdout.strip():
        log("POST", "Pushing unpushed commits...")
        push_result = run_cmd(
            ["git", "push", "-u", "origin", branch],
            label="push",
            cwd=repo_dir,
            check=False,
        )
        return push_result.returncode == 0
    return True


def ensure_pr(
    config: TaskConfig,
    setup: RepoSetup,
    build_passed: bool,
    lint_passed: bool,
    agent_result: AgentResult | None = None,
) -> str | None:
    """Check if a PR exists for the branch; if not, create one.

    For ``new_task``: creates a new PR if needed.
    For ``pr_iteration``: pushes commits, then resolves the existing PR URL.
    For ``pr_review``: resolves the existing PR URL without pushing (read-only).

    Returns the PR URL, or None if there are no commits beyond the default
    branch or PR creation failed. ``build_passed`` and ``lint_passed`` control
    the verification status shown in the PR body.
    """
    repo_dir = setup.repo_dir
    branch = setup.branch
    default_branch = setup.default_branch

    # PR iteration/review: skip PR creation — just resolve existing PR URL
    from config import PR_TASK_TYPES

    if config.task_type in PR_TASK_TYPES:
        if config.task_type == "pr_iteration":
            if not ensure_pushed(repo_dir, branch):
                log("WARN", "Failed to push commits before resolving PR URL")
        else:
            log("POST", "pr_review task — skipping push (read-only)")
        log("POST", f"{config.task_type} — returning existing PR URL")
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config.repo_url,
                "--json",
                "url",
                "-q",
                ".url",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0 and result.stdout.strip():
            pr_url = result.stdout.strip()
            log("POST", f"Existing PR: {pr_url}")
            return pr_url
        stderr_msg = result.stderr.strip() if result.stderr else "(no stderr)"
        log("WARN", f"Could not resolve existing PR URL (rc={result.returncode}): {stderr_msg}")
        return None

    # Check if the agent already created a PR for this branch
    log("POST", "Checking for existing PR...")
    result = subprocess.run(
        [
            "gh",
            "pr",
            "view",
            branch,
            "--repo",
            config.repo_url,
            "--json",
            "url",
            "-q",
            ".url",
        ],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode == 0 and result.stdout.strip():
        pr_url = result.stdout.strip()
        log("POST", f"PR already exists: {pr_url}")
        return pr_url

    # Check if there are any commits on this branch beyond the default branch
    diff_result = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--oneline"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if diff_result.returncode != 0 or not diff_result.stdout.strip():
        log("POST", "No commits to create PR from — skipping PR creation")
        return None

    # Ensure all commits are pushed
    ensure_pushed(repo_dir, branch)

    # Collect commit messages for the PR body
    log_result = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--pretty=format:%s%n%b---"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    commits = log_result.stdout.strip() if log_result.returncode == 0 else ""

    # Derive PR title from first commit message
    first_commit = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--pretty=format:%s", "--reverse"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    pr_title = (
        first_commit.stdout.strip().split("\n")[0]
        if first_commit.stdout.strip()
        else f"chore: bgagent/{config.task_id}"
    )

    # Build PR body
    task_source = ""
    if config.issue_number:
        task_source = f"Resolves #{config.issue_number}\n\n"
    elif config.task_description:
        task_source = f"**Task:** {config.task_description}\n\n"

    build_status = "PASS" if build_passed else "FAIL"
    lint_status = "PASS" if lint_passed else "FAIL"

    cost_line = ""
    if agent_result and agent_result.cost_usd is not None:
        cost_line = f"- Agent cost: **${agent_result.cost_usd:.4f}**\n"

    pr_body = (
        f"## Summary\n\n"
        f"{task_source}"
        f"### Commits\n\n"
        f"```\n{commits}\n```\n\n"
        f"## Verification\n\n"
        f"- `mise run build` (post-agent): **{build_status}**\n"
        f"- `mise run lint` (post-agent): **{lint_status}**\n"
        f"{cost_line}\n"
        f"---\n\n"
        f"By submitting this pull request, I confirm that you can use, modify, copy, "
        f"and redistribute this contribution, under the terms of the [project license](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/LICENSE)."
    )

    log("POST", f"Creating PR: {pr_title}")
    pr_result = run_cmd(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            config.repo_url,
            "--head",
            branch,
            "--base",
            default_branch,
            "--title",
            pr_title,
            "--body",
            pr_body,
        ],
        label="create-pr",
        cwd=repo_dir,
        check=False,
    )
    if pr_result.returncode == 0:
        pr_url = pr_result.stdout.strip()
        log("POST", f"PR created: {pr_url}")
        return pr_url
    else:
        log("POST", "Failed to create PR")
        return None


def capture_pr_screenshots(pr_url: str, task_id: str = "") -> list[str]:
    """Capture screenshot of PR page. Returns list of pre-signed URLs (fail-open)."""
    from browser import capture_screenshot

    if not pr_url or not pr_url.startswith("https://github.com/"):
        return []
    try:
        url = capture_screenshot(pr_url, task_id)
        return [url] if url else []
    except Exception as e:
        log("WARN", f"PR screenshot capture failed (non-fatal): {type(e).__name__}: {e}")
        return []


def _append_screenshots_to_pr(
    config: TaskConfig,
    setup: RepoSetup,
    screenshot_urls: list[str],
) -> None:
    """Append ## Screenshots section to PR body via gh pr edit."""
    if not screenshot_urls:
        return
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                setup.branch,
                "--repo",
                config.repo_url,
                "--json",
                "body",
                "-q",
                ".body",
            ],
            cwd=setup.repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            log("WARN", "Could not read PR body for screenshot append")
            return

        current_body = result.stdout.strip()
        images_md = "\n".join(
            f"![Screenshot {i + 1}]({url})" for i, url in enumerate(screenshot_urls)
        )
        updated_body = f"{current_body}\n\n## Screenshots\n\n{images_md}"

        subprocess.run(
            ["gh", "pr", "edit", setup.branch, "--repo", config.repo_url, "--body", updated_body],
            cwd=setup.repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        log("POST", f"Appended {len(screenshot_urls)} screenshot(s) to PR body")
    except Exception as e:
        log("WARN", f"Failed to append screenshots to PR: {type(e).__name__}: {e}")


def _extract_agent_notes(repo_dir: str, branch: str, config: TaskConfig) -> str | None:
    """Extract the "## Agent notes" section from the PR body.

    Checks the existing PR body via `gh pr view`. Returns the text content
    of the "## Agent notes" section, or None if not found.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config.repo_url,
                "--json",
                "body",
                "-q",
                ".body",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None

        body = result.stdout.strip()
        # Find "## Agent notes" section
        match = re.search(
            r"##\s*Agent\s*notes\s*\n(.*?)(?=\n##\s|\Z)",
            body,
            re.DOTALL | re.IGNORECASE,
        )
        if match:
            notes = match.group(1).strip()
            return notes if notes else None
        return None
    except Exception as e:
        log("WARN", f"Failed to extract agent notes from PR body: {type(e).__name__}: {e}")
        return None
