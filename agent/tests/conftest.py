"""Shared fixtures for agent unit tests."""

import faulthandler
import os
import sys
import threading
from types import SimpleNamespace

import pytest

from models import TaskConfig
from tests.git_env import (
    GIT_LOCATION_VARS,
    TEST_IDENTITY_EMAIL,
    TEST_IDENTITY_NAME,
    GitConfigFingerprint,
    GitConfigLookupError,
    fingerprint_git_config,
    shared_git_config_path,
    signature_keys_changed,
)

# Session-wide hang backstop. SIGALRM (pytest-timeout method="signal") fires only
# in the MAIN thread during a test's *call* phase, so a deadlock in a WORKER
# thread, a fixture, collection, or a C-level socket read the main thread never
# returns from stalls the whole `mise run build` silently — up to the platform's
# 3600s build-verify ceiling (the ECS-only stall we chased for weeks, and the
# scoped-session S3 hang the _clean_env reset below guards against: 40+ min of
# dead air, container never reaped).
#
# The obvious instrument — ``faulthandler.dump_traceback_later(1200, exit=True)``
# — does NOT work here: faulthandler has a SINGLE internal timer, and pytest's
# ``faulthandler_timeout`` (pyproject.toml) RE-ARMS it at the start of every test
# WITHOUT ``exit=True``. So a session-level exit timer is cancelled by the first
# test, the per-test timer only DUMPS, and the suite hangs forever anyway.
#
# So own the reaper on a dedicated daemon thread pytest cannot touch. A blocked
# socket read releases the GIL, so this thread runs; it dumps every thread's
# stack for diagnosis and then HARD-EXITS the process, so `mise run build`
# returns non-zero within seconds of the deadline instead of burning to the
# ceiling. Deadline 600s: a SESSION backstop for the whole-suite hangs SIGALRM
# can't interrupt — sized well above the longest healthy run (the suite normally
# finishes in seconds; the per-test pytest-timeout cap is 120s, see
# pyproject.toml) yet far under the 3600s build-verify ceiling.
#
# ``pytest_sessionfinish`` cancels the timer on a clean finish (below), so a
# legitimately slow-but-passing run that lands near 600s — e.g. still in teardown
# / coverage write — is NOT hard-exited into a bewildering red.
# ``os._exit`` skips atexit + buffer flush, so it must only fire on a TRUE hang.
_HANG_REAP_DEADLINE_S = 600


def _reap_on_hang() -> None:
    faulthandler.dump_traceback(all_threads=True, file=sys.stderr)
    print(
        f"\nCONFTEST HANG WATCHDOG: test session exceeded {_HANG_REAP_DEADLINE_S}s "
        "— dumped all thread stacks above and hard-exiting so the build fails "
        "fast instead of stalling to the build-verify ceiling.",
        file=sys.stderr,
        flush=True,
    )
    os._exit(1)


# daemon=True so a clean, fast suite exit is never blocked waiting on this timer.
_hang_watchdog = threading.Timer(_HANG_REAP_DEADLINE_S, _reap_on_hang)
_hang_watchdog.daemon = True
_hang_watchdog.start()


# Layer 2 of the #855 git-config guard: DETECT. Captured at session start and
# re-read at session finish. `None` means there is nothing to protect (no `.git` at or
# above cwd — e.g. the built container image), which is a real no-risk case rather than
# a failure to look.
_SHARED_GIT_CONFIG: tuple[str, GitConfigFingerprint] | None = None

# Why the fingerprint could not be taken, when a repository WAS found. Distinct from
# `_SHARED_GIT_CONFIG is None`, and the distinction is load-bearing: "nothing to
# protect" is a pass, "could not look at the thing I am protecting" is a failure. The
# first version of this file collapsed the two into a silent `return`, so a config too
# broken for the resolver to describe — the exact state the guard is for — switched the
# guard off and reported nothing.
_SHARED_GIT_CONFIG_UNCHECKED: str | None = None


def pytest_sessionstart(session):
    """Fingerprint the repository-shared ``.git/config`` before any test runs (#855).

    This is the backstop for the autouse fixture below, and it is deliberately
    mechanism-INDEPENDENT: it does not care *how* the file was written, so it also
    catches routes the fixture does not anticipate. Four previous fixes for this leak
    were each scoped to one file and each was defeated by the next file added; a
    whole-session before/after comparison cannot be outrun that way.
    """
    global _SHARED_GIT_CONFIG, _SHARED_GIT_CONFIG_UNCHECKED
    try:
        path = shared_git_config_path()
    except GitConfigLookupError as exc:
        _SHARED_GIT_CONFIG_UNCHECKED = str(exc)
        return
    if path is None:
        return
    fingerprint = fingerprint_git_config(path)
    if fingerprint is None:
        _SHARED_GIT_CONFIG_UNCHECKED = f"{path} was located but could not be read or parsed by git"
        return
    _SHARED_GIT_CONFIG = (path, fingerprint)


def _describe_key_drift(before: frozenset[str], after: frozenset[str]) -> str:
    """Which key names moved between two fingerprints. Names only, never values."""
    added = sorted(after - before)
    removed = sorted(before - after)
    parts = []
    if added:
        parts.append(f"keys added: {', '.join(added)}")
    if removed:
        parts.append(f"keys removed: {', '.join(removed)}")
    if not parts:
        parts.append(f"value(s) changed among: {', '.join(sorted(after & before))}")
    return "; ".join(parts)


def _report_shared_git_config_mutation(session) -> None:
    """Fail the session if the shared ``.git/config`` was corrupted during the run (#855).

    Three outcomes, and the middle one is why this is not a single digest comparison:

    * a **signature** key moved (``core.worktree``, ``core.bare``, ``user.*``) — the leak.
      Fails the session with a remedy.
    * some **other** key moved — reported as a note and nothing more. The shared config is
      written by ordinary work too (``git fetch`` rewriting ``remote.*``, ``push -u``
      adding ``branch.<name>.remote``), and this suite runs as a pre-push hook while other
      worktrees may be active. A red naming no fixture and offering no remedy teaches
      people to re-run past the gate.
    * the config could not be fingerprinted at all — also a failure, see below.

    Reports key NAMES only, never values: a ``.git/config`` may hold a remote URL with
    embedded credentials, and this text goes to CI logs. ``mise run
    check:git-config-clean`` prints the offending values, which are safe for the signature
    keys specifically.

    Does not repair the file. A test suite that silently rewrites ``.git/config`` would be
    the same class of surprise as the bug it is guarding against — so this prints the exact
    remedy and leaves the decision to a human.
    """
    if _SHARED_GIT_CONFIG_UNCHECKED is not None:
        print(
            "\nSHARED GIT CONFIG — COULD NOT CHECK\n"
            f"  {_SHARED_GIT_CONFIG_UNCHECKED}\n"
            "  A repository was found but the #855 guard could not fingerprint its shared\n"
            "  config, so this run proves nothing about whether a fixture leaked into it.\n"
            "  That is itself the signature of a broken repo: `core.worktree` naming a\n"
            "  path that no longer exists makes every `git rev-parse` in the tree abort.\n"
            "  Diagnose with:  mise run check:git-config-clean",
            file=sys.stderr,
            flush=True,
        )
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        return

    if _SHARED_GIT_CONFIG is None:
        return
    path, before = _SHARED_GIT_CONFIG
    after = fingerprint_git_config(path)

    if after is None:
        detail = "the file is now unreadable, gone, or no longer parses"
    else:
        if after.digest == before.digest:
            return
        drift = _describe_key_drift(before.names, after.names)
        moved = signature_keys_changed(before, after)
        if not moved:
            # Real, but not the leak. Say so and leave the session's verdict alone.
            print(
                f"\nnote: {path} changed during this run, but no #855 signature key did\n"
                f"  ({drift}) — routine git/editor activity looks like this. Not failing.",
                file=sys.stderr,
                flush=True,
            )
            return
        detail = f"signature key(s) changed: {', '.join(moved)} — {drift}"

    print(
        f"\nSHARED GIT CONFIG MUTATED — {path}\n"
        f"  {detail}\n"
        "  A test wrote into the repository's shared config. This is the #855 leak: a\n"
        "  fixture shelling out to git while a GIT_DIR is inherited from the environment\n"
        "  (which git exports to hooks in a linked worktree) escapes cwd, --local and the\n"
        "  GIT_CONFIG_* pins alike.\n"
        "  Fix the fixture: pass env=isolated_git_env(repo) from tests/git_env.py.\n"
        f"  Clean up the repo:  git config --file {path} --unset-all core.worktree\n"
        f"                      git config --file {path} --remove-section user",
        file=sys.stderr,
        flush=True,
    )
    session.exitstatus = pytest.ExitCode.TESTS_FAILED


def pytest_sessionfinish(session, exitstatus):
    """Cancel the hang watchdog on a clean session finish, then run the #855 check.

    Without the cancel, a legitimately slow-but-passing suite that finishes just after
    the 600s deadline (e.g. during teardown / coverage write) would be hard-exited
    by ``_reap_on_hang`` and turn green red with a thread-dump uncorrelated to any
    failed test. ``Timer.cancel()`` is a no-op if the timer already fired (a true
    hang), so this only prevents the false-positive kill.

    The config check runs here rather than as a test because no test can observe a
    mutation made by a test that runs after it."""
    _hang_watchdog.cancel()
    _report_shared_git_config_mutation(session)


class FakeRunCmd:
    """Shared fake for ``shell.run_cmd``: records argv and returns scripted results.

    Used by tests that patch ``run_cmd`` (e.g. ``repo.py``, ``post_hooks.py``).
    Records every call's ``cmd``/``label``/``cwd``/``check`` and returns a
    ``CompletedProcess``-like ``SimpleNamespace``.

    ``returncodes`` maps a label key -> returncode (default 0); ``stdouts`` maps a
    label key -> stdout string (default ""). Matching is **exact** by default
    (the label must equal the key). Pass ``match_substring=True`` to match when
    the key is a substring of the label — handy for sequence tests that key off a
    recognizable label fragment. Exact matching is the safe default because some
    label keys (e.g. ``"push"``) are substrings of other labels
    (``"note-unpushed-commits"``).
    """

    def __init__(self, returncodes=None, stdouts=None, match_substring=False):
        self.calls: list[dict] = []
        self._returncodes = returncodes or {}
        self._stdouts = stdouts or {}
        self._match_substring = match_substring

    def _lookup(self, mapping, label, default):
        if self._match_substring:
            value = default
            for key, val in mapping.items():
                if key in label:
                    value = val
            return value
        return mapping.get(label, default)

    def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
        self.calls.append({"cmd": cmd, "label": label, "cwd": cwd, "check": check})
        rc = self._lookup(self._returncodes, label, 0)
        stdout = self._lookup(self._stdouts, label, "")
        return SimpleNamespace(returncode=rc, stdout=stdout, stderr="")

    def labels(self) -> list[str]:
        return [c["label"] for c in self.calls]

    def cmd_for(self, label: str):
        """Return the argv for the first call whose label matches *label*.

        Matches by substring when ``match_substring`` is set, else exact equality.
        """
        for c in self.calls:
            if (label in c["label"]) if self._match_substring else (c["label"] == label):
                return c["cmd"]
        return None


def make_task_config(**overrides) -> TaskConfig:
    """Build a TaskConfig with test-friendly defaults; ``**overrides`` win.

    Shared by tests that need a repo-bound TaskConfig (``repo.py``,
    ``post_hooks.py``). Each test supplies its own scripted fields (e.g.
    ``is_pr_workflow``, ``issue_number``) via ``overrides``.
    """
    return TaskConfig(
        repo_url=overrides.pop("repo_url", "owner/repo"),
        aws_region=overrides.pop("aws_region", "us-east-1"),
        task_id=overrides.pop("task_id", "task-abc"),
        task_description=overrides.pop("task_description", "Do a thing"),
        **overrides,
    )


# Env vars that agent code reads — clean them to avoid leaking host state.
_AGENT_ENV_VARS = [
    "TASK_TABLE_NAME",
    "TASK_EVENTS_TABLE_NAME",
    "USER_CONCURRENCY_TABLE_NAME",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN_SECRET_ARN",
    "REPO_URL",
    "ISSUE_NUMBER",
    "TASK_DESCRIPTION",
    "ANTHROPIC_MODEL",
    "MAX_TURNS",
    "MAX_BUDGET_USD",
    "DRY_RUN",
    "LOG_GROUP_NAME",
    "MEMORY_ID",
    "ENABLE_CLI_TELEMETRY",
    # Per-session IAM scoping (PR #209) — the scoped-session S3-hang guard.
    # See the ``_clean_env`` docstring below for the full rationale (why the
    # env strip AND the cache reset are both required).
    "AGENT_SESSION_ROLE_ARN",
]


@pytest.fixture(autouse=True)
def _isolate_git_location(monkeypatch, tmp_path):
    """Layer 1 of the #855 guard: PREVENT. Applies to every test, unconditionally.

    Placement is the whole point. #720/#731 got the *content* of this right but put it
    in a per-class fixture inside ``test_post_hooks.py``, so #665 was free to add a
    fresh unguarded ``_git()`` helper in ``test_registry_loader.py`` seven days later
    and reopen the leak. An autouse fixture in ``conftest.py`` is the only placement
    that also covers test files nobody has written yet.

    Three distinct jobs, and the third was added late because the first two do not
    cover the route they appear to:

    1. **Strip the repo-LOCATION vars.** While any of them is set, ``git -C <tmp>``,
       ``cwd=``, ``--local`` and the ``GIT_CONFIG_*`` pins are all bypassed, because
       an explicit ``GIT_DIR`` overrides repository discovery outright. Git exports
       these to hooks in a linked worktree, which is exactly how this suite runs as a
       pre-push gate from ``.worktrees/``.

    2. **Pin config resolution and identity.** So that a fixture which shells out to
       git *without* using ``isolated_git_env`` still cannot reach the developer's
       ``~/.gitconfig``, and any commit it makes is attributed to the reserved test
       identity rather than to whoever happens to be running the suite.

    3. **Move the process out of the checkout, and cap discovery.** Jobs 1 and 2 close
       the ``GIT_DIR`` route; neither touches repository discovery from the inherited
       cwd, and pytest runs from ``agent/`` — *inside* the checkout. So with exactly
       the environment jobs 1 and 2 produce, a plain
       ``subprocess.run(["git", "config", "user.email", "t@t"])`` with no ``cwd=`` and
       no ``-C`` still walks up from ``agent/`` and writes the shared config: same
       leak, different route, and reached by precisely the author this fixture is
       advertised to protect — the one who forgot ``isolated_git_env``. Standing in
       ``tmp_path`` instead makes that command fail loudly (``fatal: not in a git
       directory``) rather than succeed somewhere it should not.

       ``GIT_CEILING_DIRECTORIES`` is re-set for the same reason, and note that job 1
       *deletes* it, which widens discovery rather than narrowing it. Pinned to
       ``tmp_path.parent`` — not ``tmp_path`` — so a test's own repository under
       ``tmp_path`` is still discoverable while the walk can never climb out of the
       pytest temp tree, whatever ``TMPDIR`` points at on this machine.

    Production code is a beneficiary too, not just fixtures: ``post_hooks`` and
    ``repo`` shell out to git with the ambient environment, so an inherited ``GIT_DIR``
    would point the code under test at the real repository and the assertions would
    silently describe the wrong one.
    """
    for var in GIT_LOCATION_VARS:
        monkeypatch.delenv(var, raising=False)

    monkeypatch.chdir(tmp_path)
    # realpath because git resolves ceiling entries through symlinks and so does
    # ``git_env._ceiling_directories``; a logical spelling would match neither on a host
    # where TMPDIR or $HOME is a symlink.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", os.path.realpath(tmp_path.parent))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / ".gitconfig-test"))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_AUTHOR_NAME", TEST_IDENTITY_NAME)
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", TEST_IDENTITY_EMAIL)
    monkeypatch.setenv("GIT_COMMITTER_NAME", TEST_IDENTITY_NAME)
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", TEST_IDENTITY_EMAIL)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Remove agent-related env vars and reset the AWS session cache each test.

    The env cleanup + session reset TOGETHER close a scoped-session leak that
    hangs the suite on the ECS substrate: ``aws_session`` caches the resolved
    boto3 session in a MODULE GLOBAL (``_session``/``_scoped``), and
    ``tenant_client`` returns ``session.client(...)`` when ``_scoped`` is True —
    bypassing a downstream ``@patch("boto3.client")``. Two things make a test
    resolve *scoped*: a stale cached session (fixed by ``reset_session_cache``),
    OR ``AGENT_SESSION_ROLE_ARN`` still being set when the cache is cold (fixed by
    stripping it in ``_AGENT_ENV_VARS`` above — the ECS task def sets it, so on
    that substrate the reset alone re-resolves scoped and the leak persists). With
    the var gone AND the cache reset, every test resolves the unscoped path where
    its ``boto3.client`` mock intercepts. Otherwise a mocked test (e.g.
    ``test_attachments``) makes a REAL S3 call that hangs on the ECS network
    (no egress) in a socket read SIGALRM can't interrupt.
    """
    for var in _AGENT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)

    from aws_session import reset_session_cache

    reset_session_cache()
