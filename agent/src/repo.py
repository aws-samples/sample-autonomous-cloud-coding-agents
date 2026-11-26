import os
import re
import subprocess
from typing import Any, NamedTuple, NoReturn

from config import AGENT_WORKSPACE
from models import RepoSetup, TaskConfig
from shell import log, run_cmd, run_cmd_with_backoff, slugify

_MISE_CONFIG_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "cdk.out", "dist", "build"})


def _find_mise_configs(repo_dir: str) -> list[str]:
    configs: list[str] = []
    for dirpath, dirnames, filenames in os.walk(repo_dir):
        dirnames[:] = [d for d in dirnames if d not in _MISE_CONFIG_SKIP_DIRS]
        if "mise.toml" in filenames and os.path.abspath(dirpath) != os.path.abspath(repo_dir):
            configs.append(os.path.join(dirpath, "mise.toml"))
    return configs


def _clone_backoff_reporter(progress: Any, label: str):
    if progress is None:
        return None

    from hooks import _try_progress

    def _on_retry(attempt: int, max_attempts: int, _stderr: str) -> None:
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
    """Raised when repo setup cannot reach a dependency.

    Its message is a canonical ``BLOCKED[<kind>]`` reason, which the platform's
    error classifier matches."""


def _fail_setup_command(label: str, resource: str, stderr: str, progress: Any) -> NoReturn:
    from hooks import _record_blocker_reason, _try_progress, detect_egress_denial
    from shell import is_transient_cmd_failure, redact_secrets

    egress_detected, host = detect_egress_denial(stderr)
    if egress_detected and host:
        detail = f"{label} could not reach {host!r} (host not allowlisted)"
        _record_blocker_reason("egress_denied", detail, host)
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
        snippet = redact_secrets((stderr or "").strip())[:500]
        raise RuntimeError(f"{label} failed (non-transient): {snippet}")

    from progress_writer import format_blocker_reason

    detail = f"{label} failed after bounded retries"
    _record_blocker_reason("dependency_unreachable", detail, resource)
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


class PushCapabilityError(RuntimeError):
    """Raised when GitHub refuses the push the preflight tries.

    The message is the contract with the CDK error classifier
    (``cdk/src/handlers/shared/error-classifier.ts``), which matches it anywhere in
    the persisted error. Per ``cause``:

    - ``no_write``: contains ``Token cannot push to <repo>``.
    - ``credential_rejected``: a ``BLOCKED[auth_failure]`` reason.
    - ``org_policy``: contains ``GitHub organization policy blocks pushes to``.
    - ``archived``: contains ``is archived on GitHub, so it is read-only``.

    ``cause`` also picks the live ``agent_blocked`` event."""

    def __init__(self, message: str, *, cause: str) -> None:
        super().__init__(message)
        self.cause = cause


# A dry run sends no ref update, so the remote never gets this ref. Git still checks
# a dry run to a ref the remote already has for fast-forward, so the refspec is forced.
_PUSH_PREFLIGHT_REF = "refs/heads/bgagent-push-preflight"

# GitHub refuses the push service to a token without write access, with 403 or with
# 404 "Repository not found".
_PUSH_REFUSED_SIGNATURES: tuple[str, ...] = (
    "permission to",  # remote: Permission to <owner>/<repo>.git denied to <user>.
    "write access to repository not granted",
    "the requested url returned error: 403",
    "the requested url returned error: 404",
    "repository not found",
)

_CREDENTIAL_REJECTED_SIGNATURES: tuple[str, ...] = (
    "the requested url returned error: 401",
    "authentication failed",
    "invalid username or password",
    "invalid username or token",
    "could not read username",
    "terminal prompts disabled",
)

# GitHub sends an organization-policy refusal with a 403 too.
_ORG_POLICY_REFUSALS: tuple[tuple[str, str], ...] = (
    (
        "saml sso",
        (
            "it enforces SAML single sign-on and the token is not authorized for it. To fix "
            "it, authorize the classic token for the organization (GitHub > Settings > "
            "Developer settings > Personal access tokens > Tokens (classic) > Configure SSO)"
        ),
    ),
    (
        "ip allow list",
        (
            "its IP allow list does not include the agent's address. To fix it, add the "
            "agent's egress IP addresses to the organization's IP allow list"
        ),
    ),
)
_ARCHIVED_SIGNATURE = "this repository was archived so it is read-only"

_REFUSAL_EVENTS: dict[str, tuple[str, str]] = {
    "no_write": ("auth_failure", "GitHub refused the token a push to {repo}"),
    "credential_rejected": ("auth_failure", "GitHub did not accept a token for {repo}"),
    "org_policy": ("auth_failure", "An organization policy blocks the token for {repo}"),
    "archived": ("unknown_environmental", "{repo} is archived on GitHub (read-only)"),
}


class _TokenRemedy(NamedTuple):
    label: str
    remedy: str


def _token_remedy(token: str) -> _TokenRemedy:
    owner = "its owner needs write access to the repository"
    classic = (
        "give the token the `public_repo` scope for a public repository, or `repo` for a "
        "private one (`repo` grants every private repository its owner can reach)"
    )
    fine_grained = (
        "include the repository in the token's repository access and give it the "
        "Contents permission with Read and write access"
    )
    if token.startswith("github_pat_"):
        return _TokenRemedy("fine-grained personal access token", f"{fine_grained}; {owner}")
    if token.startswith("ghp_"):
        return _TokenRemedy("classic personal access token", f"{classic}; {owner}")
    if token.startswith(("ghs_", "ghu_")):
        return _TokenRemedy(
            "GitHub App token",
            "give the app the Contents permission with Read and write access and install "
            "it on the repository",
        )
    return _TokenRemedy(
        "GitHub token",
        f"for a fine-grained personal access token, {fine_grained}; for a classic one, "
        f"{classic}; either way, {owner}",
    )


def _quoted_line(lines: list[str], signatures: tuple[str, ...]) -> str:
    from shell import redact_secrets

    line = next((ln for ln in lines if any(s in ln.lower() for s in signatures)), "")
    line = re.sub(r"(?i)(denied to )\S+", r"\1<token user>", line or (lines[0] if lines else ""))
    return redact_secrets(line)[:200]


def _push_refusal(config: TaskConfig, stderr: str) -> PushCapabilityError | None:
    from progress_writer import format_blocker_reason
    from shell import is_transient_cmd_failure

    if is_transient_cmd_failure(stderr):
        return None
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    remote = " ".join(ln.lower() for ln in lines if ln.lower().startswith("remote:"))
    low = stderr.lower()
    repo_url = config.repo_url
    no_loss = "The task stopped before the agent ran, so no work was lost."
    if _ARCHIVED_SIGNATURE in remote:
        return PushCapabilityError(
            f"Repository {repo_url} is archived on GitHub, so it is read-only "
            f"({_quoted_line(lines, (_ARCHIVED_SIGNATURE,))}). Unarchive it or target "
            f"another repository. {no_loss}",
            cause="archived",
        )
    for signature, cause in _ORG_POLICY_REFUSALS:
        if signature in remote:
            return PushCapabilityError(
                f"GitHub organization policy blocks pushes to {repo_url}: {cause} "
                f"({_quoted_line(lines, (signature,))}). {no_loss}",
                cause="org_policy",
            )
    if any(sig in low for sig in _CREDENTIAL_REJECTED_SIGNATURES):
        line = _quoted_line(lines, _CREDENTIAL_REJECTED_SIGNATURES)
        return PushCapabilityError(
            format_blocker_reason(
                "auth_failure",
                f"GitHub did not accept a token for the push ({line}): it is missing, "
                f"invalid, expired or revoked. Replace the GitHub token secret, then "
                f"resubmit. {no_loss}",
                repo_url,
            ),
            cause="credential_rejected",
        )
    if any(sig in low for sig in _PUSH_REFUSED_SIGNATURES):
        token_type, remedy = _token_remedy(config.github_token)
        return PushCapabilityError(
            f"Token cannot push to {repo_url}: GitHub refused the {token_type} write "
            f"access ({_quoted_line(lines, _PUSH_REFUSED_SIGNATURES)}). To fix it, "
            f"{remedy}. {no_loss} Token types and the permissions they need: "
            "agent/README.md, GitHub PAT — Minimal Permissions.",
            cause="no_write",
        )
    return None


def _preflight_probe_commit(repo_dir: str) -> str:
    """``HEAD`` names no commit in a clone of an empty repository, so pushing it fails
    before git contacts the remote. Git knows the empty tree without storing it."""
    tree = run_cmd(
        ["git", "hash-object", "-t", "tree", "/dev/null"],
        label="push-preflight-tree",
        cwd=repo_dir,
    ).stdout.strip()
    return run_cmd(
        [
            "git",
            "-c",
            "user.name=bgagent",
            "-c",
            "user.email=bgagent@noreply.github.com",
            "commit-tree",
            tree,
            "-m",
            "bgagent push preflight",
        ],
        label="push-preflight-commit",
        cwd=repo_dir,
    ).stdout.strip()


_PUSH_PREFLIGHT_TIMEOUT_S = 120


def _fail_push_preflight_timeout(
    config: TaskConfig, exc: subprocess.TimeoutExpired, progress: Any
) -> NoReturn:
    from hooks import _record_blocker_reason, _try_progress
    from progress_writer import format_blocker_reason
    from shell import redact_secrets

    output = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr
    if output:
        log("WARN", f"push-preflight output before the timeout: {redact_secrets(output)[-500:]}")
    detail = f"push-preflight got no answer from GitHub within {_PUSH_PREFLIGHT_TIMEOUT_S}s"
    _record_blocker_reason("dependency_unreachable", detail, config.repo_url)
    if progress is not None:
        _try_progress(
            progress,
            "write_agent_blocked",
            kind="dependency_unreachable",
            detail=detail,
            remediation_hint="Check GitHub's status and the agent VPC's reachability, then retry.",
            retryable=True,
            resource=config.repo_url,
        )
    raise DependencyUnreachableError(
        format_blocker_reason("dependency_unreachable", detail, config.repo_url)
    )


def _report_refusal(refusal: PushCapabilityError, config: TaskConfig, progress: Any) -> None:
    from hooks import _record_blocker_reason, _try_progress

    kind, detail = _REFUSAL_EVENTS[refusal.cause]
    detail = detail.format(repo=config.repo_url)
    _record_blocker_reason(kind, detail, config.repo_url)
    if progress is not None:
        _try_progress(
            progress,
            "write_agent_blocked",
            kind=kind,
            detail=detail,
            remediation_hint="The task error names the cause and the fix; resubmit after it.",
            retryable=False,
            resource=config.repo_url,
        )


_GITHUB = "https://github.com"


def _configure_git_credentials(repo_dir: str, repo_url: str) -> None:
    """An explicit push URL is exempt from a ``url.<base>.pushInsteadOf`` rule in the
    machine's git config; a plain ``insteadOf`` rule rewrites it all the same.

    Git asks every credential helper that applies to a URL in turn (system, global,
    then local config) and takes the first answer. An empty
    ``credential.https://github.com.helper`` clears every helper read before it, for
    github.com only.
    """
    url = f"{_GITHUB}/{repo_url}.git"
    run_cmd(
        ["git", "remote", "set-url", "--push", "origin", url],
        label="set-remote-push-url",
        cwd=repo_dir,
    )
    effective = run_cmd(
        ["git", "remote", "get-url", "--push", "origin"],
        label="get-remote-push-url",
        cwd=repo_dir,
    ).stdout.strip()
    if effective != url:
        from shell import redact_secrets

        raise RuntimeError(
            f"git config rewrites the push URL of {repo_url} to {redact_secrets(effective)!r} "
            "(a url.<base>.insteadOf rule in the system or global git config), so the push "
            "would not use the task's GitHub token. Remove that rule, or run the agent "
            "where git has no such configuration."
        )
    helper_key = f"credential.{_GITHUB}.helper"
    run_cmd(
        ["git", "config", "--local", helper_key, ""],
        label="reset-git-credential-helpers",
        cwd=repo_dir,
    )
    run_cmd(
        ["git", "config", "--local", "--add", helper_key, "!gh auth git-credential"],
        label="configure-git-credential-helper",
        cwd=repo_dir,
    )


def _task_pushes(config: TaskConfig) -> bool:
    if config.read_only:
        return False
    from workflow import WorkflowValidationError, load_workflow

    try:
        workflow = load_workflow((config.resolved_workflow or {}).get("id", "coding/new-task-v1"))
    except WorkflowValidationError:
        return True
    return not (workflow.delivers_repo_artifact or workflow.ensure_pr_strategy == "resolve")


def _preflight_push_capability(config: TaskConfig, repo_dir: str, progress: Any) -> None:
    """Fail the task now if GitHub refuses the token a push to the repository (#801).

    GitHub's REST ``permissions.push`` and GraphQL ``viewerPermission`` describe the
    user's role on the repository, not what the token may do, and GitHub returns no
    ``X-OAuth-Scopes`` header for a fine-grained token. ``git push --dry-run`` asks
    GitHub for the push service, which GitHub refuses to a token without write
    access, then stops before sending anything. Branch rules and push protection are
    evaluated on a real push only.
    """
    if not _task_pushes(config):
        return

    log("SETUP", f"Checking that the GitHub token can push to {config.repo_url}...")
    probe = _preflight_probe_commit(repo_dir)
    try:
        result = run_cmd_with_backoff(
            [
                "git",
                "push",
                "--dry-run",
                # A dry run still runs the pre-push hook.
                "--no-verify",
                "origin",
                f"+{probe}:{_PUSH_PREFLIGHT_REF}",
            ],
            label="push-preflight",
            cwd=repo_dir,
            timeout=_PUSH_PREFLIGHT_TIMEOUT_S,
            on_retry=_clone_backoff_reporter(progress, "push-preflight"),
        )
    except subprocess.TimeoutExpired as exc:
        _fail_push_preflight_timeout(config, exc, progress)
    if result.returncode == 0:
        return
    stderr = result.stderr or ""
    refusal = _push_refusal(config, stderr)
    if refusal is not None:
        _report_refusal(refusal, config, progress)
        raise refusal
    _fail_setup_command("push-preflight", config.repo_url, stderr, progress)


def _prepare_clone_dir(repo_dir: str, notes: list[str]) -> None:
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
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        raise RuntimeError(
            "clone did not produce a git repository at the workspace root "
            f"({repo_dir}/.git missing after clone) — the agent's working tree "
            "would not be the tracked checkout; refusing to run so no work is lost"
        )


def _refuse_pr_from_fork(config: TaskConfig, repo_dir: str, progress: Any) -> None:
    view = run_cmd_with_backoff(
        [
            "gh",
            "pr",
            "view",
            config.pr_number,
            "--repo",
            config.repo_url,
            "--json",
            "isCrossRepository",
            "-q",
            ".isCrossRepository",
        ],
        label="check-pr-fork",
        cwd=repo_dir,
        on_retry=_clone_backoff_reporter(progress, "check-pr-fork"),
    )
    if view.returncode != 0:
        _fail_setup_command("check-pr-fork", config.repo_url, view.stderr, progress)
    if view.stdout.strip() == "true":
        raise RuntimeError(
            f"pull request #{config.pr_number} of {config.repo_url} comes from another "
            "repository (a fork): its branch is in that repository, not in "
            f"{config.repo_url}, so it cannot be checked out or pushed to here"
        )


def _run_baseline(argv: list[str], label: str, repo_dir: str) -> subprocess.CompletedProcess:
    from post_hooks import BUILD_VERIFY_TIMEOUT_S, SHELL_COMMAND_NOT_FOUND

    try:
        return run_cmd(
            argv,
            label=label,
            cwd=repo_dir,
            check=False,
            timeout=BUILD_VERIFY_TIMEOUT_S,
            stream=True,
        )
    except OSError as exc:
        log("WARN", f"{label}: the command could not be started: {exc}")
        return subprocess.CompletedProcess(argv, SHELL_COMMAND_NOT_FOUND, "", str(exc))


def setup_repo(config: TaskConfig, progress: Any = None) -> RepoSetup:  # noqa: C901 -- 28 when the ceiling of 15 was set; must not grow
    """Clone repo, create branch, configure git auth, run mise install.

    When ``progress`` is present, transient clone/fetch retries emit
    ``dependency_unreachable`` blocker events.
    """
    repo_dir = f"{AGENT_WORKSPACE}/{config.task_id}"
    notes: list[str] = []

    if config.branch_name:
        branch = config.branch_name
    else:
        title = ""
        if config.issue:
            title = config.issue.title
        if not title:
            title = config.task_description
        slug = slugify(title)
        branch = f"bgagent/{config.task_id}/{slug}"

    _prepare_clone_dir(repo_dir, notes)

    # On persistent session storage the mount may be owned by a different UID than
    # the container user, triggering git's "dubious ownership" check.
    run_cmd(
        ["git", "config", "--global", "--add", "safe.directory", repo_dir],
        label="safe-directory",
    )

    # ``--no-upstream``: for a fork, gh would add the parent as the remote
    # ``upstream`` and make it the repository of every later ``gh`` command that
    # has no ``--repo``.
    log("SETUP", f"Cloning {config.repo_url}...")
    clone_result = run_cmd_with_backoff(
        ["gh", "repo", "clone", "--no-upstream", config.repo_url, repo_dir],
        label="clone",
        on_retry=_clone_backoff_reporter(progress, "clone"),
    )
    if clone_result.returncode != 0:
        _fail_setup_command("clone", config.repo_url, clone_result.stderr, progress)

    _assert_clone_root(repo_dir)

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
    _configure_git_credentials(repo_dir, config.repo_url)

    _preflight_push_capability(config, repo_dir, progress)

    head_sha_before = ""
    resolved_diamond_base: str | None = None
    pr_base = config.base_branch
    if config.is_pr_workflow and config.branch_name:
        log("SETUP", f"Checking out existing PR branch: {branch}")
        _refuse_pr_from_fork(config, repo_dir, progress)
        fetch_result = run_cmd_with_backoff(
            ["git", "fetch", "origin", branch],
            label="fetch-pr-branch",
            cwd=repo_dir,
            on_retry=_clone_backoff_reporter(progress, "fetch-pr-branch"),
        )
        if fetch_result.returncode != 0:
            _fail_setup_command("fetch-pr-branch", branch, fetch_result.stderr, progress)
        # ``-B``, not ``-b``: when the pull request's head is the repository's
        # default branch, the clone has already created that branch, and ``-b``
        # refuses to create it again.
        run_cmd(
            ["git", "checkout", "-B", branch, f"origin/{branch}"],
            label="checkout-pr-branch",
            cwd=repo_dir,
        )
        sha_res = run_cmd(
            ["git", "rev-parse", "HEAD"],
            label="head-sha-before",
            cwd=repo_dir,
            check=False,
        )
        if sha_res.returncode == 0:
            head_sha_before = sha_res.stdout.strip()
        for pred_branch in config.merge_branches:
            _merge_predecessor_branch(repo_dir, pred_branch, notes)
    elif config.base_branch:
        base_branch = config.base_branch
        if config.merge_branches:
            detected = detect_default_branch(config.repo_url, repo_dir)
            if detected != base_branch:
                log(
                    "SETUP",
                    f"Diamond base: server passed '{base_branch}', using detected "
                    f"repo default '{detected}' instead (F1 wrong-base guard)",
                )
                base_branch = detected
            resolved_diamond_base = base_branch
        log("SETUP", f"Creating branch {branch} from base {base_branch}")
        base_res = run_cmd(
            ["git", "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{base_branch}"],
            label="find-base-branch",
            cwd=repo_dir,
            check=False,
        )
        if base_res.returncode == 0:
            run_cmd(
                ["git", "checkout", "-b", branch, f"origin/{base_branch}"],
                label="create-branch-from-base",
                cwd=repo_dir,
            )
        else:
            notes.append(f"base branch '{base_branch}' not on origin; branched off default instead")
            log("SETUP", f"Base branch not found; creating {branch} off HEAD")
            run_cmd(["git", "checkout", "-b", branch], label="create-branch", cwd=repo_dir)
            pr_base = None

        for pred_branch in config.merge_branches:
            _merge_predecessor_branch(repo_dir, pred_branch, notes)
    else:
        log("SETUP", f"Creating branch: {branch}")
        run_cmd(["git", "checkout", "-b", branch], label="create-branch", cwd=repo_dir)

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

    from post_hooks import (
        BUILD_VERIFY_TIMEOUT_S,
        DEFAULT_BUILD_COMMAND,
        DEFAULT_LINT_COMMAND,
        is_infra_failure,
        is_verify_command_inert,
        resolve_verify_argv,
    )

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
        try:
            result = _run_baseline(build_argv, "verify-build-pre", repo_dir)
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

        lint_argv = resolve_verify_argv(config.lint_command, DEFAULT_LINT_COMMAND)
        lint_cmd_str = " ".join(lint_argv)
        log("SETUP", f"Running initial lint ({lint_cmd_str})...")
        try:
            result = _run_baseline(lint_argv, "verify-lint-pre", repo_dir)
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
            if not config.lint_command and is_verify_command_inert(
                result.returncode, result.stderr
            ):
                lint_gate_inert = True
                lint_before = True
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
            notes.append(f"Initial lint ({lint_cmd_str}): OK")
            lint_before = True

    default_branch = (
        resolved_diamond_base or pr_base or detect_default_branch(config.repo_url, repo_dir)
    )

    _install_commit_hook(repo_dir)

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
    pred_res = run_cmd(
        ["git", "show-ref", "--verify", "--quiet", f"refs/remotes/origin/{pred_branch}"],
        label="find-predecessor",
        cwd=repo_dir,
        check=False,
    )
    if pred_res.returncode != 0:
        notes.append(f"predecessor branch '{pred_branch}' not on origin; skipped merge")
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

    run_cmd(["git", "merge", "--abort"], label="merge-abort", cwd=repo_dir, check=False)
    notes.append(
        f"predecessor branch '{pred_branch}' conflicts with this branch; "
        f"merge aborted — integrate origin/{pred_branch} as part of the task"
    )
    log("SETUP", f"Predecessor merge conflicted, aborted: {pred_branch}")


def _install_commit_hook(repo_dir: str) -> None:
    try:
        hooks_dir = os.path.join(repo_dir, ".git", "hooks")
        os.makedirs(hooks_dir, exist_ok=True)

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
        os.chmod(hook_dst, current | exec_bits)
        log("SETUP", "Installed prepare-commit-msg hook")
    except Exception as e:
        log("WARN", f"Commit hook install failed: {type(e).__name__}: {e}")


def _default_branch_of_clone(repo_dir: str) -> str:
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log("WARN", f"Could not read origin/HEAD ({type(exc).__name__}) — defaulting to 'main'")
        return "main"
    branch = result.stdout.strip().removeprefix("refs/remotes/origin/")
    if result.returncode != 0 or not branch:
        log("WARN", "The clone has no origin/HEAD — defaulting to 'main'")
        return "main"
    log("SETUP", f"Default branch of the clone (origin/HEAD): {branch}")
    return branch


def detect_default_branch(repo_url: str, repo_dir: str) -> str:
    """Detect the repository's default branch via gh CLI.

    If detection fails (timeout, auth error, etc.), falls back to the default
    branch the clone recorded, and to 'main' only when that is unknown too.
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
        log("WARN", "Default branch detection timed out — using the clone's origin/HEAD")
        return _default_branch_of_clone(repo_dir)
    except (OSError, subprocess.SubprocessError) as exc:
        log(
            "WARN",
            f"Default branch detection failed ({type(exc).__name__}) — "
            "using the clone's origin/HEAD",
        )
        return _default_branch_of_clone(repo_dir)

    if result.returncode == 0 and result.stdout.strip():
        branch = result.stdout.strip()
        log("SETUP", f"Detected default branch: {branch}")
        return branch

    stderr = result.stderr.strip()[:200] if result.stderr else "(no stderr)"
    log(
        "WARN",
        f"Could not detect default branch (exit {result.returncode}): "
        f"{stderr} — using the clone's origin/HEAD",
    )
    return _default_branch_of_clone(repo_dir)
