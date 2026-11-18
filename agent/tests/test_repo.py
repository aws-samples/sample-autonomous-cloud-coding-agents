"""Unit tests for repo.py — hermetic git/gh setup (no network).

``setup_repo`` and ``detect_default_branch`` shell out heavily. Most tests fake
the two seams they use — ``shell.run_cmd`` (logged commands) and
``subprocess.run`` (detect_default_branch) — recording argv and returning
scripted results. Where the result depends on what git itself does with the
branches, the git commands run for real against a bare repository under
``tmp_path`` (``_setup_with_real_git``).
"""

import functools
import subprocess
from types import SimpleNamespace

import pytest

import repo
import shell
from tests.conftest import FakeRunCmd, make_task_config


def _fake_run_cmd(
    returncodes: dict[str, int] | None = None,
    stdouts: dict[str, str] | None = None,
) -> FakeRunCmd:
    """repo.py keys scripted results off a recognizable label fragment (substring match)."""
    return FakeRunCmd(returncodes=returncodes, stdouts=stdouts, match_substring=True)


_config = make_task_config


def _patch_common(monkeypatch, fake: FakeRunCmd):
    """Patch run_cmd everywhere repo.py reaches it, plus the commit-hook install."""
    monkeypatch.setattr(repo, "run_cmd", fake)
    # #251 Phase 2: clone/fetch now go through run_cmd_with_backoff. Route it to
    # the same fake so scripted returncodes drive both — the fake ignores the
    # extra retry kwargs (max_attempts/base_delay_s/on_retry/sleep) via **kwargs.
    monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
    # _install_commit_hook touches the filesystem; stub it out (it's its own
    # best-effort path and not under test here).
    monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
    # The clone is faked here, so the real workspace never gets a
    # `.git`. Stub the pre-clean + git-root backstop (tested directly in
    # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
    # assertion on a non-existent/empty workspace path.
    monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
    monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)


def _git(*args: str, cwd) -> str:
    """Run git for real under ``tmp_path`` and return what it printed. No git
    configuration reaches it from the host (tests/conftest.py), so the identity
    of the commits is given here."""
    identity = ("-c", "user.name=ABCA Test", "-c", "user.email=abca-test@example.invalid")
    done = subprocess.run(
        ["git", *identity, *args], cwd=cwd, check=True, capture_output=True, text=True
    )
    return done.stdout.strip()


def _origin(tmp_path, default: str, *branches: str) -> str:
    """A bare repository that stands in for GitHub: its default branch is
    *default*, and each of *branches* is cut from it with one commit of its own."""
    origin, seed = tmp_path / "origin.git", tmp_path / "seed"
    _git("init", "-q", "--bare", str(origin), cwd=tmp_path)
    _git("init", "-q", str(seed), cwd=tmp_path)
    for repository in (origin, seed):
        _git("symbolic-ref", "HEAD", f"refs/heads/{default}", cwd=repository)
    _git("commit", "-q", "--allow-empty", "-m", "base", cwd=seed)
    for name in branches:
        _git("checkout", "-q", "-b", name, default, cwd=seed)
        _git("commit", "-q", "--allow-empty", "-m", name, cwd=seed)
    _git("push", "-q", str(origin), "--all", cwd=seed)
    return str(origin)


def _setup_with_real_git(
    monkeypatch, tmp_path, config, *, default="main", branches=(), offline=False, ran=None
):
    """Run ``setup_repo`` with real git against an ``_origin`` under ``tmp_path``.

    ``gh repo clone`` becomes ``git clone <origin>``. The other git commands run
    as written, except the two that would leave ``tmp_path`` (the global
    ``safe.directory`` entry and the remote URL on github.com). ``gh`` and
    ``mise`` answer 0 without running. With *offline*, every ``git fetch`` fails
    the way a dropped connection does. The label of each command is appended to
    *ran*.
    """
    origin = _origin(tmp_path, default, *branches)

    def run(cmd, label, cwd=None, check=True, **_kwargs):
        if ran is not None:
            ran.append(label)
        if label == "clone":
            cmd = ["git", "clone", "-q", origin, cmd[-1]]
        elif cmd[0] != "git" or label in ("safe-directory", "set-remote-url"):
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        elif offline and cmd[1] == "fetch":
            return SimpleNamespace(returncode=1, stdout="", stderr="fatal: connection reset")
        return shell.run_cmd(cmd, label, cwd=cwd, check=check)

    monkeypatch.setattr(repo, "AGENT_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setattr(repo, "run_cmd", run)
    monkeypatch.setattr(repo, "run_cmd_with_backoff", functools.partial(run, check=False))
    monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
    monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: default)
    return repo.setup_repo(config)


class TestSetupRepoHappyPath:
    def test_new_task_argv_sequence_and_remote_url_has_no_token(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        # detect_default_branch is exercised separately; stub for this test.
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        labels = fake.labels()
        # Core sequence present and ordered: clone before remote pin before branch.
        assert "clone" in labels
        assert "set-remote-url" in labels
        assert "configure-git-credential-helper" in labels
        assert labels.index("clone") < labels.index("set-remote-url")
        assert labels.index("set-remote-url") < labels.index("create-branch")

        # Security fix: remote URL is the plain https URL WITHOUT an embedded token.
        set_url_cmd = fake.cmd_for("set-remote-url")
        assert set_url_cmd is not None
        remote = set_url_cmd[-1]
        assert remote == "https://github.com/owner/repo.git"
        assert "@" not in remote
        assert "x-access-token" not in remote
        assert "ghp_" not in " ".join(set_url_cmd)

        # And the credential.helper config call is present (token resolved at call time).
        helper_cmd = fake.cmd_for("configure-git-credential-helper")
        assert helper_cmd is not None
        assert "credential.helper" in helper_cmd

        # Derived branch slug for a new task.
        assert setup.branch.startswith("bgagent/task-abc/")
        assert setup.default_branch == "main"

    def test_clone_adds_no_upstream_remote_for_a_fork(self, monkeypatch):
        # For a fork, `gh repo clone` adds the parent as the remote `upstream` and
        # makes it the repository of every later `gh` command that has no `--repo`:
        # the agent would read and write the parent's pull requests. With
        # `--no-upstream` the task's repository stays the only remote.
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        repo.setup_repo(_config())

        assert fake.cmd_for("clone")[:4] == ["gh", "repo", "clone", "--no-upstream"]

    def test_pr_branch_checkout_path(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)

        setup = repo.setup_repo(
            _config(
                is_pr_workflow=True,
                branch_name="feature/existing",
                base_branch="develop",
            )
        )

        labels = fake.labels()
        assert "fetch-pr-branch" in labels
        assert "checkout-pr-branch" in labels
        assert "create-branch" not in labels
        assert setup.branch == "feature/existing"
        # base_branch from orchestrator wins for PR workflows — no detection call.
        assert setup.default_branch == "develop"

    def test_non_pr_task_captures_head_sha_for_digest(self, monkeypatch):
        # A NON-PR workflow (e.g. coding/pr-review-v1) must also
        # capture the cloned HEAD sha (via the post-setup rev-parse) so the planner
        # can echo it into repo_digest_sha. The PR path captures its own sha; this
        # covers the else/default clone path such a workflow uses.
        fake = _fake_run_cmd(stdouts={"head-sha-after-setup": "deadbeefcafe1234\n"})
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        assert "head-sha-after-setup" in fake.labels()
        assert setup.head_sha_before == "deadbeefcafe1234"

    def test_pr_workflow_does_not_double_capture_head_sha(self, monkeypatch):
        # The PR path already set head_sha_before, so the post-setup fallback must
        # NOT run (guarded on `if not head_sha_before`).
        fake = _fake_run_cmd(stdouts={"head-sha-before": "aaaa1111bbbb2222\n"})
        _patch_common(monkeypatch, fake)

        setup = repo.setup_repo(
            _config(is_pr_workflow=True, branch_name="feature/x", base_branch="develop")
        )

        assert setup.head_sha_before == "aaaa1111bbbb2222"
        assert "head-sha-after-setup" not in fake.labels()


class TestPullRequestBranch:
    """Checking out the branch of an existing pull request.

    Where the commands are faked, each of them answers 0, so the clone "has" a
    local branch with the name of the pull request's branch: the case of a pull
    request whose branch is named like the default branch."""

    @staticmethod
    def _pr_task(head: str):
        return _config(is_pr_workflow=True, pr_number="40", branch_name=head, base_branch="main")

    @pytest.mark.parametrize("head", ["develop", "feature/x"], ids=["default-branch", "other"])
    def test_pr_branch_is_checked_out_with_real_git(self, tmp_path, monkeypatch, head):
        # `develop`: a release pull request from the default branch into `main`.
        # The clone has already created and checked out the branch the pull
        # request names, which `git checkout -b` refuses to create again.
        ran: list[str] = []
        setup = _setup_with_real_git(
            monkeypatch,
            tmp_path,
            self._pr_task(head),
            default="develop",
            branches=("main", "feature/x"),
            ran=ran,
        )

        clone = setup.repo_dir
        assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=clone) == head
        assert _git("rev-parse", "HEAD", cwd=clone) == _git(
            "rev-parse", f"origin/{head}", cwd=clone
        )
        assert setup.head_sha_before == _git("rev-parse", f"origin/{head}", cwd=clone)
        assert (setup.branch, setup.default_branch) == (head, "main")
        # GitHub is asked whether the pull request comes from a fork only where
        # the clone already has a branch of that name: nowhere else can the
        # answer change what is checked out, so no other task pays for the call.
        assert ("check-pr-fork" in ran) == (head == "develop")

    def test_pr_from_a_fork_is_refused_before_its_branch_name_is_fetched(self, monkeypatch):
        # The head ref of a pull request from a fork names a branch of the fork.
        # Where the clone has a branch of the same name (a fork's `main`), setup
        # would check out this repository's branch, and an iteration would push
        # to it.
        fake = _fake_run_cmd(stdouts={"check-pr-fork": "true\n"})
        _patch_common(monkeypatch, fake)

        with pytest.raises(RuntimeError, match="#40 of owner/repo comes from another repository"):
            repo.setup_repo(self._pr_task("main"))

        assert "fetch-pr-branch" not in fake.labels()

    def test_fork_check_without_an_answer_stops_setup_like_a_failed_fetch(self, monkeypatch):
        # No answer is not "not a fork": setup stops. GitHub is reported as
        # unreachable the way the clone and the fetch beside the check report it,
        # after the same retries (run_cmd_with_backoff, faked here).
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        bad_gateway = "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)"

        def backoff(cmd, label, **kwargs):
            failed = label == "check-pr-fork"
            return SimpleNamespace(
                returncode=int(failed), stdout="", stderr=bad_gateway if failed else ""
            )

        monkeypatch.setattr(repo, "run_cmd_with_backoff", backoff)

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(self._pr_task("main"))

        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]: check-pr-fork ")
        assert "(resource: owner/repo)" in str(excinfo.value)
        assert "checkout-pr-branch" not in fake.labels()

    def test_pr_from_the_repository_itself_passes_the_fork_check(self, monkeypatch):
        fake = _fake_run_cmd(stdouts={"check-pr-fork": "false\n"})
        _patch_common(monkeypatch, fake)

        repo.setup_repo(self._pr_task("main"))

        # The answer must come from the task's repository, whatever the remotes are.
        assert fake.cmd_for("check-pr-fork") == [
            "gh",
            "pr",
            "view",
            "40",
            "--repo",
            "owner/repo",
            "--json",
            "isCrossRepository",
            "-q",
            ".isCrossRepository",
        ]
        assert "checkout-pr-branch" in fake.labels()


class TestDiamondBaseBranch:
    """A diamond child (base_branch + merge_branches)
    is handed the server's 'main' literal as its base, which is WRONG on a fork
    whose real default isn't main. repo.py must resolve the real default and use
    it for BOTH the checkout base and the PR base. A linear child (base_branch, no
    merge_branches) must be left untouched."""

    def test_diamond_resolves_real_default_over_server_main_literal(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        # Fork's real default is linear-vercel, but the server passed 'main'.
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "linear-vercel")

        setup = repo.setup_repo(
            _config(
                base_branch="main",
                merge_branches=["bgagent/task-x/feat-a", "bgagent/task-y/feat-b"],
            )
        )

        # Checkout base was rewritten to the detected default, not 'main'.
        find_cmd = fake.cmd_for("find-base-branch")
        assert find_cmd is not None
        assert find_cmd[-1] == "refs/remotes/origin/linear-vercel"
        create_cmd = fake.cmd_for("create-branch-from-base")
        assert create_cmd is not None
        assert create_cmd[-1] == "origin/linear-vercel"
        # PR base (setup.default_branch) follows — so the diamond PR targets the
        # real default, not stale main (the whole point of F1).
        assert setup.default_branch == "linear-vercel"
        # The predecessor branches are still merged in (diamond sees all preds).
        assert "merge-predecessor" in " ".join(fake.labels()) or any(
            "merge" in lbl for lbl in fake.labels()
        )

    def test_diamond_no_op_when_server_base_already_matches_detected_default(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        # Server 'main' already IS the real default (upstream/main case) → no rewrite.
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(
            _config(base_branch="main", merge_branches=["bgagent/task-x/feat-a"])
        )
        assert fake.cmd_for("find-base-branch")[-1] == "refs/remotes/origin/main"
        assert setup.default_branch == "main"

    def test_linear_child_base_branch_is_left_untouched(self, monkeypatch):
        # A LINEAR child (single predecessor → base_branch set, NO merge_branches)
        # stacks on its predecessor's branch; that base must NOT be rewritten to
        # the repo default (it's intentionally the predecessor branch).
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        # If detect_default_branch were (wrongly) consulted, it'd return this — the
        # test proves it is NOT used for a linear child.
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "linear-vercel")

        setup = repo.setup_repo(
            _config(base_branch="bgagent/task-pred/feat-pred", merge_branches=[])
        )
        base_ref = "refs/remotes/origin/bgagent/task-pred/feat-pred"
        assert fake.cmd_for("find-base-branch")[-1] == base_ref
        assert fake.cmd_for("create-branch-from-base")[-1] == "origin/bgagent/task-pred/feat-pred"
        # PR base is the predecessor branch (the stack target), unchanged.
        assert setup.default_branch == "bgagent/task-pred/feat-pred"


class TestStackedChildWithRealGit:
    """A stacked child takes its base and its predecessors from the branches the
    clone already holds: a plain ``git clone`` brings every branch of the remote.
    Asking the network a second time can only add a way to fail."""

    PRED = "bgagent/task-pred/feat-pred"

    def test_child_branches_from_its_predecessor_when_the_connection_drops(
        self, tmp_path, monkeypatch
    ):
        # The predecessor's branch is in the clone. A fetch that fails right after
        # the clone must not make the child start from the default branch, without
        # its predecessor's code and with a setup note as the only trace.
        setup = _setup_with_real_git(
            monkeypatch,
            tmp_path,
            _config(base_branch=self.PRED),
            branches=(self.PRED,),
            offline=True,
        )

        clone = setup.repo_dir
        assert _git("rev-parse", "HEAD", cwd=clone) == _git(
            "rev-parse", f"origin/{self.PRED}", cwd=clone
        )
        assert setup.default_branch == self.PRED
        assert not [n for n in setup.notes if "branched off default" in n]

    def test_predecessor_is_merged_when_the_connection_drops(self, tmp_path, monkeypatch):
        # Same for the branches a diamond child merges (one is enough here: each
        # goes through the same function).
        setup = _setup_with_real_git(
            monkeypatch,
            tmp_path,
            _config(base_branch="main", merge_branches=[self.PRED]),
            branches=(self.PRED,),
            offline=True,
        )

        clone = setup.repo_dir
        assert f"merged predecessor branch '{self.PRED}'" in setup.notes
        assert _git("rev-parse", "HEAD", cwd=clone) == _git(
            "rev-parse", f"origin/{self.PRED}", cwd=clone
        )

    def test_child_whose_base_is_gone_targets_the_default_branch(self, tmp_path, monkeypatch):
        # The predecessor's pull request was merged and its branch deleted before
        # the child started. The child is cut from the default branch, so that is
        # what its pull request has to target: nothing can be compared with, or
        # merged into, a branch that origin no longer has.
        setup = _setup_with_real_git(
            monkeypatch, tmp_path, _config(base_branch=self.PRED), default="trunk"
        )

        clone = setup.repo_dir
        assert _git("rev-parse", "HEAD", cwd=clone) == _git("rev-parse", "origin/trunk", cwd=clone)
        assert f"base branch '{self.PRED}' not on origin; branched off default instead" in (
            setup.notes
        )
        assert setup.default_branch == "trunk"


class TestReadOnlyBaselineSkip:
    """ECS rightsized planning: a read_only workflow (coding/pr-review-v1)
    never edits code, runs the post-agent gate, or opens a PR, so the pre-agent
    build + lint baseline is pure waste — and on a big repo the full CI-parity
    `mise run build` won't fit the 8 GB read-only planning task def (it would
    stall/OOM before the planner reads a file). setup_repo must skip both
    baselines for read_only and still return neutral OK values."""

    def test_read_only_skips_build_and_lint_baseline(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=True))

        labels = fake.labels()
        # The heavy build + lint baselines must NOT run.
        assert "verify-build-pre" not in labels
        assert "verify-lint-pre" not in labels
        # But the clone/branch/mise-install setup still happens.
        assert "clone" in labels
        assert "mise-install" in labels
        # Neutral OK baselines (nothing gets committed, so nothing to gate).
        assert setup.build_before is True
        assert setup.lint_before is True
        assert setup.build_gate_inert is False
        assert setup.lint_gate_inert is False
        assert any("Read-only workflow" in n for n in setup.notes)

    def test_non_read_only_still_runs_build_and_lint_baseline(self, monkeypatch):
        # Regression guard: the default (write) workflow must still run both
        # baselines — the skip is gated strictly on read_only.
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        labels = fake.labels()
        assert "verify-build-pre" in labels
        assert "verify-lint-pre" in labels
        assert setup.build_before is True  # fake run_cmd returns rc 0
        assert setup.lint_before is True


class TestBaselineBuildTimeout:
    """The pre-agent baseline build/lint must run with the SAME generous
    wall-clock ceiling as the post-agent gate (BUILD_VERIFY_TIMEOUT_S, 30min)
    — NOT run_cmd's 600s default — and a TIMEOUT must be GUARDED so a
    slow-but-valid CI-parity build no longer raises out of setup_repo and crashes
    the whole task before the agent ever runs (the observed symptom: no PR, issue
    stuck in Backlog, indistinguishable from a real failure)."""

    class _RecordingFake:
        """run_cmd fake that records the ``timeout`` kwarg and can raise
        TimeoutExpired for a label substring."""

        def __init__(
            self,
            timeout_on: str | None = None,
            rc_on: tuple[str, int, str] | None = None,
        ):
            self.calls: list[dict] = []
            self._timeout_on = timeout_on
            # (label_substring, returncode, stderr) to force a non-zero exit on a
            # specific labelled command (e.g. an OOM-killed baseline build).
            self._rc_on = rc_on

        def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            self.calls.append({"label": label, "timeout": timeout})
            if self._timeout_on and self._timeout_on in label:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)
            if self._rc_on and self._rc_on[0] in label:
                return SimpleNamespace(returncode=self._rc_on[1], stdout="", stderr=self._rc_on[2])
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        def timeout_for(self, label: str) -> int | None:
            for c in self.calls:
                if label in c["label"]:
                    return c["timeout"]
            return None

    def test_baseline_build_uses_the_generous_verify_ceiling_not_600s(self, monkeypatch):
        from post_hooks import BUILD_VERIFY_TIMEOUT_S

        fake = self._RecordingFake()
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        repo.setup_repo(_config(read_only=False))

        assert fake.timeout_for("verify-build-pre") == BUILD_VERIFY_TIMEOUT_S
        assert fake.timeout_for("verify-lint-pre") == BUILD_VERIFY_TIMEOUT_S
        assert BUILD_VERIFY_TIMEOUT_S > 600  # the whole point: not the old default

    def test_baseline_build_timeout_is_guarded_not_a_task_crash(self, monkeypatch):
        # The heavy build times out. setup_repo must NOT propagate TimeoutExpired
        # (which crashed the task pre-agent); it degrades to "no baseline" and the
        # run proceeds with build_before=True (a timeout is not a regression).
        fake = self._RecordingFake(timeout_on="verify-build-pre")
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))  # must not raise

        assert setup.build_before is True  # timeout → not treated as a regression
        assert setup.build_gate_inert is False
        assert any("did not finish within" in n for n in setup.notes)

    def test_baseline_lint_timeout_is_guarded(self, monkeypatch):
        fake = self._RecordingFake(timeout_on="verify-lint-pre")
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))  # must not raise

        assert setup.lint_before is True
        assert setup.lint_gate_inert is False
        assert any("Initial lint" in n and "did not finish within" in n for n in setup.notes)

    def test_baseline_build_OOM_kill_is_not_a_regression(self, monkeypatch):
        # Root cause of an observed false ✅: the baseline build was OOM-KILLED (exit
        # 137) because several heavy CI-parity builds shared one ECS box. Exit 137
        # is an ENVIRONMENT fault, NOT broken code — so build_before must be True
        # (no usable baseline, no known regression), NOT False ("already broken").
        # A False here poisons the whole verdict: the regression gate reads
        # "red-before → red-after isn't the agent's fault → ✅" while the absolute
        # orchestration gate fails the node — a task GitHub built green.
        fake = self._RecordingFake(rc_on=("verify-build-pre", 137, "Killed"))
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is True  # OOM → no baseline, NOT "already broken"
        assert setup.build_gate_inert is False  # an OOM kill is not an inert gate
        assert any("environment fault" in n for n in setup.notes)
        # And it must NOT be recorded as a pre-existing build failure.
        assert not any("FAILED before agent changes" in n for n in setup.notes)

    def test_baseline_build_genuine_failure_still_marks_regression_baseline(self, monkeypatch):
        # Guard the other side: a REAL red build (exit 1, not an infra signal) must
        # still record build_before=False so genuine regressions are gated.
        fake = self._RecordingFake(rc_on=("verify-build-pre", 1, "TS2345: type error"))
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is False  # a real red build IS the baseline
        assert any("FAILED before agent changes" in n for n in setup.notes)


class TestBaselineCommandThatCannotStart:
    """A configured command without shell operators is exec'd directly. When its
    program is not installed the exec itself raises, where the same command
    inside ``bash -lc`` exits 127. Both are a baseline that could not run, and
    neither may end the task before the agent starts."""

    def test_missing_program_is_a_failed_baseline_not_a_task_crash(self, monkeypatch):
        fake = _fake_run_cmd()

        def run_cmd(cmd, label, **kwargs):
            if label in ("verify-build-pre", "verify-lint-pre"):
                raise FileNotFoundError(2, "No such file or directory", cmd[0])
            return fake(cmd, label, **kwargs)

        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "run_cmd", run_cmd)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(
            _config(build_command="gradle build", lint_command="gradle check")
        )  # must not raise

        assert setup.build_before is False
        assert setup.lint_before is False
        assert "Initial build (gradle build) FAILED before agent changes" in setup.notes
        assert "Initial lint (gradle check) FAILED before agent changes" in setup.notes
        # A configured command that cannot run is the operator's to correct; only
        # the unconfigured default switches the "gating is off" warning on.
        assert setup.build_gate_inert is False
        assert setup.lint_gate_inert is False


class TestFindMiseConfigs:
    """`mise trust <repo_dir>` trusts only the ROOT config;
    a monorepo's per-package `mise.toml` roots must ALSO be trusted or
    `mise run build` fanning into `//cdk:*` etc. dies at the trust gate."""

    def _mk(self, root, rels):
        import os

        for r in rels:
            d = os.path.dirname(r)
            if d:
                os.makedirs(os.path.join(root, d), exist_ok=True)
            open(os.path.join(root, r), "w").close()

    def _rel(self, root, configs):
        import os

        return sorted(os.path.relpath(c, root) for c in configs)

    def test_returns_nested_configs_excluding_root(self, tmp_path):
        root = str(tmp_path)
        self._mk(root, ["mise.toml", "cdk/mise.toml", "cli/mise.toml", "agent/mise.toml"])
        got = self._rel(root, repo._find_mise_configs(root))
        # root already trusted by `mise trust <repo_dir>`, so it's excluded
        assert "mise.toml" not in got
        assert got == ["agent/mise.toml", "cdk/mise.toml", "cli/mise.toml"]

    def test_skips_vendored_and_build_dirs(self, tmp_path):
        root = str(tmp_path)
        self._mk(
            root,
            ["mise.toml", "cdk/mise.toml", "node_modules/pkg/mise.toml", "cdk/cdk.out/a/mise.toml"],
        )
        got = self._rel(root, repo._find_mise_configs(root))
        assert got == ["cdk/mise.toml"]  # node_modules + cdk.out pruned

    def test_no_nested_configs_returns_empty(self, tmp_path):
        root = str(tmp_path)
        self._mk(root, ["mise.toml"])  # only the root
        assert repo._find_mise_configs(root) == []


class TestDetectDefaultBranch:
    def test_returns_detected_branch(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="trunk\n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "trunk"

    def test_timeout_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=30)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_gh_missing_falls_back_to_main(self, monkeypatch):
        # FileNotFoundError (gh not on PATH) is an OSError — must not escape.
        def fake_run(*args, **kwargs):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_oserror_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise OSError("permission denied")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_subprocess_error_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise subprocess.SubprocessError("boom")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_nonzero_exit_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="auth error")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_empty_stdout_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="   \n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    @pytest.mark.parametrize(
        "gh_failure",
        [
            subprocess.TimeoutExpired(cmd="gh", timeout=30),
            FileNotFoundError("gh"),
            SimpleNamespace(returncode=1, stdout="", stderr="HTTP 502: Bad Gateway"),
        ],
        ids=["timeout", "gh-missing", "non-zero-exit"],
    )
    def test_gh_failure_falls_back_to_the_default_branch_of_the_clone(
        self, tmp_path, monkeypatch, gh_failure
    ):
        # `git clone` records the remote's default branch as origin/HEAD. A GitHub
        # API call that fails must not turn a `trunk` repository into a `main` one:
        # the pull request would be opened against a branch that does not exist.
        clone = tmp_path / "clone"
        _git("clone", "-q", _origin(tmp_path, "trunk"), str(clone), cwd=tmp_path)
        real_run = subprocess.run

        def fake_run(cmd, **kwargs):
            if cmd[0] != "gh":
                return real_run(cmd, **kwargs)
            if isinstance(gh_failure, Exception):
                raise gh_failure
            return gh_failure

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", str(clone)) == "trunk"


class TestPlatformBranchNameVerbatim:
    """The agent MUST use the platform-provided ``config.branch_name`` verbatim
    when present, for EVERY workflow — never re-deriving its own slug. A
    re-derived slug diverges from the platform's (shell.py slugify strips
    dots / truncates at 40; gateway.ts uses dashes / truncates at 50), which
    silently breaks stacked-PR chaining (#247): a stacked child looks for the
    predecessor's platform-named branch, the agent pushed a differently-named
    one, the branch is not found, and the child falls back to main (#14)."""

    def test_uses_platform_branch_name_verbatim_for_new_task(self, monkeypatch):
        # new_task (is_pr_workflow=False) with a platform branch_name carrying a
        # dotted/dashed slug. The agent must NOT re-slugify it.
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=False,
                branch_name="bgagent/01TESTTASKID/abca-166-add-seville-guide-html",
                task_description="ABCA-166: Add seville-guide.html",
            )
        )
        assert setup.branch == "bgagent/01TESTTASKID/abca-166-add-seville-guide-html"

    def test_uses_platform_branch_name_verbatim_for_pr_workflow(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=True,
                branch_name="bgagent/01TESTTASKID/abca-167-stacked-child",
                base_branch="bgagent/01PREDTASK/abca-166-predecessor",
            )
        )
        assert setup.branch == "bgagent/01TESTTASKID/abca-167-stacked-child"

    def test_falls_back_to_derived_slug_only_when_no_branch_name(self, monkeypatch):
        # No platform branch_name → the agent derives its own slug (legacy path).
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=False,
                task_description="ABCA-168: derive me",
            )
        )
        assert setup.branch.startswith("bgagent/")


class _RecordingProgress:
    """Progress double recording write_agent_blocked calls (mirrors test_hooks)."""

    def __init__(self):
        self.calls = []
        self._disabled = False

    def __getattr__(self, name):
        if name.startswith("write_"):
            return lambda **kw: self.calls.append((name, kw))
        raise AttributeError(name)


class TestSetupRepoDependencyUnreachable:
    """#251 Phase 2: bounded remediation on transient clone failure + the
    security invariant that remediation never widens creds/egress."""

    def _patch_backoff_to_fail(self, monkeypatch, fake, *, transient_stderr):
        """Wire run_cmd_with_backoff to a real bounded loop over the fake so the
        report/raise path fires, while run_cmd (non-clone commands) stays faked."""
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)

        def fake_backoff(cmd, label, *, on_retry=None, **kwargs):
            # Mirror the real helper: on_retry only fires for transient failures.
            from shell import is_transient_cmd_failure

            if is_transient_cmd_failure(transient_stderr):
                for attempt in range(1, 3):
                    if on_retry is not None:
                        on_retry(attempt, 3, transient_stderr)
            return SimpleNamespace(returncode=1, stdout="", stderr=transient_stderr)

        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake_backoff)

    def test_named_host_clone_bails_through_real_backoff_no_retry_events(self, monkeypatch):
        """#251 review (end-to-end): drive the REAL run_cmd_with_backoff (not the
        fake) so the shell.py DNS-bail + repo.py egress reclassification are proven
        together. A named-host DNS failure must produce ZERO dependency_unreachable
        retry events and exactly one non-retryable egress_denied — and the clone
        command must run only once (no burned retries)."""
        clone_calls = []

        def fake_run_cmd(cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            if "clone" in label:
                clone_calls.append(cmd)
                return SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr="fatal: unable to access: Could not resolve host: github.com",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        # Patch shell.run_cmd (what the REAL run_cmd_with_backoff calls) AND
        # repo.run_cmd (the non-clone setup commands). run_cmd_with_backoff itself
        # is NOT patched — the real DNS-bail logic runs.
        monkeypatch.setattr("shell.run_cmd", fake_run_cmd)
        monkeypatch.setattr(repo, "run_cmd", fake_run_cmd)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        # Bailed on the first clone attempt — no retries burned.
        assert len(clone_calls) == 1
        # Terminal reason is egress_denied naming the host, not dependency_unreachable.
        assert str(excinfo.value).startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in str(excinfo.value)
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        # No misleading dependency_unreachable retry events; exactly one egress_denied.
        assert not [c for c in blocked if c[1]["kind"] == "dependency_unreachable"]
        egress = [c for c in blocked if c[1]["kind"] == "egress_denied"]
        assert len(egress) == 1
        assert egress[0][1]["retryable"] is False

    def test_exhausted_clone_reports_and_raises_canonical_reason(self, monkeypatch):
        fake = _fake_run_cmd()
        # A hostless transient blip (connection reset, no nameable host) → the
        # retryable dependency_unreachable branch. A name-resolution failure that
        # names a host is egress_denied instead — see the egress test below.
        self._patch_backoff_to_fail(
            monkeypatch, fake, transient_stderr="error: RPC failed; connection reset"
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        # Canonical reason carried on the exception → terminal error → classifier.
        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:")
        assert "(resource: owner/repo)" in str(excinfo.value)

        # Each transient retry + the final exhaustion emitted an auditable event:
        # _patch_backoff_to_fail fires on_retry twice (attempts 1,2) and
        # _fail_setup_command emits the terminal blocker → exactly 3.
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert len(blocked) == 3
        assert all(c[1]["kind"] == "dependency_unreachable" for c in blocked)
        assert all(c[1]["retryable"] is True for c in blocked)

    def test_exhausted_clone_naming_host_is_egress_denied_not_retryable(self, monkeypatch):
        """#251 review fix: a name-resolution failure naming a host is a
        firewalled endpoint, NOT a transient blip. It must classify as
        non-retryable egress_denied (allowlist remedy) — the same verdict the
        PostToolUse egress detector reaches for identical stderr — rather than
        retryable dependency_unreachable ("retry the task", which never helps)."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="fatal: unable to access: Could not resolve host: github.com",
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        # Reclassified to egress_denied naming the exact host to allowlist.
        assert str(excinfo.value).startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in str(excinfo.value)

        # The terminal blocker is egress_denied and non-retryable.
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        terminal = [c for c in blocked if c[1]["kind"] == "egress_denied"]
        assert terminal, "expected an egress_denied blocker event"
        assert all(c[1]["retryable"] is False for c in terminal)
        assert all(c[1]["resource"] == "github.com" for c in terminal)

    def test_permanent_clone_failure_is_not_reported_as_dependency_unreachable(self, monkeypatch):
        """A permanent failure (repo not found / auth denied) must raise a plain
        RuntimeError — NOT the retryable dependency_unreachable blocker — so the
        classifier routes it to the auth/not-found remedy (#251 review fix)."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="Could not resolve to a Repository with the name 'owner/repo'",
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(RuntimeError) as excinfo:
            repo.setup_repo(_config(), progress=progress)
        assert not isinstance(excinfo.value, repo.DependencyUnreachableError)
        assert "BLOCKED[" not in str(excinfo.value)
        # No dependency_unreachable blocker emitted for a permanent failure.
        assert not [c for c in progress.calls if c[0] == "write_agent_blocked"]

    def test_permanent_failure_stderr_is_redacted_in_raised_error(self, monkeypatch):
        """The raised RuntimeError message is persisted to TaskResult.error, so a
        credential leaked in git stderr must be redacted (pre-#251 check=True
        behavior — regression guard)."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="fatal: Authentication failed for 'https://ghp_SECRETTOKEN123@github.com/o/r'",
        )
        import pytest

        with pytest.raises(RuntimeError) as excinfo:
            repo.setup_repo(_config(), progress=_RecordingProgress())
        assert "ghp_SECRETTOKEN123" not in str(excinfo.value)

    def test_exhausted_pr_branch_fetch_reports_branch_as_resource(self, monkeypatch):
        """The PR-workflow fetch path (repo.py) mirrors the clone path but its
        blocker resource is the branch name, not the repo. Clone succeeds; the
        transient fetch failure exhausts retries → dependency_unreachable naming
        the branch."""
        fake = _fake_run_cmd()
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        # The clone is faked here, so the real workspace never gets a
        # `.git`. Stub the pre-clean + git-root backstop (tested directly in
        # TestCloneWorkspaceGuards) so the hermetic clone tests don't trip the
        # assertion on a non-existent/empty workspace path.
        monkeypatch.setattr(repo, "_prepare_clone_dir", lambda repo_dir, notes: None)
        monkeypatch.setattr(repo, "_assert_clone_root", lambda repo_dir: None)

        def fake_backoff(cmd, label, *, on_retry=None, **kwargs):
            # Clone succeeds; only the PR-branch fetch fails transiently.
            if label == "fetch-pr-branch":
                return SimpleNamespace(returncode=1, stdout="", stderr="connection timed out")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake_backoff)
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(
                _config(is_pr_workflow=True, branch_name="feature/x", base_branch="main"),
                progress=progress,
            )

        # Resource is the branch, not the repo — this is the fetch path.
        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:")
        assert "(resource: feature/x)" in str(excinfo.value)
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert any(c[1].get("resource") == "feature/x" for c in blocked)

    def test_remediation_does_not_widen_creds_or_egress(self, monkeypatch):
        """Invariant (AC): remediation only re-runs the same command. It must
        NOT run any credential- or remote-mutating command before failing —
        no scope/allowlist widening, purely a bounded retry of the clone."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(monkeypatch, fake, transient_stderr="connection timed out")
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError):
            repo.setup_repo(_config(), progress=progress)

        # setup aborts at clone: none of the credential/remote-config commands
        # (which run AFTER clone) executed. Remediation widened nothing.
        labels = fake.labels()
        assert "set-remote-url" not in labels
        assert "configure-git-credential-helper" not in labels
        assert "safe-directory" in labels  # only the pre-clone step ran


class TestCloneWorkspaceGuards:
    """The clone-time slate-clean + git-root backstop that stop a
    stacked child from silently editing a NESTED working tree the pipeline's
    git ops never see (which reported a false COMPLETED with the work lost)."""

    def test_prepare_clears_non_empty_workspace_and_notes(self, tmp_path):
        repo_dir = tmp_path / "task-abc"
        repo_dir.mkdir()
        (repo_dir / "stale.txt").write_text("residue from a prior run")
        (repo_dir / "nested").mkdir()
        notes: list[str] = []

        repo._prepare_clone_dir(str(repo_dir), notes)

        # The whole dir is removed so the clone lands directly at the root.
        assert not repo_dir.exists()
        assert any("residue" in n for n in notes)

    def test_prepare_leaves_empty_workspace_untouched_no_note(self, tmp_path):
        repo_dir = tmp_path / "task-abc"
        repo_dir.mkdir()  # exists but empty — a normal fresh workspace
        notes: list[str] = []

        repo._prepare_clone_dir(str(repo_dir), notes)

        assert repo_dir.exists()  # empty dir is fine; clone lands into it
        assert notes == []

    def test_prepare_absent_workspace_is_noop(self, tmp_path):
        repo_dir = tmp_path / "does-not-exist"
        notes: list[str] = []

        repo._prepare_clone_dir(str(repo_dir), notes)  # must not raise

        assert not repo_dir.exists()
        assert notes == []

    def test_assert_root_passes_when_git_dir_present(self, tmp_path):
        repo_dir = tmp_path / "task-abc"
        (repo_dir / ".git").mkdir(parents=True)

        repo._assert_clone_root(str(repo_dir))  # must not raise

    def test_assert_root_raises_when_git_missing(self, tmp_path):
        import pytest

        repo_dir = tmp_path / "task-abc"
        repo_dir.mkdir()
        # A nested clone: .git lives one level deep, NOT at repo_dir root.
        (repo_dir / "inner" / ".git").mkdir(parents=True)

        with pytest.raises(RuntimeError, match="git repository at the workspace root"):
            repo._assert_clone_root(str(repo_dir))
