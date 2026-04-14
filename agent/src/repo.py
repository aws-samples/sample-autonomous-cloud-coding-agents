"""Repository setup: clone, branch, mise install, initial build."""

import os
import subprocess

from config import AGENT_WORKSPACE, PR_TASK_TYPES
from models import RepoSetup, TaskConfig
from shell import log, run_cmd, slugify


def setup_repo(config: TaskConfig) -> RepoSetup:
    """Clone repo, create branch, configure git auth, run mise install.

    Returns a RepoSetup with repo_dir, branch, notes, build_before,
    lint_before, and default_branch.
    """
    repo_dir = f"{AGENT_WORKSPACE}/{config.task_id}"
    notes: list[str] = []

    if config.task_type in PR_TASK_TYPES and config.branch_name:
        branch = config.branch_name
    else:
        # Derive branch slug from issue title or task description
        title = ""
        if config.issue:
            title = config.issue.title
        if not title:
            title = config.task_description
        slug = slugify(title)
        branch = f"bgagent/{config.task_id}/{slug}"

    # Mark the repo directory as safe for git.  On persistent session storage
    # the mount may be owned by a different UID than the container user,
    # triggering git's "dubious ownership" check on clone/resume.
    run_cmd(
        ["git", "config", "--global", "--add", "safe.directory", repo_dir],
        label="safe-directory",
    )

    # Clone
    log("SETUP", f"Cloning {config.repo_url}...")
    run_cmd(
        ["gh", "repo", "clone", config.repo_url, repo_dir],
        label="clone",
    )

    # Configure remote URL with embedded token so git push works without
    # credential helpers or extra auth setup inside the agent.
    token = config.github_token
    run_cmd(
        [
            "git",
            "remote",
            "set-url",
            "origin",
            f"https://x-access-token:{token}@github.com/{config.repo_url}.git",
        ],
        label="set-remote-url",
        cwd=repo_dir,
    )

    # Branch setup
    if config.task_type in PR_TASK_TYPES and config.branch_name:
        log("SETUP", f"Checking out existing PR branch: {branch}")
        run_cmd(
            ["git", "fetch", "origin", branch],
            label="fetch-pr-branch",
            cwd=repo_dir,
        )
        run_cmd(
            ["git", "checkout", "-b", branch, f"origin/{branch}"],
            label="checkout-pr-branch",
            cwd=repo_dir,
        )
    else:
        log("SETUP", f"Creating branch: {branch}")
        run_cmd(["git", "checkout", "-b", branch], label="create-branch", cwd=repo_dir)

    # Trust mise config files in the cloned repo (required before mise install)
    run_cmd(
        ["mise", "trust", repo_dir],
        label="mise-trust",
        cwd=repo_dir,
        check=False,
    )

    # mise install (deterministic — not left to the LLM)
    log("SETUP", "Running mise install...")
    result = run_cmd(
        ["mise", "install"],
        label="mise-install",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        note = f"mise install failed (exit {result.returncode})"
        notes.append(note)
    else:
        notes.append("mise install: OK")

    # Initial build (record whether the project builds before agent changes)
    log("SETUP", "Running initial build (mise run build)...")
    result = run_cmd(
        ["mise", "run", "build"],
        label="mise-run-build-pre",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        note = "Initial build (mise run build) FAILED before agent changes"
        notes.append(note)
        build_before = False
    else:
        notes.append("Initial build (mise run build): OK")
        build_before = True

    # Initial lint baseline (record whether lint passes before agent changes)
    log("SETUP", "Running initial lint (mise run lint)...")
    result = run_cmd(
        ["mise", "run", "lint"],
        label="mise-run-lint-pre",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        note = "Initial lint (mise run lint) FAILED before agent changes"
        notes.append(note)
        lint_before = False
    else:
        notes.append("Initial lint (mise run lint): OK")
        lint_before = True

    # Detect default branch
    # For PR tasks (pr_iteration, pr_review): use base_branch from orchestrator if available
    if config.task_type in PR_TASK_TYPES and config.base_branch:
        default_branch = config.base_branch
    else:
        default_branch = detect_default_branch(config.repo_url, repo_dir)

    # Install prepare-commit-msg hook for code attribution
    _install_commit_hook(repo_dir)

    return RepoSetup(
        repo_dir=repo_dir,
        branch=branch,
        notes=notes,
        build_before=build_before,
        lint_before=lint_before,
        default_branch=default_branch,
    )


def _install_commit_hook(repo_dir: str) -> None:
    """Install the prepare-commit-msg git hook for Task-Id/Prompt-Version trailers."""
    try:
        hooks_dir = os.path.join(repo_dir, ".git", "hooks")
        os.makedirs(hooks_dir, exist_ok=True)

        # prepare-commit-msg.sh is at the agent root (/app/ in container, parent of src/)
        hook_src = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prepare-commit-msg.sh")
        hook_dst = os.path.join(hooks_dir, "prepare-commit-msg")

        if not os.path.isfile(hook_src):
            log("ERROR", f"Hook not found at {hook_src}")
            return

        import shutil
        import stat

        shutil.copy2(hook_src, hook_dst)
        current = os.stat(hook_dst).st_mode
        exec_bits = stat.S_IXUSR | stat.S_IXGRP
        os.chmod(hook_dst, current | exec_bits)  # nosemgrep
        log("SETUP", "Installed prepare-commit-msg hook")
    except Exception as e:
        log("WARN", f"Commit hook install failed: {type(e).__name__}: {e}")


def detect_default_branch(repo_url: str, repo_dir: str) -> str:
    """Detect the repository's default branch via gh CLI.

    Falls back to 'main' if detection fails (timeout, auth error, etc.).
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "repo",
                "view",
                repo_url,
                "--json",
                "defaultBranchRef",
                "-q",
                ".defaultBranchRef.name",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        log("WARN", "Default branch detection timed out — defaulting to 'main'")
        return "main"

    if result.returncode == 0 and result.stdout.strip():
        branch = result.stdout.strip()
        log("SETUP", f"Detected default branch: {branch}")
        return branch

    stderr = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
    log(
        "WARN",
        f"Could not detect default branch (exit {result.returncode}): "
        f"{stderr} — defaulting to 'main'",
    )
    return "main"
