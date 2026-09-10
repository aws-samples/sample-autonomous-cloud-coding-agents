"""Tests for the git-fixture isolation guard (#855).

The point of this file is that the guard is *proven live* rather than assumed, and the
honest accounting of which test proves what — corrected after a review measured the
earlier version of this paragraph and found it overclaiming — is:

* **A gutted helper** (``isolated_git_env`` quietly reduced to ``dict(os.environ)``) is
  caught by ``TestIsolatedGitEnv.test_strips_every_location_var`` /
  ``test_pins_config_resolution_and_identity``, which pass an explicit ``base=`` and so
  do not depend on the ambient environment, and by
  ``TestAutouseFixture.test_the_strip_has_teeth_out_of_process``, which is the only test
  that exercises the strip on the real ``os.environ`` path.
* **The git mechanism still behaving as documented** — that an inherited ``GIT_DIR``
  really does redirect a write into another repository, which is the premise the whole
  guard rests on — is what the differential test proves. It is *not* what catches a
  gutted helper: half A leaks because the test sets ``GIT_DIR`` itself, and half B is
  contained by the autouse fixture rather than by the function under test.
* **The detector being armed** is ``TestLayer2IsArmed``; **the pre-push gate's rules**
  are in ``cdk/test/scripts/check-git-config-clean.test.ts``.

Every repository these tests touch is built inside ``tmp_path``. Nothing here writes
to the real repository — the "leak" half of the differential test leaks into a
purpose-built fake shared repo.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.git_env import (
    GIT_LOCATION_VARS,
    SIGNATURE_KEYS,
    TEST_IDENTITY_EMAIL,
    TEST_IDENTITY_NAME,
    GitConfigFingerprint,
    GitConfigLookupError,
    find_git_dir,
    fingerprint_git_config,
    isolated_git_env,
    shared_git_config_path,
    signature_keys_changed,
)

# Set in the environment of the nested pytest run spawned by
# ``test_the_strip_has_teeth_out_of_process``. Belt-and-braces against a future edit
# broadening that run's node id into something that re-collects the spawning test and
# forks forever.
_NESTED_RUN_MARKER = "ABCA_855_NESTED_PYTEST"


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

    def test_pins_the_discovery_ceiling_at_the_parent_not_the_repo(self, tmp_path):
        """The ceiling is SET, not stripped — and set one level out.

        Both halves matter. Stripping it would widen discovery (see the note on
        ``GIT_LOCATION_VARS``), and pinning it at *repo* itself would make *repo*
        undiscoverable, so ``git -C repo status`` in a caller's fixture would start
        failing. The parent is the only value that fences the walk without breaking the
        sandbox it is fencing.
        """
        repo = tmp_path / "sandbox"
        env = isolated_git_env(repo, base={})

        assert env["GIT_CEILING_DIRECTORIES"] == str(tmp_path)
        assert env["GIT_CEILING_DIRECTORIES"] != str(repo)

    def test_the_ceiling_actually_stops_a_write_from_escaping_upward(self, tmp_path):
        """The ``-C <not-a-repo>`` route, which stripping ``GIT_DIR`` does not close.

        Measured on git 2.50.1 before this pin existed: from a non-repository directory
        inside a repository, a bare ``git config user.email t@t`` walks UP and writes the
        *parent's* config, rc 0 — the #855 leak with no ``GIT_DIR`` anywhere. It matters
        because ``TMPDIR`` sits inside a checkout on some dev machines, so whether a
        fixture leaked depended on the host.
        """
        outer = tmp_path / "outer"
        (outer / "sub").mkdir(parents=True)
        _git(outer, "init", "-q")
        outer_config = outer / ".git" / "config"
        before = outer_config.read_bytes()

        result = _git(outer / "sub", "config", "user.email", "t@t", check=False)

        assert result.returncode != 0, (
            "a write from a non-repository directory reached a repository above it — "
            f"the GIT_CEILING_DIRECTORIES pin is not holding (stdout={result.stdout!r})"
        )
        assert "not in a git directory" in result.stderr
        assert outer_config.read_bytes() == before

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

        WHAT THIS DOES AND DOES NOT PROVE, because the first version of this docstring
        claimed the wrong thing and the claim was cited as the reason the suite could not
        be gutted. What it proves is that the *mechanism* still works as documented: an
        inherited ``GIT_DIR`` really does redirect a write into another repository, which
        is the premise every layer of this guard is built on, and which git could in
        principle change. What it does NOT prove is that ``isolated_git_env`` is doing
        anything: half A leaks because *this test* sets ``GIT_DIR`` on the env it passes,
        and half B would still be contained if the helper returned a bare
        ``dict(os.environ)``, because ``conftest._isolate_git_location`` has already
        stripped and pinned that environment. The tests that fail on a gutted helper are
        ``test_strips_every_location_var`` / ``test_pins_config_resolution_and_identity``
        (explicit ``base=``, so no fixture underneath them) and
        ``TestAutouseFixture.test_the_strip_has_teeth_out_of_process``.
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

        NOTE this passes vacuously wherever the suite normally runs, because those vars
        are absent from the parent environment to begin with — it only has teeth in the
        environment git gives a hook in a linked worktree. It doubles as the *inner* test
        of ``test_the_strip_has_teeth_out_of_process`` below, which supplies exactly that
        environment; do not rename it without updating the node id there.
        """
        assert not [var for var in GIT_LOCATION_VARS if var in os.environ]

    def test_ambient_config_resolution_is_pinned(self):
        assert os.environ["GIT_CONFIG_SYSTEM"] == os.devnull
        assert os.environ["GIT_CONFIG_NOSYSTEM"] == "1"
        assert os.environ["GIT_AUTHOR_EMAIL"] == TEST_IDENTITY_EMAIL
        # Pinned to a per-test tmp path, so a bare `git config user.email` cannot reach
        # the developer's ~/.gitconfig even from a fixture that forgot isolated_git_env.
        assert os.environ["GIT_CONFIG_GLOBAL"].endswith(".gitconfig-test")
        # Inequality against the real path, not a "not under $HOME" containment check:
        # TMPDIR is itself under $HOME on this repo's dev hosts (~/.cache/...), so a
        # containment form would fail on a correctly pinned value.
        assert os.environ["GIT_CONFIG_GLOBAL"] != os.path.expanduser("~/.gitconfig")

    def test_the_process_is_moved_out_of_the_checkout(self, tmp_path):
        """Job 3 of the fixture, asserted: cwd is a throwaway and the walk is fenced.

        Stripping ``GIT_DIR`` closes the redirect route and leaves repository DISCOVERY
        wide open, and pytest is invoked from ``agent/`` — inside the checkout. So the
        author this fixture exists to protect, the one who forgot ``isolated_git_env``,
        could still write the shared config with no ``-C``, no ``cwd=`` and no ``GIT_DIR``
        involved at all.
        """
        assert Path.cwd() == tmp_path
        assert os.environ["GIT_CEILING_DIRECTORIES"] == os.path.realpath(tmp_path.parent)

        # No cwd=, no -C, no isolated env: the shape of the mistake being guarded.
        result = subprocess.run(
            ["git", "config", "user.email", "t@t"],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

        assert result.returncode != 0, (
            "a bare `git config` from a test found a repository to write to — either cwd "
            "is back inside the checkout or the discovery ceiling is gone"
        )
        assert "not in a git directory" in result.stderr

    def test_the_strip_has_teeth_out_of_process(self, tmp_path):
        """The only test that proves the strip RUNS, rather than assuming it.

        ``test_ambient_location_vars_are_stripped`` cannot: an autouse fixture has already
        run by the time any test body starts, so nothing in-process can put a ``GIT_DIR``
        in place for it to remove — and with the vars absent from the parent environment
        (their normal state outside a hook), deleting the strip loop from ``conftest``
        leaves that test green. Proving it therefore needs an out-of-process run with the
        hook environment set, and the inner run's own assertion as the verdict.
        """
        if _NESTED_RUN_MARKER in os.environ:
            pytest.skip("already inside the nested run — do not recurse")

        # A REAL repository, not a decoy path. Layer 2 resolves the shared config from
        # GIT_DIR at session start and reports "could not check" as a session FAILURE, so
        # a nonexistent GIT_DIR would fail the inner run for a reason unrelated to the
        # strip — and the failure would read as a pass of this test.
        decoy = tmp_path / "decoy"
        decoy.mkdir()
        _git(decoy, "init", "-q")

        # Anti-vacuity for the nested run itself: record what git vars were actually in
        # its environment at session start, before any fixture could touch them.
        witness = tmp_path / "ambient-at-sessionstart.txt"
        plugin = tmp_path / "probe_ambient.py"
        plugin.write_text(
            "import os, pathlib\n"
            "def pytest_sessionstart(session):\n"
            f"    pathlib.Path({str(witness)!r}).write_text(\n"
            '        "|".join(k for k in sorted(os.environ) if k.startswith("GIT_")))\n',
            encoding="utf-8",
        )

        child = {k: v for k, v in os.environ.items() if k != "GIT_CEILING_DIRECTORIES"}
        child.update(
            {
                _NESTED_RUN_MARKER: "1",
                "PYTHONPATH": os.pathsep.join(
                    part for part in (str(tmp_path), os.environ.get("PYTHONPATH", "")) if part
                ),
                # Exactly what git exports to a hook in a linked worktree — four of the
                # seven, so the strip has real work to do.
                "GIT_DIR": str(decoy / ".git"),
                "GIT_COMMON_DIR": str(decoy / ".git"),
                "GIT_WORK_TREE": str(decoy),
                "GIT_INDEX_FILE": str(decoy / ".git" / "index"),
            }
        )

        inner = (
            f"{Path(__file__).resolve()}"
            "::TestAutouseFixture::test_ambient_location_vars_are_stripped"
        )
        result = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "probe_ambient", inner],
            cwd=str(Path(__file__).resolve().parents[1]),
            env=child,
            capture_output=True,
            text=True,
            check=False,
            timeout=90,
        )

        observed = witness.read_text(encoding="utf-8") if witness.exists() else "<not written>"
        assert "GIT_DIR" in observed, (
            "the nested session did not start with an ambient GIT_DIR, so whatever it "
            f"reported says nothing about the strip. Saw: {observed!r}\n"
            f"{result.stdout[-2000:]}"
        )
        assert result.returncode == 0, (
            "the autouse fixture failed to strip the repo-location vars git exports to "
            f"hooks — this is the #855 leak, live.\n{result.stdout[-4000:]}\n"
            f"{result.stderr[-2000:]}"
        )
        assert "1 passed" in result.stdout, (
            f"expected the inner run to execute exactly one test:\n{result.stdout[-2000:]}"
        )


class TestCrossCopyParity:
    """``GIT_LOCATION_VARS`` exists three times; nothing enforced that they agreed.

    Python (here), the pre-push gate (``scripts/check-git-config-clean.mjs``) and that
    gate's own suite (``cdk/test/scripts/check-git-config-clean.test.ts``) each carry a
    copy, and they had in fact drifted — the review that prompted this test found 8/7/8
    entries across the three. Sibling of ``test_signature_keys_match_the_layer_3_gate``,
    which does the same job for ``SIGNATURE_KEYS``.
    """

    MIRRORS = (
        ("scripts", "check-git-config-clean.mjs"),
        ("cdk", "test", "scripts", "check-git-config-clean.test.ts"),
    )

    @pytest.mark.parametrize("parts", MIRRORS, ids=lambda parts: parts[-1])
    def test_the_mirrors_list_the_same_vars(self, parts):
        mirror = Path(__file__).resolve().parents[2].joinpath(*parts)
        if not mirror.is_file():
            # Only `agent/` is bundled into the container image.
            pytest.skip(f"{mirror} not present in this tree")

        text = mirror.read_text(encoding="utf-8")
        block = re.search(r"GIT_LOCATION_VARS\s*=\s*\[(.*?)\]", text, re.DOTALL)
        assert block is not None, f"no GIT_LOCATION_VARS array found in {mirror}"
        mirrored = set(re.findall(r"'(GIT_[A-Z_]+)'", block.group(1)))

        assert mirrored == set(GIT_LOCATION_VARS), (
            f"{mirror} lists a different set of repo-location vars than "
            "agent/tests/git_env.py. Note GIT_CEILING_DIRECTORIES must NOT be in any of "
            "them — it is pinned, not stripped, because deleting it WIDENS discovery."
        )

    @pytest.mark.parametrize("parts", MIRRORS, ids=lambda parts: parts[-1])
    def test_no_mirror_strips_the_discovery_ceiling(self, parts):
        """The specific drift that motivated this: the fence in the strip list.

        Checked separately from set equality because this is the failure with teeth —
        equality would also flag a harmless reordering, and a reader hitting a red needs
        to know which of the two happened.
        """
        mirror = Path(__file__).resolve().parents[2].joinpath(*parts)
        if not mirror.is_file():
            pytest.skip(f"{mirror} not present in this tree")

        text = mirror.read_text(encoding="utf-8")
        block = re.search(r"GIT_LOCATION_VARS\s*=\s*\[(.*?)\]", text, re.DOTALL)
        assert block is not None, f"no GIT_LOCATION_VARS array found in {mirror}"

        assert "GIT_CEILING_DIRECTORIES" not in block.group(1), (
            f"{mirror} deletes GIT_CEILING_DIRECTORIES along with the redirect vars. That "
            "removes git's own fence: the walk can then climb out of wherever it started "
            "and find a repository above it."
        )
        assert "GIT_CEILING_DIRECTORIES" in text, (
            f"{mirror} neither strips nor sets GIT_CEILING_DIRECTORIES, so its discovery "
            "walk is unfenced — see git_env._ceiling_directories for the measured escape."
        )


class TestSharedConfigResolution:
    """Resolution must survive a repository too broken for git to describe.

    These tests pick the corruption shape adversarially. An earlier version of this class
    set ``core.worktree`` to a directory that EXISTS — which is the one polluted shape
    where ``git rev-parse --git-common-dir`` still succeeds — so it confirmed the design
    against the benign look-alike and never exercised the case the guard is for.
    """

    @staticmethod
    def _write_config(repo, section, lines) -> None:
        """Append a config section by hand.

        Not ``git config``: once ``core.worktree`` names a missing path, git refuses to
        operate in that repository at all — including refusing to write or unset the very
        key that broke it.
        """
        config = repo / ".git" / "config"
        body = "".join(f"\t{line}\n" for line in lines)
        with config.open("a", encoding="utf-8") as handle:
            handle.write(f"[{section}]\n{body}")

    def test_resolves_when_rev_parse_cannot_answer_at_all(self, tmp_path, monkeypatch):
        """The differential test for resolution, on the shape that actually bites.

        A deleted pytest ``tmp_path`` leaves ``core.worktree`` naming an absolute path
        with two or more missing components, and in that state EVERY ``git rev-parse``
        form aborts rc 128 ``fatal: Invalid path`` — including ``--git-common-dir``, which
        this function used to be built on and which therefore reported "nothing to
        protect" exactly when there was something to protect.
        """
        repo = tmp_path / "polluted"
        repo.mkdir()
        _git(repo, "init", "-q")
        self._write_config(repo, "core", [f"worktree = {tmp_path / 'gone' / 'deeper' / 'tmp'}"])

        monkeypatch.chdir(repo)

        # The rejected approaches, asserted to be unusable rather than assumed to be.
        for form in (["--show-toplevel"], ["--path-format=absolute", "--git-common-dir"]):
            probe = subprocess.run(
                ["git", "rev-parse", *form],
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )
            assert probe.returncode != 0, (
                f"`git rev-parse {' '.join(form)}` unexpectedly succeeded on a repo with a "
                "missing core.worktree — if this now works, re-check whether the "
                "filesystem walk is still needed"
            )

        # The chosen approach: reads no config, so it still answers.
        assert shared_git_config_path() == str(repo / ".git" / "config")

    def test_resolves_when_core_worktree_redirects_to_a_real_directory(self, tmp_path, monkeypatch):
        """The other shape: ``core.worktree`` names a directory that exists.

        Here git answers happily and *wrongly* — ``--show-toplevel`` reports the redirect
        target. This is the shape seen in the real recurrences (it points at a sibling
        worktree), and the dangerous one, because nothing else in the tree complains.
        """
        repo = tmp_path / "redirected"
        repo.mkdir()
        _git(repo, "init", "-q")
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        _git(repo, "config", "--local", "core.worktree", str(elsewhere))

        monkeypatch.chdir(repo)

        toplevel = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        assert toplevel.stdout.strip() == str(elsewhere), "expected git to be redirected"

        assert shared_git_config_path() == str(repo / ".git" / "config")

    def test_resolves_to_the_SHARED_config_from_a_linked_worktree(self, shared_repo, monkeypatch):
        """A linked worktree's own gitdir is not the file at risk; the shared one is.

        Resolution has to follow the ``commondir`` pointer, or the guard would fingerprint
        a per-worktree config that no leak ever touches — protection that looks present and
        is not. This is also the only configuration in which git exports ``GIT_DIR`` to
        hooks, i.e. the only one in which the leak happens at all, so it is the shape the
        guard runs in for real.
        """
        worktree_gitdir = shared_repo / ".git" / "worktrees" / "wt"
        assert (worktree_gitdir / "commondir").is_file(), "expected a commondir pointer"

        # GIT_DIR honoured exactly as git's own hooks receive it.
        monkeypatch.setenv("GIT_DIR", str(worktree_gitdir))
        assert shared_git_config_path() == str(shared_repo / ".git" / "config")

    def test_returns_none_outside_a_repository(self, tmp_path, monkeypatch):
        outside = tmp_path / "not-a-repo"
        outside.mkdir()
        monkeypatch.chdir(outside)
        # GIT_CEILING_DIRECTORIES stops the walk from climbing into whatever repository
        # happens to contain tmp_path on this machine. Honoured by `find_git_dir` for the
        # same reason git honours it.
        monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
        assert shared_git_config_path() is None

    def test_raises_rather_than_reporting_nothing_when_the_config_is_missing(
        self, tmp_path, monkeypatch
    ):
        """A repo whose config vanished is a failure to look, not a no-risk pass.

        The two must not collapse into ``None``: ``None`` makes the session hook return
        silently, which is how the detector previously switched itself off.
        """
        repo = tmp_path / "no-config"
        repo.mkdir()
        _git(repo, "init", "-q")
        (repo / ".git" / "config").unlink()
        monkeypatch.chdir(repo)

        with pytest.raises(GitConfigLookupError, match="does not exist"):
            shared_git_config_path()


class TestFingerprint:
    """Whole-file detection, signature-scoped judgement.

    The split is the design: ``digest``/``names`` notice ANY write however it arrived
    (mechanism-independence is what four file-scoped fixes lacked), while ``signature``
    decides what is worth failing a suite over. Both halves are tested here, including
    the case that motivated the split — routine ``remote.*`` churn.
    """

    @staticmethod
    def _fingerprint(config) -> GitConfigFingerprint:
        """``fingerprint_git_config`` narrowed to non-None.

        It returns ``None`` for an unreadable path — a real case, covered by its own
        test below — so using the result directly is a type error (ty
        ``possibly-unbound-attribute``). Asserting here keeps that contract visible
        instead of annotating it away, and a None fails with a readable message rather
        than an opaque ``AttributeError`` further down.
        """
        result = fingerprint_git_config(str(config))
        assert result is not None, f"expected {config} to be readable"
        return result

    def test_detects_an_added_key_and_names_it(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        config = repo / ".git" / "config"

        before = self._fingerprint(config)
        _git(repo, "config", "--local", "core.worktree", str(tmp_path))
        after = self._fingerprint(config)

        assert after.digest != before.digest
        assert after.names - before.names == {"core.worktree"}

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

        before = self._fingerprint(config)
        _git(repo, "config", "--local", "remote.origin.url", url_with_credential)
        after = self._fingerprint(config)

        assert after.digest != before.digest, "a value-only change must still be detected"
        assert after.names == before.names, "no key was added, so the name set is stable"
        # The reason names-not-values: this data is printed into CI logs on failure.
        assert url_with_credential not in str(after.names)
        assert url_with_credential not in str(after.signature)

    def test_routine_remote_churn_is_seen_but_is_not_a_signature_change(self, tmp_path):
        """The false positive the signature scoping exists to prevent.

        ``git fetch`` rewrites ``remote.*`` and ``push -u`` adds ``branch.<name>.remote``,
        and this suite runs as a pre-push hook while other worktrees may be active. Under
        a whole-file verdict that churn reds the suite with no fixture to blame and no
        remedy to offer — and a gate people learn to re-run past has stopped being a gate.
        """
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        config = repo / ".git" / "config"

        before = self._fingerprint(config)
        _git(repo, "config", "--local", "branch.main.remote", "origin")
        after = self._fingerprint(config)

        assert after.digest != before.digest, "the write must still be DETECTED"
        assert signature_keys_changed(before, after) == [], "but it must not be JUDGED a leak"

    @pytest.mark.parametrize(
        ("key", "value"),
        [
            ("core.worktree", "/somewhere/else"),
            ("core.bare", "true"),
            ("user.name", "t"),
            ("user.email", "t@t"),
        ],
    )
    def test_every_signature_key_is_reported_when_it_changes(self, tmp_path, key, value):
        """Parametrised over the whole tuple so adding a key without wiring it is caught.

        ``core.bare`` in particular is written by git as a bare ``bare`` under
        ``[core]`` — a valueless key in ``--list -z`` output — so it is the one most likely
        to be silently dropped by a parser change.
        """
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        config = repo / ".git" / "config"

        before = self._fingerprint(config)
        _git(repo, "config", "--local", key, value)
        after = self._fingerprint(config)

        assert signature_keys_changed(before, after) == [key]

    def test_a_signature_key_being_REMOVED_is_a_change(self, tmp_path):
        """Direction matters: the leak also manifests as an identity being replaced.

        A comparison that only looked at the *after* side's keys would miss a removal, and
        ``user.email`` disappearing is how a developer's configured identity gets lost.
        """
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        config = repo / ".git" / "config"
        _git(repo, "config", "--local", "user.email", "real@dev.example")

        before = self._fingerprint(config)
        _git(repo, "config", "--local", "--unset", "user.email")
        after = self._fingerprint(config)

        assert signature_keys_changed(before, after) == ["user.email"]

    def test_signature_keys_match_the_layer_3_gate(self):
        """Cross-layer drift guard for a claim that is otherwise only a comment.

        ``git_env.SIGNATURE_KEYS`` documents itself as kept in step with
        ``scripts/check-git-config-clean.mjs``. Nothing enforced that, and an unenforced
        parity claim is the kind that quietly stops being true — a key added to one layer
        only would mean pre-push refuses a state the suite ignores, or the reverse.
        """
        gate = Path(__file__).resolve().parents[2] / "scripts" / "check-git-config-clean.mjs"
        if not gate.is_file():
            # `scripts/` is not bundled into the agent container image; only `agent/` is.
            pytest.skip(f"{gate} not present in this tree")

        quoted = set(re.findall(r"'((?:core|user)\.[A-Za-z]+)'", gate.read_text(encoding="utf-8")))
        assert quoted == set(SIGNATURE_KEYS), (
            "Layer 2 (this suite) and Layer 3 (the pre-push gate) disagree about which keys "
            "are the #855 signature. Update both, or the layers protect different things."
        )

    def test_returns_none_for_an_unreadable_path(self, tmp_path):
        assert fingerprint_git_config(str(tmp_path / "nope" / "config")) is None


class TestLayer2IsArmed:
    """Is the detector actually watching THIS run, or silently disarmed?

    ``TestMutationReport`` below exercises the report's decision logic by injecting
    fingerprints, which is the right way to test the branches but says nothing about
    whether ``pytest_sessionstart`` captured anything in the first place. It has three
    early ``return`` paths, and two of them — ``path is None`` ("nothing to protect") and
    a ``GitConfigLookupError`` — turn the whole layer off for the session while leaving
    every test in this file green. That is a failure mode with no symptom: the suite would
    report a clean bill of health on a leak it never looked for.

    So this asserts on the module-level state left behind by the real session start.
    """

    def test_the_session_hook_captured_a_fingerprint_when_run_in_a_checkout(self):
        from tests import conftest

        # Anchored at this file, NOT cwd: the autouse fixture has moved the process to a
        # tmp_path fenced by GIT_CEILING_DIRECTORIES, so a cwd-relative lookup correctly
        # finds nothing and would make this test vacuous.
        if find_git_dir(str(Path(__file__).resolve().parent)) is None:
            # The genuine no-risk case: no `.git` above the tests, e.g. the agent
            # container image, where `agent/` is copied in without the repository.
            pytest.skip("not running inside a git checkout — there is nothing to protect")

        assert conftest._SHARED_GIT_CONFIG_UNCHECKED is None, (
            "Layer 2 found a repository but could not fingerprint its shared config, so "
            "this whole run proves nothing about whether a fixture leaked into it: "
            f"{conftest._SHARED_GIT_CONFIG_UNCHECKED}"
        )
        assert conftest._SHARED_GIT_CONFIG is not None, (
            "Layer 2 is DISARMED for this session: pytest_sessionstart took an early "
            "return even though there is a checkout above these tests, so the "
            "before/after comparison at session finish will compare nothing."
        )

        path, fingerprint = conftest._SHARED_GIT_CONFIG
        assert os.path.isfile(path), f"{path} was fingerprinted but is not a file"
        # A fingerprint of an empty/unparsed file would still be a truthy tuple, so check
        # the digest is a real sha256 rather than merely present.
        assert len(fingerprint.digest) == 64


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

    def _run_report(self, monkeypatch, config, fingerprint, *, unchecked=None):
        from tests import conftest

        monkeypatch.setattr(conftest, "_SHARED_GIT_CONFIG", (str(config), fingerprint))
        monkeypatch.setattr(conftest, "_SHARED_GIT_CONFIG_UNCHECKED", unchecked)
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
        monkeypatch.setattr(conftest, "_SHARED_GIT_CONFIG_UNCHECKED", None)
        session = SimpleNamespace(exitstatus=pytest.ExitCode.OK)
        conftest._report_shared_git_config_mutation(session)
        assert session.exitstatus == pytest.ExitCode.OK

    def test_FAILS_when_the_config_could_not_be_checked_at_all(self, monkeypatch, capsys):
        """The counterpart to the test above, and the distinction the whole guard rests on.

        "Nothing to protect" is a pass; "could not look at the thing I am protecting" is a
        failure. Collapsing the two into a silent ``return`` is what let a repository too
        broken for ``git rev-parse`` to describe — the exact state this guard exists for —
        switch the guard off and report success.
        """
        from tests import conftest

        monkeypatch.setattr(conftest, "_SHARED_GIT_CONFIG", None)
        monkeypatch.setattr(
            conftest, "_SHARED_GIT_CONFIG_UNCHECKED", "/x/.git/config does not exist"
        )
        session = SimpleNamespace(exitstatus=pytest.ExitCode.OK)
        conftest._report_shared_git_config_mutation(session)

        assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
        message = capsys.readouterr().err
        assert "COULD NOT CHECK" in message
        assert "/x/.git/config does not exist" in message
        # Must point at the tool that can diagnose it, not just complain.
        assert "mise run check:git-config-clean" in message

    def test_does_not_fail_the_session_on_non_signature_drift(self, tmp_path, monkeypatch, capsys):
        """Detected, reported, not fatal — the middle verdict.

        ``branch.main.remote`` is what ``git push -u`` writes, from another worktree, while
        this suite is running as a pre-push hook. Failing on it produces a red naming no
        fixture and offering no remedy.
        """
        repo, config = self._repo_with_config(tmp_path)
        fingerprint = fingerprint_git_config(str(config))

        _git(repo, "config", "--local", "branch.main.remote", "origin")
        session = self._run_report(monkeypatch, config, fingerprint)

        assert session.exitstatus == pytest.ExitCode.OK
        message = capsys.readouterr().err
        assert "no #855 signature key did" in message
        assert "branch.main.remote" in message
        assert "SHARED GIT CONFIG MUTATED" not in message

    def test_names_the_signature_key_that_moved(self, tmp_path, monkeypatch, capsys):
        """The failure has to say WHICH key, or the remedy is guesswork."""
        repo, config = self._repo_with_config(tmp_path)
        fingerprint = fingerprint_git_config(str(config))

        _git(repo, "config", "--local", "core.worktree", str(tmp_path))
        session = self._run_report(monkeypatch, config, fingerprint)

        assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
        message = capsys.readouterr().err
        assert "signature key(s) changed: core.worktree" in message
        assert f"git config --file {config} --unset-all core.worktree" in message

    def test_reports_a_config_that_vanished(self, tmp_path, monkeypatch, capsys):
        _repo, config = self._repo_with_config(tmp_path)
        fingerprint = fingerprint_git_config(str(config))
        config.unlink()

        session = self._run_report(monkeypatch, config, fingerprint)

        assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
        assert "unreadable, gone, or no longer parses" in capsys.readouterr().err
