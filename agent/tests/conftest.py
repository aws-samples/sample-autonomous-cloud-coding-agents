"""Shared fixtures for agent unit tests."""

import faulthandler
import sys
from types import SimpleNamespace

import pytest

from models import TaskConfig

# Session-wide hang backstop, immune to what pytest-timeout's SIGALRM cannot
# reach. SIGALRM fires only in the MAIN thread during a test's *call* phase, so a
# deadlock in a WORKER thread, a fixture, collection, or a C-level socket read the
# main thread never returns from stalls the whole `mise run build` silently — up
# to the platform's 3600s build-verify ceiling (the ECS-only stall seen on
# ABCA-684/686/688 and the warm-cache run: 53 min of dead air, signal never
# fired). faulthandler runs a dedicated C watchdog thread that the GIL and blocked
# syscalls can't stall: at 1200s (20 min — comfortably inside the 3600s ceiling,
# far above the whole suite's normal ~3 min) it dumps EVERY thread's Python stack
# to stderr and hard-exits, converting a blind stall into a self-diagnosing crash
# that names the exact file:line. Complements the per-test faulthandler_timeout in
# pyproject.toml (which dumps but does not exit). ``exit=True`` guarantees the
# non-zero exit even if the hang is uninterruptible.
faulthandler.dump_traceback_later(1200, exit=True, file=sys.stderr)


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
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Remove agent-related env vars and reset the AWS session cache each test.

    The env cleanup keeps host state from leaking into agent code that reads
    ``os.environ`` at import/call time.

    The session reset closes a cross-test leak: ``aws_session`` caches the
    resolved boto3 session in a MODULE GLOBAL (``_session``/``_scoped``), and
    ``tenant_client`` returns ``session.client(...)`` from that cache when
    ``_scoped`` is True — bypassing a downstream ``@patch("boto3.client")``. If an
    earlier test left a scoped session cached (only ``test_aws_session`` cleans up
    after itself), a later test like ``test_attachments`` would get a REAL client
    despite its mock → a live S3 call that hangs on the ECS network (no route/no
    creds) in a socket read SIGALRM can't interrupt. Resetting the cache before
    every test guarantees each test resolves the session under its own patches.
    """
    for var in _AGENT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)

    from aws_session import reset_session_cache

    reset_session_cache()
