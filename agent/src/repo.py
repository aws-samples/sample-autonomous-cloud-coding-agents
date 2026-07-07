"""Repository setup: clone, branch, mise install, initial build."""

import os
import subprocess

from config import AGENT_WORKSPACE
from models import RepoSetup, TaskConfig
from shell import log, run_cmd, slugify


def setup_repo(config: TaskConfig) -> RepoSetup:
    """Clone repo, create branch, configure git auth, run mise install.

    Returns a RepoSetup with repo_dir, branch, notes, build_before,
    lint_before, and default_branch.
    """
    repo_dir = f"{AGENT_WORKSPACE}/{config.task_id}"
    notes: list[str] = []

    # Always use the platform-provided branch name verbatim when present.
    # The platform computes branch_name (gateway.ts generateBranchName/slugify)
    # and persists it on the TaskRecord AND, for #247 stacked children, as the
    # predecessor's child_branch_name that the reconciler hands to the next
    # child as its base. If the agent re-derives the slug here it produces a
    # DIFFERENT string (shell.py slugify strips dots vs gateway's dash, and
    # truncates at 40 vs 50) — e.g. ``...guide.html`` → agent ``guidehtml`` vs
    # platform ``guide-html``. That divergence means a stacked child's
    # ``git fetch origin <predecessor-branch>`` 404s and it silently falls back
    # to branching off main (A4 stacking broken). Use config.branch_name as-is.
    if config.branch_name:
        branch = config.branch_name
    else:
        # Fallback only when the platform supplied no branch (older callers /
        # direct invocations). Derive a slug from the issue title or task
        # description. NOTE: this path's slug may differ from the platform's;
        # it exists for resilience, not for the orchestrated/standard flow.
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
    head_sha_before = ""
    if config.is_pr_workflow and config.branch_name:
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
        # A6/#299: snapshot the branch HEAD BEFORE the agent runs. The post-hooks
        # compare the final HEAD to this to tell a real edit (HEAD advanced) from
        # a question-only iteration (HEAD unchanged → no commit), so the platform
        # reports "answered / no change" rather than a false "✅ Updated". Capture
        # AFTER any predecessor merges would advance HEAD — but pr_iteration /
        # pr_review pass no merge_branches, so the checkout HEAD is the baseline.
        # (Restack DOES merge predecessors and isn't a comment-iteration, so its
        # HEAD-advance is expected and never reaches the no-op reply path.)
        sha_res = run_cmd(
            ["git", "rev-parse", "HEAD"],
            label="head-sha-before",
            cwd=repo_dir,
            check=False,
        )
        if sha_res.returncode == 0:
            head_sha_before = sha_res.stdout.strip()
        # #305 A6 re-stack: a predecessor branch changed; merge its UPDATED
        # code into this existing PR branch so the child is no longer stale.
        # (pr_iteration / pr_review pass no merge_branches, so this is a no-op
        # for them — only the restack path threads predecessors here.)
        for pred_branch in config.merge_branches:
            _merge_predecessor_branch(repo_dir, pred_branch, notes)
    elif config.base_branch:
        # #247 A4: stacked child. Branch from the predecessor's branch
        # (linear) or from main (diamond) so the child sees predecessor
        # code without waiting for a human merge. fetch the base first —
        # it is an unmerged sibling branch that the fresh clone may not
        # have locally.
        log("SETUP", f"Creating branch {branch} from base {config.base_branch}")
        fetch_res = run_cmd(
            ["git", "fetch", "origin", config.base_branch],
            label="fetch-base-branch",
            cwd=repo_dir,
            check=False,
        )
        if fetch_res.returncode == 0:
            run_cmd(
                ["git", "checkout", "-b", branch, f"origin/{config.base_branch}"],
                label="create-branch-from-base",
                cwd=repo_dir,
            )
        else:
            # Base branch not found on origin (e.g. predecessor PR already
            # merged + branch deleted, or a transient fetch error). Fall
            # back to a normal branch off the current HEAD so the child
            # still runs rather than failing setup; the predecessor's code
            # is likely in the default branch by now anyway.
            notes.append(
                f"base branch '{config.base_branch}' not fetchable; branched off default instead"
            )
            log("SETUP", f"Base branch not found; creating {branch} off HEAD")
            run_cmd(["git", "checkout", "-b", branch], label="create-branch", cwd=repo_dir)

        # Diamond: merge each predecessor branch into this child's branch
        # so it sees ALL predecessors' code (the base only gave it one).
        for pred_branch in config.merge_branches:
            _merge_predecessor_branch(repo_dir, pred_branch, notes)
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

    # Initial build (record whether the project builds before agent changes).
    # #1: use the repo's configured build command (default mise run build).
    from post_hooks import (
        DEFAULT_BUILD_COMMAND,
        DEFAULT_LINT_COMMAND,
        is_verify_command_inert,
        resolve_verify_argv,
    )

    build_gate_inert = False
    build_argv = resolve_verify_argv(config.build_command, DEFAULT_BUILD_COMMAND)
    build_cmd_str = " ".join(build_argv)
    log("SETUP", f"Running initial build ({build_cmd_str})...")
    result = run_cmd(
        build_argv,
        label="verify-build-pre",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        note = f"Initial build ({build_cmd_str}) FAILED before agent changes"
        notes.append(note)
        build_before = False
        # #1: if the build command could not RUN (no task / not found) AND no
        # explicit build_command was configured, build-regression gating is
        # INERT — flag it so the agent warns on the PR rather than silently
        # passing every task. A configured command that fails to run is the
        # operator's typo, not the silent-default trap, so only flag the
        # unconfigured (mise-default) case.
        if not config.build_command and is_verify_command_inert(result.returncode, result.stderr):
            build_gate_inert = True
            notes.append(
                "⚠️ Build-regression gating is INERT: no runnable `mise run build` task in this "
                "repo and no build command configured. A change that breaks the build will still "
                "report success. Set pipeline.buildCommand in the repo's blueprint (e.g. "
                "'npm run build') to enable gating."
            )
    else:
        notes.append(f"Initial build ({build_cmd_str}): OK")
        build_before = True

    # Initial lint baseline (record whether lint passes before agent changes)
    lint_gate_inert = False
    lint_argv = resolve_verify_argv(config.lint_command, DEFAULT_LINT_COMMAND)
    lint_cmd_str = " ".join(lint_argv)
    log("SETUP", f"Running initial lint ({lint_cmd_str})...")
    result = run_cmd(
        lint_argv,
        label="verify-lint-pre",
        cwd=repo_dir,
        check=False,
    )
    if result.returncode != 0:
        # #72: distinguish "lint couldn't RUN" (no `mise run lint` task and no
        # configured lint_command — the default fired and the task doesn't exist)
        # from a genuine lint failure. The former is INERT: recording it as a
        # red lint baseline is misleading (e.g. a Node repo with no mise lint
        # task perpetually shows lint FAIL). Only flag inert for the
        # unconfigured-default case, mirroring build_gate_inert.
        if not config.lint_command and is_verify_command_inert(result.returncode, result.stderr):
            lint_gate_inert = True
            lint_before = True  # no real lint baseline → don't treat as a regression source
            notes.append(
                f"Initial lint ({lint_cmd_str}) did not run (no runnable lint task); "
                "lint verification is INERT for this repo. Set pipeline.lintCommand in the "
                "repo's blueprint (e.g. 'npm run lint') to enable lint reporting."
            )
        else:
            note = f"Initial lint ({lint_cmd_str}) FAILED before agent changes"
            notes.append(note)
            lint_before = False
    else:
        notes.append(f"Initial lint ({lint_cmd_str}): OK")
        lint_before = True

    # Detect default branch (used as the PR base + the commit-diff range).
    # - PR tasks: base_branch from the orchestrator (the PR's real base).
    # - #247 A4 stacked children: base_branch is the predecessor's branch
    #   (linear) or main (diamond) — the child's PR targets it.
    # - Otherwise: detect the repo default (main/master).
    default_branch = config.base_branch or detect_default_branch(config.repo_url, repo_dir)

    # Install prepare-commit-msg hook for code attribution
    _install_commit_hook(repo_dir)

    # #299 plan-mode T2 (warm digest): ensure the cloned HEAD sha is captured for
    # NON-PR workflows too (the PR branch above already set it). The
    # coding/decompose-v1 planner echoes this into its plan's ``repo_digest_sha``
    # so a later revise run can tell if the repo moved since the digest was built.
    # Best-effort: a read failure leaves it '' (the platform's sha-shape guard then
    # just treats the digest as un-versioned — trust-but-reverify).
    if not head_sha_before:
        head_res = run_cmd(
            ["git", "rev-parse", "HEAD"],
            label="head-sha-after-setup",
            cwd=repo_dir,
            check=False,
        )
        if head_res.returncode == 0:
            head_sha_before = head_res.stdout.strip()

    return RepoSetup(
        repo_dir=repo_dir,
        branch=branch,
        notes=notes,
        build_before=build_before,
        lint_before=lint_before,
        default_branch=default_branch,
        build_gate_inert=build_gate_inert,
        lint_gate_inert=lint_gate_inert,
        head_sha_before=head_sha_before,
    )


def _merge_predecessor_branch(repo_dir: str, pred_branch: str, notes: list[str]) -> None:
    """Merge a predecessor branch into the current child branch (#247 A4 diamond).

    Fetches the predecessor branch and merges it so the child sees its
    code. On a clean merge: done. On a CONFLICT: abort the merge (leaving
    the working tree clean) and record a note. We deliberately do NOT leave
    the repo in a conflicted state — the agent runs AFTER setup and a
    half-merged tree would break its build/lint baseline. Instead the
    predecessor branch remains fetched (``origin/<pred_branch>``) and the
    note tells the agent to integrate it as part of its task. This keeps
    conflict resolution agent-driven (per #247 design) without corrupting
    the deterministic setup phase.
    """
    fetch_res = run_cmd(
        ["git", "fetch", "origin", pred_branch],
        label="fetch-predecessor",
        cwd=repo_dir,
        check=False,
    )
    if fetch_res.returncode != 0:
        notes.append(f"predecessor branch '{pred_branch}' not fetchable; skipped merge")
        log("SETUP", f"Predecessor branch not found, skipping merge: {pred_branch}")
        return

    merge_res = run_cmd(
        ["git", "merge", "--no-edit", f"origin/{pred_branch}"],
        label="merge-predecessor",
        cwd=repo_dir,
        check=False,
    )
    if merge_res.returncode == 0:
        log("SETUP", f"Merged predecessor branch: {pred_branch}")
        notes.append(f"merged predecessor branch '{pred_branch}'")
        return

    # Conflict (or other merge failure): abort to keep the tree clean.
    run_cmd(["git", "merge", "--abort"], label="merge-abort", cwd=repo_dir, check=False)
    notes.append(
        f"predecessor branch '{pred_branch}' conflicts with this branch; "
        f"merge aborted — integrate origin/{pred_branch} as part of the task"
    )
    log("SETUP", f"Predecessor merge conflicted, aborted: {pred_branch}")


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
