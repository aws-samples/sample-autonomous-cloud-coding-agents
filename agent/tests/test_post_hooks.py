"""Unit tests for post_hooks.py — hermetic push/PR logic (no network, no git).

Covers ``ensure_pushed`` push-detection, the ``push_resolve`` push-failure
surface (``_note_unpushed_commits``), and ``ensure_pr`` body assembly basics.
The two seams are ``subprocess.run`` (read-only git/gh queries) and
``shell.run_cmd`` (mutating git/gh commands) — both faked with recorders.
"""

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


def _pr_view(url: str, base: str = "main") -> _SubprocessRunRecorder:
    """Recorder for the two ``gh pr view`` shapes ensure_pr issues.

    The URL query (``--json url``) returns *url*; the base query
    (``--json baseRefName``, used by ``_reconcile_pr_base``) returns *base*.
    Defaulting *base* to ``main`` matches ``_setup``'s default_branch so the
    reconcile is a no-op unless a test opts into a mismatch.
    """

    def responder(cmd):
        if "view" in cmd and "baseRefName" in cmd:
            return _cp(returncode=0, stdout=base + "\n")
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
        # First `gh pr view` returns a URL -> short-circuit, no creation. The
        # existing PR's base ("main") already matches default_branch, so the
        # base reconcile is a no-op (no `gh pr edit`).
        sub = _pr_view("https://github.com/o/r/pull/1", base="main")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="main"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/1"
        assert "create-pr" not in run_cmd.labels()
        assert "reconcile-pr-base" not in run_cmd.labels()

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


class TestReconcilePrBase:
    """The agent picks its own PR --base; ensure_pr corrects it deterministically
    to setup.default_branch (the orchestrator's base for a stacked child / the
    detected repo default for a root). Live-caught on the #247 chain: a stacked
    child + a root both opened against a wrong 'main'."""

    def test_retargets_when_base_mismatches(self, monkeypatch):
        # Existing PR is based on 'main' but the stacked child's real base is
        # the predecessor branch -> ensure_pr issues `gh pr edit --base <pred>`.
        pred = "bgagent/task-x/abca-1-predecessor"
        sub = _pr_view("https://github.com/o/r/pull/7", base="main")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch=pred),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/7"
        assert "reconcile-pr-base" in run_cmd.labels()
        edit_cmd = run_cmd.cmd_for("reconcile-pr-base")
        assert "edit" in edit_cmd
        assert edit_cmd[edit_cmd.index("--base") + 1] == pred

    def test_noop_when_base_matches(self, monkeypatch):
        # PR base already == default_branch -> no `gh pr edit`.
        sub = _pr_view("https://github.com/o/r/pull/7", base="develop")
        run_cmd = _RunCmdRecorder()
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch="develop"),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/7"
        assert "reconcile-pr-base" not in run_cmd.labels()

    def test_retarget_failure_warns_and_is_not_fatal(self, monkeypatch):
        # `gh pr edit` fails -> WARN naming the consequence, URL still returned.
        pred = "bgagent/task-x/abca-1-predecessor"
        sub = _pr_view("https://github.com/o/r/pull/7", base="main")
        run_cmd = _RunCmdRecorder(returncodes={"reconcile-pr-base": 1})
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)
        warns: list[str] = []
        monkeypatch.setattr(
            post_hooks, "log", lambda lvl, msg: warns.append(msg) if lvl == "WARN" else None
        )

        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch=pred),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/7"
        assert any("PR remains based on 'main'" in w for w in warns)

    def test_reconcile_skipped_for_freshly_created_pr_path(self, monkeypatch):
        # When the agent did NOT pre-create the PR, ensure_pr creates it with the
        # correct --base directly; no separate reconcile needed (create path
        # already uses default_branch). Guards against double-work.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd and "--reverse" in cmd:
                return _cp(returncode=0, stdout="feat: x\n")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: x\n\n---")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/8\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        pred = "bgagent/task-x/abca-1-predecessor"
        url = post_hooks.ensure_pr(
            _config(),
            _setup(default_branch=pred),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )
        assert url == "https://github.com/o/r/pull/8"
        # create path used the right base; no post-creation reconcile fired.
        create_cmd = run_cmd.cmd_for("create-pr")
        assert create_cmd[create_cmd.index("--base") + 1] == pred
        assert "reconcile-pr-base" not in run_cmd.labels()
