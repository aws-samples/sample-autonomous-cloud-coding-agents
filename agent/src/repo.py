"""Repository setup: clone, branch, mise install, initial build."""

import os
import subprocess
from typing import Any

from config import AGENT_WORKSPACE
from models import RepoSetup, TaskConfig
from shell import log, run_cmd, run_cmd_with_backoff, slugify

# Directories never worth scanning for nested mise configs (huge, and any
# ``mise.toml`` inside a dependency tree is not ours to trust). Bounds the walk
# on a large clone so the trust step stays fast.
_MISE_CONFIG_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "cdk.out", "dist", "build"})


def _find_mise_configs(repo_dir: str) -> list[str]:
    """Return every ``mise.toml`` under *repo_dir* EXCEPT the root one (already
    trusted by ``mise trust <repo_dir>``), skipping vendored/build dirs.

    A monorepo has per-package config roots (``cdk/mise.toml`` etc.); each must
    be trusted or ``mise run <task>`` fanning into it fails at the trust gate.
    """
    configs: list[str] = []
    for dirpath, dirnames, filenames in os.walk(repo_dir):
        dirnames[:] = [d for d in dirnames if d not in _MISE_CONFIG_SKIP_DIRS]
        if "mise.toml" in filenames and os.path.abspath(dirpath) != os.path.abspath(repo_dir):
            configs.append(os.path.join(dirpath, "mise.toml"))
    return configs


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


def _prepare_clone_dir(repo_dir: str, notes: list[str]) -> None:
    """ABCA-815 root cause: guarantee a clean slate at *repo_dir* before cloning.

    On persistent session storage the workspace path (``/workspace/<task_id>``)
    can carry residue from a prior run/task sharing the id or mount. If repo_dir
    already exists and is NON-EMPTY, ``gh repo clone <url> <repo_dir>`` exits 128
    ("directory not empty") WITHOUT nesting — but the agent, whose cwd IS
    repo_dir, then works against whatever stale tree is there (or re-clones into a
    subdir), while every pipeline git op (ensure_committed / ensure_pr /
    ensure_pushed) runs against repo_dir's ROOT. Those trees diverge silently:
    the agent's edits/commits land in the inner tree, the outer tree stays clean,
    ensure_committed sees nothing to commit, ensure_pr finds no commits, and the
    task reports a false COMPLETED with the work lost (the ABCA-815 stacked-child
    favorites regression). Removing the residue so the clone lands DIRECTLY in an
    empty repo_dir closes that divergence at the source; :func:`_assert_clone_root`
    is the post-clone backstop."""
    if os.path.exists(repo_dir) and os.listdir(repo_dir):
        log(
            "SETUP",
            f"Workspace {repo_dir} is non-empty before clone (persistent-storage "
            "residue) — clearing it so the clone lands at the root, not nested",
        )
        notes.append("cleared pre-existing workspace residue before clone")
        import shutil

        shutil.rmtree(repo_dir, ignore_errors=True)


def _assert_clone_root(repo_dir: str) -> None:
    """ABCA-815 backstop: assert the clone produced a git root AT *repo_dir*.

    If ``.git`` is missing here the working tree the agent will edit (cwd=repo_dir)
    is NOT a checkout the pipeline's git ops can see — every commit/PR step would
    silently no-op and the task would report a false success with the work lost.
    Fail loudly at setup (a plain RuntimeError → terminal FAILED with a clear
    reason) instead of after the agent has burned a run."""
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        raise RuntimeError(
            "clone did not produce a git repository at the workspace root "
            f"({repo_dir}/.git missing after clone) — the agent's working tree "
            "would not be the tracked checkout; refusing to run so no work is lost"
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

    # ABCA-815 root cause: guarantee a clean slate at repo_dir BEFORE cloning.
    _prepare_clone_dir(repo_dir, notes)

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

    # ABCA-815 backstop: assert the clone produced a git root AT repo_dir.
    _assert_clone_root(repo_dir)

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

    # Trust mise config files in the cloned repo (required before mise install
    # AND before every `mise run <task>`). ``mise trust <dir>`` trusts only the
    # ROOT ``mise.toml`` — but a monorepo has per-package config ROOTS
    # (``cdk/mise.toml``, ``cli/mise.toml``, ``agent/mise.toml``, ``docs/mise.toml``
    # here). When ``mise run build`` fans out into ``//cdk:eslint`` etc. it loads
    # the nested config, which is UNtrusted → ``mise ERROR Config files … are not
    # trusted`` → exit 1, and the whole build/lint gate dies in seconds BEFORE
    # anything compiles. (`mise trust --all` only covers cwd + PARENTS, not
    # children, so it doesn't help.) Trust every ``mise.toml`` in the clone.
    # Live-caught (ABCA-662 follow-up): fresh-clone fork builds failed the baseline
    # at the trust gate, indistinguishable in the log from a red build.
    run_cmd(
        ["mise", "trust", repo_dir],
        label="mise-trust",
        cwd=repo_dir,
        check=False,
    )
    for cfg in _find_mise_configs(repo_dir):
        run_cmd(
            ["mise", "trust", cfg],
            label="mise-trust-nested",
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
        BUILD_VERIFY_TIMEOUT_S,
        DEFAULT_BUILD_COMMAND,
        DEFAULT_LINT_COMMAND,
        is_infra_failure,
        is_verify_command_inert,
        resolve_verify_argv,
    )

    # #299 ECS_RIGHTSIZED_PLANNING: a read_only workflow (coding/decompose-v1)
    # clones, reads/greps to plan, and emits an artifact — it NEVER edits code,
    # runs the post-agent build/lint gate, or opens a PR. Running the full
    # pre-agent `mise run build` + lint baseline for it is pure waste: on a big
    # repo that baseline is the multi-minute CI-parity build the 64 GB box was
    # sized for, and it will not fit the 8 GB read-only planning task def (it
    # would stall or OOM the planner before it ever reads a file). Skip both
    # baselines for read_only and record neutral "OK" values (there is no
    # regression to gate against — nothing gets committed). No baseline is ever
    # compared for a read_only run, so these values are informational only.
    build_gate_inert = False
    lint_gate_inert = False
    if config.read_only:
        log("SETUP", "Skipping build/lint baseline for read-only workflow (no build, no PR)")
        notes.append("Read-only workflow: skipped pre-agent build/lint baseline (planning only)")
        build_before = True
        lint_before = True
    else:
        build_argv = resolve_verify_argv(config.build_command, DEFAULT_BUILD_COMMAND)
        build_cmd_str = " ".join(build_argv)
        log("SETUP", f"Running initial build ({build_cmd_str})...")
        # ABCA-659 Bug B: use the same generous wall-clock ceiling as the
        # POST-agent gate (BUILD_VERIFY_TIMEOUT_S, 30min) — NOT run_cmd's 600s
        # default — and GUARD the timeout. A heavy CI-parity baseline build
        # (install + compile + full test suite + synth) legitimately runs longer
        # than 10min; at 600s it raised TimeoutExpired here (this call had no
        # try/except) and crashed the whole task BEFORE the agent ever ran, so
        # the issue got no PR and sat in Backlog — indistinguishable from a real
        # failure (the 661/662 symptom). The baseline is only informational (it
        # seeds regression gating); a timeout means "no usable baseline", NOT
        # "the agent broke it", so we treat it as no-known-regression and let the
        # run proceed. The post-agent gate re-runs the build with the same
        # ceiling and surfaces an honest "timed out" if it's genuinely too slow.
        try:
            result = run_cmd(
                build_argv,
                label="verify-build-pre",
                cwd=repo_dir,
                check=False,
                timeout=BUILD_VERIFY_TIMEOUT_S,
                # Stream live → the full baseline-build log reaches CloudWatch
                # verbatim (buffered capture hid the failing sub-task — ABCA-662).
                stream=True,
            )
        except subprocess.TimeoutExpired:
            log(
                "WARN",
                f"Initial build ({build_cmd_str}) did not finish within "
                f"{BUILD_VERIFY_TIMEOUT_S}s — skipping baseline (not a regression)",
            )
            notes.append(
                f"Initial build ({build_cmd_str}) did not finish within "
                f"{BUILD_VERIFY_TIMEOUT_S}s — baseline skipped (not treated as a regression)"
            )
            build_before = True
        else:
            if result.returncode != 0 and is_infra_failure(result.returncode, result.stderr):
                # An ENVIRONMENT fault (OOM / exit 137 / out of disk) means the
                # baseline build was KILLED, not that the code is broken. Treat it
                # exactly like the timeout case above: there is NO usable baseline,
                # so record no-known-regression (build_before=True) rather than the
                # false "the project was already broken" (build_before=False).
                #
                # This was the ABCA-662 root cause: several heavy CI-parity builds
                # shared one ECS box, the baseline was OOM-killed (exit 137), and
                # the generic non-zero branch below mislabeled it build_before=False.
                # That false "already red" flag then told the regression gate
                # "red-before → red-after isn't the agent's fault → ✅" AND flowed
                # into the absolute orchestration gate as a node failure — a task
                # that GitHub built green. The post-agent gate already had this OOM
                # check (is_infra_failure); the pre-agent baseline was missing it.
                log(
                    "WARN",
                    f"Initial build ({build_cmd_str}) was KILLED by an environment "
                    f"fault (exit {result.returncode}: out of memory/disk) — no usable "
                    "baseline, treating as no-known-regression (not 'already broken')",
                )
                notes.append(
                    f"Initial build ({build_cmd_str}) hit an environment fault "
                    f"(exit {result.returncode}: out of memory/disk) before agent "
                    "changes — baseline skipped (not treated as a regression)"
                )
                build_before = True
            elif result.returncode != 0:
                note = f"Initial build ({build_cmd_str}) FAILED before agent changes"
                notes.append(note)
                build_before = False
                # #1: if the build command could not RUN (no task / not found) AND no
                # explicit build_command was configured, build-regression gating is
                # INERT — flag it so the agent warns on the PR rather than silently
                # passing every task. A configured command that fails to run is the
                # operator's typo, not the silent-default trap, so only flag the
                # unconfigured (mise-default) case.
                if not config.build_command and is_verify_command_inert(
                    result.returncode, result.stderr
                ):
                    build_gate_inert = True
                    notes.append(
                        "⚠️ Build-regression gating is INERT: no runnable `mise run build` task "
                        "in this repo and no build command configured. A change that breaks the "
                        "build will still report success. Set pipeline.buildCommand in the repo's "
                        "blueprint (e.g. 'npm run build') to enable gating."
                    )
            else:
                notes.append(f"Initial build ({build_cmd_str}): OK")
                build_before = True

        # Initial lint baseline (record whether lint passes before agent changes)
        lint_argv = resolve_verify_argv(config.lint_command, DEFAULT_LINT_COMMAND)
        lint_cmd_str = " ".join(lint_argv)
        log("SETUP", f"Running initial lint ({lint_cmd_str})...")
        # ABCA-659 Bug B: same generous ceiling + timeout guard as the build
        # baseline above (a slow lint must not crash the task before the agent
        # runs). A timeout → no usable lint baseline → treat as not-a-regression.
        try:
            result = run_cmd(
                lint_argv,
                label="verify-lint-pre",
                cwd=repo_dir,
                check=False,
                timeout=BUILD_VERIFY_TIMEOUT_S,
                stream=True,  # full lint output → CloudWatch verbatim (ABCA-662)
            )
        except subprocess.TimeoutExpired:
            log(
                "WARN",
                f"Initial lint ({lint_cmd_str}) did not finish within "
                f"{BUILD_VERIFY_TIMEOUT_S}s — skipping baseline (not a regression)",
            )
            notes.append(
                f"Initial lint ({lint_cmd_str}) did not finish within "
                f"{BUILD_VERIFY_TIMEOUT_S}s — baseline skipped (not treated as a regression)"
            )
            lint_before = True
            result = None
        if result is not None and result.returncode != 0:
            # #72: distinguish "lint couldn't RUN" (no `mise run lint` task and no
            # configured lint_command — the default fired and the task doesn't exist)
            # from a genuine lint failure. The former is INERT: recording it as a
            # red lint baseline is misleading (e.g. a Node repo with no mise lint
            # task perpetually shows lint FAIL). Only flag inert for the
            # unconfigured-default case, mirroring build_gate_inert.
            if not config.lint_command and is_verify_command_inert(
                result.returncode, result.stderr
            ):
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
        elif result is not None:
            # Ran and passed (the timeout path already noted + set lint_before).
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
