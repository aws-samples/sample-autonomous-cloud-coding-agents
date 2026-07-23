"""Unit tests for post_hooks.py — hermetic push/PR logic (no network, no git).

Covers ``ensure_pushed`` push-detection, the ``push_resolve`` push-failure
surface (``_note_unpushed_commits``), and ``ensure_pr`` body assembly basics.
The two seams are ``subprocess.run`` (read-only git/gh queries) and
``shell.run_cmd`` (mutating git/gh commands) — both faked with recorders.
"""

import subprocess
from types import SimpleNamespace

import post_hooks
from models import RepoSetup
from tests.conftest import FakeRunCmd, make_task_config

# post_hooks.py keys scripted results off the exact label (FakeRunCmd's default
# exact-match mode), so e.g. returncodes={"push": 1} does not bleed into the
# "note-unpushed-commits" label.
_RunCmdRecorder = FakeRunCmd


def _cp(returncode=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class _SubprocessRunRecorder:
    """Fake for ``subprocess.run``: dispatches on a recognizable argv fragment.

    Accepts EITHER a list of (predicate, result) pairs (first match wins) OR a
    single ``responder`` callable ``argv -> CompletedProcess-like``. Default
    result is rc=0, empty stdout.
    """

    def __init__(self, script=None, responder=None):
        self.calls: list[list[str]] = []
        self._script = script or []
        self._responder = responder

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if self._responder is not None:
            return self._responder(cmd)
        for predicate, result in self._script:
            if predicate(cmd):
                return result
        return _cp()


def _pr_view(url: str) -> _SubprocessRunRecorder:
    """Recorder whose ``gh pr view`` returns *url* (other calls rc=0, empty)."""

    def responder(cmd):
        if "view" in cmd:
            return _cp(returncode=0, stdout=url + "\n")
        return _cp()

    return _SubprocessRunRecorder(responder=responder)


_config = make_task_config


def _setup(**overrides) -> RepoSetup:
    return RepoSetup(
        repo_dir=overrides.pop("repo_dir", "/tmp/repo"),
        branch=overrides.pop("branch", "bgagent/task-xyz/fix"),
        default_branch=overrides.pop("default_branch", "main"),
        **overrides,
    )


class TestEnsurePushed:
    def test_pushes_when_unpushed_commits_exist(self, monkeypatch):
        # git log shows unpushed commits (rc=0, non-empty stdout) -> push runs.
        sub = _SubprocessRunRecorder(
            script=[(lambda c: "log" in c, _cp(returncode=0, stdout="abc def\n"))]
        )
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is True
        assert "push" in run_cmd.labels()

    def test_no_push_when_up_to_date(self, monkeypatch):
        # git log rc=0 with empty stdout -> nothing to push, no push command.
        sub = _SubprocessRunRecorder(script=[(lambda c: "log" in c, _cp(returncode=0, stdout=""))])
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is True
        assert "push" not in run_cmd.labels()

    def test_push_failure_returns_false(self, monkeypatch):
        # Remote branch missing (git log rc!=0) triggers push; push fails.
        sub = _SubprocessRunRecorder(
            script=[(lambda c: "log" in c, _cp(returncode=128, stderr="no upstream"))]
        )
        run_cmd = _RunCmdRecorder(returncodes={"push": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is False
        assert "push" in run_cmd.labels()


class TestPushResolveFailureSurface:
    def test_push_failure_posts_unpushed_note_and_returns_url(self, monkeypatch):
        # ensure_pushed fails -> _note_unpushed_commits posts a PR comment, and
        # the existing PR URL is still returned (the PR exists).
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: False)
        sub = _pr_view("https://github.com/o/r/pull/9")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )
        assert url == "https://github.com/o/r/pull/9"
        # The un-pushed-commits note was posted as a PR comment.
        assert "note-unpushed-commits" in run_cmd.labels()
        note_cmd = run_cmd.cmd_for("note-unpushed-commits")
        assert "comment" in note_cmd

    def test_failed_note_post_warns_loudly(self, monkeypatch):
        # check=False means run_cmd never raises on a non-zero gh exit, so
        # _note_unpushed_commits must inspect the returncode itself — a
        # failed `gh pr comment` (missing scope, rate limit) was previously
        # a silent no-op while the PR quietly went stale.
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: False)
        sub = _pr_view("https://github.com/o/r/pull/9")
        run_cmd = _RunCmdRecorder(returncodes={"note-unpushed-commits": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        warns: list[str] = []
        monkeypatch.setattr(
            post_hooks, "log", lambda lvl, msg: warns.append(msg) if lvl == "WARN" else None
        )

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )

        # The URL is still returned (PR exists), but the failure to notify
        # the reviewer is surfaced as a WARN naming the consequence.
        assert url == "https://github.com/o/r/pull/9"
        assert any("reviewer has NOT been notified" in w for w in warns)

    def test_push_success_does_not_post_note(self, monkeypatch):
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        sub = _pr_view("https://github.com/o/r/pull/9")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )
        assert url == "https://github.com/o/r/pull/9"
        assert "note-unpushed-commits" not in run_cmd.labels()

    def test_resolve_strategy_skips_push(self, monkeypatch):
        calls = {"pushed": False}

        def _ensure_pushed(d, b):
            calls["pushed"] = True
            return True

        monkeypatch.setattr(post_hooks, "ensure_pushed", _ensure_pushed)
        sub = _pr_view("https://github.com/o/r/pull/3")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="resolve"
        )
        assert url == "https://github.com/o/r/pull/3"
        assert calls["pushed"] is False


class TestEnsurePrCreate:
    def test_returns_existing_pr_when_already_open(self, monkeypatch):
        # First `gh pr view` returns a URL -> short-circuit, no creation.
        sub = _pr_view("https://github.com/o/r/pull/1")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="create"
        )
        assert url == "https://github.com/o/r/pull/1"
        assert "create-pr" not in run_cmd.labels()

    def test_no_commits_means_no_pr(self, monkeypatch):
        # pr view -> empty (no existing PR); git log diff -> empty (no commits).
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd:
                return _cp(returncode=0, stdout="")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="create"
        )
        assert url is None
        assert "create-pr" not in run_cmd.labels()

    def test_creates_pr_with_body_basics(self, monkeypatch):
        # No existing PR; commits present; gh pr create succeeds.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd and "--reverse" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n\n---")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/42\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(issue_number="55"),
            _setup(),
            build_passed=True,
            lint_passed=False,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/42"
        create_cmd = run_cmd.cmd_for("create-pr")
        assert create_cmd is not None
        # PR title derived from first commit subject.
        assert "--title" in create_cmd
        assert create_cmd[create_cmd.index("--title") + 1] == "feat: do the thing"
        # Body carries verification statuses and the issue link.
        body = create_cmd[create_cmd.index("--body") + 1]
        assert "Resolves #55" in body
        assert "**PASS**" in body  # build passed
        assert "**FAIL**" in body  # lint failed


class TestReconcileAgentBranch:
    """ABCA-815 root cause: reconcile the platform branch when the agent
    committed on its OWN branch instead of the pre-checked-out platform branch.

    Real git (tmp_path) — this is pure git plumbing, so a real repo gives far
    higher confidence than faking subprocess. The two seams (subprocess.run for
    the branch read, run_cmd for the mutating ops) both hit the tmp repo."""

    @staticmethod
    def _git(repo, *args):
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)

    def _make_repo(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        self._git(repo, "init", "-q")
        self._git(repo, "config", "user.email", "t@t")
        self._git(repo, "config", "user.name", "t")
        (repo / "f.txt").write_text("base\n")
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "base")
        # Rename default branch to a stable name for the test.
        self._git(repo, "branch", "-M", "main")
        return str(repo)

    def _head_sha(self, repo):
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()

    def _sha_of(self, repo, ref):
        return subprocess.run(
            ["git", "rev-parse", ref], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()

    def test_reconciles_when_agent_on_own_branch(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        # Platform creates its (empty) branch, as setup_repo does.
        self._git(repo, "checkout", "-qb", platform)
        # Agent goes rogue: its own branch + a commit (the live ABCA-815 case).
        self._git(repo, "checkout", "-qb", "agent-own-branch")
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        agent_head = self._head_sha(repo)

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is True
        # Platform branch now points at the agent's commit …
        assert self._sha_of(repo, platform) == agent_head
        # … and it is the checked-out branch, so downstream delivery uses it.
        assert post_hooks._current_branch(repo) == platform

    def test_noop_when_already_on_platform_branch(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\non platform\n")
        self._git(repo, "commit", "-qam", "work on platform")
        before = self._head_sha(repo)

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is False
        assert self._sha_of(repo, platform) == before
        assert post_hooks._current_branch(repo) == platform

    def test_noop_on_detached_head(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        # Detach HEAD at the current commit.
        self._git(repo, "checkout", "-q", "--detach")

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is False  # nothing to adopt

    def test_current_branch_reports_none_when_detached(self, tmp_path):
        repo = self._make_repo(tmp_path)
        self._git(repo, "checkout", "-q", "--detach")
        assert post_hooks._current_branch(repo) is None
