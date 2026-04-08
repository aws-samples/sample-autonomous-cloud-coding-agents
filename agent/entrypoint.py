"""Background Agent entrypoint.

Mirrors the durable function orchestration flow from the PRD (Section 6).
Supports two modes:
  - Local batch mode: `python entrypoint.py` (reads config from env vars)
  - AgentCore server mode: imported by server.py via `run_task()`

Flow:
  1. Build configuration
  2. Context hydration: fetch GitHub issue, assemble prompt
  3. Setup: clone repo, create branch, mise install, initial build
  4. Invoke Claude Agent SDK (one-shot, unattended)
  5. Post-hooks: safety-net commit, verify build, verify lint, ensure PR
  6. Collect and return metrics
"""

import asyncio
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from urllib.parse import quote

import requests

import memory as agent_memory
import task_state
from observability import task_span
from prompts import get_system_prompt
from system_prompt import SYSTEM_PROMPT

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

AGENT_WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/workspace")


def resolve_github_token() -> str:
    """Resolve GitHub token from Secrets Manager or environment variable.

    In deployed mode, GITHUB_TOKEN_SECRET_ARN is set and the token is fetched
    from Secrets Manager on first call, then cached in os.environ.
    For local development, falls back to GITHUB_TOKEN.
    """
    # Return cached value if already resolved
    cached = os.environ.get("GITHUB_TOKEN", "")
    if cached:
        return cached
    secret_arn = os.environ.get("GITHUB_TOKEN_SECRET_ARN")
    if secret_arn:
        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_arn)
        token = resp["SecretString"]
        # Cache in env so downstream tools (git, gh CLI) work unchanged
        os.environ["GITHUB_TOKEN"] = token
        return token
    return ""


def build_config(
    repo_url: str,
    task_description: str = "",
    issue_number: str = "",
    github_token: str = "",
    anthropic_model: str = "",
    max_turns: int = 10,
    max_budget_usd: float | None = None,
    aws_region: str = "",
    dry_run: bool = False,
    task_id: str = "",
    system_prompt_overrides: str = "",
    task_type: str = "new_task",
    branch_name: str = "",
    pr_number: str = "",
) -> dict:
    """Build and validate configuration from explicit parameters.

    Parameters fall back to environment variables if empty.
    """
    config = {
        "repo_url": repo_url or os.environ.get("REPO_URL", ""),
        "issue_number": issue_number or os.environ.get("ISSUE_NUMBER", ""),
        "task_description": task_description or os.environ.get("TASK_DESCRIPTION", ""),
        "github_token": github_token or resolve_github_token(),
        "aws_region": aws_region or os.environ.get("AWS_REGION", ""),
        "anthropic_model": anthropic_model
        or os.environ.get("ANTHROPIC_MODEL", "us.anthropic.claude-sonnet-4-6"),
        "dry_run": dry_run,
        "max_turns": max_turns,
        "max_budget_usd": max_budget_usd,
        "system_prompt_overrides": system_prompt_overrides,
        "task_type": task_type,
        "branch_name": branch_name,
        "pr_number": pr_number,
    }

    errors = []
    if not config["repo_url"]:
        errors.append("repo_url is required (e.g., 'owner/repo')")
    if not config["github_token"]:
        errors.append("github_token is required")
    if not config["aws_region"]:
        errors.append("aws_region is required for Bedrock")
    if config["task_type"] == "pr_iteration":
        if not config["pr_number"]:
            errors.append("pr_number is required for pr_iteration task type")
    elif not config["issue_number"] and not config["task_description"]:
        errors.append("Either issue_number or task_description is required")

    if errors:
        raise ValueError("; ".join(errors))

    config["task_id"] = task_id or uuid.uuid4().hex[:12]
    return config


def get_config() -> dict:
    """Parse configuration from environment variables (local batch mode)."""
    try:
        return build_config(
            repo_url=os.environ.get("REPO_URL", ""),
            task_description=os.environ.get("TASK_DESCRIPTION", ""),
            issue_number=os.environ.get("ISSUE_NUMBER", ""),
            github_token=os.environ.get("GITHUB_TOKEN", ""),
            anthropic_model=os.environ.get("ANTHROPIC_MODEL", ""),
            max_turns=int(os.environ.get("MAX_TURNS", "100")),
            max_budget_usd=float(os.environ.get("MAX_BUDGET_USD", "0")) or None,
            aws_region=os.environ.get("AWS_REGION", ""),
            dry_run=os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes"),
        )
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Context hydration
# ---------------------------------------------------------------------------


def fetch_github_issue(repo_url: str, issue_number: str, token: str) -> dict:
    """Fetch a GitHub issue's title, body, and comments."""
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }

    # Fetch issue
    issue_resp = requests.get(
        f"https://api.github.com/repos/{repo_url}/issues/{issue_number}",
        headers=headers,
        timeout=30,
    )
    issue_resp.raise_for_status()
    issue = issue_resp.json()

    # Fetch comments
    comments = []
    if issue.get("comments", 0) > 0:
        comments_resp = requests.get(
            f"https://api.github.com/repos/{repo_url}/issues/{issue_number}/comments",
            headers=headers,
            timeout=30,
        )
        comments_resp.raise_for_status()
        comments = [{"author": c["user"]["login"], "body": c["body"]} for c in comments_resp.json()]

    return {
        "title": issue["title"],
        "body": issue.get("body", ""),
        "number": issue["number"],
        "comments": comments,
    }


def assemble_prompt(config: dict) -> str:
    """Assemble the user prompt from issue context and task description.

    .. deprecated::
        In production (AgentCore server mode), the orchestrator's
        ``assembleUserPrompt()`` in ``context-hydration.ts`` is the sole prompt
        assembler. The hydrated prompt arrives via ``hydrated_context["user_prompt"]``.
        This Python implementation is retained only for **local batch mode**
        (``python entrypoint.py``) and **dry-run mode** (``DRY_RUN=1``).
    """
    parts = []

    parts.append(f"Task ID: {config['task_id']}")
    parts.append(f"Repository: {config['repo_url']}")

    if config.get("issue"):
        issue = config["issue"]
        parts.append(f"\n## GitHub Issue #{issue['number']}: {issue['title']}\n")
        parts.append(issue["body"] or "(no description)")
        if issue["comments"]:
            parts.append("\n### Comments\n")
            for c in issue["comments"]:
                parts.append(f"**@{c['author']}**: {c['body']}\n")

    if config["task_description"]:
        parts.append(f"\n## Task\n\n{config['task_description']}")
    elif config.get("issue"):
        parts.append(
            "\n## Task\n\nResolve the GitHub issue described above. "
            "Follow the workflow in your system instructions."
        )

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Repository setup (deterministic pre-hooks)
# ---------------------------------------------------------------------------


def slugify(text: str, max_len: int = 40) -> str:
    """Convert text to a URL-safe slug for branch names."""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s-]+", "-", text)
    text = text.strip("-")
    if len(text) > max_len:
        text = text[:max_len].rstrip("-")
    return text or "task"


def redact_secrets(text: str) -> str:
    """Redact tokens and secrets from log output."""
    # GitHub and generic token-like values.
    text = re.sub(r"(ghp_|github_pat_|gho_|ghs_|ghr_)[A-Za-z0-9_]+", r"\1***", text)
    text = re.sub(r"(x-access-token:)[^\s@]+", r"\1***", text)
    text = re.sub(r"(authorization:\s*(?:bearer|token)\s+)[^\s]+", r"\1***", text, flags=re.I)
    text = re.sub(
        r"([?&](?:token|access_token|api_key|apikey|password)=)[^&\s]+",
        r"\1***",
        text,
        flags=re.I,
    )
    text = re.sub(r"(gh[opusr]_[A-Za-z0-9_]+)", "***", text)
    return text


def _clean_env() -> dict[str, str]:
    """Return a copy of os.environ with OTEL auto-instrumentation vars removed.

    The ``opentelemetry-instrument`` wrapper injects PYTHONPATH and OTEL_*
    env vars that would cause child Python processes (e.g. mise run build →
    semgrep in the target repo) to attempt OTEL auto-instrumentation and fail
    because the target repo's Python environment doesn't have the OTEL
    packages installed.  Stripping these vars isolates target-repo commands
    from the agent's own instrumentation.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("OTEL_")}
    # Strip only OTEL-injected PYTHONPATH components (the sitecustomize.py
    # directory), preserving any entries the target repo's toolchain may need.
    pythonpath = env.get("PYTHONPATH", "")
    if pythonpath:
        cleaned = os.pathsep.join(
            p for p in pythonpath.split(os.pathsep) if "opentelemetry" not in p
        )
        if cleaned:
            env["PYTHONPATH"] = cleaned
        else:
            env.pop("PYTHONPATH", None)
    return env


def run_cmd(
    cmd: list[str],
    label: str,
    cwd: str | None = None,
    timeout: int = 600,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a command with logging."""
    log("CMD", redact_secrets(f"{label}: {' '.join(cmd)}"))
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_clean_env(),
    )
    if result.returncode != 0:
        log("CMD", f"{label}: FAILED (exit {result.returncode})")
        if result.stderr:
            for line in result.stderr.strip().splitlines()[:20]:
                log("CMD", f"  {line}")
        if check:
            stderr_snippet = redact_secrets(result.stderr.strip()[:500]) if result.stderr else ""
            raise RuntimeError(f"{label} failed (exit {result.returncode}): {stderr_snippet}")
    else:
        log("CMD", f"{label}: OK")
    return result


def setup_repo(config: dict) -> dict:
    """Clone repo, create branch, configure git auth, run mise install.

    Returns a dict with keys: repo_dir, branch, notes, build_before,
    lint_before, and default_branch.
    """
    repo_dir = f"{AGENT_WORKSPACE}/{config['task_id']}"
    setup: dict[str, str | list[str] | bool] = {"repo_dir": repo_dir, "notes": []}

    if config.get("task_type") == "pr_iteration" and config.get("branch_name"):
        branch = config["branch_name"]
        setup["branch"] = branch
    else:
        # Derive branch slug from issue title or task description
        title = ""
        if config.get("issue"):
            title = config["issue"]["title"]
        if not title:
            title = config["task_description"]
        slug = slugify(title)
        branch = f"bgagent/{config['task_id']}/{slug}"
        setup["branch"] = branch

    # Mark the repo directory as safe for git.  On persistent session storage
    # the mount may be owned by a different UID than the container user,
    # triggering git's "dubious ownership" check on clone/resume.
    run_cmd(
        ["git", "config", "--global", "--add", "safe.directory", repo_dir],
        label="safe-directory",
    )

    # Clone
    log("SETUP", f"Cloning {config['repo_url']}...")
    run_cmd(
        ["gh", "repo", "clone", config["repo_url"], repo_dir],
        label="clone",
    )

    # Configure remote URL with embedded token so git push works without
    # credential helpers or extra auth setup inside the agent.
    token = config["github_token"]
    run_cmd(
        [
            "git",
            "remote",
            "set-url",
            "origin",
            f"https://x-access-token:{token}@github.com/{config['repo_url']}.git",
        ],
        label="set-remote-url",
        cwd=repo_dir,
    )

    # Branch setup
    if config.get("task_type") == "pr_iteration" and config.get("branch_name"):
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
        setup["notes"].append(note)
    else:
        setup["notes"].append("mise install: OK")

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
        setup["notes"].append(note)
        setup["build_before"] = False
    else:
        setup["notes"].append("Initial build (mise run build): OK")
        setup["build_before"] = True

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
        setup["notes"].append(note)
        setup["lint_before"] = False
    else:
        setup["notes"].append("Initial lint (mise run lint): OK")
        setup["lint_before"] = True

    # Detect default branch
    # For PR iteration: use base_branch from orchestrator if available
    if config.get("task_type") == "pr_iteration" and config.get("base_branch"):
        setup["default_branch"] = config["base_branch"]
    else:
        setup["default_branch"] = detect_default_branch(config["repo_url"], repo_dir)

    # Install prepare-commit-msg hook for code attribution
    _install_commit_hook(repo_dir)

    return setup


def _install_commit_hook(repo_dir: str) -> None:
    """Install the prepare-commit-msg git hook for Task-Id/Prompt-Version trailers."""
    try:
        hooks_dir = os.path.join(repo_dir, ".git", "hooks")
        os.makedirs(hooks_dir, exist_ok=True)

        hook_src = os.path.join(os.path.dirname(__file__), "prepare-commit-msg.sh")
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
    config: dict,
    setup: dict,
    build_passed: bool,
    lint_passed: bool,
    agent_result: dict | None = None,
) -> str | None:
    """Check if a PR exists for the branch; if not, create one.

    Returns the PR URL, or None if there are no commits beyond the default
    branch or PR creation failed. ``build_passed`` and ``lint_passed`` control
    the verification status shown in the PR body.
    """
    repo_dir = setup["repo_dir"]
    branch = setup["branch"]
    default_branch = setup.get("default_branch", "main")

    # PR iteration: skip PR creation — just push and return existing PR URL
    if config.get("task_type") == "pr_iteration":
        if not ensure_pushed(repo_dir, branch):
            log("WARN", "Failed to push commits before resolving PR URL")
        log("POST", "PR iteration — returning existing PR URL")
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config["repo_url"],
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
            config["repo_url"],
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
        else f"chore: bgagent/{config['task_id']}"
    )

    # Build PR body
    task_source = ""
    if config["issue_number"]:
        task_source = f"Resolves #{config['issue_number']}\n\n"
    elif config["task_description"]:
        task_source = f"**Task:** {config['task_description']}\n\n"

    build_status = "PASS" if build_passed else "FAIL"
    lint_status = "PASS" if lint_passed else "FAIL"

    cost_line = ""
    if agent_result and agent_result.get("cost_usd") is not None:
        cost_line = f"- Agent cost: **${agent_result['cost_usd']:.4f}**\n"

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
            config["repo_url"],
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


# ---------------------------------------------------------------------------
# Self-feedback extraction
# ---------------------------------------------------------------------------


def _extract_agent_notes(repo_dir: str, branch: str, config: dict) -> str | None:
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
                config["repo_url"],
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


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def get_disk_usage(path: str = AGENT_WORKSPACE) -> float:
    """Return disk usage in bytes for the given path."""
    try:
        result = subprocess.run(
            ["du", "-sb", path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return int(result.stdout.split()[0]) if result.returncode == 0 else 0
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return 0


def format_bytes(size: float) -> str:
    """Human-readable byte size."""
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size) < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def _emit_metrics_to_cloudwatch(json_payload: dict) -> None:
    """Write the METRICS_REPORT JSON event directly to CloudWatch Logs.

    Writes the log event directly to the APPLICATION_LOGS log group using the
    CloudWatch Logs API, ensuring metrics are reliably available for dashboard
    Logs Insights queries regardless of container stdout routing.
    """
    log_group = os.environ.get("LOG_GROUP_NAME")
    if not log_group:
        return

    try:
        import contextlib

        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("logs", region_name=region)

        task_id = json_payload.get("task_id", "unknown")
        log_stream = f"metrics/{task_id}"

        # Create the log stream (ignore if it already exists)
        with contextlib.suppress(client.exceptions.ResourceAlreadyExistsException):
            client.create_log_stream(logGroupName=log_group, logStreamName=log_stream)

        client.put_log_events(
            logGroupName=log_group,
            logStreamName=log_stream,
            logEvents=[
                {
                    "timestamp": int(time.time() * 1000),
                    "message": json.dumps(json_payload),
                }
            ],
        )
    except ImportError:
        print("[metrics] boto3 not available — skipping CloudWatch write", flush=True)
    except Exception as e:
        exc_type = type(e).__name__
        print(f"[metrics] CloudWatch Logs write failed (best-effort): {exc_type}: {e}", flush=True)
        if "Credential" in exc_type or "Endpoint" in exc_type or "AccessDenied" in str(e):
            print(
                "[metrics] WARNING: This may indicate a deployment misconfiguration "
                "(IAM role, VPC endpoint, or credentials). Dashboard data will be missing.",
                flush=True,
            )


class _TrajectoryWriter:
    """Write per-turn trajectory events to CloudWatch Logs.

    Follows the same pattern as ``_emit_metrics_to_cloudwatch()``: lazy boto3
    import, best-effort error handling, ``contextlib.suppress`` for idempotent
    stream creation.  Log stream: ``trajectory/{task_id}`` (parallel to the
    existing ``metrics/{task_id}`` stream).

    Events are progressively truncated to stay under the CloudWatch Logs 262 KB
    event-size limit: large fields (thinking, tool result content) are truncated
    first, then a hard byte-level safety-net truncation is applied.
    """

    _CW_MAX_EVENT_BYTES = 262_144  # CloudWatch limit per event

    _MAX_FAILURES = 3

    def __init__(self, task_id: str) -> None:
        self._task_id = task_id
        self._log_group = os.environ.get("LOG_GROUP_NAME")
        self._client = None
        self._disabled = False
        self._failure_count = 0

    def _ensure_client(self):
        """Lazily create the CloudWatch Logs client and log stream."""
        if self._client is not None:
            return
        if not self._log_group:
            self._disabled = True
            return

        import contextlib

        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        self._client = boto3.client("logs", region_name=region)

        log_stream = f"trajectory/{self._task_id}"
        with contextlib.suppress(self._client.exceptions.ResourceAlreadyExistsException):
            self._client.create_log_stream(logGroupName=self._log_group, logStreamName=log_stream)

    def _put_event(self, payload: dict) -> None:
        """Serialize *payload* to JSON, truncate if needed, and write."""
        if not self._log_group or self._disabled:
            return
        try:
            self._ensure_client()
            if self._client is None:
                self._disabled = True
                return

            message = json.dumps(payload, default=str)

            # Safety-net: hard byte-level truncation
            encoded = message.encode("utf-8")
            if len(encoded) > self._CW_MAX_EVENT_BYTES:
                print(
                    f"[trajectory] WARNING: Event exceeded CW limit even after field "
                    f"truncation ({len(encoded)} bytes). Hard-truncating — event JSON "
                    f"will be invalid.",
                    flush=True,
                )
                message = (
                    encoded[: self._CW_MAX_EVENT_BYTES - 100].decode("utf-8", errors="ignore")
                    + " [TRUNCATED]"
                )

            self._client.put_log_events(
                logGroupName=self._log_group,
                logStreamName=f"trajectory/{self._task_id}",
                logEvents=[
                    {
                        "timestamp": int(time.time() * 1000),
                        "message": message,
                    }
                ],
            )
        except ImportError:
            self._disabled = True
            print("[trajectory] boto3 not available — skipping", flush=True)
        except Exception as e:
            self._failure_count += 1
            exc_type = type(e).__name__
            if self._failure_count >= self._MAX_FAILURES:
                self._disabled = True
                print(
                    f"[trajectory] CloudWatch write failed {self._failure_count} times, "
                    f"disabling trajectory: {exc_type}: {e}",
                    flush=True,
                )
            else:
                print(
                    f"[trajectory] CloudWatch write failed ({self._failure_count}/"
                    f"{self._MAX_FAILURES}): {exc_type}: {e}",
                    flush=True,
                )
            if "Credential" in exc_type or "Endpoint" in exc_type or "AccessDenied" in str(e):
                print(
                    "[trajectory] WARNING: This may indicate a deployment misconfiguration "
                    "(IAM role, VPC endpoint, or credentials). Trajectory data will be missing.",
                    flush=True,
                )

    @staticmethod
    def _truncate_field(value: str, max_len: int = 4000) -> str:
        """Truncate a large string field for trajectory events."""
        if not value or len(value) <= max_len:
            return value
        return value[:max_len] + f"... [truncated, {len(value)} chars total]"

    def write_turn(
        self,
        turn: int,
        model: str,
        thinking: str,
        text: str,
        tool_calls: list[dict],
        tool_results: list[dict],
    ) -> None:
        """Write a TRAJECTORY_TURN event for one agent turn."""
        # Truncate large fields to stay under CloudWatch event limit
        truncated_thinking = self._truncate_field(thinking)
        truncated_text = self._truncate_field(text)
        truncated_results = []
        for tr in tool_results:
            entry = dict(tr)
            if isinstance(entry.get("content"), str):
                entry["content"] = self._truncate_field(entry["content"], 2000)
            truncated_results.append(entry)

        self._put_event(
            {
                "event": "TRAJECTORY_TURN",
                "task_id": self._task_id,
                "turn": turn,
                "model": model,
                "thinking": truncated_thinking,
                "text": truncated_text,
                "tool_calls": tool_calls,
                "tool_results": truncated_results,
            }
        )

    def write_result(
        self,
        subtype: str,
        num_turns: int,
        cost_usd: float | None,
        duration_ms: int,
        duration_api_ms: int,
        session_id: str,
        usage: dict | None,
    ) -> None:
        """Write a TRAJECTORY_RESULT summary event at session end."""
        self._put_event(
            {
                "event": "TRAJECTORY_RESULT",
                "task_id": self._task_id,
                "subtype": subtype,
                "num_turns": num_turns,
                "cost_usd": cost_usd,
                "duration_ms": duration_ms,
                "duration_api_ms": duration_api_ms,
                "session_id": session_id,
                "usage": usage,
            }
        )


# Values under these keys may contain tool stderr, paths, or incidental secrets.
_METRICS_REDACT_KEYS = frozenset({"error"})


def _metrics_payload_for_logging(metrics: dict) -> dict:
    """Build metrics dict for stdout / CloudWatch JSON (redacts sensitive fields)."""
    out: dict = {}
    for k, v in metrics.items():
        if k in _METRICS_REDACT_KEYS:
            out[k] = None if v is None else "[redacted]"
            continue
        if isinstance(v, (bool, int, float, type(None))):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def print_metrics(metrics: dict):
    """Emit a METRICS_REPORT event and print a human-readable summary.

    Writes the JSON event directly to CloudWatch Logs via
    ``_emit_metrics_to_cloudwatch()`` for dashboard querying, and prints a
    human-readable table to stdout for operator console inspection.

    Native types (int, float, bool, None) are preserved in the JSON payload.
    None values become JSON ``null`` and are excluded by ``ispresent()``
    filters in the dashboard queries. Raw ``error`` text is never logged verbatim.
    """
    safe = _metrics_payload_for_logging(metrics)
    json_payload: dict = {"event": "METRICS_REPORT", **safe}

    # Write directly to CloudWatch Logs (reliable — doesn't depend on stdout capture)
    _emit_metrics_to_cloudwatch(json_payload)

    # Also print to stdout for operator console visibility
    print(json.dumps(json_payload), flush=True)

    # Human-readable banner only; do not print keys/values from ``metrics`` (taints logging sinks).
    print("\n" + "=" * 60)
    print("METRICS REPORT")
    print("=" * 60)
    print(
        "  See structured JSON on the previous line — table omitted so metric "
        "keys are not echoed next to log sinks.",
        flush=True,
    )
    print("=" * 60)


# ---------------------------------------------------------------------------
# Agent invocation
# ---------------------------------------------------------------------------


def log(prefix: str, text: str):
    """Print a timestamped log line without dynamic payload text."""
    ts = time.strftime("%H:%M:%S")
    _ = text
    print(f"[{ts}] {prefix}", flush=True)


def truncate(text: str, max_len: int = 200) -> str:
    """Truncate text for log display."""
    if not text:
        return ""
    text = text.replace("\n", " ").strip()
    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


def _setup_agent_env(config: dict) -> tuple[str | None, str | None]:
    """Configure process environment for the Claude Code CLI subprocess.

    Sets Bedrock credentials, strips OTEL auto-instrumentation vars, and
    optionally enables CLI-native OTel telemetry.

    Returns (otlp_endpoint, otlp_protocol) for logging.
    """
    os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
    os.environ["AWS_REGION"] = config["aws_region"]
    os.environ["ANTHROPIC_MODEL"] = config["anthropic_model"]
    os.environ["GITHUB_TOKEN"] = config["github_token"]
    os.environ["GH_TOKEN"] = config["github_token"]
    # DO NOT set ANTHROPIC_LOG — any logging level causes the CLI to write to
    # stderr, which fills the OS pipe buffer (64 KB) and deadlocks the
    # single-threaded Node.js CLI process (blocked stderr write prevents stdout
    # writes, while the SDK is waiting on stdout).  The stderr callback in
    # ClaudeAgentOptions cannot drain fast enough to prevent this.
    os.environ.pop("ANTHROPIC_LOG", None)
    os.environ["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "anthropic.claude-haiku-4-5-20251001-v1:0"

    # Save OTLP endpoint/protocol configured by ADOT auto-instrumentation
    # before stripping, so we can re-use it for Claude Code CLI telemetry.
    otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    otlp_protocol = os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL")

    # Strip OTEL auto-instrumentation vars from os.environ so target-repo
    # child processes (mise run build, pytest, semgrep, etc.) don't attempt
    # Python OTEL auto-instrumentation using the agent's packages.
    # The agent's own TracerProvider is already configured at startup — it does
    # not re-read env vars, so removing them is safe.
    for key in [k for k in os.environ if k.startswith("OTEL_")]:
        del os.environ[key]
    pythonpath = os.environ.get("PYTHONPATH", "")
    if pythonpath:
        cleaned = os.pathsep.join(
            p for p in pythonpath.split(os.pathsep) if "opentelemetry" not in p
        )
        if cleaned:
            os.environ["PYTHONPATH"] = cleaned
        else:
            os.environ.pop("PYTHONPATH", None)

    # Enable Claude Code CLI's native OTel telemetry if an OTLP endpoint is
    # available.  The CLI exports events (tool results, API requests/errors,
    # tool decisions) as OTLP logs with per-prompt granularity — beyond the
    # aggregate ResultMessage at session end.
    #
    # Gated on ENABLE_CLI_TELEMETRY env var (opt-in) because the ADOT sidecar
    # in AgentCore Runtime is only confirmed to forward traces (configured via
    # CfnRuntimeLogsMixin.TRACES.toXRay() in CDK). Whether the sidecar also
    # forwards OTLP logs is unconfirmed. Set ENABLE_CLI_TELEMETRY=1 in the
    # runtime environment to enable and verify logs appear in CloudWatch.
    #
    # Configuration choices based on AWS documentation:
    #   - OTEL_METRICS_EXPORTER=none: All AWS ADOT examples disable metrics
    #     export. CloudWatch does not ingest OTLP metrics from the sidecar.
    #   - OTEL_TRACES_EXPORTER=none: Explicitly disabled. The agent's own
    #     custom spans (task.pipeline, task.agent_execution, etc.) already
    #     provide trace-level coverage via the Python ADOT auto-instrumentation.
    #   - OTEL_LOGS_EXPORTER=otlp: SDK events (tool_result, api_request, etc.)
    #     are the primary telemetry of interest and are exported as OTLP logs.
    #   - OTEL_EXPORTER_OTLP_LOGS_HEADERS: Includes the application log group
    #     name so that, if the exporter sends directly to CloudWatch's OTLP
    #     endpoint, logs land in the correct log group. Ignored by the sidecar
    #     if it has its own routing config.
    #   - Protocol defaults to http/protobuf (AWS-recommended for OTLP).
    #
    # NOTE: These env vars are set on os.environ (process-global) because the
    # Claude Agent SDK spawns the CLI subprocess from the process environment.
    # This is safe for single-task-per-container deployments (AgentCore Runtime
    # allocates one session per container).  If concurrent tasks ever share a
    # process, this must be revisited (pass env via subprocess instead).
    if os.environ.get("ENABLE_CLI_TELEMETRY") == "1":
        if not otlp_endpoint:
            log("WARN", "OTEL_EXPORTER_OTLP_ENDPOINT not set by ADOT")
            # Default to http/protobuf on port 4318 (AWS-recommended protocol).
            otlp_endpoint = "http://localhost:4318"
        if not otlp_protocol:
            otlp_protocol = "http/protobuf"

        os.environ["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
        os.environ["OTEL_METRICS_EXPORTER"] = "none"
        os.environ["OTEL_TRACES_EXPORTER"] = "none"
        os.environ["OTEL_LOGS_EXPORTER"] = "otlp"
        os.environ["OTEL_EXPORTER_OTLP_PROTOCOL"] = otlp_protocol
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = otlp_endpoint
        os.environ["OTEL_LOG_TOOL_DETAILS"] = "1"

        # Route OTLP logs to the application log group. This header is used
        # when sending directly to CloudWatch's OTLP logs endpoint
        # (https://logs.{region}.amazonaws.com/v1/logs). If the exporter
        # sends to the ADOT sidecar instead, the sidecar may ignore this.
        log_group = os.environ.get("LOG_GROUP_NAME", "")
        if log_group:
            os.environ["OTEL_EXPORTER_OTLP_LOGS_HEADERS"] = f"x-aws-log-group={log_group}"

        # Tag all SDK telemetry with task metadata for correlation in CloudWatch.
        # Values are percent-encoded per the OTEL_RESOURCE_ATTRIBUTES spec to
        # handle any special characters (commas, equals, spaces) in config values.
        os.environ["OTEL_RESOURCE_ATTRIBUTES"] = (
            f"task.id={quote(config.get('task_id', 'unknown'), safe='')},"
            f"repo.url={quote(config.get('repo_url', 'unknown'), safe='')},"
            f"agent.model={quote(config.get('anthropic_model', 'unknown'), safe='')}"
        )
        log(
            "AGENT",
            f"Claude Code telemetry enabled: endpoint={otlp_endpoint} "
            f"protocol={otlp_protocol} logs_log_group={log_group or '(not set)'}",
        )
    else:
        log("AGENT", "Claude Code CLI telemetry disabled (set ENABLE_CLI_TELEMETRY=1 to enable)")

    return otlp_endpoint, otlp_protocol


async def run_agent(
    prompt: str, system_prompt: str, config: dict, cwd: str = AGENT_WORKSPACE
) -> dict:
    """Invoke the Claude Agent SDK and stream output."""
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ThinkingBlock,
        ToolResultBlock,
        ToolUseBlock,
    )

    _setup_agent_env(config)

    stderr_line_count = 0

    def _on_stderr(line: str) -> None:
        nonlocal stderr_line_count
        stderr_line_count += 1
        log("CLI", line.rstrip())

    # Log SDK and CLI versions for diagnosing protocol mismatches
    import claude_agent_sdk as _sdk

    sdk_version = getattr(_sdk, "__version__", "unknown")
    log("AGENT", f"claude-agent-sdk version: {sdk_version}")
    cli_path = subprocess.run(["which", "claude"], capture_output=True, text=True, timeout=5)
    if cli_path.returncode == 0:
        cli_ver = subprocess.run(
            ["claude", "--version"], capture_output=True, text=True, timeout=10
        )
        log("AGENT", f"claude CLI: {cli_path.stdout.strip()} version={cli_ver.stdout.strip()}")
    else:
        log("WARN", "claude CLI not found on PATH")

    options = ClaudeAgentOptions(
        model=config["anthropic_model"],
        system_prompt=system_prompt,
        allowed_tools=["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"],
        permission_mode="bypassPermissions",
        cwd=cwd,
        max_turns=config["max_turns"],
        setting_sources=["project"],
        **({"max_budget_usd": config["max_budget_usd"]} if config.get("max_budget_usd") else {}),
        stderr=_on_stderr,
    )

    result: dict[str, object] = {"status": "unknown", "turns": 0, "cost_usd": None}
    message_counts = {"system": 0, "assistant": 0, "result": 0, "other": 0}
    trajectory = _TrajectoryWriter(config.get("task_id", "unknown"))

    # Use ClaudeSDKClient (connect/query/receive_response) instead of the
    # standalone query() function.  This matches the official AWS sample:
    # https://github.com/aws-samples/sample-deploy-ClaudeAgentSDK-based-agents-to-AgentCore-Runtime
    client = ClaudeSDKClient(options=options)
    log("AGENT", "Connecting to Claude Code CLI subprocess...")
    await client.connect()
    log("AGENT", "Connected. Sending prompt...")
    await client.query(prompt=prompt)
    log("AGENT", "Prompt sent. Receiving messages...")
    try:
        async for message in client.receive_response():
            if isinstance(message, SystemMessage):
                message_counts["system"] += 1
                log("SYS", f"{message.subtype}: {message.data}")
                if message.subtype == "init" and isinstance(message.data, dict):
                    cli_ver = message.data.get("claude_code_version", "?")
                    log("SYS", f"CLI reports version: {cli_ver}")
                log("AGENT", "Waiting for next message from CLI...")

            elif isinstance(message, AssistantMessage):
                message_counts["assistant"] += 1
                result["turns"] += 1
                log("TURN", f"#{result['turns']} (model: {message.model})")

                # Per-turn accumulators for trajectory
                turn_thinking = ""
                turn_text = ""
                turn_tool_calls: list[dict] = []
                turn_tool_results: list[dict] = []

                for block in message.content:
                    if isinstance(block, ThinkingBlock):
                        log("THINK", truncate(block.thinking, 200))
                        turn_thinking += block.thinking + "\n"
                    elif isinstance(block, TextBlock):
                        print(block.text, flush=True)
                        turn_text += block.text + "\n"
                    elif isinstance(block, ToolUseBlock):
                        tool_input = block.input
                        if block.name == "Bash":
                            cmd = tool_input.get("command", "")
                            log("TOOL", f"Bash: {truncate(cmd, 300)}")
                        elif block.name in ("Read", "Glob", "Grep"):
                            log("TOOL", f"{block.name}: {truncate(str(tool_input))}")
                        elif block.name in ("Write", "Edit"):
                            path = tool_input.get("file_path", "")
                            log("TOOL", f"{block.name}: {path}")
                        else:
                            log("TOOL", f"{block.name}: {truncate(str(tool_input))}")
                        turn_tool_calls.append({"name": block.name, "input": tool_input})
                    elif isinstance(block, ToolResultBlock):
                        status = "ERROR" if block.is_error else "ok"
                        content = (
                            block.content if isinstance(block.content, str) else str(block.content)
                        )
                        log("RESULT", f"[{status}] {truncate(content)}")
                        turn_tool_results.append(
                            {
                                "tool_use_id": getattr(block, "tool_use_id", ""),
                                "is_error": block.is_error,
                                "content": content,
                            }
                        )

                # Write trajectory event for this turn
                trajectory.write_turn(
                    turn=result["turns"],
                    model=message.model,
                    thinking=turn_thinking.strip(),
                    text=turn_text.strip(),
                    tool_calls=turn_tool_calls,
                    tool_results=turn_tool_results,
                )

            elif isinstance(message, ResultMessage):
                message_counts["result"] += 1
                result["status"] = message.subtype
                result["cost_usd"] = getattr(message, "total_cost_usd", None)
                result["num_turns"] = getattr(message, "num_turns", 0)
                result["duration_ms"] = getattr(message, "duration_ms", 0)
                result["duration_api_ms"] = getattr(message, "duration_api_ms", 0)
                result["session_id"] = getattr(message, "session_id", "")

                # Capture token usage from ResultMessage
                raw_usage = getattr(message, "usage", None)
                if raw_usage is not None:
                    # Handle both object (dataclass) and dict forms
                    if isinstance(raw_usage, dict):
                        usage_dict: dict | None = {
                            "input_tokens": raw_usage.get("input_tokens", 0),
                            "output_tokens": raw_usage.get("output_tokens", 0),
                            "cache_read_input_tokens": raw_usage.get("cache_read_input_tokens", 0),
                            "cache_creation_input_tokens": raw_usage.get(
                                "cache_creation_input_tokens", 0
                            ),
                        }
                    else:
                        usage_dict = {
                            "input_tokens": getattr(raw_usage, "input_tokens", 0),
                            "output_tokens": getattr(raw_usage, "output_tokens", 0),
                            "cache_read_input_tokens": getattr(
                                raw_usage, "cache_read_input_tokens", 0
                            ),
                            "cache_creation_input_tokens": getattr(
                                raw_usage, "cache_creation_input_tokens", 0
                            ),
                        }
                    result["usage"] = usage_dict
                    if all(v == 0 for v in usage_dict.values()):
                        log(
                            "WARN",
                            f"All token usage values are zero — usage object "
                            f"type={type(raw_usage).__name__}",
                        )
                    else:
                        log(
                            "USAGE",
                            f"input={usage_dict['input_tokens']} "
                            f"output={usage_dict['output_tokens']} "
                            f"cache_read={usage_dict['cache_read_input_tokens']} "
                            f"cache_create={usage_dict['cache_creation_input_tokens']}",
                        )
                else:
                    usage_dict = None
                    result["usage"] = None

                log(
                    "DONE",
                    f"status={message.subtype} turns={message.num_turns} "
                    f"cost=${message.total_cost_usd or 0:.4f} "
                    f"duration={message.duration_ms / 1000:.1f}s",
                )
                if message.is_error and message.result:
                    log("ERROR", message.result)

                # Write trajectory result summary
                trajectory.write_result(
                    subtype=message.subtype,
                    num_turns=getattr(message, "num_turns", 0),
                    cost_usd=getattr(message, "total_cost_usd", None),
                    duration_ms=getattr(message, "duration_ms", 0),
                    duration_api_ms=getattr(message, "duration_api_ms", 0),
                    session_id=getattr(message, "session_id", ""),
                    usage=usage_dict,
                )

            else:
                message_counts["other"] += 1
                log(
                    "MSG",
                    f"Unrecognized message type: {type(message).__name__}: "
                    f"{truncate(str(message), 300)}",
                )

    except Exception as e:
        log("ERROR", f"Exception during receive_response(): {type(e).__name__}: {e}")
        if result["status"] == "unknown":
            result["status"] = "error"
            result["error"] = f"receive_response() failed: {e}"

    log("AGENT", f"Generator finished. Messages received: {message_counts}")
    log("AGENT", f"CLI stderr lines received: {stderr_line_count}")
    if message_counts["assistant"] == 0 and message_counts["system"] > 0:
        log(
            "WARN",
            "Got init SystemMessage but zero AssistantMessages. The CLI subprocess "
            "started but produced no turns. Likely causes: (1) Bedrock API auth/connectivity "
            "failure, (2) SDK↔CLI protocol mismatch, (3) CLI crash after init. "
            "Check [CLI] stderr lines above for errors.",
        )
    if message_counts["result"] == 0:
        log(
            "WARN",
            "No ResultMessage received from the agent SDK — "
            "agent metrics (cost, turns) will be unavailable",
        )

    return result


# ---------------------------------------------------------------------------
# run_task — core pipeline callable from server.py or main()
# ---------------------------------------------------------------------------


def _build_system_prompt(
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


def _discover_project_config(repo_dir: str) -> dict[str, list[str]]:
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


def _write_memory(
    config: dict,
    setup: dict,
    agent_result: dict,
    start_time: float,
    build_passed: bool,
    pr_url: str | None,
    memory_id: str,
) -> bool:
    """Write task episode and repo learnings to AgentCore Memory.

    Returns True if any memory was successfully written.
    """
    # Parse self-feedback from PR body — separate try-catch so extraction
    # failures don't mask memory write errors (and vice versa).
    self_feedback = None
    try:
        self_feedback = _extract_agent_notes(setup["repo_dir"], setup["branch"], config)
    except Exception as e:
        log(
            "WARN",
            f"Agent notes extraction failed (non-fatal): {type(e).__name__}: {e}",
        )

    raw_cost = agent_result.get("cost_usd")
    try:
        episode_cost: float | None = float(raw_cost) if raw_cost is not None else None
    except (ValueError, TypeError):
        log("WARN", f"Invalid cost_usd: '{raw_cost}'")
        episode_cost = None

    # Memory writes are individually fail-open (return False on error)
    episode_ok = agent_memory.write_task_episode(
        memory_id=memory_id,
        repo=config["repo_url"],
        task_id=config["task_id"],
        status="COMPLETED" if build_passed else "FAILED",
        pr_url=pr_url,
        cost_usd=episode_cost,
        duration_s=round(time.time() - start_time, 1),
        self_feedback=self_feedback,
    )

    learnings_ok = False
    if self_feedback:
        learnings_ok = agent_memory.write_repo_learnings(
            memory_id=memory_id,
            repo=config["repo_url"],
            task_id=config["task_id"],
            learnings=self_feedback,
        )

    log("MEMORY", f"Memory write: episode={episode_ok}, learnings={learnings_ok}")
    return episode_ok or learnings_ok


def run_task(
    repo_url: str,
    task_description: str = "",
    issue_number: str = "",
    github_token: str = "",
    anthropic_model: str = "",
    max_turns: int = 100,
    max_budget_usd: float | None = None,
    aws_region: str = "",
    task_id: str = "",
    hydrated_context: dict | None = None,
    system_prompt_overrides: str = "",
    prompt_version: str = "",
    memory_id: str = "",
    task_type: str = "new_task",
    branch_name: str = "",
    pr_number: str = "",
) -> dict:
    """Run the full agent pipeline and return a result dict.

    This is the main entry point for both:
      - AgentCore server mode (called by server.py /invocations)
      - Local batch mode (called by main())

    Returns a dict with: status, pr_url, build_passed, cost_usd,
    turns, duration_s, task_id, error.
    """
    from opentelemetry.trace import StatusCode

    # Build config
    config = build_config(
        repo_url=repo_url,
        task_description=task_description,
        issue_number=issue_number,
        github_token=github_token,
        anthropic_model=anthropic_model,
        max_turns=max_turns,
        max_budget_usd=max_budget_usd,
        aws_region=aws_region,
        task_id=task_id,
        system_prompt_overrides=system_prompt_overrides,
        task_type=task_type,
        branch_name=branch_name,
        pr_number=pr_number,
    )

    log("TASK", f"Task ID: {config['task_id']}")
    log("TASK", f"Repository: {config['repo_url']}")
    log("TASK", f"Issue: {config['issue_number'] or '(none)'}")
    log("TASK", f"Model: {config['anthropic_model']}")

    with task_span(
        "task.pipeline",
        attributes={
            "task.id": config["task_id"],
            "repo.url": config["repo_url"],
            "issue.number": config.get("issue_number", ""),
            "agent.model": config["anthropic_model"],
        },
    ) as root_span:
        task_state.write_running(config["task_id"])

        try:
            # Context hydration
            with task_span("task.context_hydration"):
                if hydrated_context:
                    log("TASK", "Using hydrated context from orchestrator")
                    prompt = hydrated_context["user_prompt"]
                    if hydrated_context.get("issue"):
                        config["issue"] = hydrated_context["issue"]
                    if hydrated_context.get("resolved_base_branch"):
                        config["base_branch"] = hydrated_context["resolved_base_branch"]
                    if hydrated_context.get("truncated"):
                        log("WARN", "Context was truncated by orchestrator token budget")
                else:
                    # Local batch mode — fetch issue and assemble prompt in-container
                    if config["issue_number"]:
                        log("TASK", f"Fetching issue #{config['issue_number']}...")
                        config["issue"] = fetch_github_issue(
                            config["repo_url"], config["issue_number"], config["github_token"]
                        )
                        log("TASK", f"  Title: {config['issue']['title']}")

                    prompt = assemble_prompt(config)

            # Configure git and gh auth before setup_repo() uses them
            subprocess.run(
                ["git", "config", "--global", "user.name", "bgagent"],
                check=True,
                capture_output=True,
                timeout=60,
            )
            subprocess.run(
                ["git", "config", "--global", "user.email", "bgagent@noreply.github.com"],
                check=True,
                capture_output=True,
                timeout=60,
            )
            os.environ["GITHUB_TOKEN"] = config["github_token"]
            os.environ["GH_TOKEN"] = config["github_token"]

            # Set env vars for the prepare-commit-msg hook BEFORE setup_repo()
            # so the hook has access to TASK_ID/PROMPT_VERSION from the start.
            os.environ["TASK_ID"] = config["task_id"]
            if prompt_version:
                os.environ["PROMPT_VERSION"] = prompt_version

            # Setup repo (deterministic pre-hooks)
            with task_span("task.repo_setup") as setup_span:
                setup = setup_repo(config)
                setup_span.set_attribute("build.before", setup.get("build_before", False))

            system_prompt = _build_system_prompt(
                config, setup, hydrated_context, system_prompt_overrides
            )

            # Log discovered repo-level project configuration
            # (all files loaded by setting_sources=["project"])
            repo_dir = setup["repo_dir"]
            project_config = _discover_project_config(repo_dir)
            if project_config:
                log("TASK", f"Repo project configuration: {project_config}")
            else:
                log("TASK", "No repo-level project configuration found")

            # Run agent
            disk_before = get_disk_usage(AGENT_WORKSPACE)
            start_time = time.time()

            log("TASK", "Starting agent...")
            if config.get("max_budget_usd"):
                log("TASK", f"Budget limit: ${config['max_budget_usd']:.2f}")
            # Warn if uvloop is the active policy — subprocess SIGCHLD conflicts.
            policy = asyncio.get_event_loop_policy()
            policy_name = type(policy).__name__
            if "uvloop" in policy_name.lower():
                log(
                    "WARN",
                    f"uvloop detected ({policy_name}) — this may cause subprocess "
                    f"SIGCHLD conflicts with the Claude Agent SDK",
                )
            with task_span("task.agent_execution") as agent_span:
                try:
                    agent_result = asyncio.run(
                        run_agent(prompt, system_prompt, config, cwd=setup["repo_dir"])
                    )
                except Exception as e:
                    log("ERROR", f"Agent failed: {e}")
                    agent_span.set_status(StatusCode.ERROR, str(e))
                    agent_span.record_exception(e)
                    agent_result = {
                        "status": "error",
                        "turns": 0,
                        "cost_usd": None,
                        "error": str(e),
                    }

            # Post-hooks
            with task_span("task.post_hooks") as post_span:
                # Safety net: commit any uncommitted tracked changes
                safety_committed = ensure_committed(setup["repo_dir"])
                post_span.set_attribute("safety_net.committed", safety_committed)

                build_passed = verify_build(setup["repo_dir"])
                lint_passed = verify_lint(setup["repo_dir"])
                pr_url = ensure_pr(
                    config, setup, build_passed, lint_passed, agent_result=agent_result
                )
                post_span.set_attribute("build.passed", build_passed)
                post_span.set_attribute("lint.passed", lint_passed)
                post_span.set_attribute("pr.url", pr_url or "")

            # Memory write — capture task episode and repo learnings
            memory_written = False
            effective_memory_id = memory_id or os.environ.get("MEMORY_ID", "")
            if effective_memory_id:
                memory_written = _write_memory(
                    config,
                    setup,
                    agent_result,
                    start_time,
                    build_passed,
                    pr_url,
                    effective_memory_id,
                )

            # Metrics
            duration = time.time() - start_time
            disk_after = get_disk_usage(AGENT_WORKSPACE)

            # Determine overall status:
            #   - "success" if the agent reported success/end_turn and the build passes
            #     (or the build was already broken before the agent ran — pre-existing failure)
            #   - "success" if agent_status is unknown (SDK didn't yield ResultMessage)
            #     but the pipeline produced a PR and the build didn't regress
            #   - "error" otherwise
            # NOTE: lint_passed is intentionally NOT used in the status
            # determination — lint failures are advisory and reported in the PR
            # body and span attributes but do not affect the task's terminal
            # status. Lint regression detection is planned for Iteration 3c.
            agent_status = agent_result["status"]
            # Default True = assume build was green before, so a post-agent
            # failure IS counted as a regression (conservative).
            build_before = setup.get("build_before", True)
            build_ok = build_passed or not build_before
            if not build_passed and not build_before:
                log(
                    "WARN",
                    "Post-agent build failed, but build was already failing before "
                    "agent changes — not counting as regression",
                )
            if agent_status in ("success", "end_turn") and build_ok:
                overall_status = "success"
            elif agent_status == "unknown" and pr_url and build_ok:
                log(
                    "WARN",
                    "Agent SDK did not yield a ResultMessage, but PR was created "
                    "and build didn't regress — treating as success",
                )
                overall_status = "success"
            else:
                overall_status = "error"

            result = {
                "status": overall_status,
                "agent_status": agent_status,
                "pr_url": pr_url,
                "build_passed": build_passed,
                "lint_passed": lint_passed,
                "cost_usd": agent_result.get("cost_usd"),
                "turns": agent_result.get("num_turns") or agent_result.get("turns"),
                "duration_s": round(duration, 1),
                "task_id": config["task_id"],
                "disk_before": format_bytes(disk_before),
                "disk_after": format_bytes(disk_after),
                "disk_delta": format_bytes(disk_after - disk_before),
                "prompt_version": prompt_version or None,
                "memory_written": memory_written,
            }
            if agent_result.get("error"):
                result["error"] = agent_result["error"]
            if agent_result.get("session_id"):
                result["session_id"] = agent_result["session_id"]

            # Propagate token usage from agent result into metrics
            usage = agent_result.get("usage")
            if isinstance(usage, dict):
                result["input_tokens"] = usage.get("input_tokens", 0)
                result["output_tokens"] = usage.get("output_tokens", 0)
                result["cache_read_input_tokens"] = usage.get("cache_read_input_tokens", 0)
                result["cache_creation_input_tokens"] = usage.get("cache_creation_input_tokens", 0)
            elif usage is not None:
                log(
                    "WARN",
                    f"agent_result['usage'] has unexpected type {type(usage).__name__} — "
                    f"token usage will not be recorded in metrics or span attributes",
                )

            # Record terminal attributes on the root span for CloudWatch querying
            root_span.set_attribute("task.status", overall_status)
            cost = agent_result.get("cost_usd")
            if cost is not None:
                root_span.set_attribute("agent.cost_usd", float(cost))
            turns = agent_result.get("num_turns") or agent_result.get("turns")
            if turns is not None:
                root_span.set_attribute("agent.turns", int(turns))
            root_span.set_attribute("build.passed", build_passed)
            root_span.set_attribute("lint.passed", lint_passed)
            root_span.set_attribute("pr.url", pr_url or "")
            root_span.set_attribute("task.duration_s", round(duration, 1))
            if isinstance(usage, dict):
                root_span.set_attribute("agent.input_tokens", usage.get("input_tokens", 0))
                root_span.set_attribute("agent.output_tokens", usage.get("output_tokens", 0))
                root_span.set_attribute(
                    "agent.cache_read_input_tokens",
                    usage.get("cache_read_input_tokens", 0),
                )
                root_span.set_attribute(
                    "agent.cache_creation_input_tokens",
                    usage.get("cache_creation_input_tokens", 0),
                )
            if overall_status != "success":
                root_span.set_status(
                    StatusCode.ERROR, str(result.get("error", "task did not succeed"))
                )

            # Emit metrics to CloudWatch Logs and print summary to stdout
            print_metrics(result)

            # Persist terminal state to DynamoDB
            terminal_status = "COMPLETED" if overall_status == "success" else "FAILED"
            task_state.write_terminal(config["task_id"], terminal_status, result)

            return result

        except Exception as e:
            # Ensure the task is marked FAILED in DynamoDB even if the pipeline
            # crashes before reaching the normal terminal-state write.
            task_state.write_terminal(config["task_id"], "FAILED", {"error": str(e)})
            raise


# ---------------------------------------------------------------------------
# Local batch mode
# ---------------------------------------------------------------------------


def main():
    config = get_config()

    print("Task configuration loaded.", flush=True)
    print("Dry run mode detected.", flush=True)
    print()

    if config["dry_run"]:
        # Context hydration for dry run
        if config["issue_number"]:
            config["issue"] = fetch_github_issue(
                config["repo_url"], config["issue_number"], config["github_token"]
            )
        prompt = assemble_prompt(config)
        system_prompt = SYSTEM_PROMPT.replace("{repo_url}", config["repo_url"])
        system_prompt = system_prompt.replace("{task_id}", config["task_id"])
        system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
        system_prompt = system_prompt.replace("{branch_name}", "bgagent/{task_id}/dry-run")
        system_prompt = system_prompt.replace("{default_branch}", "main")
        system_prompt = system_prompt.replace("{max_turns}", str(config.get("max_turns", 100)))
        system_prompt = system_prompt.replace("{setup_notes}", "(dry run — setup not executed)")
        system_prompt = system_prompt.replace("{memory_context}", "(dry run — memory not loaded)")
        overrides = config.get("system_prompt_overrides", "")
        if overrides:
            system_prompt += f"\n\n## Additional instructions\n\n{overrides}"
        system_prompt_hash = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:12]
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        print("\n--- SYSTEM PROMPT (REDACTED) ---")
        print(
            f"length={len(system_prompt)} chars sha256={system_prompt_hash} "
            "(set DEBUG_DRY_RUN_PROMPTS=1 to print full text)",
            flush=True,
        )
        print("\n--- USER PROMPT (REDACTED) ---")
        print(
            f"length={len(prompt)} chars sha256={prompt_hash} "
            "(set DEBUG_DRY_RUN_PROMPTS=1 to print full text)",
            flush=True,
        )
        if os.environ.get("DEBUG_DRY_RUN_PROMPTS") == "1":
            print(
                "\nDEBUG_DRY_RUN_PROMPTS=1 is set, but full prompt printing is disabled "
                "for secure logging compliance.",
                flush=True,
            )
        print("\n--- DRY RUN COMPLETE ---")
        return

    # Run the full pipeline.  run_task() is sync and calls asyncio.run()
    # internally, so main() must NOT be async (nested asyncio.run() is illegal).
    result = run_task(
        repo_url=config["repo_url"],
        task_description=config["task_description"],
        issue_number=config["issue_number"],
        github_token=config["github_token"],
        anthropic_model=config["anthropic_model"],
        max_turns=config["max_turns"],
        max_budget_usd=config.get("max_budget_usd"),
        aws_region=config["aws_region"],
        system_prompt_overrides=config.get("system_prompt_overrides", ""),
    )

    # Exit with error if agent failed
    if result["status"] != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
