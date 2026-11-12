"""Shared fixtures for agent unit tests."""

import faulthandler
import os
import sys
import tempfile
import threading
import traceback
from types import SimpleNamespace

import botocore.httpsession
import pytest

from models import TaskConfig

# Session-wide git isolation (#855). Runs when pytest imports this conftest, which
# is before it imports any test module — so it also covers test files that do not
# exist yet, fixtures of every scope, and threads that outlive the test that
# started them. Nothing below is ever restored: no test may see the inherited
# values again.
#
# The leak: git hands GIT_DIR and GIT_INDEX_FILE to the hooks it runs in a linked
# worktree, and the pre-commit and pre-push hooks run this suite. GIT_DIR
# overrides repository discovery, so with it inherited a fixture's
# `git -C <tmp_path> init`, `config` or `commit` acts on the contributor's real
# repository while every test passes. The names are git's own list of
# repository-local variables (`git rev-parse --local-env-vars`): what git itself
# clears before it works on a different repository.
for _var in (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
):
    os.environ.pop(_var, None)
# No user or machine configuration: a test repository gets no identity, hooks
# path or signing setup from the host, and `git config --global` / `--system`
# fails instead of writing to the contributor's files. The files are pinned to
# a path BELOW the null device, where nothing can exist, rather than to the
# device itself: git writes configuration to a new file and renames it into
# place, so a write that root is allowed to start would replace /dev/null.
# GIT_CONFIG_NOSYSTEM is what also switches off the extra system file Apple's
# git reads.
os.environ["GIT_CONFIG_GLOBAL"] = os.path.join(os.devnull, "gitconfig")
os.environ["GIT_CONFIG_SYSTEM"] = os.path.join(os.devnull, "gitconfig")
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
# A git command aimed at a directory that is not a repository must fail, not walk
# up and adopt one: neither the checkout this suite runs from (pytest's working
# directory is inside it) nor a repository that happens to contain the temp
# directory, as a version-controlled home directory does.
os.environ["GIT_CEILING_DIRECTORIES"] = os.pathsep.join(
    (
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))),
        os.path.realpath(tempfile.gettempdir()),
    )
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


# Session-wide AWS isolation. Applied at import so that it holds for the whole
# session: a monkeypatch would hand the inherited values back at teardown, to the
# threads and wider-scoped fixtures still running, and would not cover the import
# of a test module.
#
# 1. Nothing for botocore to find credentials in — not the environment, not a
#    profile, not the shared config or credentials files (nor the two legacy
#    files botocore still reads), not the container or instance metadata
#    endpoints. Before this, writer threads leaked by test_server.py signed
#    CloudWatch Logs requests with whatever credentials the developer's
#    environment resolved.
for _var in (
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CREDENTIAL_FILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SECURITY_TOKEN",
    "AWS_SESSION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
):
    os.environ.pop(_var, None)
os.environ["AWS_CONFIG_FILE"] = os.devnull
os.environ["AWS_SHARED_CREDENTIALS_FILE"] = os.devnull
os.environ["BOTO_CONFIG"] = os.devnull
os.environ["AWS_EC2_METADATA_DISABLED"] = "true"

# 2. No request leaves the process. Every HTTP request botocore makes — service
#    calls and its own credential lookups alike — goes through
#    ``URLLib3Session.send``, so replacing that one method refuses them all. Each
#    attempt is kept and fails the session in ``pytest_sessionfinish`` below, even
#    when the code under test swallows the error. The error is a RuntimeError
#    because botocore retries its own connection errors, with backoff.
_blocked_aws_requests: list[str] = []


def _refuse_aws_request(self, request):
    frames = [f for f in traceback.extract_stack()[:-1] if "site-packages" not in f.filename]
    # The path as the frame has it, not made relative: that asks for the working
    # directory, and where a test has deleted it the attempt would go unrecorded.
    origin = f"{frames[-1].filename}:{frames[-1].lineno}" if frames else "?"
    attempt = (
        f"{request.method} {request.url.partition('?')[0]} from {origin} "
        f"(thread {threading.current_thread().name}, "
        f"during {os.environ.get('PYTEST_CURRENT_TEST', 'no test')})"
    )
    _blocked_aws_requests.append(attempt)
    raise RuntimeError(f"unit tests must not reach AWS — refused by tests/conftest.py: {attempt}")


botocore.httpsession.URLLib3Session.send = _refuse_aws_request


# No skipped test in CI. A skip is one more line in a summary nobody reads on a
# green build, so a check that has stopped running looks exactly like one that
# passes. CI is the one environment where every test must have what it needs;
# on a developer's machine a skip stays a skip. ``CI`` is the variable GitHub
# Actions sets and the one pytest itself reads to tell.
_IN_CI = bool(os.environ.get("CI"))
_skipped: list[str] = []


def _record_skip(report):
    """Remember a skipped test, or a module skipped at import (importorskip)."""
    if report.skipped and not hasattr(report, "wasxfail"):  # an xfail is an expectation, and strict
        where = report.longrepr  # (file, line, reason) for a skip
        detail = f"{os.path.relpath(where[0])}:{where[1]}: {where[2]}"
        _skipped.append(f"{report.nodeid} — {detail}")


pytest_runtest_logreport = pytest_collectreport = _record_skip


def pytest_sessionfinish(session, exitstatus):
    """Cancel the hang watchdog on a clean session finish.

    Without this, a legitimately slow-but-passing suite that finishes just after
    the 600s deadline (e.g. during teardown / coverage write) would be hard-exited
    by ``_reap_on_hang`` and turn green red with a thread-dump uncorrelated to any
    failed test. ``Timer.cancel()`` is a no-op if the timer already fired (a true
    hang), so this only prevents the false-positive kill.

    Also fails a session in which a request to AWS was attempted. Every test may
    have passed — the code under test tends to swallow the refusal — so the exit
    status is the only place the attempt can still count. The same goes for a
    test skipped in CI."""
    _hang_watchdog.cancel()
    failed = _blocked_aws_requests or (_IN_CI and _skipped)
    if failed and session.exitstatus == pytest.ExitCode.OK:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


@pytest.hookimpl(trylast=True)  # after the coverage report, so it is the last section printed
def pytest_terminal_summary(terminalreporter):
    """Say why an otherwise green session failed, where its reader looks first."""
    if _blocked_aws_requests:
        terminalreporter.section("AWS send guard", red=True, bold=True)
        terminalreporter.line(
            f"FAILED: {len(_blocked_aws_requests)} request(s) to AWS were attempted during this "
            "session. Each was refused before it left the process, and the run fails because "
            "unit tests must not reach AWS:"
        )
        for attempt in dict.fromkeys(_blocked_aws_requests):
            terminalreporter.line(f"  {attempt}")
        terminalreporter.line(
            "Fix: stub the client at the line shown, in the test named (patch boto3.client or "
            "the aws_session.tenant_client / platform_client seam), or join the thread that "
            "outlives that test."
        )
    if _IN_CI and _skipped:
        terminalreporter.section("Skip guard", red=True, bold=True)
        terminalreporter.line(
            f"FAILED: {len(_skipped)} test(s) or module(s) were skipped, and the CI variable is "
            "set. In CI every test must run, because a skipped check looks like a passing one:"
        )
        for skipped in _skipped:
            terminalreporter.line(f"  {skipped}")
        terminalreporter.line(
            "Fix: give the test what it waits for in CI (the dependency, the tool, the file), "
            "or delete it. For a known failure use xfail: an xfail that passes fails the run."
        )


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
