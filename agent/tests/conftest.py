import faulthandler
import os
import sys
import tempfile
import threading
import traceback
from types import SimpleNamespace
from urllib.parse import urlsplit

import botocore.httpsession
import pytest

from models import TaskConfig

# #855: git hands GIT_DIR and GIT_INDEX_FILE to the hooks it runs in a linked
# worktree, and GIT_DIR overrides repository discovery. The names are git's own
# list of repository-local variables (`git rev-parse --local-env-vars`).
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
# Below the null device, not the device itself: git writes configuration to a new
# file and renames it into place, so a write that root is allowed to start would
# replace /dev/null. GIT_CONFIG_NOSYSTEM also switches off the extra system file
# Apple's git reads.
os.environ["GIT_CONFIG_GLOBAL"] = os.path.join(os.devnull, "gitconfig")
os.environ["GIT_CONFIG_SYSTEM"] = os.path.join(os.devnull, "gitconfig")
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ["GIT_CEILING_DIRECTORIES"] = os.pathsep.join(
    (
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))),
        os.path.realpath(tempfile.gettempdir()),
    )
)

# faulthandler has a single internal timer, and pytest's ``faulthandler_timeout``
# re-arms it at the start of every test without ``exit=True``: a session-level
# ``faulthandler.dump_traceback_later(exit=True)`` is cancelled by the first test.
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


_hang_watchdog = threading.Timer(_HANG_REAP_DEADLINE_S, _reap_on_hang)
_hang_watchdog.daemon = True
_hang_watchdog.start()


for _var in [name for name in os.environ if name.startswith("AWS_")]:
    del os.environ[_var]
os.environ["AWS_CONFIG_FILE"] = os.devnull
os.environ["AWS_SHARED_CREDENTIALS_FILE"] = os.devnull
os.environ["BOTO_CONFIG"] = os.devnull
os.environ["AWS_EC2_METADATA_DISABLED"] = "true"

# Every HTTP request botocore makes, its own credential lookups included, goes
# through ``URLLib3Session.send``. The refusal is a RuntimeError because botocore
# retries its own connection errors, with backoff.
_blocked_aws_requests: list[str] = []
_real_send = botocore.httpsession.URLLib3Session.send


def _loopback_origin(endpoint: str) -> str | None:
    parts = urlsplit(endpoint)
    try:
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "http" or parts.hostname != "127.0.0.1" or port is None:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username:
        return None
    return f"http://127.0.0.1:{port}"


_DYNAMODB_LOCAL_ORIGIN = _loopback_origin(os.environ.get("ABCA_DDB_LOCAL_ENDPOINT", ""))


def _refuse_aws_request(self, request):
    if _DYNAMODB_LOCAL_ORIGIN is not None:
        parts = urlsplit(request.url)
        if f"{parts.scheme}://{parts.netloc}" == _DYNAMODB_LOCAL_ORIGIN:
            return _real_send(self, request)
    frames = [f for f in traceback.extract_stack()[:-1] if "site-packages" not in f.filename]
    origin = f"{frames[-1].filename}:{frames[-1].lineno}" if frames else "?"
    attempt = (
        f"{request.method} {request.url.partition('?')[0]} from {origin} "
        f"(thread {threading.current_thread().name}, "
        f"during {os.environ.get('PYTEST_CURRENT_TEST', 'no test')})"
    )
    _blocked_aws_requests.append(attempt)
    raise RuntimeError(f"unit tests must not reach AWS — refused by tests/conftest.py: {attempt}")


botocore.httpsession.URLLib3Session.send = _refuse_aws_request


_IN_CI = bool(os.environ.get("CI"))
_skipped: list[str] = []


def _record_skip(report):
    if report.skipped and not hasattr(report, "wasxfail"):
        where = report.longrepr
        detail = f"{where[0]}:{where[1]}: {where[2]}"
        _skipped.append(f"{report.nodeid} — {detail}")
    elif report.skipped and report.wasxfail.startswith("[NOTRUN]"):
        # pytest reports an xfail marked run=False as skipped, with "[NOTRUN]" first in wasxfail.
        _skipped.append(f"{report.nodeid} — {report.wasxfail}")


pytest_runtest_logreport = pytest_collectreport = _record_skip


def pytest_sessionfinish(session, exitstatus):
    _hang_watchdog.cancel()
    failed = _blocked_aws_requests or (_IN_CI and _skipped)
    if failed and session.exitstatus == pytest.ExitCode.OK:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


@pytest.hookimpl(trylast=True)
def pytest_terminal_summary(terminalreporter):
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
            "or delete it. For a known failure use xfail without run=False (listed as [NOTRUN]): "
            "the test then runs, and an xfail that passes fails the run."
        )


class FakeRunCmd:
    """Fake for ``shell.run_cmd``: records argv and returns scripted results.

    Records every call's ``cmd``/``label``/``cwd``/``check`` and returns a
    ``CompletedProcess``-like ``SimpleNamespace``.

    ``returncodes`` maps a label key -> returncode (default 0); ``stdouts`` maps a
    label key -> stdout string (default ""). Matching is **exact** by default
    (the label must equal the key). Pass ``match_substring=True`` to match when
    the key is a substring of the label.
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
    """Build a TaskConfig with test-friendly defaults; ``**overrides`` win."""
    return TaskConfig(
        repo_url=overrides.pop("repo_url", "owner/repo"),
        aws_region=overrides.pop("aws_region", "us-east-1"),
        task_id=overrides.pop("task_id", "task-abc"),
        task_description=overrides.pop("task_description", "Do a thing"),
        **overrides,
    )


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
    "AGENT_SESSION_ROLE_ARN",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in _AGENT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)

    from aws_session import reset_session_cache

    reset_session_cache()

    from hooks import reset_blocker_reason

    reset_blocker_reason()

    # mcp 2.x copies the current OpenTelemetry context into `_meta` of every request it sends.
    from opentelemetry import context

    context.attach(context.Context())
