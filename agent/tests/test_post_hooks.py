"""Unit tests for post_hooks.py — hermetic push/PR logic (no network, no git).

Covers ``ensure_pushed`` push-detection, the ``push_resolve`` push-failure
surface (``_note_unpushed_commits``), and ``ensure_pr`` body assembly basics.
The two seams are ``subprocess.run`` (read-only git/gh queries) and
``shell.run_cmd`` (mutating git/gh commands) — both faked with recorders.
"""

from types import SimpleNamespace

import post_hooks
from models import RepoSetup, TaskConfig


class _RunCmdRecorder:
    """Fake for ``shell.run_cmd``: records argv, returns scripted returncodes/stdout."""

    def __init__(self, returncodes=None, stdouts=None):
        self.calls: list[dict] = []
        self._returncodes = returncodes or {}
        self._stdouts = stdouts or {}

    def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
        self.calls.append({"cmd": cmd, "label": label})
        rc = self._returncodes.get(label, 0)
        stdout = self._stdouts.get(label, "")
        return SimpleNamespace(returncode=rc, stdout=stdout, stderr="")

    def labels(self) -> list[str]:
        return [c["label"] for c in self.calls]

    def cmd_for(self, label: str):
        for c in self.calls:
            if c["label"] == label:
                return c["cmd"]
        return None


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


def _config(**overrides) -> TaskConfig:
    return TaskConfig(
        repo_url=overrides.pop("repo_url", "owner/repo"),
        aws_region=overrides.pop("aws_region", "us-east-1"),
        task_id=overrides.pop("task_id", "task-xyz"),
        task_description=overrides.pop("task_description", "Fix the bug"),
        **overrides,
    )


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
