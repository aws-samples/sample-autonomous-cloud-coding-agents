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
    # _install_commit_hook touches the filesystem; stub it out (it's its own
    # best-effort path and not under test here).
    monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)


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
        # #299 plan-mode T2: a NON-PR workflow (e.g. coding/decompose-v1) must also
        # capture the cloned HEAD sha (via the post-setup rev-parse) so the planner
        # can echo it into repo_digest_sha. The PR path captures its own sha; this
        # covers the else/default clone path that decompose uses.
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


class TestReadOnlyBaselineSkip:
    """#299 ECS_RIGHTSIZED_PLANNING: a read_only workflow (coding/decompose-v1)
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
    silently breaks #247 A4 stacking: a stacked child fetches the
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
