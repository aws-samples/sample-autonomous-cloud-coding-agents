"""Repository setup: clone, branch, mise install, initial build."""

import os
import subprocess
from typing import Any

from config import AGENT_WORKSPACE
from models import RepoSetup, TaskConfig
from shell import log, run_cmd, run_cmd_with_backoff, slugify


def _clone_backoff_reporter(progress: Any, label: str):
    """Build an ``on_retry`` callback that emits a ``dependency_unreachable``
    blocker event per transient retry (#251, Phase 2) — auditable in the live
    stream + 90d record. Returns ``None`` when no progress writer is wired so
    ``run_cmd_with_backoff`` simply logs to CMD."""
    if progress is None:
        return None

    from hooks import _try_progress

    def _on_retry(attempt: int, max_attempts: int, stderr: str) -> None:
        _try_progress(
            progress,
            "write_agent_blocked",
            kind="dependency_unreachable",
            detail=f"{label} transient failure (attempt {attempt}/{max_attempts})",
            remediation_hint=(
                "Retrying with backoff; check registry/network reachability if this persists."
            ),
            retryable=True,
        )

    return _on_retry


class DependencyUnreachableError(RuntimeError):
    """Raised when repo setup cannot reach a dependency after bounded retries
    (#251, Phase 2). Its message is the canonical ``BLOCKED[dependency_unreachable]``
    reason so the crash path carries it into the terminal ``error`` verbatim and
    the CDK classifier attaches a precise remedy."""


def _fail_setup_command(label: str, resource: str, stderr: str, progress: Any) -> None:
    """Handle a failed clone/fetch after bounded retries.

    Three-way classification, in priority order:

    1. **Egress denial** — the stderr matches a name-resolution / connection
       signature naming a host (``detect_egress_denial``). A firewalled host is
       NOT a transient blip: retrying never helps, and the true remedy is
       "allowlist the host", not "retry the task". Report a non-retryable
       ``egress_denied`` blocker naming the host so the classifier routes to the
       DNS-Firewall remedy — the same verdict the PostToolUse egress detector
       reaches for the identical stderr (they must not disagree).
    2. **Transient** — a DNS/registry blip that survived the retries with no
       nameable host: report a retryable ``dependency_unreachable`` blocker.
    3. **Permanent** — repo not found, auth denied: re-raise a plain
       ``RuntimeError`` carrying the redacted git stderr, preserving the pre-#251
       ``check=True`` behavior so the classifier routes it to the right (auth /
       not-found) remedy rather than mislabeling it retryable.

    Never widens creds/egress — it only reports."""
    # (1) Egress denial takes priority over the transient set: several signatures
    # ("could not resolve host", "network is unreachable", EAI_AGAIN) live in
    # BOTH the transient set and the egress patterns. A captured host means a
    # firewalled endpoint — non-retryable — so classify it as egress_denied
    # before the transient branch, matching hooks.detect_egress_denial.
    from hooks import _record_blocker_reason, _try_progress, detect_egress_denial
    from shell import is_transient_cmd_failure, redact_secrets

    egress_detected, host = detect_egress_denial(stderr)
    if egress_detected and host:
        detail = f"{label} could not reach {host!r} (host not allowlisted)"
        _record_blocker_reason("egress_denied", detail, host)
        if progress is not None:
            _try_progress(
                progress,
                "write_agent_blocked",
                kind="egress_denied",
                detail=detail,
                remediation_hint=(
                    f"Allowlist {host!r} in the DNS Firewall rule group if it is a "
                    "legitimate dependency, then resubmit. The agent never widens egress itself."
                ),
                retryable=False,
                resource=host,
            )
        from progress_writer import format_blocker_reason

        raise DependencyUnreachableError(format_blocker_reason("egress_denied", detail, host))

    if not is_transient_cmd_failure(stderr):
        # (3) Permanent. Redact before raising — this message is persisted to
        # TaskResult.error (DynamoDB, `bgagent status`). The pre-#251 check=True
        # path redacted here (shell.py run_cmd); preserve that so a credential in
        # git stderr never lands in cleartext.
        snippet = redact_secrets((stderr or "").strip()[:500])
        raise RuntimeError(f"{label} failed (non-transient): {snippet}")

    # (2) Transient with no nameable host.
    from progress_writer import format_blocker_reason

    detail = f"{label} failed after bounded retries"
    _record_blocker_reason("dependency_unreachable", detail, resource)
    if progress is not None:
        _try_progress(
            progress,
            "write_agent_blocked",
            kind="dependency_unreachable",
            detail=detail,
            remediation_hint=(
                "The dependency/registry stayed unreachable after retries. "
                "Check network/DNS reachability from the agent VPC, then retry the task."
            ),
            retryable=True,
            resource=resource,
        )
    raise DependencyUnreachableError(
        format_blocker_reason("dependency_unreachable", detail, resource)
    )


def setup_repo(config: TaskConfig, progress: Any = None) -> RepoSetup:
    """Clone repo, create branch, configure git auth, run mise install.

    Returns a RepoSetup with repo_dir, branch, notes, build_before,
    lint_before, and default_branch.

    ``progress`` is optional (preserves legacy/test call shape). When present,
    transient clone/fetch retries emit ``dependency_unreachable`` blocker
    events (#251, Phase 2).
    """
    repo_dir = f"{AGENT_WORKSPACE}/{config.task_id}"
    notes: list[str] = []

    if config.is_pr_workflow and config.branch_name:
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

    # Clone — bounded retry on transient network/registry failures (#251).
    log("SETUP", f"Cloning {config.repo_url}...")
    clone_result = run_cmd_with_backoff(
        ["gh", "repo", "clone", config.repo_url, repo_dir],
        label="clone",
        on_retry=_clone_backoff_reporter(progress, "clone"),
    )
    if clone_result.returncode != 0:
        _fail_setup_command("clone", config.repo_url, clone_result.stderr, progress)

    # Pin the remote to the plain https URL (no embedded credentials) and
    # authenticate git push via gh's credential helper. Embedding the token
    # in the remote URL would persist it in .git/config inside the workspace
    # the agent (and any code it runs) fully controls — readable by a
    # prompt-injected step, `git remote -v`, or anything that copies the
    # tree. The helper resolves credentials at call time from the
    # GH_TOKEN/GITHUB_TOKEN env vars the caller exports before setup_repo(),
    # so the token never touches disk.
    run_cmd(
        [
            "git",
            "remote",
            "set-url",
            "origin",
            f"https://github.com/{config.repo_url}.git",
        ],
        label="set-remote-url",
        cwd=repo_dir,
    )
    run_cmd(
        ["git", "config", "--local", "credential.helper", "!gh auth git-credential"],
        label="configure-git-credential-helper",
        cwd=repo_dir,
    )

    # Branch setup
    if config.is_pr_workflow and config.branch_name:
        log("SETUP", f"Checking out existing PR branch: {branch}")
        fetch_result = run_cmd_with_backoff(
            ["git", "fetch", "origin", branch],
            label="fetch-pr-branch",
            cwd=repo_dir,
            on_retry=_clone_backoff_reporter(progress, "fetch-pr-branch"),
        )
        if fetch_result.returncode != 0:
            _fail_setup_command("fetch-pr-branch", branch, fetch_result.stderr, progress)
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
    if config.is_pr_workflow and config.base_branch:
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
    except (OSError, subprocess.SubprocessError) as exc:
        # gh missing from PATH (FileNotFoundError is an OSError), a permission
        # error spawning it, or any other subprocess failure. The docstring
        # promises a fallback to 'main'; without this the exception would
        # escape and fail the whole task. (TimeoutExpired is a
        # SubprocessError too but is handled above for its distinct message.)
        log(
            "WARN",
            f"Default branch detection failed ({type(exc).__name__}) — defaulting to 'main'",
        )
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
