"""Post-agent hooks: build/lint verification, commit, push, PR creation."""

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

# Default verification commands (#1 build-gate fix). A repo that uses mise gets
# these for free; a non-mise repo sets ``pipeline.buildCommand`` /
# ``lintCommand`` in its blueprint (threaded to the agent as build_command /
# lint_command) so gating runs the repo's real command.
DEFAULT_BUILD_COMMAND = "mise run build"
DEFAULT_LINT_COMMAND = "mise run lint"

# Wall-clock ceiling for a single build/lint verification subprocess. The old
# hardcoded 600s (run_cmd's default) was too low for a real CI-parity build
# (install + compile + full test suite + synth) — a heavy repo's legitimate
# build exceeded it and was reported as a build FAILURE, which is the wrong
# diagnosis (the build didn't fail, it didn't finish in time). Raised to 30min
# and made env-overridable; well under the orchestrator's 9h durable ceiling.
# When the ceiling IS hit we now surface a distinct "timed out" reason (see
# VerifyOutcome.timed_out → pipeline error_message → platform failure copy)
# rather than a generic "build failed".
BUILD_VERIFY_TIMEOUT_S = int(os.environ.get("BUILD_VERIFY_TIMEOUT_S") or 1800)


@dataclass
class VerifyOutcome:
    """Result of a build/lint verification run.

    ``passed`` drives gating exactly as the old bare-bool return did. The two
    other flags distinguish WHY a not-passed result happened, so the platform
    can report an honest, actionable reason instead of a blanket "build failed":

    - ``timed_out`` — the command exceeded ``BUILD_VERIFY_TIMEOUT_S`` and was
      killed (a build that never finished, not a build that failed).
    - ``inert`` — the command could not RUN at all: exit 127 (command not
      found, e.g. ``yarn`` missing) or mise "no such task". This is a CONFIG
      problem (the gate isn't actually verifying anything), NOT the agent's
      code being broken. Live-caught 2026-06-29: an inert exit-127 gate was
      silently reported as ``build_passed=False`` — a false "your code is
      broken" for a repo we never managed to build. ``is_verify_command_inert``
      already existed but was only consulted at repo SETUP; now the post-agent
      gate consults it too.

    - ``infra_failed`` — the command was KILLED by an environment fault (the
      build box ran out of disk/ENOSPC or memory/OOM), so the build could not
      complete on this host. Like ``inert`` this is NOT the agent's code being
      broken — it's an infrastructure fault that a retry (fresh host) or more
      capacity clears. Live-caught on ABCA-659: 3 concurrent ABCA builds filled
      the 20 GiB Fargate root fs → ENOSPC mid-build → bogus ``build_passed=False``.

    A timeout / inert / infra_failed result still counts as not-passed for
    gating, but the pipeline surfaces each as its own reason.
    """

    passed: bool
    timed_out: bool = False
    inert: bool = False
    infra_failed: bool = False


# POSIX shell exit code for "command not found" — an inert build signal (the
# configured verify command isn't installed), not a genuine build failure.
SHELL_COMMAND_NOT_FOUND = 127


def is_verify_command_inert(returncode: int, stderr: str) -> bool:
    """True when a verify command did not actually RUN (vs ran-and-failed).

    Distinguishes the #1 inert-gate state — the build/lint command isn't
    runnable in this repo, so gating is effectively OFF — from a genuine red
    build (command executed, exited non-zero), which IS meaningful signal.

    Heuristics (conservative — only the unambiguous "couldn't run" signals):
      - exit 127: shell "command not found" (e.g. ``gradle`` not installed).
      - mise "no tasks defined" / "no task named" / "not found": the configured
        (or default ``mise run build``) task does not exist in the repo.
    A repo that genuinely fails its build returns some other non-zero code with
    real compiler/test output, which this does NOT flag.
    """
    if returncode == SHELL_COMMAND_NOT_FOUND:
        return True
    s = (stderr or "").lower()
    return (
        "no tasks defined" in s
        or "no task named" in s
        or ("mise" in s and "not found" in s)
        or "command not found" in s
    )


# Exit code for a process killed by SIGKILL (128 + 9) — how the OOM-killer and
# some disk-full kills surface. Paired with the ENOSPC/OOM stderr signatures.
SIGKILL_EXIT = 137


def is_infra_failure(returncode: int, stderr: str) -> bool:
    """True when a verify command was killed by an ENVIRONMENT fault, not a real
    build failure — the build box ran out of disk or memory.

    Distinct from :func:`is_verify_command_inert` (the command isn't runnable —
    a CONFIG problem) and from a genuine red build (command ran, tests failed).
    An out-of-disk / OOM kill means the build *couldn't complete on this host*,
    so reporting ``build_passed=False`` is a false "your code is broken" — it's
    an infrastructure fault a retry (on a fresh host) or more capacity clears.
    Live-caught on ABCA-659: 3 concurrent ABCA builds filled the 20 GiB Fargate
    root fs → ``ENOSPC: no space left on device`` mid-build → bogus build-fail.

    A bare SIGKILL (137) with no accompanying signature is ALSO treated as infra:
    the container-runtime / cgroup OOM-killer delivers SIGKILL and writes its
    "Killed process …" line to the KERNEL log, not the build process's own stderr,
    so an OOM'd `mise run build` frequently exits 137 with NO "killed"/"out of
    memory" string captured (live-caught on ABCA-691: a post-agent build OOM at
    137 fell through to the inert heuristic and was mislabeled "command not
    found"; a 137 with plain build output would fall through to a GENUINE build
    FAILURE → a false gate on healthy code). SIGKILL is never something a healthy
    `mise run build` does to itself — a real test failure exits with the runner's
    own non-zero code (1/2), not 137. So 137 ⇒ resource kill ⇒ infra, and this is
    checked BEFORE the inert/genuine-failure paths in ``_run_verify``.
    """
    s = (stderr or "").lower()
    disk_full = "no space left on device" in s or "enospc" in s or "errno 28" in s
    oom = "out of memory" in s or "oomkilled" in s or "cannot allocate memory" in s
    # A SIGKILL (137) is a resource/OOM kill by the runtime, not a build result —
    # infra regardless of what (if anything) reached the captured stderr.
    return disk_full or oom or returncode == SIGKILL_EXIT


# Shell metacharacters that mean the command can't be a single argv exec and
# must run through a shell to behave as written (#72: a configured
# ``npm ci && npm run lint && npm test`` was shlex-split into one ``npm`` call
# with ``&&``/``npm``/… as bogus args — ``npm ci`` ran, ignored the rest, exited
# 0, and the chain's lint/test NEVER ran, so a broken build reported "OK").
_SHELL_OPERATORS = ("&&", "||", "|", ";", ">", "<", "$(", "`")

# A leading ``VAR=value`` env-assignment prefix (one or more) is shell syntax:
# ``MISE_EXPERIMENTAL=1 mise //cdk:eslint`` only sets the env when run through a
# shell. Exec'd directly (shlex-split), the FIRST token ``MISE_EXPERIMENTAL=1``
# is treated as the program name → ``FileNotFoundError``. Detect it so such a
# command is routed through ``bash -lc`` like the operator case. NAME must be a
# valid POSIX env identifier so a plain arg like ``a=b`` in a real program's
# args (unusual as a leading token, but be precise) is matched only when it truly
# leads. Live-caught: a configured ``lint_command`` of ``MISE_EXPERIMENTAL=1 mise
# //cdk:eslint`` crashed the whole task at exit 1 before the build ran.
_ENV_ASSIGN_PREFIX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def resolve_verify_argv(command: str | None, default: str) -> list[str]:
    """Resolve a configured verify command into an argv for :func:`run_cmd`.

    Empty/whitespace/None ``command`` → the default (mise). A plain command with
    args (``npm run build``) is ``shlex``-split and exec'd directly. A command
    that needs a shell to behave as written — it contains shell operators (``&&``,
    ``|``, ``;``, redirects, command substitution) OR begins with a ``VAR=value``
    env-assignment prefix — is wrapped as ``bash -lc '<command>'``; otherwise the
    operators/assignment are passed as literal args to (or AS) the first program
    and mis-run (#72: chained build commands silently no-op'd; ABCA-662 follow-up:
    an env-prefixed lint command exec'd ``VAR=value`` as the binary → crash).
    """
    cmd = (command or "").strip() or default
    needs_shell = any(op in cmd for op in _SHELL_OPERATORS) or bool(_ENV_ASSIGN_PREFIX.match(cmd))
    if needs_shell:
        return ["bash", "-lc", cmd]
    return shlex.split(cmd)


def _run_verify(repo_dir: str, command: str, default: str, label: str) -> VerifyOutcome:
    """Run a configured verify command and classify the outcome.

    Returns a :class:`VerifyOutcome` so callers can distinguish a TIMEOUT (the
    command exceeded ``BUILD_VERIFY_TIMEOUT_S`` and was killed — the build did
    not *fail*, it did not *finish*) from a genuine non-zero exit. Both are
    not-passed for gating, but the pipeline surfaces them as different reasons.
    """
    argv = resolve_verify_argv(command, default)
    log("POST", f"Running post-agent {label} ({' '.join(argv)})...")
    try:
        result = run_cmd(
            argv,
            label=label,
            cwd=repo_dir,
            check=False,
            timeout=BUILD_VERIFY_TIMEOUT_S,
            # Stream the build/lint output live → full log reaches CloudWatch
            # verbatim (a buffered summary hid which sub-task failed — ABCA-662).
            stream=True,
        )
    except subprocess.TimeoutExpired:
        log(
            "WARN",
            f"Post-agent {label} TIMED OUT after {BUILD_VERIFY_TIMEOUT_S}s "
            "— reporting as timed out (not a build failure)",
        )
        return VerifyOutcome(passed=False, timed_out=True)
    if result.returncode != 0:
        stderr = getattr(result, "stderr", "") or ""
        # An ENVIRONMENT fault (out of disk / OOM) means the build couldn't
        # complete on this host — NOT that the code is broken. Check this BEFORE
        # the inert/genuine-failure paths: it's the most specific signal, and a
        # disk-full mid-build otherwise looks like a random non-zero exit and gets
        # mis-reported as "build/tests failed" (ABCA-659: concurrent builds filled
        # the Fargate root fs → ENOSPC → bogus build-fail). Surface as infra so the
        # platform reports "retry / needs more capacity", not the agent's code.
        if is_infra_failure(result.returncode, stderr):
            log(
                "WARN",
                f"Post-agent {label} was KILLED by an environment fault (exit "
                f"{result.returncode}: out of disk/memory) — infrastructure issue, "
                "not a build failure",
            )
            return VerifyOutcome(passed=False, infra_failed=True)
        # Distinguish "couldn't RUN" (exit 127 / no-such-task → the gate is
        # inert, a config problem) from "ran and failed" (real red build). An
        # inert gate verified nothing, so reporting it as a build FAILURE is a
        # false "your code is broken" — surface it as inert instead. K8.
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
    """Run the configured build command (default ``mise run build``) to verify the build.

    Returns a :class:`VerifyOutcome` (``.passed`` for gating, ``.timed_out`` to
    distinguish "exceeded the time limit" from "ran and failed").
    """
    return _run_verify(repo_dir, command, DEFAULT_BUILD_COMMAND, "verify-build-post")


def verify_lint(repo_dir: str, command: str = "") -> VerifyOutcome:
    """Run the configured lint command (default ``mise run lint``) to verify lint passes."""
    return _run_verify(repo_dir, command, DEFAULT_LINT_COMMAND, "verify-lint-post")


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


def _current_branch(repo_dir: str) -> str | None:
    """Return the checked-out branch name, or None if detached / git fails."""
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
        return None
    if res.returncode != 0:
        return None
    name = res.stdout.strip()
    # "HEAD" is git's sentinel for a detached HEAD — not a branch name.
    return name or None if name != "HEAD" else None


def reconcile_agent_branch(repo_dir: str, branch: str) -> bool:
    """ABCA-815 root cause: make delivery tolerant of the agent switching off the
    platform-provided branch.

    The platform checks out ``branch`` (``config.branch_name``, e.g.
    ``bgagent/<task_id>/<slug>``) BEFORE the agent runs, and every delivery git op
    (ensure_committed / ensure_pr's commit-diff / ensure_pushed) is keyed to it.
    But the agent doesn't always stay there: live on backgroundagent-dev it
    sometimes ran ``git checkout -b <its-own-short-branch>``, committed + opened
    its own PR there, and left the platform branch empty. ensure_pr then saw no
    commits on ``branch`` → skipped → the task looked delivered-nothing (the
    ABCA-815 signature), and for a #247 stacked child the successor had no branch
    to stack on. It is NON-deterministic (the same task succeeds on a retry when
    the agent happens to stay put), so a prompt tweak alone can't be relied on.

    This reconciles deterministically: if HEAD is on a DIFFERENT branch than the
    platform ``branch`` and that HEAD carries commits, fast-forward the platform
    branch to the agent's HEAD (``git branch -f`` + checkout) so all downstream
    delivery runs against the branch the platform tracks. The agent's commits are
    preserved verbatim — we only re-point the platform branch label at them.

    Returns True if it moved the platform branch, False otherwise (already on it,
    detached HEAD with no branch to adopt, or a git failure — all handled by the
    existing ensure_committed/ensure_pr/delivery-gate chain). Best-effort: never
    raises, so a reconcile failure degrades to the pre-existing behavior."""
    head_branch = _current_branch(repo_dir)
    if head_branch is None or head_branch == branch:
        # On the platform branch already (the common, healthy case) or detached
        # with nothing to adopt — nothing to reconcile.
        return False
    log(
        "POST",
        f"Agent left the platform branch: HEAD is on '{head_branch}', expected "
        f"'{branch}'. Reconciling the platform branch to the agent's commits so "
        "the work is delivered on the tracked branch (ABCA-815).",
    )
    try:
        # Re-point the platform branch at the agent's HEAD (force: the platform
        # branch was created empty at setup, so this only ever fast-forwards it
        # to the work the agent actually did). Then check it out so ensure_committed
        # / ensure_pr / ensure_pushed all operate on the tracked branch.
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


_UNPUSHED_COMMITS_NOTE = (
    "⚠️ **bgagent could not push its follow-up commits to this branch.** "
    "The `git push` during the `push_resolve` step failed, so the latest "
    "agent changes are committed locally but are NOT reflected in this PR. "
    "A maintainer may need to re-run the task or push manually."
)


def _note_unpushed_commits(repo_dir: str, branch: str, config: TaskConfig) -> None:
    """Post a PR comment warning that follow-up commits failed to push.

    Best-effort surface for the ``push_resolve`` push-failure path: the PR URL
    is still returned (the PR exists) but it no longer reflects the agent's
    latest work, so the reviewer must be told. Failure to post the comment is
    logged but not fatal — the WARN log line emitted by the caller is the
    fallback signal.

    ``check=False`` means ``run_cmd`` does NOT raise on a non-zero ``gh``
    exit, so the returncode is inspected explicitly — otherwise a failed
    ``gh pr comment`` (missing scope, rate limit, not-a-PR) is a silent
    no-op and the reviewer never learns the PR is stale. The ``except``
    below only covers OS-level failures (gh missing, timeout).
    """
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


def _reconcile_pr_base(repo_dir: str, branch: str, config: TaskConfig, expected_base: str) -> None:
    """Deterministically retarget an existing PR onto ``expected_base``.

    The PR is created by the AGENT (its own ``gh pr create`` in the prompt
    workflow), so the ``--base`` it chose is a model judgment call, not the
    orchestrator's. Live-caught on the #247 chain stress test (2026-07-18):
    a stacked child that branched off its predecessor's branch STILL opened
    its PR against ``main`` — the agent reasoned "this was based off the
    chain-Y branch, let me open the PR against main" and even a root whose
    ``detect_default_branch`` correctly returned ``linear-vercel`` was pointed
    at ``main``. Wrong base ⇒ the PR shows the whole default-branch divergence
    (100s of files) instead of the child's real delta, and a stacked child's
    PR merges onto the wrong branch.

    ``expected_base`` is ``setup.default_branch`` — which is the orchestrator's
    ``base_branch`` for a stacked child (the predecessor's branch, or ``main``
    for a diamond) and ``detect_default_branch`` for a root. This post-hook
    reads the PR's current base and, if it disagrees, retargets it via
    ``gh pr edit --base`` — removing the agent's discretion without forbidding
    it from opening the PR (which keeps the agent-authored title/body).

    Best-effort: any failure is logged, never fatal — a mis-based PR is a
    presentation/merge-target defect, not a reason to fail the whole task.
    """
    try:
        view = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--repo",
                config.repo_url,
                "--json",
                "baseRefName",
                "-q",
                ".baseRefName",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log("WARN", f"Could not read PR base to reconcile ({type(exc).__name__}) — leaving as-is")
        return
    if view.returncode != 0 or not view.stdout.strip():
        # No PR / unreadable base — nothing to reconcile (creation path handles
        # the no-PR case; a transient read error just leaves the base as-is).
        return
    current_base = view.stdout.strip()
    if current_base == expected_base:
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
    build_passed: bool,
    lint_passed: bool,
    agent_result: AgentResult | None = None,
    strategy: str = "create",
) -> str | None:
    """Realize the PR per the workflow's ``ensure_pr`` strategy.

    Strategy (provider-neutral, from the workflow step — replaces the former
    ``task_type`` self-inspection, #248):

    - ``create``: create a new PR if one doesn't exist (the new_task path).
    - ``push_resolve``: push follow-up commits, then resolve the existing PR URL
      (the pr_iteration path).
    - ``resolve``: resolve the existing PR URL without pushing (read-only;
      the pr_review path).

    Returns the PR URL, or None if there are no commits beyond the default
    branch or PR creation failed. ``build_passed`` and ``lint_passed`` control
    the verification status shown in the PR body.
    """
    repo_dir = setup.repo_dir
    branch = setup.branch
    default_branch = setup.default_branch

    # push_resolve / resolve: skip PR creation — just resolve the existing URL.
    if strategy in ("push_resolve", "resolve"):
        push_failed = False
        if strategy == "push_resolve":
            if not ensure_pushed(repo_dir, branch):
                # Surface the failure rather than silently returning the stale
                # PR URL as success: the local follow-up commits never reached
                # the remote, so the PR the caller resolves below does NOT
                # reflect the agent's latest work. We note this on the PR
                # itself (below) so the reviewer is not misled.
                push_failed = True
                log("WARN", "Failed to push commits before resolving PR URL")
        else:
            log("POST", "resolve strategy — skipping push (read-only)")
        log("POST", f"ensure_pr strategy={strategy} — returning existing PR URL")
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
            if push_failed:
                _note_unpushed_commits(repo_dir, branch, config)
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
        # The agent opened this PR and picked its own --base; correct it to the
        # orchestrator-supplied / detected base if it disagrees (stacked-child
        # + root wrong-base fix, 2026-07-18).
        _reconcile_pr_base(repo_dir, branch, config, default_branch)
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
    # #1: show the actual commands run (default mise), not a hardcoded label.
    build_label = (config.build_command or DEFAULT_BUILD_COMMAND).strip()
    lint_label = (config.lint_command or DEFAULT_LINT_COMMAND).strip()

    cost_line = ""
    if agent_result and agent_result.cost_usd is not None:
        cost_line = f"- Agent cost: **${agent_result.cost_usd:.4f}**\n"

    # #1: when build-regression gating is inert (no runnable build command, none
    # configured), say so plainly — otherwise a green "build: PASS" misleads:
    # nothing was actually verified.
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
        # nosemgrep: py-silent-success-masking -- PR body notes optional; extraction failure logged
        return None
