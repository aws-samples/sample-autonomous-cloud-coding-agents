"""Repository setup: clone, branch, mise install, initial build."""

import os
import re
import subprocess
from typing import Any, NamedTuple, NoReturn

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
    blocker event per transient retry — auditable in the live stream and the
    retained event record. Returns ``None`` when no progress writer is wired so
    ``run_cmd_with_backoff`` simply logs to CMD."""
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
    """Raised when repo setup cannot reach a dependency after bounded retries.

    Its message is the canonical ``BLOCKED[dependency_unreachable]`` reason so the
    crash path carries it into the terminal ``error`` verbatim and the platform's
    error classifier attaches a precise remedy."""


def _fail_setup_command(label: str, resource: str, stderr: str, progress: Any) -> NoReturn:
    """Handle a failed clone, fetch or push preflight after bounded retries.

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
    3. **Permanent** — repo not found, auth denied, any other git error: re-raise
       a plain ``RuntimeError`` carrying the redacted git stderr, preserving the
       original ``check=True`` behavior so it is never mislabeled retryable. The
       classifier names an auth or not-found remedy when the stderr matches one of
       its patterns, and "Unexpected error" otherwise.

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
        # TaskResult.error (DynamoDB, `bgagent status`). The original check=True
        # path redacted here (shell.py run_cmd); preserve that so a credential in
        # git stderr never lands in cleartext.
        # Redact first: a cut can remove the prefix the redactor recognizes a token by.
        snippet = redact_secrets((stderr or "").strip())[:500]
        raise RuntimeError(f"{label} failed (non-transient): {snippet}")

    # (2) Transient with no nameable host.
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
    the persisted error (the pipeline prefixes the type name). Per ``cause``:

    - ``no_write``: contains ``Token cannot push to <repo>``, classified
      "Insufficient GitHub token scopes". The orchestrator's preflight uses the same
      phrase, but its message also carries the ``INSUFFICIENT_GITHUB_REPO_PERMISSIONS``
      code, which matches first and is titled "Insufficient GitHub permissions": same
      category and verdict, another title.
    - ``credential_rejected``: a ``BLOCKED[auth_failure]`` reason.
    - ``org_policy``: contains ``GitHub organization policy blocks pushes to``.
    - ``archived``: contains ``is archived on GitHub, so it is read-only``.

    ``cause`` also picks the live ``agent_blocked`` event, so it cannot disagree
    with the message."""

    def __init__(self, message: str, *, cause: str) -> None:
        super().__init__(message)
        self.cause = cause


# Ref the push preflight dry-runs to. A dry run sends no ref update, so the remote
# never gets this ref. The refspec is forced: a dry run to a ref the remote already
# has is otherwise checked for fast-forward, and that refusal says nothing about the
# token.
_PUSH_PREFLIGHT_REF = "refs/heads/bgagent-push-preflight"

# GitHub refuses the push service to a token without write access, with 403 or with
# 404 "Repository not found". The clone has just fetched this repository, so it
# exists: here a 404 is a refused push, not a missing repository.
_PUSH_REFUSED_SIGNATURES: tuple[str, ...] = (
    "permission to",  # remote: Permission to <owner>/<repo>.git denied to <user>.
    "write access to repository not granted",
    "the requested url returned error: 403",
    "the requested url returned error: 404",
    "repository not found",
)

# GitHub did not accept a credential for the push, or none was sent. An invalid
# token fails earlier (the orchestrator's preflight and ``gh repo clone`` both send
# it), so here it was revoked or expired after the clone, or the helper supplied none.
_CREDENTIAL_REJECTED_SIGNATURES: tuple[str, ...] = (
    "the requested url returned error: 401",
    "authentication failed",
    "invalid username or password",
    "invalid username or token",
    "could not read username",
    "terminal prompts disabled",
)

# Refusals caused by an organization policy, not by the token's permissions: GitHub
# sends them with a 403 too. Whole phrases from GitHub's ``remote:`` lines, which a
# user, organization or repository name (one word) cannot contain.
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

# The live event for each refusal cause: (blocker kind, detail).
_REFUSAL_EVENTS: dict[str, tuple[str, str]] = {
    "no_write": ("auth_failure", "GitHub refused the token a push to {repo}"),
    "credential_rejected": ("auth_failure", "GitHub did not accept a token for {repo}"),
    "org_policy": ("auth_failure", "An organization policy blocks the token for {repo}"),
    "archived": ("unknown_environmental", "{repo} is archived on GitHub (read-only)"),
}


class _TokenRemedy(NamedTuple):
    label: str  # the token type, as the error names it
    remedy: str


def _token_remedy(token: str) -> _TokenRemedy:
    """The token type and the permission to add, for a token GitHub refused a push.

    Reads only the documented type prefix of the token; the token itself never
    reaches the message. A personal access token acts for its owner, so the owner
    needs write access to the repository as well: the remedies say so. They say
    "the repository", never its name: the message names it once, and a long
    ``owner/repo`` repeated in every remedy could push the end of the message past
    what the task record stores, where the classifier reads it."""
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
    """The first line naming one of *signatures*, as the error quotes it: the line
    that says why, not a ``warning:`` before it. Redacted, and without the login
    GitHub names in ``denied to <user>``."""
    from shell import redact_secrets

    line = next((ln for ln in lines if any(s in ln.lower() for s in signatures)), "")
    line = re.sub(r"(?i)(denied to )\S+", r"\1<token user>", line or (lines[0] if lines else ""))
    # Redact first: a cut can remove the prefix the redactor recognizes a token by.
    return redact_secrets(line)[:200]


def _push_refusal(config: TaskConfig, stderr: str) -> PushCapabilityError | None:
    """Classify a failed dry-run push; ``None`` when GitHub did not refuse it."""
    from progress_writer import format_blocker_reason
    from shell import is_transient_cmd_failure

    # A failure that outlasted the retries or a blocked host is never a refusal, so
    # a policy phrase can never make it permanent; _fail_setup_command takes it.
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
    """Make a commit to dry-run push, in any clone, an empty repository's too.

    ``HEAD`` names no commit in a clone of an empty repository, so pushing it fails
    before git contacts the remote. This commit's tree is the empty tree, which git
    knows without storing it, so making the commit writes one unreferenced object and
    leaves ``HEAD``, the index and the working tree alone."""
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


# Seconds one dry-run attempt may take. It only lists the remote's refs.
_PUSH_PREFLIGHT_TIMEOUT_S = 120


def _fail_push_preflight_timeout(
    config: TaskConfig, exc: subprocess.TimeoutExpired, progress: Any
) -> NoReturn:
    """Report a dry run GitHub did not answer in time: retryable, not a build timeout.

    ``run_cmd_with_backoff`` does not retry a timeout, so the reason says one attempt
    rather than claiming retries."""
    from hooks import _record_blocker_reason, _try_progress
    from progress_writer import format_blocker_reason
    from shell import redact_secrets

    output = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr
    if output:
        # Redact first: a cut can remove the prefix the redactor recognizes a token by.
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
    """Emit the live ``agent_blocked`` event that matches *refusal*'s cause."""
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
    """Make every push from this clone go to GitHub over HTTPS with the task's token.

    - **The push URL.** A ``url.<base>.pushInsteadOf`` rule in the machine's git
      config rewrites the push URL (to SSH, say) while the fetch URL stays HTTPS, so
      the push preflight and the final push would use the developer's SSH key, not
      the task's token. An explicit push URL is exempt from ``pushInsteadOf``. A plain
      ``insteadOf`` rule rewrites it all the same, so the effective push URL is then
      checked, and setup stops if it is not the HTTPS one.
    - **The credential.** Git asks every credential helper that applies to a URL in
      turn (system, global, then local config) and takes the first answer, so a
      saved GitHub login would answer before a helper added here. An empty
      ``credential.https://github.com.helper`` in the local config clears every
      helper read before it for github.com, and only for github.com: a login for
      another host keeps working. Then only ``gh`` answers there, reading
      ``GH_TOKEN``/``GITHUB_TOKEN`` at call time; the token never touches disk.
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
    """Whether the task's post-hooks will push, by the rules they apply.

    Read-only workflows never push. A repository-bound workflow whose primary
    outcome is an artifact clones for context and delivers a document instead of a
    PR (``Workflow.delivers_repo_artifact``). A workflow whose ``ensure_pr`` step
    uses the ``resolve`` strategy only looks up the existing PR
    (``Workflow.ensure_pr_strategy``). Both are the rules the pipeline's post-hooks
    use."""
    if config.read_only:
        return False
    from workflow import load_workflow

    workflow = load_workflow((config.resolved_workflow or {}).get("id", "coding/new-task-v1"))
    return not (workflow.delivers_repo_artifact or workflow.ensure_pr_strategy == "resolve")


def _preflight_push_capability(config: TaskConfig, repo_dir: str, progress: Any) -> None:
    """Fail the task now if GitHub refuses the token a push to the repository (#801).

    A token can authenticate and read a repository while every write is refused,
    for instance a classic personal access token with no scopes, which still reads
    public repositories. Nothing else in setup notices: such a token passes the
    clone and the whole agent run, and the work is lost at the final push. The
    orchestrator's preflight does not catch it either: the REST API's
    ``permissions.push`` and the GraphQL ``viewerPermission`` it falls back to both
    describe the user's role on the repository, not what the token may do.

    ``git push --dry-run`` asks GitHub for the push service, which GitHub refuses
    to a token without write access, then stops before sending anything. It uses the
    remote and the credential helper of the final push, so it tests that path for
    every token type, with no scope parsing: GitHub returns no ``X-OAuth-Scopes``
    header for a fine-grained token. The helper reads the token from
    ``GH_TOKEN``/``GITHUB_TOKEN`` at call time; it is never written to disk or passed
    on the command line. The check covers write access only: branch rules and push
    protection are evaluated on a real push, which a dry run never makes.

    Tasks that never push are not checked (``_task_pushes``): read-only workflows,
    and repository-bound workflows that deliver an artifact. A token that may not
    write is fit for them.
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
                # A dry run still runs the pre-push hook. Skip it: the probe tests the
                # credential, and no hook from a global core.hooksPath or a git
                # template may block or slow it.
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
        # Unhandled, the timeout would be classified as a build timeout.
        _fail_push_preflight_timeout(config, exc, progress)
    if result.returncode == 0:
        return
    stderr = result.stderr or ""
    refusal = _push_refusal(config, stderr)
    if refusal is not None:
        _report_refusal(refusal, config, progress)
        raise refusal
    # Not a refusal: a transient failure that outlasted the retries, an egress block,
    # or another git error. The final push goes through the same remote, credential
    # helper and transport, so going on would most likely lose the agent's work at the
    # end. _fail_setup_command reports it as egress_denied, a retryable
    # dependency_unreachable, or a plain RuntimeError carrying git's message.
    _fail_setup_command("push-preflight", config.repo_url, stderr, progress)


def _prepare_clone_dir(repo_dir: str, notes: list[str]) -> None:
    """Guarantee a clean slate at *repo_dir* before cloning.

    On persistent session storage the workspace path (``/workspace/<task_id>``)
    can carry residue from a prior run/task sharing the id or mount. If repo_dir
    already exists and is NON-EMPTY, ``gh repo clone <url> <repo_dir>`` exits 128
    ("directory not empty") WITHOUT nesting — but the agent, whose cwd IS
    repo_dir, then works against whatever stale tree is there (or re-clones into a
    subdir), while every pipeline git op (ensure_committed / ensure_pr /
    ensure_pushed) runs against repo_dir's ROOT. Those trees diverge silently:
    the agent's edits/commits land in the inner tree, the outer tree stays clean,
    ensure_committed sees nothing to commit, ensure_pr finds no commits, and the
    task reports a false COMPLETED with the work lost. Removing the residue so the
    clone lands DIRECTLY in an empty repo_dir closes that divergence at the
    source; :func:`_assert_clone_root` is the post-clone backstop."""
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
    """Backstop: assert the clone produced a git root AT *repo_dir*.

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


def _refuse_pr_from_fork(config: TaskConfig, repo_dir: str, progress: Any) -> None:
    """Stop before a fork's pull request is taken for a branch of this repository.

    ``config.branch_name`` is the head ref of the pull request, and setup fetches
    that name from ``origin``. A pull request from a fork has its branch in the
    fork. Where this repository has a branch of the same name (a fork's ``main``,
    or any other name the two share), setup would check out, and an iteration
    would push to, this repository's own branch. GitHub is asked about every
    pull request, with the retries and the failure report of the fetch beside it.
    """
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
    """Run a baseline build or lint command the way the post-agent gate runs it.

    The exec of a command without shell operators fails when its program is not
    installed or not executable. That comes back as exit 127 with the error as
    the output, what a shell reports for it, so the baseline is one that could
    not run, as for the same command inside ``bash -lc``, and the ``OSError``
    does not end the task before the agent starts. A timeout still raises.
    """
    from post_hooks import BUILD_VERIFY_TIMEOUT_S, SHELL_COMMAND_NOT_FOUND

    try:
        return run_cmd(
            argv,
            label=label,
            cwd=repo_dir,
            check=False,
            timeout=BUILD_VERIFY_TIMEOUT_S,
            # Stream live → the full baseline log reaches CloudWatch verbatim
            # (buffered capture would hide the failing sub-task).
            stream=True,
        )
    except OSError as exc:
        log("WARN", f"{label}: the command could not be started: {exc}")
        return subprocess.CompletedProcess(argv, SHELL_COMMAND_NOT_FOUND, "", str(exc))


def setup_repo(config: TaskConfig, progress: Any = None) -> RepoSetup:  # noqa: C901 -- 28 when the ceiling of 15 was set; must not grow
    """Clone repo, create branch, configure git auth, run mise install.

    Returns a RepoSetup with repo_dir, branch, notes, build_before,
    lint_before, and default_branch.

    ``progress`` is optional (preserves legacy/test call shape). When present,
    transient clone/fetch retries emit ``dependency_unreachable`` blocker events.
    """
    repo_dir = f"{AGENT_WORKSPACE}/{config.task_id}"
    notes: list[str] = []

    # Always use the platform-provided branch name verbatim when present.
    # The platform computes branch_name (gateway.ts generateBranchName/slugify)
    # and persists it on the TaskRecord AND, for stacked children, as the
    # predecessor's child_branch_name that the reconciler hands to the next
    # child as its base. If the agent re-derives the slug here it produces a
    # DIFFERENT string (shell.py slugify strips dots vs gateway's dash, and
    # truncates at 40 vs 50) — e.g. ``...guide.html`` → agent ``guidehtml`` vs
    # platform ``guide-html``. That divergence means a stacked child does not
    # find ``origin/<predecessor-branch>`` and silently falls back
    # to branching off main (breaking the stack). Use config.branch_name as-is.
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

    # Guarantee a clean slate at repo_dir BEFORE cloning.
    _prepare_clone_dir(repo_dir, notes)

    # Mark the repo directory as safe for git.  On persistent session storage
    # the mount may be owned by a different UID than the container user,
    # triggering git's "dubious ownership" check on clone/resume.
    run_cmd(
        ["git", "config", "--global", "--add", "safe.directory", repo_dir],
        label="safe-directory",
    )

    # Clone — bounded retry on transient network/registry failures.
    # ``--no-upstream``: for a fork, gh would add the parent as the remote
    # ``upstream`` and make it the repository of every later ``gh`` command that
    # has no ``--repo`` — the agent would act on the parent's pull requests.
    log("SETUP", f"Cloning {config.repo_url}...")
    clone_result = run_cmd_with_backoff(
        ["gh", "repo", "clone", "--no-upstream", config.repo_url, repo_dir],
        label="clone",
        on_retry=_clone_backoff_reporter(progress, "clone"),
    )
    if clone_result.returncode != 0:
        _fail_setup_command("clone", config.repo_url, clone_result.stderr, progress)

    # Backstop: assert the clone produced a git root AT repo_dir.
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
    _configure_git_credentials(repo_dir, config.repo_url)

    # Fail in seconds, not after the agent's whole run, on a token that may not push.
    _preflight_push_capability(config, repo_dir, progress)

    # Branch setup
    head_sha_before = ""
    # For a DIAMOND child (2+ predecessors → base_branch set AND merge_branches
    # non-empty), the orchestrator hardcodes the literal 'main' as base_branch
    # (it has no server-side record of the repo's real default branch). On a repo
    # whose real default is NOT main, branching a diamond off 'main' makes its PR
    # target main and show the whole default↔main divergence (tens of thousands
    # of lines) instead of the child's small delta. Resolve the REAL default here
    # (the same detect_default_branch the root path already uses reliably) and use
    # it for BOTH the checkout base and the PR base (setup.default_branch below),
    # so the diamond stacks on the real default and its small delta is reviewable.
    # Only a diamond overrides; a LINEAR child's base_branch is its predecessor
    # branch (correct — the PR stacks on it) and must be left untouched.
    resolved_diamond_base: str | None = None
    # The pull request base the orchestrator named: the base of an existing PR,
    # or a linear child's predecessor branch. Cleared below when a stacked child
    # finds that branch gone from origin. (A diamond's PR base is
    # resolved_diamond_base, whatever this holds.)
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
        # default branch (a release PR from ``develop``), the clone has already
        # created that branch, and ``-b`` refuses to create it again. The check
        # above has made sure that it is the pull request's branch.
        run_cmd(
            ["git", "checkout", "-B", branch, f"origin/{branch}"],
            label="checkout-pr-branch",
            cwd=repo_dir,
        )
        # Snapshot the branch HEAD BEFORE the agent runs. The post-hooks compare
        # the final HEAD to this to tell a real edit (HEAD advanced) from a
        # question-only iteration (HEAD unchanged → no commit), so the platform
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
        # Re-stack: a predecessor branch changed; merge its UPDATED code into
        # this existing PR branch so the child is no longer stale.
        # (pr_iteration / pr_review pass no merge_branches, so this is a no-op
        # for them — only the restack path threads predecessors here.)
        for pred_branch in config.merge_branches:
            _merge_predecessor_branch(repo_dir, pred_branch, notes)
    elif config.base_branch:
        # Stacked child. Branch from the predecessor's branch (linear) or from
        # the repo default (diamond) so the child sees predecessor code without
        # waiting for a human merge. The base is looked up in the clone, which
        # holds every branch of origin: fetching it again can only add a way
        # to fail, and a failed fetch would read as "branch gone".
        base_branch = config.base_branch
        # A diamond rewrites the orchestrator's 'main' literal to the real
        # default before the checkout (see the block comment above); a linear
        # child (no merge_branches) keeps its predecessor base untouched.
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
            # Base branch not found on origin (predecessor PR already merged
            # + branch deleted). Fall back to a normal branch off the current
            # HEAD so the child still runs rather than failing setup; the
            # predecessor's code is likely in the default branch by now anyway.
            # The pull request targets the default branch too: it cannot be
            # compared with, or opened against, a branch that is gone.
            notes.append(f"base branch '{base_branch}' not on origin; branched off default instead")
            log("SETUP", f"Base branch not found; creating {branch} off HEAD")
            run_cmd(["git", "checkout", "-b", branch], label="create-branch", cwd=repo_dir)
            pr_base = None

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
    # Without this, fresh-clone builds failed the baseline at the trust gate,
    # indistinguishable in the log from a red build.
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
    # Use the repo's configured build command (default mise run build).
    from post_hooks import (
        BUILD_VERIFY_TIMEOUT_S,
        DEFAULT_BUILD_COMMAND,
        DEFAULT_LINT_COMMAND,
        is_infra_failure,
        is_verify_command_inert,
        resolve_verify_argv,
    )

    # A read_only workflow clones, reads/greps, and
    # emits an artifact — it NEVER edits code, runs the post-agent build/lint
    # gate, or opens a PR. Running the full pre-agent `mise run build` + lint
    # baseline for it is pure waste: on a big repo that baseline is the
    # multi-minute CI-parity build, and it will not fit the smaller memory budget
    # provisioned for a read-only planning task (it would stall or OOM the planner
    # before it ever reads a file). Skip both baselines for read_only and record
    # neutral "OK" values (there is no regression to gate against — nothing gets
    # committed). No baseline is ever compared for a read_only run, so these
    # values are informational only.
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
        # Use the same generous wall-clock ceiling as the POST-agent gate
        # (BUILD_VERIFY_TIMEOUT_S, 30min) — NOT run_cmd's 600s default — and GUARD
        # the timeout. A heavy CI-parity baseline build (install + compile + full
        # test suite + synth) legitimately runs longer than 10min; at 600s it
        # would raise TimeoutExpired here (this call had no try/except) and crash
        # the whole task BEFORE the agent ever ran, so the issue got no PR and sat
        # in Backlog — indistinguishable from a real failure. The baseline is only
        # informational (it seeds regression gating); a timeout means "no usable
        # baseline", NOT "the agent broke it", so we treat it as no-known-regression
        # and let the run proceed. The post-agent gate re-runs the build with the
        # same ceiling and surfaces an honest "timed out" if it's genuinely too slow.
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
                # An ENVIRONMENT fault (OOM / exit 137 / out of disk) means the
                # baseline build was KILLED, not that the code is broken. Treat it
                # exactly like the timeout case above: there is NO usable baseline,
                # so record no-known-regression (build_before=True) rather than the
                # false "the project was already broken" (build_before=False).
                #
                # This was a real failure mode: several heavy CI-parity builds
                # shared one host, the baseline was OOM-killed (exit 137), and the
                # generic non-zero branch below mislabeled it build_before=False.
                # That false "already red" flag then told the regression gate
                # "red-before → red-after isn't the agent's fault → ✅" AND flowed
                # into the orchestration gate as a node failure — for a task that
                # GitHub built green. The post-agent gate already had this OOM
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
                # If the build command could not RUN (no task / not found) AND no
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
        # Same generous ceiling + timeout guard as the build baseline above (a
        # slow lint must not crash the task before the agent runs). A timeout →
        # no usable lint baseline → treat as not-a-regression.
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
            # Distinguish "lint couldn't RUN" (no `mise run lint` task and no
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
    # - Linear stacked children: base_branch is the predecessor's branch — the
    #   child's PR targets it.
    # - Diamond children: base_branch was the orchestrator's 'main' literal; we
    #   resolved the REAL repo default above (resolved_diamond_base) so the PR
    #   targets it, not stale main.
    # - Otherwise, and for a linear child whose predecessor branch is gone from
    #   origin (pr_base cleared above): detect the repo default (main/master).
    default_branch = (
        resolved_diamond_base or pr_base or detect_default_branch(config.repo_url, repo_dir)
    )

    # Install prepare-commit-msg hook for code attribution
    _install_commit_hook(repo_dir)

    # Ensure the cloned HEAD sha is captured for NON-PR workflows too (the PR
    # branch above already set it). A read-only planner echoes this
    # into its plan's ``repo_digest_sha`` so a later revise run can tell if the
    # repo moved since the digest was built. Best-effort: a read failure leaves it
    # '' (the platform's sha-shape guard then just treats the digest as
    # un-versioned — trust-but-reverify).
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
    """Merge a predecessor branch into the current child branch (diamond stack).

    Merges the predecessor branch as the clone holds it so the child sees its
    code. On a clean merge: done. On a CONFLICT: abort the merge (leaving
    the working tree clean) and record a note. We deliberately do NOT leave
    the repo in a conflicted state — the agent runs AFTER setup and a
    half-merged tree would break its build/lint baseline. Instead the
    predecessor branch stays in the clone (``origin/<pred_branch>``) and the
    note tells the agent to integrate it as part of its task. This keeps
    conflict resolution agent-driven without corrupting the deterministic
    setup phase.
    """
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

    # Conflict (or other merge failure): abort to keep the tree clean.
    run_cmd(["git", "merge", "--abort"], label="merge-abort", cwd=repo_dir, check=False)
    notes.append(
        f"predecessor branch '{pred_branch}' conflicts with this branch; "
        f"merge aborted — integrate origin/{pred_branch} as part of the task"
    )
    log("SETUP", f"Predecessor merge conflicted, aborted: {pred_branch}")


def _install_commit_hook(repo_dir: str) -> None:
    """Install the prepare-commit-msg git hook, which adds the attribution trailers."""
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
        os.chmod(hook_dst, current | exec_bits)
        log("SETUP", "Installed prepare-commit-msg hook")
    except Exception as e:
        log("WARN", f"Commit hook install failed: {type(e).__name__}: {e}")


def _default_branch_of_clone(repo_dir: str) -> str:
    """The default branch ``git clone`` recorded as ``origin/HEAD``, or 'main'.

    What :func:`detect_default_branch` answers when GitHub does not: the clone
    knows the remote's default branch, and reading it needs no network.
    """
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
        # gh missing from PATH (FileNotFoundError is an OSError), a permission
        # error spawning it, or any other subprocess failure. The docstring
        # promises a fallback; without this the exception would
        # escape and fail the whole task. (TimeoutExpired is a
        # SubprocessError too but is handled above for its distinct message.)
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
