"""Unit tests for post_hooks.py — hermetic commit/push/PR logic (no network).

Covers ``ensure_pushed`` push-detection, the ``push_resolve`` push-failure
surface (``_note_unpushed_commits``), and ``ensure_pr`` body assembly basics.
The two seams are ``subprocess.run`` (read-only git/gh queries) and
``shell.run_cmd`` (mutating git/gh commands) — both faked with recorders,
except where a class says that it runs real git under ``tmp_path``.
"""

import os
import subprocess
from types import SimpleNamespace

import pytest

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


def _git(repo, *args) -> str:
    """Run git for real in *repo*, a directory under ``tmp_path``, and return
    what it printed."""
    done = subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)
    return done.stdout.strip()


@pytest.fixture
def git_env(tmp_path, monkeypatch):
    """The environment for a test in which the post-hooks run git for real.

    They run it with the environment of the process, so that is prepared here
    and not handed to each call: without the repository variables of a commit
    hook this suite may run under, without the ignore file of the host, and with
    the committer identity that the pipeline exports before the agent starts."""
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    for role in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{role}_NAME", "ABCA Test")
        monkeypatch.setenv(f"GIT_{role}_EMAIL", "abca-test@example.invalid")


class TestEnsureCommitted:
    """The safety-net commit of work the agent left uncommitted: what it stages,
    that it commits, and what it reports. Real git under ``tmp_path``."""

    SUBJECT = "chore(agent): save uncommitted work from session end"

    @pytest.fixture
    def repo(self, tmp_path, git_env):
        """A repository with one committed file, ``a.txt``."""
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        (repo / "a.txt").write_text("base\n")
        _git(repo, "add", "a.txt")
        _git(repo, "commit", "-qm", "base")
        return repo

    def test_commits_tracked_changes_and_leaves_untracked_files_alone(self, repo):
        (repo / "a.txt").write_text("base\nwork the agent did not commit\n")
        (repo / "notes-untracked.txt").write_text("a file the agent never added\n")

        assert post_hooks.ensure_committed(str(repo)) is True

        assert _git(repo, "log", "-1", "--pretty=%s") == self.SUBJECT
        assert _git(repo, "show", "HEAD:a.txt") == "base\nwork the agent did not commit"
        # `git add -u`: the commit holds the tracked file and nothing else. An
        # untracked file (a downloaded attachment, build output) stays out of
        # the pull request and stays on disk.
        assert _git(repo, "show", "--name-only", "--pretty=format:", "HEAD") == "a.txt"
        assert _git(repo, "ls-files") == "a.txt"
        assert _git(repo, "status", "--porcelain") == "?? notes-untracked.txt"
        # Only the untracked file is left, so there is no second commit.
        assert post_hooks.ensure_committed(str(repo)) is False
        assert _git(repo, "rev-list", "--count", "HEAD") == "2"

    def test_clean_tree_gets_no_commit(self, repo):
        assert post_hooks.ensure_committed(str(repo)) is False
        assert _git(repo, "rev-list", "--count", "HEAD") == "1"

    @pytest.mark.parametrize("stalled", ["diff", "commit"])
    def test_git_command_that_times_out_is_reported_as_not_committed(
        self, repo, monkeypatch, stalled
    ):
        # `git commit` runs the commit hooks of the repository (lint, tests),
        # which can outlast the minute it gets. The pipeline goes on with the
        # commits that exist: what was not committed is lost, the task is not.
        (repo / "a.txt").write_text("base\nwork the agent did not commit\n")
        real_run = subprocess.run

        def run(cmd, **kwargs):
            if cmd[1] == stalled:
                raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])
            return real_run(cmd, **kwargs)

        monkeypatch.setattr(post_hooks.subprocess, "run", run)

        assert post_hooks.ensure_committed(str(repo)) is False
        assert _git(repo, "log", "-1", "--pretty=%s") == "base"

    def test_checkout_that_is_gone_is_reported_as_not_committed(self, tmp_path):
        # git cannot even be started in a directory that does not exist.
        assert post_hooks.ensure_committed(str(tmp_path / "gone")) is False


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

    def test_push_that_times_out_returns_false(self, monkeypatch):
        # `git push` runs the pre-push hooks of the repository (its test
        # suites), which can outlast the ten minutes a push gets. run_cmd then
        # raises, check=False or not.
        sub = _SubprocessRunRecorder(
            script=[(lambda c: "log" in c, _cp(returncode=0, stdout="abc def\n"))]
        )

        def run_cmd(cmd, label, timeout=600, **kwargs):
            raise subprocess.TimeoutExpired(cmd, timeout)

        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        assert post_hooks.ensure_pushed("/tmp/repo", "br") is False


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

    def test_pr_lookup_that_times_out_is_no_url_not_a_crash(self, monkeypatch):
        # The commits are pushed, then `gh pr view` does not answer in time. The
        # URL is not known, as when gh exits non-zero; the work is delivered.
        def responder(cmd):
            if "view" in cmd:
                raise subprocess.TimeoutExpired(cmd, 60)
            return _cp()

        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(
            post_hooks.subprocess, "run", _SubprocessRunRecorder(responder=responder)
        )
        monkeypatch.setattr(post_hooks, "run_cmd", _RunCmdRecorder())

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="push_resolve"
        )

        assert url is None


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

    def test_pr_lookup_that_times_out_goes_on_to_create_the_pr(self, monkeypatch):
        # `gh pr view` does not answer in time: no pull request is known, as
        # when gh exits non-zero, so the commits are pushed and one is created.
        def responder(cmd):
            if "view" in cmd:
                raise subprocess.TimeoutExpired(cmd, 60)
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            return _cp()

        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/42\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(
            post_hooks.subprocess, "run", _SubprocessRunRecorder(responder=responder)
        )
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="create"
        )

        assert url == "https://github.com/o/r/pull/42"

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
            _config(issue_number="55", repo_url="acme/webapp"),
            _setup(default_branch="develop"),
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
        # The licence the contribution is offered under is that of the repository
        # the pull request is in, on the branch it targets: the link the prompt
        # has the agent write when it opens the pull request itself.
        assert "[project license](https://github.com/acme/webapp/blob/develop/LICENSE)" in body
        assert "sample-autonomous-cloud-coding-agents" not in body

    def test_build_that_could_not_run_is_not_reported_as_a_pass(self, monkeypatch):
        # build_passed=None: the build command could not run (exit 127, no such
        # task), so nothing was built. The body has to say that, not PASS.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(stdouts={"create-pr": "https://github.com/o/r/pull/42\n"})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        post_hooks.ensure_pr(
            _config(build_command="yarn install && yarn build"),
            _setup(),
            build_passed=None,
            lint_passed=True,
            strategy="create",
        )

        create_cmd = run_cmd.cmd_for("create-pr")
        assert create_cmd is not None
        body = create_cmd[create_cmd.index("--body") + 1]
        assert (
            "- `yarn install && yarn build` (post-agent): **NOT RUN (command could not run)**"
            in body
        )
        assert "- `mise run lint` (post-agent): **PASS**" in body

    def test_returns_none_when_pr_creation_fails(self, monkeypatch):
        # No existing PR; commits present; gh pr create exits non-zero.
        def responder(cmd):
            if "view" in cmd:
                return _cp(returncode=1, stderr="no pr")
            if "log" in cmd:
                return _cp(returncode=0, stdout="feat: do the thing\n")
            return _cp()

        sub = _SubprocessRunRecorder(responder=responder)
        run_cmd = _RunCmdRecorder(returncodes={"create-pr": 1})
        monkeypatch.setattr(post_hooks, "ensure_pushed", lambda d, b: True)
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)
        monkeypatch.setattr(post_hooks, "run_cmd", run_cmd)

        url = post_hooks.ensure_pr(
            _config(), _setup(), build_passed=True, lint_passed=True, strategy="create"
        )
        assert url is None
        assert run_cmd.cmd_for("create-pr") is not None


class TestExistingPrGetsLaterCommits:
    """The agent opens its pull request and then goes on working. What it
    commits after its last push, and the safety-net commit, must still reach
    the pull request.

    Real git with a bare repository as origin; only ``gh`` is faked."""

    BRANCH = "bgagent/task-xyz/fix"
    PR = "https://github.com/o/r/pull/1"

    @pytest.fixture
    def pushed(self, tmp_path, git_env, monkeypatch):
        """A clone whose task branch is pushed and has its pull request open:
        the clone, its origin, and the ``gh`` commands the post-hooks run."""
        origin, repo = tmp_path / "origin.git", tmp_path / "repo"
        _git(tmp_path, "init", "-q", "--bare", str(origin))
        _git(tmp_path, "clone", "-q", str(origin), str(repo))
        (repo / "f.txt").write_text("base\n")
        _git(repo, "add", "f.txt")
        _git(repo, "commit", "-qm", "base")
        _git(repo, "branch", "-M", "main")
        _git(repo, "push", "-q", "origin", "main")
        _git(repo, "checkout", "-qb", self.BRANCH)
        (repo / "f.txt").write_text("base\nagent change\n")
        _git(repo, "commit", "-qam", "agent work")
        _git(repo, "push", "-q", "-u", "origin", self.BRANCH)

        gh: list[list[str]] = []
        real_run = subprocess.run

        def run(cmd, **kwargs):
            if cmd[0] != "gh":
                return real_run(cmd, **kwargs)
            gh.append(cmd)
            # `gh pr view <branch> --json <field>`: the pull request the agent opened.
            return _cp(stdout="main\n" if "baseRefName" in cmd else self.PR + "\n")

        monkeypatch.setattr(post_hooks.subprocess, "run", run)
        return SimpleNamespace(repo=repo, origin=origin, gh=gh)

    def _ensure_pr(self, pushed) -> str | None:
        return post_hooks.ensure_pr(
            _config(),
            _setup(repo_dir=str(pushed.repo), branch=self.BRANCH),
            build_passed=True,
            lint_passed=True,
            strategy="create",
        )

    def test_safety_net_commit_reaches_the_pull_request(self, pushed):
        # With its pull request open the agent edits the file once more and
        # stops at its turn limit without committing.
        (pushed.repo / "f.txt").write_text("base\nagent change\nlast edit\n")
        assert post_hooks.ensure_committed(str(pushed.repo)) is True

        assert self._ensure_pr(pushed) == self.PR

        on_origin = _git(pushed.origin, "rev-parse", self.BRANCH)
        assert on_origin == _git(pushed.repo, "rev-parse", "HEAD")

    def test_reviewer_is_told_when_the_later_commits_cannot_be_pushed(self, pushed, tmp_path):
        # Someone else pushed to the branch of the pull request meanwhile, so
        # origin refuses the agent's push: it is not a fast-forward.
        other = tmp_path / "other"
        _git(tmp_path, "clone", "-q", "--branch", self.BRANCH, str(pushed.origin), str(other))
        _git(other, "commit", "-q", "--allow-empty", "-m", "a commit by somebody else")
        _git(other, "push", "-q", "origin", self.BRANCH)
        (pushed.repo / "f.txt").write_text("base\nagent change\nlast edit\n")
        assert post_hooks.ensure_committed(str(pushed.repo)) is True

        # The pull request exists, so its URL is still the result. A comment on
        # it says that it does not hold the agent's latest commits.
        assert self._ensure_pr(pushed) == self.PR
        assert [cmd[:4] for cmd in pushed.gh if "comment" in cmd] == [
            ["gh", "pr", "comment", self.BRANCH]
        ]

    def test_no_notice_when_the_refused_branch_holds_nothing_that_origin_lacks(self, pushed):
        # The session ended on another branch of origin, and the hook that runs
        # before this one re-pointed the task branch at it. Origin refuses that
        # push, it is no fast-forward; but every commit of the branch is on
        # origin already, so nothing of the agent's is missing from the pull
        # request and there is nothing to tell the reviewer.
        on_origin = _git(pushed.origin, "rev-parse", self.BRANCH)
        _git(pushed.repo, "checkout", "-qb", "release", "main")
        _git(pushed.repo, "commit", "-q", "--allow-empty", "-m", "release work")
        _git(pushed.repo, "push", "-q", "origin", "release")
        assert post_hooks.reconcile_agent_branch(str(pushed.repo), self.BRANCH) is True

        assert self._ensure_pr(pushed) == self.PR

        assert [cmd for cmd in pushed.gh if "comment" in cmd] == []
        assert _git(pushed.origin, "rev-parse", self.BRANCH) == on_origin


class TestExtractAgentNotes:
    """``_extract_agent_notes`` reads the "## Agent notes" section of the PR body."""

    @pytest.mark.parametrize(
        ("body", "expected"),
        [
            (
                "## Summary\nDone.\n\n## Agent notes\nRetried the build once.\n\n## Tests\nok\n",
                "Retried the build once.",
            ),
            ("## Summary\nDone.\n", None),  # no such section
        ],
    )
    def test_returns_the_section_text_or_none(self, monkeypatch, body, expected):
        sub = _SubprocessRunRecorder(responder=lambda _cmd: _cp(stdout=body))
        monkeypatch.setattr(post_hooks.subprocess, "run", sub)

        assert post_hooks._extract_agent_notes("/repo", "bgagent/t/x", _config()) == expected
        assert sub.calls, "the PR body is read with `gh pr view`"


class TestReconcileAgentBranch:
    """A leading cause of lost deliverables: reconcile the platform branch when
    the agent committed on its OWN branch instead of the pre-checked-out
    platform branch.

    Real git (tmp_path) — this is pure git plumbing, so a real repo gives far
    higher confidence than faking subprocess. The two seams (subprocess.run for
    the branch read, run_cmd for the mutating ops) both hit the tmp repo."""

    # Repo-LOCATION vars. An explicit GIT_DIR overrides repository discovery
    # outright, so it beats cwd, HOME, the GIT_CONFIG_* pins and `--local`
    # alike. Git exports these to hooks in a LINKED WORKTREE (unset in a normal
    # repo), which is exactly how this suite runs as a pre-push gate from
    # .worktrees/.
    _GIT_LOCATION_VARS = (
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_PREFIX",
    )

    @pytest.fixture(autouse=True)
    def _clear_ambient_git_location(self, monkeypatch):
        """Strip repo-location vars for the whole class (#720).

        Not just for the fixture helpers: ``post_hooks`` itself shells out to
        git with the ambient environment (e.g. ``_current_branch``), so an
        inherited GIT_DIR would point PRODUCTION code at the real repo instead
        of the tmp one — the assertions would silently describe the wrong
        repository.
        """
        for var in self._GIT_LOCATION_VARS:
            monkeypatch.delenv(var, raising=False)

    @staticmethod
    def _isolated_env(repo):
        # Hard-isolate from the developer's real git identity (#720). `cwd` alone
        # is NOT containment: a bare `git config` walks up to the nearest
        # enclosing repo, and `git init` at a linked-worktree root re-inits the
        # SHARED .git rather than creating a nested one — so both can write
        # straight into the real .git/config. Pinning the HOME/config env vars
        # means even a transcribed `git config user.email` cannot escape tmp.
        #
        # Dropping the repo-LOCATION vars first is load-bearing, not tidiness.
        # An explicit GIT_DIR overrides repository discovery outright, so it
        # defeats cwd, HOME and the GIT_CONFIG_* pins together — and `--local`
        # resolves relative to it, so that is no defence either. Git exports
        # GIT_DIR to hooks in a LINKED WORKTREE (it is unset in a normal repo),
        # which is exactly how this suite runs as a pre-push gate from
        # .worktrees/: inheriting it re-opens #720 and additionally stamps
        # `bare = true` on the real repo.
        env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in {
                "GIT_DIR",
                "GIT_COMMON_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                "GIT_PREFIX",
            }
        }
        env.update(
            {
                "HOME": str(repo),
                "XDG_CONFIG_HOME": str(repo),
                "GIT_CONFIG_GLOBAL": os.path.join(str(repo), ".gitconfig-test"),
                "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "ABCA Test",
                "GIT_AUTHOR_EMAIL": "abca-test@example.invalid",
                "GIT_COMMITTER_NAME": "ABCA Test",
                "GIT_COMMITTER_EMAIL": "abca-test@example.invalid",
            }
        )
        return env

    def _git(self, repo, *args):
        subprocess.run(
            ["git", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=self._isolated_env(repo),
        )

    def _make_repo(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        self._git(repo, "init", "-q")
        # RFC-2606 reserved domain, and --local so the write cannot escape this
        # repo even if the enclosing-repo fallback above is ever reintroduced.
        self._git(repo, "config", "--local", "user.email", "abca-test@example.invalid")
        self._git(repo, "config", "--local", "user.name", "ABCA Test")
        (repo / "f.txt").write_text("base\n")
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "base")
        # Rename default branch to a stable name for the test.
        self._git(repo, "branch", "-M", "main")
        return str(repo)

    def test_fixture_cannot_touch_an_outer_repo_even_with_git_dir_set(self, tmp_path, monkeypatch):
        """Regression guard for #720: the fixture must stay contained when a
        repo-location var is present in the ambient environment.

        Git exports GIT_DIR to hooks in a linked worktree, which is how this
        suite runs as a pre-push gate. An inherited GIT_DIR overrides repository
        discovery entirely, so it beats cwd/HOME/GIT_CONFIG_* *and* `--local` —
        the fixture would re-init and rewrite the real shared repo. Fails if
        _git ever stops stripping those vars."""
        outer = tmp_path / "outer"
        outer.mkdir()
        # Build the stand-in "real" repo with the location vars still cleared by
        # the autouse fixture, so this setup lands in tmp and not the actual repo.
        subprocess.run(["git", "init", "-q"], cwd=outer, check=True, capture_output=True)
        sentinel_config = outer / ".git" / "config"
        subprocess.run(
            ["git", "config", "--local", "user.email", "sentinel@example.invalid"],
            cwd=outer,
            check=True,
            capture_output=True,
        )
        before = sentinel_config.read_text()

        # Exactly what a pre-push hook in a linked worktree hands us.
        monkeypatch.setenv("GIT_DIR", str(outer / ".git"))
        monkeypatch.setenv("GIT_WORK_TREE", str(outer))

        self._make_repo(tmp_path)

        assert sentinel_config.read_text() == before, (
            "fixture escaped into the outer repo — _git must strip GIT_DIR/"
            "GIT_WORK_TREE before overlaying its pins (#720)"
        )

    def _head_sha(self, repo):
        # Same isolated env as _git: an inherited GIT_DIR would make this read
        # the REAL repo's HEAD instead of the fixture's.
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=self._isolated_env(repo),
        ).stdout.strip()

    def _sha_of(self, repo, ref):
        return subprocess.run(
            ["git", "rev-parse", ref],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
            env=self._isolated_env(repo),
        ).stdout.strip()

    def test_reconciles_when_agent_on_own_branch(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        # Platform creates its (empty) branch, as setup_repo does.
        self._git(repo, "checkout", "-qb", platform)
        # Agent goes rogue: its own branch + a commit (the case observed in practice).
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

    # The second name is for an iteration on a pull request: its branch is named
    # by a person, and may be named like a file or directory of the repository.
    @pytest.mark.parametrize("platform", ["bgagent/task-1/fix", "f.txt"])
    def test_keeps_the_commits_when_the_agent_ended_on_a_branch_behind_them(
        self, tmp_path, platform
    ):
        repo = self._make_repo(tmp_path)
        self._git(repo, "checkout", "-qb", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        agent_commit = self._head_sha(repo)
        # The agent looks at the default branch (does the test fail there too?)
        # and the session ends before it switches back.
        self._git(repo, "checkout", "-q", "main")

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        # main has no commit the platform branch lacks: re-pointing the platform
        # branch at it would drop the agent's commit and gain nothing.
        assert self._sha_of(repo, platform) == agent_commit
        assert moved is False
        # The platform branch is checked out again, so it is what gets built,
        # pushed and opened as the pull request.
        assert post_hooks._current_branch(repo) == platform

    def _origin_main_is(self, repo, commit):
        """What a clone records of origin: where its main is, and that main is
        its default branch."""
        self._git(repo, "update-ref", "refs/remotes/origin/main", commit)
        self._git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

    def test_keeps_the_commits_when_the_default_branch_has_moved_on(self, tmp_path):
        # An iteration on a pull request whose branch was cut from an older
        # main: main is ahead of it by now, so neither contains the other.
        repo = self._make_repo(tmp_path)
        pr_branch = "feature/x"
        self._git(repo, "checkout", "-qb", pr_branch)
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        agent_commit = self._head_sha(repo)
        self._git(repo, "checkout", "-q", "main")
        self._git(repo, "commit", "-q", "--allow-empty", "-m", "merged meanwhile")
        self._origin_main_is(repo, "main")

        moved = post_hooks.reconcile_agent_branch(repo, pr_branch)

        # The session ended on main, and every commit of main is origin's: none
        # is the agent's own, so there is nothing to adopt.
        assert self._sha_of(repo, pr_branch) == agent_commit
        assert moved is False
        assert post_hooks._current_branch(repo) == pr_branch

    def test_edits_made_on_the_branch_behind_are_committed_on_top_of_the_commits(self, tmp_path):
        repo = self._make_repo(tmp_path)
        (tmp_path / "repo" / "g.txt").write_text("base\n")
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "second file")
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        agent_commit = self._head_sha(repo)
        # Back on main the agent goes on working, in a file its commit left alone.
        self._git(repo, "checkout", "-q", "main")
        (tmp_path / "repo" / "g.txt").write_text("base\nedited on main, never committed\n")

        post_hooks.reconcile_agent_branch(repo, platform)

        # git carries the edit over to the platform branch, where the safety-net
        # commit saves it on top of the agent's commit.
        assert post_hooks._current_branch(repo) == platform
        assert post_hooks.ensure_committed(repo) is True
        assert self._sha_of(repo, f"{platform}~1") == agent_commit

    def test_checkout_that_git_refuses_adopts_the_head_as_before(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        # Back on main the agent edits the file its commit changed: git will not
        # switch branches over that edit.
        self._git(repo, "checkout", "-q", "main")
        (tmp_path / "repo" / "f.txt").write_text("base\nedited on main, never committed\n")

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        # The edit cannot be carried to the platform branch as it is, and left on
        # main it would be committed and built there while the platform branch
        # is pushed and described under its name. So HEAD is adopted, as before
        # this rule existed: the edit is what gets committed, built and pushed.
        assert moved is True
        assert self._sha_of(repo, platform) == self._sha_of(repo, "main")
        assert post_hooks._current_branch(repo) == platform
        assert (tmp_path / "repo" / "f.txt").read_text() == (
            "base\nedited on main, never committed\n"
        )

    def test_adopts_commits_the_agent_rewrote_on_its_own_branch(self, tmp_path):
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        # The agent branches off and amends its commit there. Now neither branch
        # contains the other: the platform branch has the first version, HEAD
        # the corrected one.
        self._git(repo, "checkout", "-qb", "agent-own-branch")
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change, corrected\n")
        self._git(repo, "commit", "-qa", "--amend", "-m", "agent work")
        corrected = self._head_sha(repo)

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        # HEAD holds work the platform branch lacks, so it is still adopted.
        assert moved is True
        assert self._sha_of(repo, platform) == corrected
        assert post_hooks._current_branch(repo) == platform

    def test_follows_a_head_that_contains_the_platform_branch(self, tmp_path):
        # Nothing was committed on the platform branch, and the session ended on
        # a main that had moved on, with an edit that was never committed. Moving
        # the platform branch to that HEAD drops nothing, so it is moved as
        # before: going back to its older tree is what git would refuse here.
        repo = self._make_repo(tmp_path)
        platform = "bgagent/task-1/fix"
        self._git(repo, "branch", platform)
        (tmp_path / "repo" / "f.txt").write_text("base\nmerged meanwhile\n")
        self._git(repo, "commit", "-qam", "merged meanwhile")
        self._origin_main_is(repo, "main")
        (tmp_path / "repo" / "f.txt").write_text("base\nmerged meanwhile\nnever committed\n")

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is True
        assert self._sha_of(repo, platform) == self._sha_of(repo, "main")
        assert post_hooks._current_branch(repo) == platform
        assert (tmp_path / "repo" / "f.txt").read_text().endswith("never committed\n")

    def test_adopts_commits_the_agent_pushed_from_its_own_branch(self, tmp_path):
        # What this hook was written for: the agent works on a branch of its
        # own, pushes it and opens its pull request from there. Its commits are
        # on origin by then, but not on origin's default branch.
        repo = self._make_repo(tmp_path)
        self._origin_main_is(repo, "main")
        platform = "bgagent/task-1/fix"
        self._git(repo, "checkout", "-qb", platform)
        self._git(repo, "checkout", "-qb", "agent-own-branch")
        (tmp_path / "repo" / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        self._git(repo, "update-ref", "refs/remotes/origin/agent-own-branch", "HEAD")
        agent_head = self._head_sha(repo)

        moved = post_hooks.reconcile_agent_branch(repo, platform)

        assert moved is True
        assert self._sha_of(repo, platform) == agent_head
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


class TestReconcilePrBase:
    """The agent picks its own PR --base; ensure_pr corrects it deterministically
    to setup.default_branch (the orchestrator's base for a stacked child / the
    detected repo default for a root). Observed in practice on an orchestrated
    chain (#247): a stacked child + a root both opened against a wrong 'main'."""

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


class TestIsVerifyCommandInert:
    """A command that ran and failed is not one that could not run, whatever
    words its log happens to contain. (The older tests of this function are in
    ``test_verify_commands.py``.)"""

    def test_mise_and_not_found_on_different_lines_is_a_failed_build(self):
        # mise names itself on one line; a failed test is titled "... not found"
        # on another. Nothing here says the command could not run.
        log = "mise ERROR task failed\n  ● returns 404 when the task is not found"
        assert post_hooks.is_verify_command_inert(1, log) is False

    def test_command_not_found_inside_a_failed_run_is_a_failed_build(self):
        # A step of the build could not find a tool and the build went on to
        # fail its tests: it ran. A command the shell cannot find exits 127.
        log = "FAIL a.test.ts\nbash: line 3: foo: command not found\n1 test failed"
        assert post_hooks.is_verify_command_inert(1, log) is False

    def test_a_mise_warning_above_a_failed_run_is_a_failed_build(self):
        # mise warns about a tool it does not know and runs the task all the
        # same (this is its line, with both words on it); the tests then fail.
        log = (
            "mise WARN  Failed to resolve tool version list for foo: "
            "[/repo/mise.toml] foo@1: foo not found in mise tool registry\n"
            "[build] $ jest\nFAIL a.test.ts\n[build] ERROR task failed"
        )
        assert post_hooks.is_verify_command_inert(1, log) is False

    def test_a_task_that_mise_cannot_find_is_inert(self):
        # What mise prints, with exit 1, when a task depends on one that does
        # not exist: its own error line.
        assert post_hooks.is_verify_command_inert(1, "mise ERROR task not found: compile") is True

    def test_a_task_missing_from_a_repository_that_has_other_tasks_is_inert(self):
        log = (
            "mise ERROR no task build found\n"
            "\n"
            "Available tasks:\n"
            "  Name  Description\n"
            "  test  \n"
            "mise ERROR Version: 2026.11.6 linux-arm64 (2026-11-10)\n"
            "mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information"
        )
        assert post_hooks.is_verify_command_inert(1, log) is True

    def test_a_missing_task_named_like_a_mise_command_is_inert(self):
        # In a repository without any mise task (#749). For `build`, mise says "no tasks defined".
        log = (
            "mise ERROR unknown command: lint\n"
            "\n"
            "Did you mean:\n"
            "  mise install-into\n"
            "  mise plugin-list\n"
            "mise ERROR Version: 2026.8.4 macos-arm64"
        )
        assert post_hooks.is_verify_command_inert(1, log) is True

    def test_the_words_of_a_missing_task_in_the_output_of_a_task_are_a_failed_build(self):
        for said in ('ERROR: unknown command "biuld"', "no task lint found"):
            log = f"[build] $ ./build.sh\n{said}\n[build] ERROR task failed"
            assert post_hooks.is_verify_command_inert(1, log) is False, said

    def test_a_task_file_that_mise_made_executable_and_ran_is_a_failed_build(self):
        # mise 2026.11.6 warns in the words of its error, sets the executable bit (the image
        # runs it with MISE_YES=1) and runs the task.
        log = (
            "mise WARN  no task build found, but a non-executable file exists at "
            "/repo/mise-tasks/build\n"
            "mise marked as executable\n"
            "[build] $ /repo/mise-tasks/build\n"
            "[build] ERROR task failed"
        )
        assert post_hooks.is_verify_command_inert(3, log) is False


class TestVerifyCommandThatCannotStart:
    """``verify_build`` when the command cannot even be started. (The older tests
    of ``verify_build`` are in ``test_verify_commands.py``.)"""

    def test_missing_program_is_an_inert_gate_not_a_crash(self, tmp_path):
        # No shell operator, so the command is exec'd directly (nothing is
        # faked here): a program that is not installed makes the exec itself
        # raise, where the same command inside `bash -lc` exits 127.
        outcome = post_hooks.verify_build(str(tmp_path), "abca-no-such-program build")

        assert outcome.passed is False
        assert outcome.inert is True

    def test_exec_that_fails_for_lack_of_memory_is_an_infrastructure_fault(self, monkeypatch):
        # The same error class as a missing program, but it says nothing about
        # the command: the host could not start a process at all.
        def out_of_memory(argv, **kw):
            raise OSError(12, "Cannot allocate memory")  # ENOMEM

        monkeypatch.setattr(post_hooks, "run_cmd", out_of_memory)

        outcome = post_hooks.verify_build("/repo", "npm run build")

        assert outcome.passed is False
        assert outcome.infra_failed is True
        assert outcome.inert is False
