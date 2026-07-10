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
