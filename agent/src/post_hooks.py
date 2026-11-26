from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING

from shell import log, run_cmd

if TYPE_CHECKING:
    from models import AgentResult, RepoSetup, TaskConfig

DEFAULT_BUILD_COMMAND = "mise run build"
DEFAULT_LINT_COMMAND = "mise run lint"

BUILD_VERIFY_TIMEOUT_S = int(os.environ.get("BUILD_VERIFY_TIMEOUT_S") or 1800)


@dataclass
class VerifyOutcome:
    """Result of a build/lint verification run.

    - ``timed_out`` — the command exceeded ``BUILD_VERIFY_TIMEOUT_S`` and was
      killed (a build that never finished, not a build that failed).
    - ``inert`` — the command could not RUN at all: exit 127 (command not
      found, e.g. ``yarn`` missing) or mise "no such task".
    - ``infra_failed`` — the command was KILLED by an environment fault (the
      build box ran out of disk/ENOSPC or memory/OOM).

    A timeout / inert / infra_failed result still counts as not-passed for
    gating, but the pipeline surfaces each as its own reason.
    """

    passed: bool
    timed_out: bool = False
    inert: bool = False
    infra_failed: bool = False


SHELL_COMMAND_NOT_FOUND = 127

_MISE_NO_SUCH_TASK = re.compile(r"not found|no task \S+ found|unknown command")


def is_verify_command_inert(returncode: int, stderr: str) -> bool:
    """True when a verify command did not actually RUN (vs ran-and-failed).

    - exit 127: shell "command not found" (e.g. ``gradle`` not installed).
      mise exits with the status of the task that failed, so a tool missing
      inside a task is a 127 as well.
    - mise "no tasks defined" / "no task named", or one of mise's own error
      lines that says a task does not exist (``_MISE_NO_SUCH_TASK``). The
      same words anywhere else in the log are no signal: mise itself warns
      "no task <name> found, but a non-executable file exists" before it
      makes that file executable and runs it.
    """
    if returncode == SHELL_COMMAND_NOT_FOUND:
        return True
    s = (stderr or "").lower()
    return (
        "no tasks defined" in s
        or "no task named" in s
        or any("mise error" in line and _MISE_NO_SUCH_TASK.search(line) for line in s.splitlines())
    )


SIGKILL_EXIT = 137


def is_infra_failure(returncode: int, stderr: str) -> bool:
    """True when a verify command was killed by an ENVIRONMENT fault, not a real
    build failure — the build box ran out of disk or memory.

    A bare SIGKILL (137) with no accompanying signature is ALSO treated as infra:
    the container-runtime / cgroup OOM-killer delivers SIGKILL and writes its
    "Killed process …" line to the KERNEL log, not the build process's own stderr.
    """
    s = (stderr or "").lower()
    disk_full = "no space left on device" in s or "enospc" in s or "errno 28" in s
    oom = "out of memory" in s or "oomkilled" in s or "cannot allocate memory" in s
    return disk_full or oom or returncode == SIGKILL_EXIT


_SHELL_OPERATORS = ("&&", "||", "|", ";", ">", "<", "$(", "`")

_ENV_ASSIGN_PREFIX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def resolve_verify_argv(command: str | None, default: str) -> list[str]:
    """Resolve a configured verify command into an argv for :func:`run_cmd`.

    Empty/whitespace/None ``command`` → the default (mise). A plain command with
    args (``npm run build``) is ``shlex``-split and exec'd directly. A command
    that needs a shell to behave as written — it contains shell operators (``&&``,
    ``|``, ``;``, redirects, command substitution) OR begins with a ``VAR=value``
    env-assignment prefix — is wrapped as ``bash -lc '<command>'``.

    A command that ``shlex`` cannot split, one with a quote that is never closed
    or with a trailing backslash, is wrapped the same way.
    """
    cmd = (command or "").strip() or default
    needs_shell = any(op in cmd for op in _SHELL_OPERATORS) or bool(_ENV_ASSIGN_PREFIX.match(cmd))
    if needs_shell:
        return ["bash", "-lc", cmd]
    try:
        return shlex.split(cmd)
    except ValueError:
        return ["bash", "-lc", cmd]


def _run_verify(repo_dir: str, command: str, default: str, label: str) -> VerifyOutcome:
    argv = resolve_verify_argv(command, default)
    log("POST", f"Running post-agent {label} ({' '.join(argv)})...")
    try:
        result = run_cmd(
            argv,
            label=label,
            cwd=repo_dir,
            check=False,
            timeout=BUILD_VERIFY_TIMEOUT_S,
            stream=True,
        )
    except subprocess.TimeoutExpired:
        log(
            "WARN",
            f"Post-agent {label} TIMED OUT after {BUILD_VERIFY_TIMEOUT_S}s "
            "— reporting as timed out (not a build failure)",
        )
        return VerifyOutcome(passed=False, timed_out=True)
    except OSError as exc:
        log("WARN", f"Post-agent {label} could not be started: {exc}")
        result = subprocess.CompletedProcess(argv, SHELL_COMMAND_NOT_FOUND, "", str(exc))
    if result.returncode != 0:
        stderr = getattr(result, "stderr", "") or ""
        if is_infra_failure(result.returncode, stderr):
            log(
                "WARN",
                f"Post-agent {label} was KILLED by an environment fault (exit "
                f"{result.returncode}: out of disk/memory) — infrastructure issue, "
                "not a build failure",
            )
            return VerifyOutcome(passed=False, infra_failed=True)
        if is_verify_command_inert(result.returncode, stderr):
            log(
                "WARN",
                f"Post-agent {label} could not RUN (exit {result.returncode}) "
                "— gate is INERT (command not found / no such task), not a build failure",
            )
            return VerifyOutcome(passed=False, inert=True)
        log("POST", f"Post-agent {label} FAILED (exit {result.returncode})")
        return VerifyOutcome(passed=False)
    log("POST", f"Post-agent {label}: OK")
    return VerifyOutcome(passed=True)


def verify_build(repo_dir: str, command: str = "") -> VerifyOutcome:
    """Run the configured build command (default ``mise run build``) to verify the build."""
    return _run_verify(repo_dir, command, DEFAULT_BUILD_COMMAND, "verify-build-post")


def verify_lint(repo_dir: str, command: str = "") -> VerifyOutcome:
    """Run the configured lint command (default ``mise run lint``) to verify lint passes."""
    return _run_verify(repo_dir, command, DEFAULT_LINT_COMMAND, "verify-lint-post")


def ensure_committed(repo_dir: str) -> bool:
    """Safety net: commit any uncommitted tracked changes before finalization.

    Only stages tracked-but-modified files (git add -u).

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
        if result.returncode != 0:
            stderr = result.stderr.strip()[:200] if result.stderr else ""
            log("WARN", f"git status failed (exit {result.returncode}): {stderr}")
            return False
        if not result.stdout.strip():
            return False

        log("POST", "Uncommitted changes detected — creating safety-net commit")
        add_result = subprocess.run(
            ["git", "add", "-u"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if add_result.returncode != 0:
            stderr = add_result.stderr.strip()[:200] if add_result.stderr else ""
            log("WARN", f"git add -u failed (exit {add_result.returncode}): {stderr}")
            return False

        staged = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=repo_dir,
            capture_output=True,
            timeout=30,
        )
        if staged.returncode == 0:
            log("POST", "No tracked file changes to commit")
            return False

        commit_result = subprocess.run(
            ["git", "commit", "-m", "chore(agent): save uncommitted work from session end"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        log("WARN", f"Safety-net commit not made ({type(exc).__name__}: {exc})")
        return False
    if commit_result.returncode == 0:
        log("POST", "Safety-net commit created")
        return True
    log("POST", f"Safety-net commit failed: {commit_result.stderr.strip()[:200]}")
    return False


def _current_branch(repo_dir: str) -> str | None:
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_dir,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        # nosemgrep: py-silent-success-masking -- git failed: reconcile_agent_branch moves nothing
        return None
    if res.returncode != 0:
        return None
    name = res.stdout.strip()
    # "HEAD" is git's sentinel for a detached HEAD — not a branch name.
    return name or None if name != "HEAD" else None


def _lists_a_commit(repo_dir: str, *revisions: str) -> bool:
    """The closing ``--`` is for a branch named like a file of the work tree
    (``docs``), which git otherwise refuses as ambiguous."""
    listed = subprocess.run(
        ["git", "rev-list", "--ignore-missing", "-1", *revisions, "--"],
        cwd=repo_dir,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return listed.returncode != 0 or bool(listed.stdout.strip())


def reconcile_agent_branch(repo_dir: str, branch: str) -> bool:
    """Make delivery tolerant of the agent switching off the platform-provided
    branch.

    If HEAD is on a DIFFERENT branch than the platform ``branch``, the platform
    branch is re-pointed at the agent's HEAD (``git branch -f`` + checkout). The
    agent's commits are preserved verbatim.

    The label stays where it is when moving it would drop commits for nothing:
    the platform branch has commits that HEAD lacks, and HEAD has no commit of
    its own (one that is neither on the platform branch nor on origin's default
    branch). The platform branch is then checked out again, with its commits.
    When git refuses that checkout (uncommitted edits it would overwrite), HEAD
    is adopted after all, as for any other HEAD.

    Returns True if it moved the platform branch, False otherwise (already on it,
    detached HEAD with no branch to adopt, a move that would only drop commits,
    or a git failure). Never raises."""
    head_branch = _current_branch(repo_dir)
    if head_branch is None or head_branch == branch:
        return False
    try:
        drops_commits = _lists_a_commit(repo_dir, branch, "--not", "HEAD")
        own_commit = _lists_a_commit(repo_dir, "HEAD", "--not", branch, "origin/HEAD")
        if drops_commits and not own_commit:
            log(
                "POST",
                f"Agent left the platform branch: HEAD is on '{head_branch}', which has "
                f"no commit of its own. Going back to '{branch}' as it is.",
            )
            back = run_cmd(
                ["git", "checkout", branch],
                label="reconcile-branch-checkout",
                cwd=repo_dir,
                check=False,
            )
            if back.returncode == 0:
                return False
            log("WARN", f"reconcile: cannot go back to '{branch}' — adopting HEAD instead")
        log(
            "POST",
            f"Agent left the platform branch: HEAD is on '{head_branch}', expected "
            f"'{branch}'. Reconciling the platform branch to the agent's commits so "
            "the work is delivered on the tracked branch.",
        )
        force_res = run_cmd(
            ["git", "branch", "-f", branch, "HEAD"],
            label="reconcile-branch-force",
            cwd=repo_dir,
            check=False,
        )
        if force_res.returncode != 0:
            stderr = (force_res.stderr or "").strip()[:200]
            log("WARN", f"reconcile: git branch -f failed (exit {force_res.returncode}): {stderr}")
            return False
        checkout_res = run_cmd(
            ["git", "checkout", branch],
            label="reconcile-branch-checkout",
            cwd=repo_dir,
            check=False,
        )
        if checkout_res.returncode != 0:
            stderr = (checkout_res.stderr or "").strip()[:200]
            log(
                "WARN",
                f"reconcile: checkout '{branch}' failed (exit {checkout_res.returncode}): {stderr}",
            )
            return False
    except (OSError, subprocess.SubprocessError) as e:
        log("WARN", f"reconcile: git op raised {type(e).__name__}: {e}")
        return False
    log("POST", f"Reconciled: platform branch '{branch}' now points at the agent's work")
    return True


def ensure_pushed(repo_dir: str, branch: str) -> bool:
    result = subprocess.run(
        ["git", "log", f"origin/{branch}..HEAD", "--oneline"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0 or result.stdout.strip():
        log("POST", "Pushing unpushed commits...")
        try:
            push_result = run_cmd(
                ["git", "push", "-u", "origin", branch],
                label="push",
                cwd=repo_dir,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            log("WARN", f"Push not completed ({exc})")
            return False
        return push_result.returncode == 0
    return True


_UNPUSHED_COMMITS_NOTE = (
    "⚠️ **bgagent could not push its follow-up commits to this branch.** "
    "The `git push` after the agent's run failed, so the latest "
    "agent changes are committed locally but are NOT reflected in this PR. "
    "A maintainer may need to re-run the task or push manually."
)


def _note_unpushed_commits(repo_dir: str, branch: str, config: TaskConfig) -> None:
    try:
        result = run_cmd(
            [
                "gh",
                "pr",
                "comment",
                branch,
                "--repo",
                config.repo_url,
                "--body",
                _UNPUSHED_COMMITS_NOTE,
            ],
            label="note-unpushed-commits",
            cwd=repo_dir,
            check=False,
        )
        if result.returncode != 0:
            stderr_msg = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
            log(
                "WARN",
                "Failed to post un-pushed-commits note "
                f"(gh exit {result.returncode}): {stderr_msg} — the PR does not "
                "reflect the agent's latest commits and the reviewer has NOT "
                "been notified.",
            )
    except Exception as e:
        log("WARN", f"Failed to post un-pushed-commits note: {type(e).__name__}: {e}")


def _gh_pr_field(repo_dir: str, branch: str, repo_url: str, field: str) -> str | None:
    value = None
    try:
        result = subprocess.run(
            ["gh", "pr", "view", branch, "--repo", repo_url, "--json", field, "-q", f".{field}"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0:
            value = result.stdout.strip() or None
        else:
            stderr_msg = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
            log("POST", f"gh pr view '{branch}' (rc={result.returncode}): {stderr_msg}")
    except (OSError, subprocess.SubprocessError) as exc:
        log("WARN", f"gh pr view '{branch}' did not complete ({type(exc).__name__}: {exc})")
    return value


def _reconcile_pr_base(repo_dir: str, branch: str, config: TaskConfig, expected_base: str) -> None:
    current_base = _gh_pr_field(repo_dir, branch, config.repo_url, "baseRefName")
    if current_base is None or current_base == expected_base:
        return
    log(
        "POST",
        f"Retargeting PR base '{current_base}' → '{expected_base}' "
        f"(deterministic; agent chose the wrong base)",
    )
    result = run_cmd(
        ["gh", "pr", "edit", branch, "--repo", config.repo_url, "--base", expected_base],
        label="reconcile-pr-base",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        stderr_msg = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
        log(
            "WARN",
            f"Failed to retarget PR base to '{expected_base}' (gh exit {result.returncode}): "
            f"{stderr_msg} — PR remains based on '{current_base}'",
        )


def ensure_pr(
    config: TaskConfig,
    setup: RepoSetup,
    build_passed: bool | None,
    lint_passed: bool,
    agent_result: AgentResult | None = None,
    strategy: str = "create",
) -> str | None:
    """Realize the PR per the workflow's ``ensure_pr`` strategy.

    Strategy:

    - ``create``: create a new PR if one doesn't exist; if the agent has opened
      it already, push the commits made since (the new_task path).
    - ``push_resolve``: push follow-up commits, then resolve the existing PR URL
      (the pr_iteration path).
    - ``resolve``: resolve the existing PR URL without pushing (read-only;
      the pr_review path).

    Returns the PR URL, or None if there are no commits beyond the default
    branch or PR creation failed. ``build_passed`` and ``lint_passed`` control
    the verification status shown in the PR body; ``build_passed`` is None when
    the build command could not run, and the body then says so instead of PASS.
    """
    repo_dir = setup.repo_dir
    branch = setup.branch
    default_branch = setup.default_branch

    if strategy in ("push_resolve", "resolve"):
        push_failed = False
        if strategy == "push_resolve":
            if not ensure_pushed(repo_dir, branch):
                push_failed = True
                log("WARN", "Failed to push commits before resolving PR URL")
        else:
            log("POST", "resolve strategy — skipping push (read-only)")
        log("POST", f"ensure_pr strategy={strategy} — returning existing PR URL")
        pr_url = _gh_pr_field(repo_dir, branch, config.repo_url, "url")
        if pr_url:
            log("POST", f"Existing PR: {pr_url}")
            if push_failed:
                _note_unpushed_commits(repo_dir, branch, config)
            return pr_url
        log("WARN", "Could not resolve existing PR URL")
        return None

    log("POST", "Checking for existing PR...")
    pr_url = _gh_pr_field(repo_dir, branch, config.repo_url, "url")
    if pr_url:
        log("POST", f"PR already exists: {pr_url}")
        if not ensure_pushed(repo_dir, branch):
            log("WARN", "Failed to push the commits made after the PR was opened")
            if _lists_a_commit(repo_dir, branch, "--not", "--remotes=origin"):
                _note_unpushed_commits(repo_dir, branch, config)
        _reconcile_pr_base(repo_dir, branch, config, default_branch)
        return pr_url

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

    ensure_pushed(repo_dir, branch)

    log_result = subprocess.run(
        ["git", "log", f"origin/{default_branch}..HEAD", "--pretty=format:%s%n%b---"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    commits = log_result.stdout.strip() if log_result.returncode == 0 else ""

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

    task_source = ""
    if config.issue_number:
        task_source = f"Resolves #{config.issue_number}\n\n"
    elif config.task_description:
        task_source = f"**Task:** {config.task_description}\n\n"

    build_statuses = {True: "PASS", False: "FAIL", None: "NOT RUN (command could not run)"}
    build_status = build_statuses[build_passed]
    lint_status = "PASS" if lint_passed else "FAIL"
    build_label = (config.build_command or DEFAULT_BUILD_COMMAND).strip()
    lint_label = (config.lint_command or DEFAULT_LINT_COMMAND).strip()

    cost_line = ""
    if agent_result and agent_result.cost_usd is not None:
        cost_line = f"- Agent cost: **${agent_result.cost_usd:.4f}**\n"

    gate_warning = ""
    if getattr(setup, "build_gate_inert", False):
        gate_warning = (
            "> ⚠️ **Build-regression gating is OFF for this repo.** No runnable "
            f"`{DEFAULT_BUILD_COMMAND}` task was found and no build command is configured, "
            "so a change that breaks the build still reports success. To enable gating, set "
            "`pipeline.buildCommand` in this repo's ABCA blueprint (e.g. `npm run build`).\n\n"
        )

    pr_body = (
        f"## Summary\n\n"
        f"{task_source}"
        f"### Commits\n\n"
        f"```\n{commits}\n```\n\n"
        f"## Verification\n\n"
        f"{gate_warning}"
        f"- `{build_label}` (post-agent): **{build_status}**\n"
        f"- `{lint_label}` (post-agent): **{lint_status}**\n"
        f"{cost_line}\n"
        f"---\n\n"
        f"By submitting this pull request, I confirm that you can use, modify, copy, "
        f"and redistribute this contribution, under the terms of the "
        f"[project license](https://github.com/{config.repo_url}/blob/{default_branch}/LICENSE)."
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
    log("POST", "Failed to create PR")
    return None


def _extract_agent_notes(repo_dir: str, branch: str, config: TaskConfig) -> str | None:
    body = _gh_pr_field(repo_dir, branch, config.repo_url, "body")
    if not body:
        return None
    match = re.search(
        r"##\s*Agent\s*notes\s*\n(.*?)(?=\n##\s|\Z)",
        body,
        re.DOTALL | re.IGNORECASE,
    )
    if match:
        notes = match.group(1).strip()
        return notes or None
    return None
