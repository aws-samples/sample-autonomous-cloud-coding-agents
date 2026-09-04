"""Tests for the git-fixture isolation guard (#855).

The point of this file is that the guard is *proven live* rather than assumed. The
central test is differential: the **same** git command is run twice, once with an
inherited ``GIT_DIR`` and once through ``isolated_git_env``, and it is asserted to
escape in the first case and be contained in the second. A test that only checked the
contained case would still pass if ``isolated_git_env`` were quietly reduced to
``dict(os.environ)``.

Every repository these tests touch is built inside ``tmp_path``. Nothing here writes
to the real repository — the "leak" half of the differential test leaks into a
purpose-built fake shared repo.
"""

from __future__ import annotations

import os
import subprocess
from types import SimpleNamespace

import pytest

from tests.git_env import (
    GIT_LOCATION_VARS,
    TEST_IDENTITY_EMAIL,
    TEST_IDENTITY_NAME,
    fingerprint_git_config,
    isolated_git_env,
    shared_git_config_path,
)


def _git(repo, *args, env=None, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=check,
        env=env if env is not None else isolated_git_env(repo),
        timeout=60,
    )


def _config_get(config_path, key) -> str | None:
    """Read *key* from *config_path*, or None when absent."""
    result = subprocess.run(
        ["git", "config", "--file", str(config_path), "--get", key],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    return result.stdout.strip() if result.returncode == 0 else None


@pytest.fixture
def shared_repo(tmp_path):
    """A real repo with a real-looking identity, plus a linked worktree.

    Stands in for the developer's checkout. The linked worktree matters because that is
    the only configuration in which git exports ``GIT_DIR``/``GIT_COMMON_DIR`` to a
    hook — which is why this leak never reproduces from a normal checkout.
    """
    repo = tmp_path / "shared"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "--local", "user.name", "RealDev")
    _git(repo, "config", "--local", "user.email", "real@dev.example")
    _git(repo, "commit", "-q", "--allow-empty", "-m", "base")
    _git(repo, "worktree", "add", "-q", str(tmp_path / "wt"), "-b", "probe")
    return repo


class TestIsolatedGitEnv:
    def test_strips_every_location_var(self, tmp_path):
        base = dict.fromkeys(GIT_LOCATION_VARS, "/somewhere/else")
        env = isolated_git_env(tmp_path, base=base)
        assert not [var for var in GIT_LOCATION_VARS if var in env]

    def test_pins_config_resolution_and_identity(self, tmp_path):
        env = isolated_git_env(tmp_path, base={})
        assert env["HOME"] == str(tmp_path)
        assert env["GIT_CONFIG_GLOBAL"] == os.path.join(str(tmp_path), ".gitconfig-test")
        assert env["GIT_CONFIG_SYSTEM"] == os.devnull
        assert env["GIT_CONFIG_NOSYSTEM"] == "1"
        assert env["GIT_AUTHOR_EMAIL"] == TEST_IDENTITY_EMAIL
        assert env["GIT_COMMITTER_NAME"] == TEST_IDENTITY_NAME

    def test_an_inherited_git_dir_escapes_but_isolated_env_contains(self, tmp_path, shared_repo):
        """The differential test. Same command, two environments, opposite outcomes.

        Half A reproduces the bug against a fake shared repo: with ``GIT_DIR`` present,
        ``git -C <non-repo-dir> config user.name`` still finds the shared repository and
        writes there. Note what this defeats — ``-C`` pointing at a directory that is
        not a repository at all, plus ``HOME``/``XDG_CONFIG_HOME``/``GIT_CONFIG_GLOBAL``
        all pinned to a throwaway path. Repository *discovery* is what ``GIT_DIR``
        overrides, so none of those pins are consulted.

        Half B is the same write through ``isolated_git_env``, which lands in the
        sandbox's own config and leaves the shared repo byte-identical.
        """
        shared_config = shared_repo / ".git" / "config"
        before = shared_config.read_bytes()

        # --- Half A: the leak, witnessed ---
        escapes = tmp_path / "escapes"
        escapes.mkdir()
        leaky_env = isolated_git_env(escapes)
        leaky_env["GIT_DIR"] = str(shared_repo / ".git" / "worktrees" / "wt")
        leaky_env["GIT_COMMON_DIR"] = str(shared_repo / ".git")

        _git(escapes, "config", "user.name", "leaked", env=leaky_env)

        assert not (escapes / ".git").exists(), "the write should not have landed locally"
        assert _config_get(shared_config, "user.name") == "leaked", (
            "expected the inherited GIT_DIR to redirect this write into the shared "
            "config — if this assertion fails the mechanism has changed and the guard "
            "may no longer be guarding anything"
        )

        # Restore, so Half B starts from the original bytes.
        shared_config.write_bytes(before)

        # --- Half B: the same write, contained ---
        contained = tmp_path / "contained"
        contained.mkdir()
        _git(contained, "init", "-q")
        _git(contained, "config", "user.name", "contained")

        assert _config_get(contained / ".git" / "config", "user.name") == "contained"
        assert shared_config.read_bytes() == before, "shared config must be untouched"


class TestAutouseFixture:
    def test_ambient_location_vars_are_stripped(self):
        """``conftest._isolate_git_location`` has already run for this test.

        Asserted on ``os.environ`` rather than on a passed-in env because the risk is a
        fixture that shells out with the *inherited* environment.
        """
        assert not [var for var in GIT_LOCATION_VARS if var in os.environ]

    def test_ambient_config_resolution_is_pinned(self):
        assert os.environ["GIT_CONFIG_SYSTEM"] == os.devnull
        assert os.environ["GIT_CONFIG_NOSYSTEM"] == "1"
        assert os.environ["GIT_AUTHOR_EMAIL"] == TEST_IDENTITY_EMAIL
        # Pinned to a per-test tmp path, so a bare `git config user.email` cannot reach
        # the developer's ~/.gitconfig even from a fixture that forgot isolated_git_env.
        assert os.environ["GIT_CONFIG_GLOBAL"].endswith(".gitconfig-test")
        assert os.path.expanduser("~") not in (os.environ["GIT_CONFIG_GLOBAL"],)


class TestSharedConfigResolution:
    def test_resolves_through_git_common_dir_not_show_toplevel(self, tmp_path, monkeypatch):
        """``core.worktree`` must not be able to disable the detector.

        This is the failure the resolution choice exists to avoid: ``core.worktree``
        redirects ``--show-toplevel``, so a detector built on it computes a path that
        does not exist in a polluted repo and reports "nothing to protect" — the
        pollution switching off its own alarm. ``--git-common-dir`` is answered from the
        gitdir alone.
        """
        repo = tmp_path / "polluted"
        repo.mkdir()
        _git(repo, "init", "-q")
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        _git(repo, "config", "--local", "core.worktree", str(elsewhere))

        monkeypatch.chdir(repo)

        # The rejected approach: redirected away from the real repo.
        toplevel = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        assert toplevel.stdout.strip() != str(repo)

        # The chosen approach: still the real shared config.
        assert shared_git_config_path() == str(repo / ".git" / "config")

    def test_returns_none_outside_a_repository(self, tmp_path, monkeypatch):
        outside = tmp_path / "not-a-repo"
        outside.mkdir()
        monkeypatch.chdir(outside)
        # GIT_CEILING_DIRECTORIES stops discovery from walking up into whatever
        # repository happens to contain tmp_path on this machine.
        monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
        assert shared_git_config_path() is None


class TestFingerprint:
    @staticmethod
    def _fingerprint(config) -> tuple[str, frozenset[str]]:
        """``fingerprint_git_config`` narrowed to non-None.

        It returns ``None`` for an unreadable path — a real case, covered by its own
        test below — so unpacking the result directly is a type error (ty
        ``not-iterable``). Asserting here keeps that contract visible instead of
        annotating it away, and a None would fail the assertion rather than raise an
        opaque unpacking error further down.
        """
        result = fingerprint_git_config(str(config))
        assert result is not None, f"expected {config} to be readable"
        return result

    def test_detects_an_added_key_and_names_it(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        config = repo / ".git" / "config"

        digest_before, names_before = self._fingerprint(config)
        _git(repo, "config", "--local", "core.worktree", str(tmp_path))
        digest_after, names_after = self._fingerprint(config)

        assert digest_after != digest_before
        assert names_after - names_before == {"core.worktree"}

    def test_detects_a_value_change_without_capturing_the_value(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        config = repo / ".git" / "config"
        # A remote URL with a userinfo segment: the realistic reason `.git/config`
        # must never be echoed. Synthetic — reserved domain (RFC 2606), and the
        # userinfo is the literal word `placeholder`. Named for what it is (a URL)
        # rather than `secret`, which made ruff S105 read it as a hardcoded
        # credential; nothing here is one.
        url_with_credential = "https://user:placeholder@example.invalid/repo.git"
        _git(repo, "config", "--local", "remote.origin.url", "https://example.invalid/a.git")

        digest_before, names_before = self._fingerprint(config)
        _git(repo, "config", "--local", "remote.origin.url", url_with_credential)
        digest_after, names_after = self._fingerprint(config)

        assert digest_after != digest_before, "a value-only change must still be detected"
        assert names_after == names_before, "no key was added, so the name set is stable"
        # The reason names-not-values: this data is printed into CI logs on failure.
        assert url_with_credential not in str(names_after)

    def test_returns_none_for_an_unreadable_path(self, tmp_path):
        assert fingerprint_git_config(str(tmp_path / "nope" / "config")) is None


class TestMutationReport:
    """The session-level detector's decision logic (``conftest``, Layer 2).

    Unit-tested here because the hook itself cannot be exercised from inside the
    session it guards: no test can observe a mutation made by a test that runs after
    it, which is precisely why the check lives in ``pytest_sessionfinish``.
    """

    @staticmethod
    def _repo_with_config(tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        return repo, repo / ".git" / "config"

    def _run_report(self, monkeypatch, config, fingerprint):
        from tests import conftest

        monkeypatch.setattr(conftest, "_SHARED_GIT_CONFIG", (str(config), fingerprint))
        session = SimpleNamespace(exitstatus=pytest.ExitCode.OK)
        conftest._report_shared_git_config_mutation(session)
        return session

    def test_fails_the_session_when_the_config_changed(self, tmp_path, monkeypatch, capsys):
        repo, config = self._repo_with_config(tmp_path)
        fingerprint = fingerprint_git_config(str(config))

        _git(repo, "config", "--local", "user.email", "t@t")
        session = self._run_report(monkeypatch, config, fingerprint)

        assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
        message = capsys.readouterr().err
        assert "SHARED GIT CONFIG MUTATED" in message
        # The remedy must be copy-pasteable, not a description of one.
        assert f"git config --file {config} --remove-section user" in message
        assert "user.email" in message

    def test_leaves_a_clean_session_alone(self, tmp_path, monkeypatch):
        _repo, config = self._repo_with_config(tmp_path)
        fingerprint = fingerprint_git_config(str(config))

        session = self._run_report(monkeypatch, config, fingerprint)

        assert session.exitstatus == pytest.ExitCode.OK

    def test_is_inert_when_there_was_nothing_to_protect(self, monkeypatch):
        """No repository (e.g. running inside the built container image) must not fail
        the suite — that is a genuine no-risk case, not a failure to look."""
        from tests import conftest

        monkeypatch.setattr(conftest, "_SHARED_GIT_CONFIG", None)
        session = SimpleNamespace(exitstatus=pytest.ExitCode.OK)
        conftest._report_shared_git_config_mutation(session)
        assert session.exitstatus == pytest.ExitCode.OK

    def test_reports_a_config_that_vanished(self, tmp_path, monkeypatch, capsys):
        _repo, config = self._repo_with_config(tmp_path)
        fingerprint = fingerprint_git_config(str(config))
        config.unlink()

        session = self._run_report(monkeypatch, config, fingerprint)

        assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
        assert "unreadable or gone" in capsys.readouterr().err
