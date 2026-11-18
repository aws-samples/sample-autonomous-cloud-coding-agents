"""Unit tests for repo.py — hermetic git/gh setup (no network, no real git).

``setup_repo`` and ``detect_default_branch`` shell out heavily. We fake the two
seams they use — ``shell.run_cmd`` (logged commands) and ``subprocess.run``
(detect_default_branch) — recording argv and returning scripted results.
"""

import subprocess
from types import SimpleNamespace

import repo
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
    # The push preflight makes its probe commit with real git (covered by
    # TestPushPreflightAgainstRealGit); the faked workspace has no repository.
    monkeypatch.setattr(repo, "_preflight_probe_commit", lambda repo_dir: _PROBE_SHA)


_PROBE_SHA = "c0ffee" * 6 + "c0ff"


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
        fetch_cmd = fake.cmd_for("fetch-base-branch")
        assert fetch_cmd is not None
        assert fetch_cmd[-1] == "linear-vercel"
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
        assert fake.cmd_for("fetch-base-branch")[-1] == "main"
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
        assert fake.cmd_for("fetch-base-branch")[-1] == "bgagent/task-pred/feat-pred"
        assert fake.cmd_for("create-branch-from-base")[-1] == "origin/bgagent/task-pred/feat-pred"
        # PR base is the predecessor branch (the stack target), unchanged.
        assert setup.default_branch == "bgagent/task-pred/feat-pred"


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


class TestPlatformBranchNameVerbatim:
    """The agent MUST use the platform-provided ``config.branch_name`` verbatim
    when present, for EVERY workflow — never re-deriving its own slug. A
    re-derived slug diverges from the platform's (shell.py slugify strips
    dots / truncates at 40; gateway.ts uses dashes / truncates at 50), which
    silently breaks stacked-PR chaining (#247): a stacked child fetches the
    predecessor's platform-named branch, the agent pushed a differently-named
    one, the fetch 404s, and the child falls back to main (#14)."""

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


class _PreflightFake(FakeRunCmd):
    """FakeRunCmd that can also script the push preflight's stderr and timeout.

    The shared fake always returns an empty stderr, but the preflight classifies
    a refusal by git's stderr, so it needs a fake that can return one.
    """

    def __init__(self, preflight_rc: int = 0, preflight_stderr: str = "", timeout=False):
        super().__init__(match_substring=True)
        self._preflight_rc = preflight_rc
        self._preflight_stderr = preflight_stderr
        self._timeout = timeout
        self.preflight_timeout = None

    def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
        result = super().__call__(cmd, label, cwd=cwd, timeout=timeout, check=check, **kwargs)
        if label == "push-preflight":
            self.preflight_timeout = timeout
            if self._timeout:
                raise subprocess.TimeoutExpired(cmd, timeout, stderr=b"stalled")
            return SimpleNamespace(
                returncode=self._preflight_rc, stdout="", stderr=self._preflight_stderr
            )
        return result


def _denied_403(repo_url="owner/repo", user="someone"):
    # A push without write access, as seen by hand against a public repository.
    return (
        f"remote: Permission to {repo_url}.git denied to {user}.\n"
        f"fatal: unable to access 'https://github.com/{repo_url}.git/': "
        "The requested URL returned error: 403"
    )


_DENIED_403 = _denied_403()
# The 404 #801 reports for every write of the scope-less classic PAT.
_DENIED_404 = (
    "remote: Repository not found.\n"
    "fatal: repository 'https://github.com/owner/repo.git/' not found"
)
_DENIED_FINE_GRAINED = (
    "remote: Write access to repository not granted.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_REJECTED_401 = (
    "remote: Invalid username or token. Password authentication is not supported.\n"
    "fatal: Authentication failed for 'https://github.com/owner/repo.git/'"
)
_ARCHIVED = (
    "remote: This repository was archived so it is read-only.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_SAML = (
    "remote: The 'acme' organization has enabled or enforced SAML SSO.\n"
    "remote: To access this repository, you must use a token authorized for it.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_IP_ALLOW_LIST = (
    "remote: Although you appear to have the correct authorization credentials, the "
    "`acme` organization has an IP allow list enabled, and your IP address is not "
    "permitted to access this resource.\n"
    "fatal: unable to access 'https://github.com/owner/repo.git/': "
    "The requested URL returned error: 403"
)
_BAD_GATEWAY = (
    "fatal: unable to access 'https://github.com/{repo}.git/': "
    "The requested URL returned error: 502"
)


class TestPushCapabilityPreflight:
    """#801: setup_repo checks that GitHub lets the token push BEFORE the agent runs.

    A token can authenticate and read a repository yet be refused every write (a
    classic PAT with no scopes still reads public repositories). Without this check
    that token passes clone and the whole agent run, and fails only at the final
    push, after the work is done and with no way to deliver it.
    """

    def _setup(self, monkeypatch, fake):
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

    def _raises(self, monkeypatch, stderr, exc=None, progress=None, **config):
        import pytest

        fake = _PreflightFake(preflight_rc=128, preflight_stderr=stderr)
        self._setup(monkeypatch, fake)
        with pytest.raises(exc or repo.PushCapabilityError) as excinfo:
            repo.setup_repo(_config(**config), progress=progress)
        return fake, str(excinfo.value)

    def test_writeable_task_probes_push_with_a_forced_dry_run(self, monkeypatch):
        token = "ghp_" + "z" * 36
        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        setup = repo.setup_repo(_config(branch_name="bgagent/task-abc/feature", github_token=token))

        cmd = fake.cmd_for("push-preflight")
        assert cmd is not None
        # A dry run never sends a ref update, so the remote is not changed, and
        # --no-verify keeps a pre-push hook from running.
        assert cmd[:4] == ["git", "push", "--dry-run", "--no-verify"]
        assert cmd[4] == "origin"
        # Forced, from the probe commit (HEAD names no commit in an empty clone),
        # to a ref other than the task branch.
        src, dst = cmd[5].split(":", 1)
        assert src == f"+{_PROBE_SHA}"
        assert dst.startswith("refs/heads/")
        assert dst != f"refs/heads/{setup.branch}"
        # The credential comes from the helper at call time, never the argv.
        assert token not in " ".join(cmd)
        assert "@" not in " ".join(cmd)
        assert fake.preflight_timeout == 120

    def test_preflight_runs_after_auth_is_configured_and_before_branch_setup(self, monkeypatch):
        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config())

        labels = fake.labels()
        assert labels.index("configure-git-credential-helper") < labels.index("push-preflight")
        assert labels.index("push-preflight") < labels.index("create-branch")

    def test_read_only_workflow_is_not_gated(self, monkeypatch):
        # coding/pr-review-v1 is read_only: it reviews and comments on the PR and
        # never pushes, so a token without write access is fit for it.
        fake = _PreflightFake(preflight_rc=128, preflight_stderr=_DENIED_403)
        self._setup(monkeypatch, fake)

        def _no_probe(repo_dir):
            raise AssertionError("a read-only task must not make the probe commit")

        monkeypatch.setattr(repo, "_preflight_probe_commit", _no_probe)

        repo.setup_repo(_config(read_only=True))

        assert "push-preflight" not in fake.labels()

    def test_read_only_matches_the_coding_workflows_that_never_push(self):
        # The skip keys on read_only; the issue's rule is "never pushes". Tie the
        # two together for the coding workflows the image ships.
        from workflow import load_workflow

        assert load_workflow("coding/pr-review-v1").read_only is True
        for pushing in ("coding/new-task-v1", "coding/pr-iteration-v1", "coding/restack-v1"):
            assert load_workflow(pushing).read_only is False, pushing

    def test_fine_grained_token_passes_on_the_servers_verdict(self, monkeypatch):
        # GitHub returns no X-OAuth-Scopes header for a fine-grained PAT; the dry
        # run reads no scopes, so it passes on the server's verdict alone.
        fake = _PreflightFake(preflight_rc=0)
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config(github_token="github_pat_" + "a" * 20))

        assert "create-branch" in fake.labels()

    def test_classic_token_with_repo_scope_passes(self, monkeypatch):
        fake = _PreflightFake(preflight_rc=0)
        self._setup(monkeypatch, fake)

        repo.setup_repo(_config(github_token="ghp_" + "a" * 36))

        assert "create-branch" in fake.labels()

    def test_classic_token_without_scopes_fails_before_the_agent_runs(self, monkeypatch):
        token = "ghp_" + "b" * 36
        fake, message = self._raises(monkeypatch, _DENIED_404, github_token=token)

        # The CDK error classifier maps this phrase to "Insufficient GitHub token
        # scopes" (cdk/src/handlers/shared/error-classifier.ts).
        assert message.startswith("Token cannot push to owner/repo")
        assert "classic personal access token" in message
        assert "`repo` scope" in message
        assert "Repository not found" in message
        assert "agent/README.md" in message
        assert token not in message
        # No later setup step ran: no branch, no mise install, no build.
        assert fake.labels()[-1] == "push-preflight"

    def test_403_refusal_and_the_login_is_not_kept(self, monkeypatch):
        _, message = self._raises(monkeypatch, _denied_403(user="bot-account"))

        assert message.startswith("Token cannot push to owner/repo")
        assert "Permission to owner/repo.git denied to <token user>" in message
        assert "bot-account" not in message

    def test_fine_grained_refusal_names_access_and_the_contents_permission(self, monkeypatch):
        _, message = self._raises(
            monkeypatch, _DENIED_FINE_GRAINED, github_token="github_pat_" + "c" * 20
        )

        assert "fine-grained personal access token" in message
        assert "include owner/repo in the token's repository access" in message
        assert "Contents permission with Read and write access" in message
        assert "Write access to repository not granted" in message

    def test_unknown_token_type_gets_both_remedies(self, monkeypatch):
        # No token in the config: gh supplies whatever it is logged in with.
        _, message = self._raises(monkeypatch, _DENIED_403, github_token="")

        assert "Contents permission" in message
        assert "`repo` scope" in message

    def test_github_app_token_remedy(self):
        remedy = repo._token_remedy("ghs_" + "e" * 36, "owner/repo")

        assert remedy.label == "GitHub App token"
        assert "install it on owner/repo" in remedy.remedy

    def test_rejected_credential_is_an_auth_failure_not_a_scope_problem(self, monkeypatch):
        # A token revoked or expired after the clone: GitHub rejects it at the push.
        # Adding scopes would not help.
        _, message = self._raises(monkeypatch, _REJECTED_401, github_token="ghp_" + "f" * 36)

        assert message.startswith("BLOCKED[auth_failure]:")
        assert "(resource: owner/repo)" in message
        assert "invalid, expired or revoked" in message
        assert "Token cannot push" not in message

    def test_archived_repository_is_not_blamed_on_the_token(self, monkeypatch):
        _, message = self._raises(monkeypatch, _ARCHIVED, github_token="ghp_" + "b" * 36)

        assert message.startswith("Repository owner/repo is archived on GitHub, so it is read-only")
        assert "Token cannot push" not in message
        assert "`repo` scope" not in message

    def test_saml_enforcement_names_sso_authorization(self, monkeypatch):
        _, message = self._raises(monkeypatch, _SAML, github_token="ghp_" + "b" * 36)

        assert message.startswith("GitHub organization policy blocks pushes to owner/repo")
        assert "SAML single sign-on" in message
        assert "Configure SSO" in message
        assert "`repo` scope" not in message

    def test_ip_allow_list_names_the_allow_list(self, monkeypatch):
        _, message = self._raises(monkeypatch, _IP_ALLOW_LIST)

        assert message.startswith("GitHub organization policy blocks pushes to owner/repo")
        assert "egress IP addresses" in message

    def test_names_never_pick_the_cause(self, monkeypatch):
        import pytest

        # The policy words in a user or repository name must not pass for GitHub's
        # message: these are plain refusals of a scope-less classic token.
        for repo_url, user in (
            ("acme/archived-tools", "someone"),
            ("acme/python3-saml", "someone"),
            ("owner/repo", "samlee"),
            ("owner/repo", "archivedbot"),
        ):
            _, message = self._raises(
                monkeypatch,
                _denied_403(repo_url, user),
                repo_url=repo_url,
                github_token="ghp_" + "b" * 36,
            )
            assert message.startswith(f"Token cannot push to {repo_url}"), repo_url
            assert "`repo` scope" in message
            assert "SAML" not in message
            assert "is archived on GitHub" not in message

        # Nor turn a GitHub outage on such a repository into a permanent refusal.
        for repo_url in ("acme/archived-notes", "acme/saml-tools"):
            fake = _PreflightFake(
                preflight_rc=128, preflight_stderr=_BAD_GATEWAY.format(repo=repo_url)
            )
            self._setup(monkeypatch, fake)
            with pytest.raises(repo.DependencyUnreachableError) as excinfo:
                repo.setup_repo(_config(repo_url=repo_url))
            assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:"), repo_url

    def test_error_quotes_the_line_that_says_why(self, monkeypatch):
        stderr = "warning: redirecting to https://github.com/owner/repo.git/\n" + _DENIED_403
        _, message = self._raises(monkeypatch, stderr)

        assert "Permission to owner/repo.git denied" in message
        assert "redirecting" not in message

    def test_git_stderr_is_redacted_in_the_error(self, monkeypatch):
        leaked = "ghp_" + "d" * 36
        _, message = self._raises(
            monkeypatch, f"remote: Permission to owner/repo.git denied. Token {leaked}"
        )

        assert leaked not in message

    def test_each_refusal_emits_the_event_of_its_cause(self, monkeypatch):
        for stderr, kind in (
            (_DENIED_403, "auth_failure"),
            (_REJECTED_401, "auth_failure"),
            (_SAML, "auth_failure"),
            (_ARCHIVED, "unknown_environmental"),
        ):
            progress = _RecordingProgress()
            self._raises(monkeypatch, stderr, progress=progress)

            blocked = [kw for name, kw in progress.calls if name == "write_agent_blocked"]
            assert len(blocked) == 1, stderr
            assert blocked[0]["kind"] == kind, stderr
            assert blocked[0]["retryable"] is False
            assert blocked[0]["resource"] == "owner/repo"
        # An archived repository is not reported as the token's fault.
        assert "token" not in blocked[0]["detail"].lower()

    def test_transient_failure_is_not_reported_as_a_permission_problem(self, monkeypatch):
        # Simulates GitHub staying unavailable after the retries: a retryable
        # blocker, so the operator is not sent to change a token that is fine.
        _, message = self._raises(
            monkeypatch, _BAD_GATEWAY.format(repo="owner/repo"), exc=repo.DependencyUnreachableError
        )

        assert message.startswith("BLOCKED[dependency_unreachable]:")

    def test_rate_limit_is_transient(self, monkeypatch):
        _, message = self._raises(
            monkeypatch,
            "fatal: unable to access 'https://github.com/owner/repo.git/': "
            "The requested URL returned error: 429",
            exc=repo.DependencyUnreachableError,
        )

        assert message.startswith("BLOCKED[dependency_unreachable]:")

    def test_timeout_is_a_retryable_dependency_failure_not_a_build_timeout(self, monkeypatch):
        import pytest

        fake = _PreflightFake(timeout=True)
        self._setup(monkeypatch, fake)
        progress = _RecordingProgress()

        # Unhandled, TimeoutExpired would be classified "Build/tests didn't finish".
        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        message = str(excinfo.value)
        assert message.startswith("BLOCKED[dependency_unreachable]:")
        assert "within 120s" in message
        assert "retries" not in message
        blocked = [kw for name, kw in progress.calls if name == "write_agent_blocked"]
        assert blocked and blocked[0]["retryable"] is True

    def test_unresolvable_host_is_an_egress_block(self, monkeypatch):
        _, message = self._raises(
            monkeypatch,
            "fatal: unable to access 'https://github.com/acme/archived-x.git/': "
            "Could not resolve host: github.com",
            exc=repo.DependencyUnreachableError,
            repo_url="acme/archived-x",
        )

        assert message.startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in message

    def test_other_failure_stops_the_task_with_the_git_error(self, monkeypatch):
        # The final push goes through the same remote and credential helper, so a
        # dry run that fails for another reason would most likely fail it too.
        _, message = self._raises(monkeypatch, "fatal: something unexpected", exc=RuntimeError)

        assert "push-preflight failed" in message
        assert "something unexpected" in message

    def test_failed_probe_commit_stops_setup_before_the_push(self, monkeypatch):
        import pytest

        fake = _PreflightFake()
        self._setup(monkeypatch, fake)

        def _broken(repo_dir):
            raise RuntimeError("push-preflight-commit failed (exit 128): fatal: bad object")

        monkeypatch.setattr(repo, "_preflight_probe_commit", _broken)

        with pytest.raises(RuntimeError, match="push-preflight-commit failed"):
            repo.setup_repo(_config())

        assert "push-preflight" not in fake.labels()
        assert "create-branch" not in fake.labels()

    def test_pr_iteration_is_checked_before_its_branch_is_fetched(self, monkeypatch):
        # pr-iteration and restack push their PR branch too (push_resolve).
        fake, _ = self._raises(
            monkeypatch,
            _DENIED_403,
            is_pr_workflow=True,
            branch_name="feature/x",
            base_branch="develop",
        )

        assert "fetch-pr-branch" not in fake.labels()
        assert "checkout-pr-branch" not in fake.labels()

    def test_stacked_child_is_checked_before_its_base_is_fetched(self, monkeypatch):
        fake, _ = self._raises(
            monkeypatch, _DENIED_403, branch_name="bgagent/t/child", base_branch="pred"
        )

        assert "fetch-base-branch" not in fake.labels()


class TestPushPreflightRetries:
    """Through the real bounded retry loop: a refusal fails in one attempt, an
    outage is retried."""

    def _run(self, monkeypatch, stderr):
        import pytest

        attempts = []

        def fake_run_cmd(cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            if label == "push-preflight":
                attempts.append(cmd)
                return SimpleNamespace(returncode=128, stdout="", stderr=stderr)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        import functools

        import shell

        sleeps = []
        monkeypatch.setattr("shell.run_cmd", fake_run_cmd)
        # The real loop, with its sleeps recorded rather than slept.
        monkeypatch.setattr(
            repo,
            "run_cmd_with_backoff",
            functools.partial(shell.run_cmd_with_backoff, sleep=sleeps.append),
        )
        monkeypatch.setattr(repo, "_preflight_probe_commit", lambda repo_dir: _PROBE_SHA)
        with pytest.raises(RuntimeError):
            repo._preflight_push_capability(_config(), "/nonexistent", progress=None)
        return attempts, sleeps

    def test_refusal_takes_one_attempt(self, monkeypatch):
        attempts, sleeps = self._run(monkeypatch, _DENIED_403)

        assert len(attempts) == 1
        assert sleeps == []

    def test_outage_is_retried(self, monkeypatch):
        attempts, sleeps = self._run(monkeypatch, _BAD_GATEWAY.format(repo="owner/repo"))

        assert len(attempts) == 3
        assert len(sleeps) == 2


class TestPushPreflightAgainstRealGit:
    """The preflight's commands against a real git remote (a local bare repository):
    it reaches the remote, passes, changes nothing, and does not depend on HEAD or on
    hooks."""

    @staticmethod
    def _git(*args, cwd):
        return subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
        ).stdout

    def _remote_and_clone(self, tmp_path, monkeypatch, *, empty=False):
        monkeypatch.setenv("GIT_AUTHOR_NAME", "t")
        monkeypatch.setenv("GIT_AUTHOR_EMAIL", "t@example.com")
        monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
        monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@example.com")
        remote = tmp_path / "remote.git"
        self._git("init", "--bare", "-q", "-b", "main", str(remote), cwd=tmp_path)
        if not empty:
            seed = tmp_path / "seed"
            self._git("init", "-q", str(seed), cwd=tmp_path)
            self._git("commit", "-q", "--allow-empty", "-m", "init", cwd=seed)
            self._git("push", "-q", str(remote), "HEAD:refs/heads/main", cwd=seed)
        work = tmp_path / "work"
        self._git("clone", "-q", str(remote), str(work), cwd=tmp_path)
        return remote, work

    def test_dry_run_creates_no_ref_and_leaves_the_clone_alone(self, tmp_path, monkeypatch):
        remote, work = self._remote_and_clone(tmp_path, monkeypatch)
        refs_before = self._git("for-each-ref", cwd=remote)
        head_before = self._git("rev-parse", "HEAD", cwd=work)
        config_before = (work / ".git" / "config").read_text()

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert self._git("for-each-ref", cwd=remote) == refs_before
        assert "bgagent-push-preflight" not in refs_before
        assert self._git("rev-parse", "HEAD", cwd=work) == head_before
        assert self._git("status", "--porcelain", cwd=work) == ""
        assert (work / ".git" / "config").read_text() == config_before

    def test_dry_run_reaches_the_remote(self, tmp_path, monkeypatch):
        import pytest

        # The check rests on the dry run contacting the remote: with no remote to
        # reach, it must fail, not pass locally.
        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        self._git("remote", "set-url", "origin", str(tmp_path / "missing.git"), cwd=work)

        with pytest.raises(RuntimeError, match="push-preflight failed"):
            repo._preflight_push_capability(_config(), str(work), progress=None)

    def test_empty_repository_passes(self, tmp_path, monkeypatch):
        # HEAD names no commit in a clone of an empty repository; the probe commit
        # does not need one.
        remote, work = self._remote_and_clone(tmp_path, monkeypatch, empty=True)

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert self._git("for-each-ref", cwd=remote) == ""

    def test_existing_ref_with_the_probe_name_does_not_block(self, tmp_path, monkeypatch):
        remote, work = self._remote_and_clone(tmp_path, monkeypatch)
        # Someone pushed an unrelated branch with the probe's name.
        other = tmp_path / "other"
        self._git("init", "-q", str(other), cwd=tmp_path)
        self._git("commit", "-q", "--allow-empty", "-m", "unrelated", cwd=other)
        self._git("push", "-q", str(remote), "HEAD:refs/heads/bgagent-push-preflight", cwd=other)
        refs_before = self._git("for-each-ref", cwd=remote)

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert self._git("for-each-ref", cwd=remote) == refs_before

    def test_pre_push_hook_does_not_run(self, tmp_path, monkeypatch):
        _, work = self._remote_and_clone(tmp_path, monkeypatch)
        hooks = tmp_path / "hooks"
        hooks.mkdir()
        marker = tmp_path / "hook-ran"
        hook = hooks / "pre-push"
        hook.write_text(f"#!/bin/sh\ntouch {marker}\nexit 1\n")
        hook.chmod(0o755)
        # Pin the hooks directory so a hooksPath from the host cannot hide the hook.
        self._git("config", "core.hooksPath", str(hooks), cwd=work)
        # Control: a plain dry run does run it.
        subprocess.run(
            ["git", "push", "--dry-run", "origin", "HEAD:refs/heads/x"],
            cwd=work,
            capture_output=True,
        )
        assert marker.exists()
        marker.unlink()

        repo._preflight_push_capability(_config(), str(work), progress=None)

        assert not marker.exists()
