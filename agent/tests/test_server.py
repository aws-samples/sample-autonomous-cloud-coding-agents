"""Tests for AgentCore FastAPI server behavior."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture(autouse=True)
def reset_server_state():
    server._background_pipeline_failed = False
    with server._threads_lock:
        server._active_threads.clear()
    yield
    server._background_pipeline_failed = False
    with server._threads_lock:
        server._active_threads.clear()


@pytest.fixture
def client():
    return TestClient(server.app)


def test_ping_healthy_by_default(client):
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.json() == {"status": "healthy"}


def test_background_thread_failure_503_and_backup_terminal_write(client, monkeypatch):
    def boom(**_kwargs):
        raise RuntimeError("simulated pipeline crash")

    mock_write = MagicMock()
    monkeypatch.setattr(server, "run_task", boom)
    monkeypatch.setattr(server.task_state, "write_terminal", mock_write)

    client.post(
        "/invocations",
        json={
            "input": {
                "task_id": "task-crash-1",
                "repo_url": "o/r",
                "prompt": "x",
                "github_token": "ghp_x",
                "aws_region": "us-east-1",
            }
        },
    )

    # Wait for the background thread to actually finish before asserting.
    # The previous pattern polled /ping for the failure flag, but the flag
    # flips *before* the backup write_terminal runs in the same thread —
    # producing a race where /ping returns 503 but mock_write.assert_called()
    # fires before the call happens. Joining the thread eliminates the race.
    deadline = time.time() + 5.0
    while time.time() < deadline:
        with server._threads_lock:
            live = [t for t in server._active_threads if t.is_alive()]
        if not live:
            break
        time.sleep(0.02)
    else:
        pytest.fail("Background thread did not exit within 5s")

    r = client.get("/ping")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "unhealthy"
    assert body["reason"] == "background_pipeline_failed"

    # Race: /ping flips to 503 as soon as ``_background_pipeline_failed = True``
    # is set in the except block, but ``task_state.write_terminal(...)`` happens
    # a few lines later (after ``print()`` + ``traceback.print_exc()``). Wait
    # for the mock to actually be invoked before asserting.
    deadline2 = time.time() + 5.0
    while time.time() < deadline2 and not mock_write.called:
        time.sleep(0.05)
    mock_write.assert_called()
    call_kw = mock_write.call_args
    assert call_kw[0][0] == "task-crash-1"
    assert call_kw[0][1] == "FAILED"
    dumped = call_kw[0][2]
    assert "error" in dumped
    assert "Background pipeline thread" in dumped["error"]
    assert "RuntimeError" in dumped["error"]


def _invocation_payload(task_id: str = "task-sync-1") -> dict:
    return {
        "input": {
            "task_id": task_id,
            "repo_url": "o/r",
            "prompt": "do a thing",
            "github_token": "ghp_x",
            "aws_region": "us-east-1",
        }
    }


def test_sync_path_regression_when_accept_is_missing(client, monkeypatch):
    """No Accept header → JSON acceptance shape preserved."""
    started = threading.Event()

    def fake_run_task(**kwargs):
        started.set()

    monkeypatch.setattr(server, "run_task", fake_run_task)
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

    r = client.post("/invocations", json=_invocation_payload("t-sync"))
    assert r.status_code == 200
    body = r.json()
    assert body["output"]["result"] == {"status": "accepted", "task_id": "t-sync"}
    assert "message" in body["output"]
    # Background thread ran
    assert started.wait(timeout=3)


def test_sync_path_preserved_for_application_json_accept(client, monkeypatch):
    """Accept: application/json → sync JSON path."""
    monkeypatch.setattr(server, "run_task", lambda **_: None)
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

    r = client.post(
        "/invocations",
        json=_invocation_payload("t-json"),
        headers={"Accept": "application/json"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["output"]["result"]["status"] == "accepted"


def test_event_stream_accept_header_ignored_returns_sync_json(client, monkeypatch):
    """Accept: text/event-stream is ignored; sync JSON is always returned."""
    monkeypatch.setattr(server, "run_task", lambda **_: None)
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

    r = client.post(
        "/invocations",
        json=_invocation_payload("t-accept-sse"),
        headers={"Accept": "text/event-stream"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["output"]["result"] == {"status": "accepted", "task_id": "t-accept-sse"}


def test_ping_reports_healthy_when_idle(client, monkeypatch):
    """/ping returns {"status": "healthy"} with no active pipeline threads."""
    monkeypatch.setattr(server, "_background_pipeline_failed", False)
    with server._threads_lock:
        server._active_threads.clear()
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.json() == {"status": "healthy"}


def test_ping_reports_healthybusy_when_pipeline_alive(client, monkeypatch):
    """/ping returns HealthyBusy while a pipeline thread is alive (idle-evict guard)."""
    monkeypatch.setattr(server, "_background_pipeline_failed", False)

    stop = threading.Event()

    def worker():
        stop.wait(timeout=5)

    t = threading.Thread(target=worker, name="test-live-pipeline")
    t.start()
    try:
        with server._threads_lock:
            server._active_threads.clear()
            server._active_threads.append(t)
        r = client.get("/ping")
        assert r.status_code == 200
        assert r.json() == {"status": "HealthyBusy"}
    finally:
        stop.set()
        t.join(timeout=2)
        with server._threads_lock:
            server._active_threads.clear()


def test_invocations_rejects_missing_required_params_with_400(client, monkeypatch):
    """A task record missing required fields is rejected up front with 400.

    Regression guard for wiring `_validate_required_params` into the handler
    — without it, bad payloads would spawn a background thread that crashes
    deep inside `setup_repo` or hydration, producing a cryptic terminal
    failure instead of a structured `TASK_RECORD_INCOMPLETE` 400.
    """
    # Patch _spawn_background so if validation ever fails to trigger we'd
    # see the test spawn a real pipeline thread.
    spawn_calls: list[dict] = []
    monkeypatch.setattr(server, "_spawn_background", lambda params: spawn_calls.append(params))

    response = client.post(
        "/invocations",
        json={
            "input": {
                "task_id": "t-missing",
                "resolved_workflow": {"id": "coding/pr-review-v1", "version": "1.0.0"},
            }
        },
    )

    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "TASK_RECORD_INCOMPLETE"
    assert "repo_url" in body["missing"]
    assert "pr_number" in body["missing"]
    # Background pipeline must NOT be spawned on validation failure.
    assert spawn_calls == []


def test_spawn_background_resets_pipeline_failed_flag(monkeypatch):
    """A new spawn clears ``_background_pipeline_failed`` when no prior threads are alive.

    AgentCore reconciliation keys off ``/ping`` status; a stale
    ``_background_pipeline_failed = True`` after a crashed pipeline would
    route new traffic around a healthy container forever.
    """
    server._background_pipeline_failed = True
    with server._threads_lock:
        server._active_threads.clear()

    # Stub the actual pipeline so we don't try to run a real task.
    monkeypatch.setattr(server, "_run_task_background", lambda **_kwargs: None)

    thread = server._spawn_background(
        {"task_id": "t-reset", "repo_url": "o/r", "task_description": "x"}
    )
    thread.join(timeout=2)

    assert server._background_pipeline_failed is False

    with server._threads_lock:
        server._active_threads.clear()


def test_run_task_background_starts_and_stops_heartbeat(monkeypatch):
    """The heartbeat worker thread runs while the pipeline runs and stops after.

    Regression guard: if someone accidentally drops the heartbeat thread
    start/stop, the stranded-task reconciler would start flagging healthy
    long-running tasks as stuck.
    """
    heartbeat_calls: list[str] = []

    def fake_write_heartbeat(task_id: str) -> None:
        heartbeat_calls.append(task_id)

    monkeypatch.setattr(server.task_state, "write_heartbeat", fake_write_heartbeat)
    monkeypatch.setattr(server, "_HEARTBEAT_INTERVAL_SECONDS", 0.05)

    # Stub run_task to sleep briefly so the heartbeat has time to fire.
    def fake_run_task(**_kwargs):
        time.sleep(0.15)

    monkeypatch.setattr(server, "run_task", fake_run_task)
    # Stub terminal write so the fake pipeline doesn't try to hit DDB.
    monkeypatch.setattr(server.task_state, "write_terminal", lambda *a, **kw: None)

    server._run_task_background(
        task_id="t-heartbeat",
        repo_url="o/r",
        task_description="x",
        issue_number="",
        github_token="",
        anthropic_model="",
        max_turns=10,
        max_budget_usd=None,
        aws_region="us-east-1",
    )

    # Heartbeat should have fired at least once during the 0.15s pipeline
    # with a 0.05s cadence.
    assert len(heartbeat_calls) >= 1
    assert heartbeat_calls[0] == "t-heartbeat"


def test_run_task_background_propagates_correlation_envelope(monkeypatch):
    """The background task thread propagates {session_id, user_id, repo} into
    OTEL baggage via propagate_correlation_context (#245).

    Regression guard for the widened trigger: correlation must propagate even
    when session_id is empty but user_id/repo are known — the branch the whole
    envelope-in-baggage feature depends on.
    """
    calls: list[dict] = []
    monkeypatch.setattr(
        server,
        "propagate_correlation_context",
        lambda session_id, **kw: calls.append({"session_id": session_id, **kw}),
    )
    monkeypatch.setattr(server, "run_task", lambda **_kwargs: None)
    monkeypatch.setattr(server.task_state, "write_heartbeat", lambda *a, **kw: None)
    monkeypatch.setattr(server.task_state, "write_terminal", lambda *a, **kw: None)

    # No session_id, but user_id + repo_url known → propagation must still run.
    server._run_task_background(
        task_id="t-corr",
        repo_url="o/r",
        task_description="x",
        issue_number="",
        github_token="",
        anthropic_model="",
        max_turns=10,
        max_budget_usd=None,
        aws_region="us-east-1",
        user_id="user-1",
    )

    assert calls == [{"session_id": "", "user_id": "user-1", "repo": "o/r"}]


def test_validate_required_params_pr_workflows_require_pr_number():
    """PR-iteration and PR-review workflows need a pr_number regardless."""
    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "resolved_workflow": {"id": "coding/pr-iteration-v1", "version": "1.0.0"},
            "pr_number": "",
        }
    )
    assert missing == ["pr_number"]

    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "resolved_workflow": {"id": "coding/pr-review-v1", "version": "1.0.0"},
            "pr_number": "42",
        }
    )
    assert missing == []

    # Restack (#305) is a PR workflow — pr_number suffices, NO description
    # required (regression: it previously fell into the non-PR branch and
    # 400'd on missing issue_number_or_task_description).
    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "resolved_workflow": {"id": "coding/restack-v1", "version": "1.0.0"},
            "pr_number": "113",
        }
    )
    assert missing == []
    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "resolved_workflow": {"id": "coding/restack-v1", "version": "1.0.0"},
            "pr_number": "",
        }
    )
    assert missing == ["pr_number"]

    # A non-PR workflow needs issue OR description.
    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "resolved_workflow": {"id": "coding/new-task-v1", "version": "1.0.0"},
        }
    )
    assert missing == ["issue_number_or_task_description"]

    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "resolved_workflow": {"id": "coding/new-task-v1", "version": "1.0.0"},
            "task_description": "do the thing",
        }
    )
    assert missing == []


def test_validate_required_params_repoless_workflow_does_not_require_repo():
    """#248 Phase 3: a repo-less workflow is accepted at the /invocations boundary
    with no repo_url (the AgentCore-backend admission path).

    Regression guard: repo_url was previously required unconditionally here, which
    rejected every repo-less task on the AgentCore backend before the pipeline ran.
    """
    missing = server._validate_required_params(
        {
            "resolved_workflow": {"id": "default/agent-v1", "version": "1.0.0"},
            "task_description": "Summarise these papers",
        }
    )
    assert missing == []

    # A repo-bound workflow still requires repo_url.
    missing = server._validate_required_params(
        {
            "resolved_workflow": {"id": "coding/new-task-v1", "version": "1.0.0"},
            "task_description": "do the thing",
        }
    )
    assert missing == ["repo_url"]


def test_drain_threads_joins_active_threads():
    """_drain_threads joins live background threads on shutdown."""
    stop = threading.Event()

    def worker():
        stop.wait(timeout=1)

    t = threading.Thread(target=worker, name="drain-test")
    t.start()
    with server._threads_lock:
        server._active_threads.clear()
        server._active_threads.append(t)

    # Signal thread to exit, then drain.
    stop.set()
    server._drain_threads(timeout=5)
    # Thread must have finished by now.
    assert not t.is_alive()

    with server._threads_lock:
        server._active_threads.clear()


def test_debug_cw_write_blocking_no_log_group_is_noop(monkeypatch):
    """_debug_cw is a no-op when LOG_GROUP_NAME is unset."""
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    # Should not raise, even if boto3 would fail — we never reach it.
    server._debug_cw("hello", task_id="t")


def test_debug_cw_exc_appends_the_traceback(monkeypatch, capfd):
    """``_debug_cw_exc`` is the exception-carrying variant used by the error paths.

    Still reached from ``/invocations`` and from ``/run`` AFTER the config install
    (the pre-install paths deliberately use the stdout-only ``_pre_config_log``),
    so its formatting stays under test on its own rather than incidentally.
    """
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    try:
        raise RuntimeError("kaboom")
    except RuntimeError as exc:
        server._debug_cw_exc("something FAILED", exc, task_id="t")
    out = capfd.readouterr().out
    assert "something FAILED [RuntimeError: kaboom]" in out
    assert "Traceback" in out


def test_debug_cw_write_blocking_bumps_failure_counter_on_boto_error(monkeypatch):
    """On boto errors the failure counter increments so operators can alarm.

    AgentCore doesn't forward container stdout to APPLICATION_LOGS, so a
    broken ``_debug_cw`` is invisible except for this counter. If the
    counter ever stops bumping on error the blind-debug alarm breaks
    silently.
    """
    # Seed the counter to a known value so we can assert the delta without
    # being sensitive to other tests.
    with server._debug_cw_failures_lock:
        server._debug_cw_failures = 0

    # Stub ``boto3.client`` to raise so the except branch (which bumps
    # the counter) runs.
    class _BrokenBoto3:
        @staticmethod
        def client(*args, **kwargs):
            raise RuntimeError("simulated boto failure")

    monkeypatch.setitem(__import__("sys").modules, "boto3", _BrokenBoto3)

    server._debug_cw_write_blocking(
        log_group="/some/log-group",
        task_id="t-1",
        stamped="2026-01-01T00:00:00Z hello",
    )

    with server._debug_cw_failures_lock:
        assert server._debug_cw_failures == 1


# Chunk 7c — _warn_cw parallels _debug_cw so warn-level invocation-payload
# issues aren't invisible in production (AgentCore doesn't forward
# container stdout to APPLICATION_LOGS).


def test_warn_cw_prints_stamped_line_to_stdout(monkeypatch, capfd):
    """stdout must still carry the ``[server/warn]`` prefix.

    Local ``docker-compose`` runs rely on stdout; the ``capfd``-based
    tests on ``_extract_invocation_params`` also rely on the prefix so
    CloudWatch routing must NOT replace the local emission. ``capfd``
    (not ``capsys``) because ``_warn_cw`` writes via ``os.write(1, ...)``
    — the same non-print sink as ``_debug_cw`` — so the line only
    appears at the file-descriptor level.
    """
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    server._warn_cw("something went wrong", task_id="t-1")
    captured = capfd.readouterr()
    assert "[server/warn] something went wrong" in captured.out


def test_warn_cw_no_log_group_is_noop(monkeypatch):
    """_warn_cw skips the CloudWatch thread when LOG_GROUP_NAME is unset.

    Local dev has no log group — the function must not attempt a
    thread spawn. stdout line still fires (asserted separately above).

    The assertion on ``threading.Thread`` being uncalled is load-bearing:
    without it, a future refactor that spawned the thread before the
    env check would pass this test silently. Explicitly patching the
    env out also defends against a prior test leaking ``LOG_GROUP_NAME``
    into ``os.environ``.
    """
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)

    thread_calls: list[tuple] = []

    class _RecordingThread:
        def __init__(self, *args, **kwargs):
            thread_calls.append((args, kwargs))

        def start(self) -> None:
            thread_calls.append(("start",))

    monkeypatch.setattr("server.threading.Thread", _RecordingThread)

    server._warn_cw("hello", task_id="t-1")

    assert thread_calls == [], (
        f"_warn_cw must not spawn a thread when LOG_GROUP_NAME is unset, "
        f"got calls: {thread_calls!r}"
    )


def test_warn_cw_write_blocking_bumps_failure_counter_on_boto_error(monkeypatch):
    """Warn-path boto errors bump the same failure counter as debug.

    A single alarm surface is intentional (§server.py comment on
    ``_debug_cw_failures``). If the counter ever stops bumping on a
    warn write failure the blind-warn alarm breaks silently.
    """
    with server._debug_cw_failures_lock:
        server._debug_cw_failures = 0

    class _BrokenBoto3:
        @staticmethod
        def client(*args, **kwargs):
            raise RuntimeError("simulated boto failure")

    monkeypatch.setitem(__import__("sys").modules, "boto3", _BrokenBoto3)

    server._warn_cw_write_blocking(
        log_group="/some/log-group",
        task_id="t-1",
        stamped="[server/warn] malformed payload",
    )

    with server._debug_cw_failures_lock:
        assert server._debug_cw_failures == 1


def test_warn_cw_write_blocking_uses_server_warn_stream(monkeypatch):
    """Warn writes land in ``server_warn/<task_id>``, not the debug stream.

    A separate stream lets operators alarm on warn traffic independently
    of the (much noisier) ``server_debug`` breadcrumbs.
    """
    captured_streams: list[str] = []

    class _FakeLogs:
        class exceptions:
            class ResourceAlreadyExistsException(Exception):
                pass

        def create_log_stream(self, *, logGroupName, logStreamName):
            captured_streams.append(logStreamName)

        def put_log_events(self, *, logGroupName, logStreamName, logEvents):
            captured_streams.append(logStreamName)

    class _FakeBoto3:
        @staticmethod
        def client(*args, **kwargs):
            return _FakeLogs()

    monkeypatch.setitem(__import__("sys").modules, "boto3", _FakeBoto3)

    server._warn_cw_write_blocking(
        log_group="/some/log-group",
        task_id="t-abc",
        stamped="[server/warn] hi",
    )

    assert captured_streams == ["server_warn/t-abc", "server_warn/t-abc"]


# ---------------------------------------------------------------------------
# Chunk K: trace flag extraction (design §10.1)
# ---------------------------------------------------------------------------


class _FakeRequest:
    """Minimal stand-in for starlette.Request — only ``.headers.get`` is used."""

    def __init__(self, headers=None):
        self.headers = headers or {}


class TestExtractTrace:
    """_extract_invocation_params is the boundary where the orchestrator's
    ``trace`` payload becomes the agent's ``trace`` kwarg. The flag is
    strictly opt-in — only a real boolean ``True`` counts."""

    def _base_payload(self, **extra):
        return {
            "repo_url": "org/repo",
            "task_description": "Fix it",
            "task_id": "t-1",
            **extra,
        }

    def _fake_req(self) -> Any:
        # ``_extract_invocation_params`` only calls ``request.headers.get``,
        # so a duck-typed stub suffices. Return ``Any`` to silence the
        # ty type checker without importing starlette at runtime.
        return _FakeRequest()

    def test_trace_true_in_payload_extracts_to_True(self):
        params = server._extract_invocation_params(
            self._base_payload(trace=True),
            self._fake_req(),
        )
        assert params["trace"] is True

    def test_trace_absent_defaults_to_False(self):
        params = server._extract_invocation_params(
            self._base_payload(),
            self._fake_req(),
        )
        assert params["trace"] is False

    def test_trace_string_true_does_NOT_enable_trace(self):
        # Guard against a misbehaving client sending "true" (truthy
        # string) — the extractor uses ``is True`` so only real
        # booleans flip the flag.
        params = server._extract_invocation_params(
            self._base_payload(trace="true"),
            self._fake_req(),
        )
        assert params["trace"] is False

    def test_trace_1_does_NOT_enable_trace(self):
        params = server._extract_invocation_params(
            self._base_payload(trace=1),
            self._fake_req(),
        )
        assert params["trace"] is False


class TestExtractUserId:
    """``user_id`` is the platform Cognito ``sub`` threaded
    from the orchestrator. The agent uses it to construct the trace S3
    key ``traces/<user_id>/<task_id>.jsonl.gz``. A non-string value
    must be coerced to empty so a surprise ``None`` / int doesn't flow
    into an S3 PutObject call later."""

    def _base_payload(self, **extra):
        return {
            "repo_url": "org/repo",
            "task_description": "Fix it",
            "task_id": "t-1",
            **extra,
        }

    def _fake_req(self) -> Any:
        return _FakeRequest()

    def test_user_id_string_extracts_verbatim(self):
        params = server._extract_invocation_params(
            self._base_payload(user_id="sub-abc-123"),
            self._fake_req(),
        )
        assert params["user_id"] == "sub-abc-123"

    def test_user_id_absent_defaults_to_empty_string(self):
        params = server._extract_invocation_params(
            self._base_payload(),
            self._fake_req(),
        )
        assert params["user_id"] == ""

    def test_user_id_none_coerced_to_empty(self):
        params = server._extract_invocation_params(
            self._base_payload(user_id=None),
            self._fake_req(),
        )
        assert params["user_id"] == ""

    def test_user_id_non_string_coerced_to_empty(self):
        # Defend against a misbehaving caller sending an int or dict —
        # the agent writes ``user_id`` into an S3 object key, so a
        # non-string would blow up at upload time (or worse, silently
        # stringify to something like ``"None"`` or ``"123"``).
        params = server._extract_invocation_params(
            self._base_payload(user_id=12345),
            self._fake_req(),
        )
        assert params["user_id"] == ""

    def test_user_id_non_string_logs_warn(self, capfd):
        # Silent coercion is a documented anti-pattern in project
        # guidelines — if Stage 4 later skips the S3 upload because
        # ``user_id`` is empty, a user investigating "my trace never
        # appeared" needs a signal in CloudWatch to correlate.
        server._extract_invocation_params(
            self._base_payload(user_id=12345, task_id="t-warn"),
            self._fake_req(),
        )
        captured = capfd.readouterr()
        assert "[server/warn]" in captured.out
        assert "user_id payload field is not a string" in captured.out
        assert "type=int" in captured.out
        assert "'t-warn'" in captured.out


class TestExtractInitialApprovalGateCount:
    """Chunk 7 (§13.6): ``initial_approval_gate_count`` is the TaskTable-
    persisted counter threaded by the orchestrator on container spawn so
    a restart resumes the cumulative gate budget instead of resetting.
    Shape mirrors ``approval_timeout_s`` — integer, optional, fail-open
    on a malformed field."""

    def _base_payload(self, **extra):
        return {
            "repo_url": "org/repo",
            "task_description": "Fix it",
            "task_id": "t-1",
            **extra,
        }

    def _fake_req(self) -> Any:
        return _FakeRequest()

    def test_absent_defaults_to_zero(self):
        params = server._extract_invocation_params(
            self._base_payload(),
            self._fake_req(),
        )
        assert params["initial_approval_gate_count"] == 0

    def test_positive_int_extracts_verbatim(self):
        params = server._extract_invocation_params(
            self._base_payload(initial_approval_gate_count=12),
            self._fake_req(),
        )
        assert params["initial_approval_gate_count"] == 12

    def test_int_like_string_is_accepted_via_int_coercion(self):
        # DDB responses pass through orchestrator as numbers, but a
        # misbehaving caller that passes "12" as a string should still
        # coerce cleanly — int() handles digits-as-string.
        params = server._extract_invocation_params(
            self._base_payload(initial_approval_gate_count="12"),
            self._fake_req(),
        )
        assert params["initial_approval_gate_count"] == 12

    def test_non_numeric_string_coerces_to_zero_and_warns(self, capfd):
        params = server._extract_invocation_params(
            self._base_payload(initial_approval_gate_count="not-a-number", task_id="t-warn"),
            self._fake_req(),
        )
        assert params["initial_approval_gate_count"] == 0
        captured = capfd.readouterr()
        assert "[server/warn]" in captured.out
        assert "initial_approval_gate_count payload field is not an int" in captured.out

    def test_none_coerces_to_zero(self):
        params = server._extract_invocation_params(
            self._base_payload(initial_approval_gate_count=None),
            self._fake_req(),
        )
        assert params["initial_approval_gate_count"] == 0


class TestExtractApprovalGateCap:
    """Chunk 7b (§4 step 5, decision #13): ``approval_gate_cap`` is the
    TaskTable-persisted per-task cap, resolved from
    ``Blueprint.security.approvalGateCap`` at submit-time. Threaded as an
    integer or None; malformed payloads fall back to None so the engine's
    bounds check runs cleanly."""

    def _base_payload(self, **extra):
        return {
            "repo_url": "org/repo",
            "task_description": "Fix it",
            "task_id": "t-1",
            **extra,
        }

    def _fake_req(self) -> Any:
        return _FakeRequest()

    def test_absent_defaults_to_none(self):
        params = server._extract_invocation_params(
            self._base_payload(),
            self._fake_req(),
        )
        assert params["approval_gate_cap"] is None

    def test_positive_int_extracts_verbatim(self):
        params = server._extract_invocation_params(
            self._base_payload(approval_gate_cap=150),
            self._fake_req(),
        )
        assert params["approval_gate_cap"] == 150

    def test_int_like_string_accepted_via_int_coercion(self):
        params = server._extract_invocation_params(
            self._base_payload(approval_gate_cap="50"),
            self._fake_req(),
        )
        assert params["approval_gate_cap"] == 50

    def test_non_numeric_string_coerces_to_none_and_warns(self, capfd):
        params = server._extract_invocation_params(
            self._base_payload(approval_gate_cap="not-a-number", task_id="t-warn"),
            self._fake_req(),
        )
        assert params["approval_gate_cap"] is None
        captured = capfd.readouterr()
        assert "[server/warn]" in captured.out
        assert "approval_gate_cap payload field is not an int" in captured.out

    def test_none_stays_none(self):
        params = server._extract_invocation_params(
            self._base_payload(approval_gate_cap=None),
            self._fake_req(),
        )
        assert params["approval_gate_cap"] is None


# --------------------------------------------------------------------------
# AWS Lambda MicroVMs lifecycle hooks (ADR-021 P1)
# --------------------------------------------------------------------------


READY_HOOK = f"{server.MICROVM_HOOK_PREFIX}/ready"
RUN_HOOK = f"{server.MICROVM_HOOK_PREFIX}/run"
VALIDATE_HOOK = f"{server.MICROVM_HOOK_PREFIX}/validate"
TERMINATE_HOOK = f"{server.MICROVM_HOOK_PREFIX}/terminate"


def _platform_config(**overrides) -> dict:
    """A ``platform_config`` block carrying exactly the required subset.

    Built from the contract rather than a literal key list so a contract change
    cannot leave these tests asserting a stale required set.
    """
    config = {key: f"value-for-{key}" for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS}
    config.update(overrides)
    return config


def _run_hook_body(envelope: dict, microvm_id: str = "microvm-abc") -> dict:
    """Wrap an ABCA payload envelope in the service's ``/run`` request body.

    The service passes ``runHookPayload`` through as an opaque STRING (it never
    parses it), so the double encoding here is the real wire shape, not a test
    artifact.
    """
    return {"microvmId": microvm_id, "runHookPayload": json.dumps(envelope)}


class TestMicrovmReadyHook:
    """``/ready`` is what makes a MicroVM image buildable at all.

    ``CreateMicrovmImage`` refuses an image that enables any lifecycle hook
    without ``/ready``, and with the hook enabled but unserved both chipset
    builds fail ("Ready hook check failed: the application returned a client
    error (HTTP 4xx) response"). A 200 from a booted server is the whole
    contract in P1 — deeper warm-up checks are P2's ``/validate``.
    """

    def test_ready_returns_200_once_the_server_is_up(self, client):
        r = client.post(READY_HOOK)
        assert r.status_code == 200
        assert r.json() == {"status": "ready"}

    def test_ready_is_mounted_under_the_service_hook_prefix(self):
        assert server.MICROVM_HOOK_PREFIX == "/aws/lambda-microvms/runtime/v1"
        routes = {getattr(r, "path", None) for r in server.app.routes}
        assert READY_HOOK in routes
        assert RUN_HOOK in routes
        assert VALIDATE_HOOK in routes
        assert TERMINATE_HOOK in routes

    def test_ready_does_not_start_a_pipeline(self, client, monkeypatch):
        # A build hook must never run task work: the snapshot is taken right
        # after it answers, so anything it starts would be frozen into the image.
        monkeypatch.setattr(server, "run_task", MagicMock())
        client.post(READY_HOOK)
        with server._threads_lock:
            assert server._active_threads == []

    def test_suspend_and_resume_are_NOT_served(self, client):
        # Declaring a hook nothing answers fails the corresponding build or
        # lifecycle transition, so the construct declares exactly the hooks the
        # agent serves. /validate + /terminate joined that set in P2; /suspend +
        # /resume need the ComputeStrategy interface widening (P3), so they must
        # still 404 — the assertion that keeps the construct honest.
        for hook in ("suspend", "resume"):
            assert client.post(f"{server.MICROVM_HOOK_PREFIX}/{hook}").status_code == 404


class TestMicrovmRunHookInlinePayload:
    """Inline envelope: ``{"agent_payload": {...}}``.

    The exception rather than the rule — the service caps ``runHookPayload`` at
    4 096 bytes and a hydrated payload is larger — but it is the branch that
    proves the payload→pipeline mapping without any S3 involvement.
    """

    def test_accepts_the_payload_and_starts_the_pipeline_asynchronously(self, client, monkeypatch):
        started = threading.Event()
        seen: dict = {}

        def fake_run_task(**kwargs):
            seen.update(kwargs)
            started.set()

        monkeypatch.setattr(server, "run_task", fake_run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": {
                        "task_id": "t-microvm-1",
                        "repo_url": "org/repo",
                        "prompt": "Fix the bug",
                        "github_token": "ghp_x",
                        "aws_region": "us-east-1",
                    }
                },
                microvm_id="microvm-inline",
            ),
        )

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "accepted"
        assert body["task_id"] == "t-microvm-1"
        # Echoed so a MicroVM log line can be joined to the control-plane id.
        assert body["microvm_id"] == "microvm-inline"

        assert started.wait(timeout=5.0), "pipeline thread did not start"
        # Same mapping the /invocations path performs: prompt→task_description,
        # model_id→anthropic_model, etc. — one mapper, not two.
        assert seen["task_id"] == "t-microvm-1"
        assert seen["repo_url"] == "org/repo"
        assert seen["task_description"] == "Fix the bug"

    def test_returns_before_the_pipeline_finishes(self, client, monkeypatch):
        release = threading.Event()
        entered = threading.Event()

        def slow_run_task(**_kwargs):
            entered.set()
            release.wait(timeout=10.0)

        monkeypatch.setattr(server, "run_task", slow_run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        try:
            r = client.post(
                RUN_HOOK,
                json=_run_hook_body(
                    {"agent_payload": {"task_id": "t-async", "repo_url": "o/r", "prompt": "x"}}
                ),
            )
            # The hook budget is 1-60 s and the pipeline runs for minutes, so the
            # 200 must land while the pipeline is still executing.
            assert r.status_code == 200
            assert entered.wait(timeout=5.0)
            with server._threads_lock:
                assert any(t.is_alive() for t in server._active_threads)
        finally:
            release.set()

    def test_uses_the_same_model_id_and_prompt_aliases_as_invocations(self, client, monkeypatch):
        seen: dict = {}
        started = threading.Event()

        def fake_run_task(**kwargs):
            seen.update(kwargs)
            started.set()

        monkeypatch.setattr(server, "run_task", fake_run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": {
                        "task_id": "t-alias",
                        "repo_url": "o/r",
                        "prompt": "do it",
                        "model_id": "anthropic.claude-x",
                        "cedar_policies": ["p1"],
                        "channel_source": "linear",
                    }
                }
            ),
        )
        assert started.wait(timeout=5.0)
        assert seen["anthropic_model"] == "anthropic.claude-x"
        assert seen["cedar_policies"] == ["p1"]
        assert seen["channel_source"] == "linear"


class TestMicrovmRunHookS3Payload:
    """S3-pointer envelope: ``{"agent_payload_s3_uri": "s3://bucket/key"}``.

    The DOMINANT path on this backend: with a 4 096-byte ``runHookPayload`` cap,
    any hydrated payload is offloaded to the platform payload bucket and only the
    pointer travels in the hook body.
    """

    def test_fetches_the_payload_from_s3_and_starts_the_pipeline(self, client, monkeypatch):
        seen: dict = {}
        started = threading.Event()

        def fake_run_task(**kwargs):
            seen.update(kwargs)
            started.set()

        fetched: dict = {}

        def fake_fetch(uri):
            fetched["uri"] = uri
            return {"task_id": "t-s3", "repo_url": "org/repo", "prompt": "from s3"}

        monkeypatch.setattr(server, "_fetch_microvm_payload_from_s3", fake_fetch)
        monkeypatch.setattr(server, "run_task", fake_run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload_s3_uri": "s3://payload-bucket/t-s3/payload.json"}),
        )

        assert r.status_code == 200
        assert r.json()["task_id"] == "t-s3"
        assert fetched["uri"] == "s3://payload-bucket/t-s3/payload.json"
        assert started.wait(timeout=5.0)
        assert seen["task_description"] == "from s3"

    def test_parses_bucket_and_key_out_of_the_uri(self, monkeypatch):
        captured: dict = {}

        class _Body:
            @staticmethod
            def read():
                return b'{"task_id": "t-1", "repo_url": "o/r"}'

        class _S3:
            @staticmethod
            def get_object(**kwargs):
                captured.update(kwargs)
                return {"Body": _Body}

        import boto3

        monkeypatch.setattr(boto3, "client", lambda *_a, **_k: _S3)

        payload = server._fetch_microvm_payload_from_s3("s3://my-bucket/prefix/t-1/payload.json")

        # Key keeps every slash after the bucket — a naive split would truncate it.
        assert captured == {"Bucket": "my-bucket", "Key": "prefix/t-1/payload.json"}
        assert payload == {"task_id": "t-1", "repo_url": "o/r"}

    def test_rejects_a_uri_with_no_key(self, monkeypatch):
        with pytest.raises(ValueError, match="not a bucket/key URI"):
            server._fetch_microvm_payload_from_s3("s3://bucket-only")

    def test_rejects_a_non_object_s3_body(self, monkeypatch):
        class _Body:
            @staticmethod
            def read():
                return b"[1, 2, 3]"

        class _S3:
            @staticmethod
            def get_object(**_kwargs):
                return {"Body": _Body}

        import boto3

        monkeypatch.setattr(boto3, "client", lambda *_a, **_k: _S3)

        with pytest.raises(ValueError, match="expected an object"):
            server._fetch_microvm_payload_from_s3("s3://b/k")

    def test_s3_failure_returns_500_and_starts_nothing(self, client, monkeypatch):
        def boom(_uri):
            raise RuntimeError("AccessDenied")

        monkeypatch.setattr(server, "_fetch_microvm_payload_from_s3", boom)
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload_s3_uri": "s3://bucket/key"}))

        # 500, not 400: the body was well-formed, the fetch was not. Retrying an
        # identical body CAN help here, unlike a malformed envelope.
        assert r.status_code == 500
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_UNREADABLE"
        assert "AccessDenied" in r.json()["message"]
        with server._threads_lock:
            assert server._active_threads == []


class TestMicrovmRunHookRejections:
    """Every shape the agent cannot act on must fail LOUDLY, before spawning.

    A hook that 200s on a payload it could not read would start a pipeline with
    an empty prompt and burn a full task before anyone noticed.
    """

    @pytest.mark.parametrize(
        "run_hook_payload,expected_fragment",
        [
            ("", "runHookPayload is empty"),
            ("   ", "runHookPayload is empty"),
            ("not json at all", "not valid JSON"),
            ('"a string"', "must be a JSON object"),
            ("[1,2,3]", "must be a JSON object"),
            ('{"agent_payload": "not-an-object"}', "agent_payload must be an object"),
            ('{"agent_payload_s3_uri": "https://example.com/x"}', "must be an s3:// URI"),
            ('{"agent_payload_s3_uri": 42}', "must be an s3:// URI"),
            ('{"something_else": 1}', "neither agent_payload nor agent_payload_s3_uri"),
        ],
    )
    def test_returns_400_with_a_named_code(
        self, client, monkeypatch, run_hook_payload, expected_fragment
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(
            RUN_HOOK, json={"microvmId": "microvm-x", "runHookPayload": run_hook_payload}
        )

        assert r.status_code == 400
        body = r.json()
        assert body["code"] == "MICROVM_RUN_PAYLOAD_INVALID"
        assert expected_fragment in body["message"]
        with server._threads_lock:
            assert server._active_threads == []

    def test_a_missing_body_field_is_a_400_not_a_422(self, client, monkeypatch):
        # Both fields default to "", so an empty body reaches our own structured
        # rejection instead of FastAPI's 422 — the message ends up in the MicroVM
        # log group, so it has to be ours.
        monkeypatch.setattr(server, "run_task", MagicMock())
        r = client.post(RUN_HOOK, json={})
        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_INVALID"

    def test_incomplete_task_record_reuses_the_invocations_rejection_shape(
        self, client, monkeypatch
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload": {"task_id": "t-bad"}}),
        )

        assert r.status_code == 400
        body = r.json()
        assert body["code"] == "TASK_RECORD_INCOMPLETE"
        # Same validator as /invocations, so the same missing-field vocabulary.
        assert "repo_url" in body["missing"]
        with server._threads_lock:
            assert server._active_threads == []


class TestMicrovmRunHookHeaderPosture:
    """No AgentCore Runtime sits in front of this call.

    So there is no session-id header and no workload access token — the same
    env-var identity posture the ECS backend already has (ADR-021 sub-decision 3,
    identity delta). Asserted so a future reader does not mistake the empty
    values for a bug.
    """

    def test_session_id_and_workload_token_resolve_empty(self, client, monkeypatch):
        seen: dict = {}
        started = threading.Event()

        def fake_run_task(**kwargs):
            seen.update(kwargs)
            started.set()

        monkeypatch.setattr(server, "run_task", fake_run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {"agent_payload": {"task_id": "t-hdr", "repo_url": "o/r", "prompt": "x"}}
            ),
        )
        assert started.wait(timeout=5.0)
        # run_task never receives the token/session (they are consumed by
        # _run_task_background), so assert via the extractor instead.
        fake_request: Any = _FakeRequest()
        params = server._extract_invocation_params(
            {"task_id": "t-hdr", "repo_url": "o/r", "prompt": "x"}, fake_request
        )
        assert params["session_id"] == ""
        assert params["workload_access_token"] == ""


class TestInvocationParamContract:
    """The invocation boundary is wired as:

        params = _extract_invocation_params(inp, request)   # a dict
        _run_task_background(**params)                       # kwargs unpack

    The ONLY thing keeping these in sync is that every dict key is a valid
    parameter name of ``_run_task_background`` (and vice-versa for required
    fields). A mismatch is invisible until runtime and crashes EVERY task
    with a ``NameError`` / ``TypeError`` — exactly the stacked-child regression
    (#247) where ``base_branch`` was passed to ``run_task`` but never extracted
    into the params dict. These tests lock that contract structurally so
    the next field added on one side but not the other fails in CI.
    """

    def _fake_req(self) -> Any:
        return _FakeRequest()

    def _payload(self, **extra):
        return {"repo_url": "org/repo", "task_description": "x", "task_id": "t-1", **extra}

    def test_every_extracted_key_is_a_valid_background_param(self):
        import inspect

        params = server._extract_invocation_params(self._payload(), self._fake_req())
        sig = inspect.signature(server._run_task_background)
        bg_param_names = set(sig.parameters)

        unknown = set(params) - bg_param_names
        assert not unknown, (
            f"_extract_invocation_params returns keys that _run_task_background "
            f"does not accept (would crash on **kwargs unpack): {sorted(unknown)}"
        )

    def test_extracted_params_unpack_into_background_signature(self):
        # Binding the extracted dict against the real signature is exactly
        # what `_run_task_background(**params)` does — this raises TypeError
        # if a key is unknown OR a required (no-default) param is missing.
        import inspect

        params = server._extract_invocation_params(self._payload(), self._fake_req())
        sig = inspect.signature(server._run_task_background)
        # Should not raise.
        sig.bind(**params)

    def test_base_branch_and_merge_branches_extracted_and_accepted(self):
        # The specific stacked-child fields whose omission caused the regression.
        import inspect

        params = server._extract_invocation_params(
            self._payload(base_branch="bgagent/taskA/a", merge_branches=["b1", "b2"]),
            self._fake_req(),
        )
        assert params["base_branch"] == "bgagent/taskA/a"
        assert params["merge_branches"] == ["b1", "b2"]
        # And they are real parameters of the background runner.
        bg = set(inspect.signature(server._run_task_background).parameters)
        assert {"base_branch", "merge_branches"} <= bg

    def test_stacking_fields_default_safely_when_absent(self):
        params = server._extract_invocation_params(self._payload(), self._fake_req())
        assert params["base_branch"] is None
        assert params["merge_branches"] == []

    def test_merge_branches_non_string_entries_filtered(self):
        params = server._extract_invocation_params(
            self._payload(merge_branches=["ok", 123, None, "ok2"]),
            self._fake_req(),
        )
        assert params["merge_branches"] == ["ok", "ok2"]


# --------------------------------------------------------------------------
# platform_config: payload-sourced platform env (ADR-021 P2)
# --------------------------------------------------------------------------


@pytest.fixture
def env_guard():
    """Snapshot/restore ``os.environ`` around a test that installs into it.

    ``_install_platform_config`` writes to the REAL process environment (that is
    its job), and ``monkeypatch`` cannot undo a write it did not make — so
    without this, one platform_config test would leak table names and a bogus
    ``AGENT_SESSION_ROLE_ARN`` into every test that runs after it (the conftest
    ``_clean_env`` fixture only strips the subset it knows about).
    """
    before = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(before)


class TestPlatformConfigContract:
    """The allowlist is a CROSS-PACKAGE contract, not an agent-local constant.

    The producer is the orchestrator's run-hook envelope builder
    (``cdk/src/handlers/shared/orchestrator.ts``); both sides read
    ``contracts/constants.json``. These tests are the agent-side tripwire: an
    edit to the contract that the CDK side has not followed shows up here.
    """

    def test_allowlist_is_sourced_from_the_shared_contract(self):
        from shared_constants import SHARED_CONSTANTS

        contract = SHARED_CONSTANTS["microvm_platform_config"]
        assert contract["env_by_key"] == server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY
        assert frozenset(contract["required"]) == server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS

    def test_wire_contract_is_exactly_the_documented_key_set(self):
        # Spelled out on purpose: this is the wire contract Stage B's producer is
        # written against, so a silent add/remove/rename must fail a test rather
        # than merely change a JSON file.
        assert server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY == {
            "task_table_name": "TASK_TABLE_NAME",
            "task_events_table_name": "TASK_EVENTS_TABLE_NAME",
            "task_approvals_table_name": "TASK_APPROVALS_TABLE_NAME",
            "nudges_table_name": "NUDGES_TABLE_NAME",
            "log_group_name": "LOG_GROUP_NAME",
            "artifacts_bucket_name": "ARTIFACTS_BUCKET_NAME",
            "trace_artifacts_bucket_name": "TRACE_ARTIFACTS_BUCKET_NAME",
            "github_token_secret_arn": "GITHUB_TOKEN_SECRET_ARN",
            "linear_oauth_secret_arn": "LINEAR_OAUTH_SECRET_ARN",
            "jira_oauth_secret_arn": "JIRA_OAUTH_SECRET_ARN",
            "agent_session_role_arn": "AGENT_SESSION_ROLE_ARN",
            "aws_sdk_ua_app_id": "AWS_SDK_UA_APP_ID",
            "anthropic_default_haiku_model": "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        }

    def test_required_subset_is_exactly_the_four_run_blocking_keys(self):
        assert (
            frozenset(
                {
                    "task_table_name",
                    "task_events_table_name",
                    "github_token_secret_arn",
                    "agent_session_role_arn",
                }
            )
            == server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        )

    def test_required_keys_are_all_on_the_allowlist(self):
        assert (
            set(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY)
            >= server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        )

    def test_env_names_are_upper_snake_and_unique(self):
        env_names = list(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.values())
        assert len(set(env_names)) == len(env_names)
        for name in env_names:
            assert server._PLATFORM_CONFIG_ENV_RE.match(name), name

    def test_memory_id_is_not_a_platform_config_key(self):
        # memory_id stays inside agent_payload: it is per-task state, not process
        # configuration. Asserted so a future "it's an env var too" refactor has
        # to argue with a test.
        assert "memory_id" not in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY

    def test_contract_validator_rejects_a_non_snake_case_key(self, monkeypatch):
        monkeypatch.setattr(
            server, "MICROVM_PLATFORM_CONFIG_ENV_BY_KEY", {"Task-Table": "TASK_TABLE_NAME"}
        )
        with pytest.raises(ValueError, match="not snake_case"):
            server._validate_platform_config_contract()

    def test_contract_validator_rejects_a_non_env_name_value(self, monkeypatch):
        monkeypatch.setattr(
            server, "MICROVM_PLATFORM_CONFIG_ENV_BY_KEY", {"task_table_name": "task table"}
        )
        with pytest.raises(ValueError, match="UPPER_SNAKE"):
            server._validate_platform_config_contract()

    def test_contract_validator_rejects_two_keys_on_one_env_var(self, monkeypatch):
        monkeypatch.setattr(
            server,
            "MICROVM_PLATFORM_CONFIG_ENV_BY_KEY",
            {"a_name": "SAME_ENV", "b_name": "SAME_ENV"},
        )
        monkeypatch.setattr(server, "MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS", frozenset({"a_name"}))
        with pytest.raises(ValueError, match="same env var"):
            server._validate_platform_config_contract()

    def test_contract_validator_rejects_a_required_key_off_the_allowlist(self, monkeypatch):
        monkeypatch.setattr(
            server, "MICROVM_PLATFORM_CONFIG_ENV_BY_KEY", {"task_table_name": "TASK_TABLE_NAME"}
        )
        monkeypatch.setattr(server, "MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS", frozenset({"nope"}))
        with pytest.raises(ValueError, match="absent from env_by_key"):
            server._validate_platform_config_contract()

    def test_contract_validator_rejects_an_empty_allowlist(self, monkeypatch):
        monkeypatch.setattr(server, "MICROVM_PLATFORM_CONFIG_ENV_BY_KEY", {})
        with pytest.raises(ValueError, match="must not be empty"):
            server._validate_platform_config_contract()

    def test_contract_validator_rejects_an_empty_required_set(self, monkeypatch):
        monkeypatch.setattr(server, "MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS", frozenset())
        with pytest.raises(ValueError, match="required must not be empty"):
            server._validate_platform_config_contract()


class TestInstallPlatformConfig:
    """Installing into ``os.environ`` is an env-injection surface — fail closed."""

    def test_absent_block_installs_nothing(self, env_guard):
        # The P1 envelope shape. A MicroVM image must still boot under an
        # orchestrator that predates Stage B: the snapshot env is all there is.
        assert server._install_platform_config(None) == []
        assert "TASK_TABLE_NAME" not in os.environ

    def test_installs_the_allowlisted_keys_as_upper_snake_env_vars(self, env_guard):
        installed = server._install_platform_config(_platform_config())
        assert installed == sorted(
            server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]
            for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        )
        assert os.environ["TASK_TABLE_NAME"] == "value-for-task_table_name"
        assert os.environ["AGENT_SESSION_ROLE_ARN"] == "value-for-agent_session_role_arn"

    def test_every_allowlisted_key_is_installable(self, env_guard):
        full = {key: f"v-{key}" for key in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY}
        installed = server._install_platform_config(full)
        assert installed == sorted(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.values())
        for key, env_name in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.items():
            assert os.environ[env_name] == f"v-{key}"

    def test_payload_wins_over_a_pre_existing_image_env_value(self, env_guard):
        # The load-bearing precedence rule: image env is frozen at snapshot time,
        # the payload describes the live deployment.
        os.environ["TASK_TABLE_NAME"] = "baked-into-the-snapshot"
        server._install_platform_config(_platform_config(task_table_name="live-table"))
        assert os.environ["TASK_TABLE_NAME"] == "live-table"

    def test_unknown_key_rejects_the_whole_block_and_installs_nothing(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(ld_preload="/tmp/evil.so"))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "ld_preload" in str(excinfo.value)
        # Fail CLOSED: not one key from a rejected block reaches the environment,
        # so a hostile key cannot ride along with valid ones.
        assert "TASK_TABLE_NAME" not in os.environ

    def test_unknown_key_message_lists_the_allowlist(self, env_guard):
        with pytest.raises(server._PlatformConfigError, match="task_table_name"):
            server._install_platform_config({"nope": "x"})

    @pytest.mark.parametrize("raw", ["a string", ["a", "list"], 42, True])
    def test_a_non_object_block_is_rejected(self, raw, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(raw)
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "must be an object" in str(excinfo.value)

    @pytest.mark.parametrize("value", [42, 1.5, ["x"], {"a": 1}, True])
    def test_a_non_string_value_is_rejected(self, value, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(log_group_name=value))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "must be" in str(excinfo.value)
        assert "LOG_GROUP_NAME" not in os.environ

    @pytest.mark.parametrize("value", ["", "   ", None])
    def test_a_blank_optional_value_is_treated_as_absent(self, value, env_guard):
        # The natural producer (`process.env.X ?? ''`) emits an empty string for a
        # resource the deployment does not have. Skipping is right; clobbering an
        # image value with "" would turn "absent there" into "unconfigured here".
        os.environ["LOG_GROUP_NAME"] = "from-the-image"
        installed = server._install_platform_config(_platform_config(log_group_name=value))
        assert "LOG_GROUP_NAME" not in installed
        assert os.environ["LOG_GROUP_NAME"] == "from-the-image"

    @pytest.mark.parametrize("value", ["", "  ", None])
    def test_a_blank_required_value_is_rejected(self, value, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(task_table_name=value))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"
        assert "task_table_name" in str(excinfo.value)
        assert "TASK_EVENTS_TABLE_NAME" not in os.environ

    def test_a_missing_required_key_is_rejected(self, env_guard):
        partial = _platform_config()
        partial.pop("agent_session_role_arn")
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(partial)
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"
        assert "agent_session_role_arn" in str(excinfo.value)

    def test_an_explicitly_empty_block_is_incomplete_not_absent(self, env_guard):
        # Sending the key with nothing in it is a producer bug; omitting the key
        # is the documented "I have nothing to say".
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config({})
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"

    def test_the_two_codes_are_distinct(self, env_guard):
        # One exception type, two operator remedies: fix the producer vs. fix the
        # deployment wiring. Collapsing them would send operators to the wrong one.
        with pytest.raises(server._PlatformConfigError) as invalid:
            server._install_platform_config({"bogus_key": "x"})
        with pytest.raises(server._PlatformConfigError) as incomplete:
            server._install_platform_config({"log_group_name": "lg"})
        assert invalid.value.code != incomplete.value.code


class TestMicrovmRunHookPlatformConfig:
    """``platform_config`` arrives on the ``/run`` hook as a SIBLING of ``agent_payload``."""

    def _payload(self, **extra) -> dict:
        return {
            "task_id": "t-pc",
            "repo_url": "org/repo",
            "prompt": "do it",
            "github_token": "ghp_x",
            **extra,
        }

    def test_inline_envelope_installs_the_config_and_accepts_the_task(
        self, client, monkeypatch, env_guard
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": self._payload(),
                    "platform_config": _platform_config(log_group_name="/abca/agent"),
                }
            ),
        )

        assert r.status_code == 200
        assert r.json()["status"] == "accepted"
        assert os.environ["TASK_TABLE_NAME"] == "value-for-task_table_name"
        assert os.environ["LOG_GROUP_NAME"] == "/abca/agent"

    def test_the_config_is_installed_BEFORE_credential_resolution(
        self, client, monkeypatch, env_guard
    ):
        # The ordering that makes the whole feature work: _extract_invocation_params
        # resolves the GitHub token, which reads GITHUB_TOKEN_SECRET_ARN. Installing
        # after that point would resolve the task against the snapshot's frozen env
        # and silently ignore everything the orchestrator sent.
        seen: dict = {}

        def fake_resolve_github_token():
            seen["gh_arn"] = os.environ.get("GITHUB_TOKEN_SECRET_ARN")
            seen["session_role"] = os.environ.get("AGENT_SESSION_ROLE_ARN")
            seen["threads_at_resolve"] = len(server._active_threads)
            return "ghp_resolved"

        monkeypatch.setattr(server, "resolve_github_token", fake_resolve_github_token)
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        payload = self._payload()
        payload.pop("github_token")  # force the resolver to run
        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": payload,
                    "platform_config": _platform_config(
                        github_token_secret_arn="arn:aws:secretsmanager:::secret:live"
                    ),
                }
            ),
        )

        assert r.status_code == 200
        assert seen["gh_arn"] == "arn:aws:secretsmanager:::secret:live"
        assert seen["session_role"] == "value-for-agent_session_role_arn"
        # ...and before the pipeline thread existed at all.
        assert seen["threads_at_resolve"] == 0

    def test_an_unknown_key_returns_400_and_starts_nothing(self, client, monkeypatch, env_guard):
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": self._payload(),
                    "platform_config": _platform_config(aws_endpoint_url="http://attacker"),
                }
            ),
        )

        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "aws_endpoint_url" in r.json()["message"]
        assert "TASK_TABLE_NAME" not in os.environ
        with server._threads_lock:
            assert server._active_threads == []

    def test_a_missing_required_key_returns_400_and_starts_nothing(
        self, client, monkeypatch, env_guard
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        partial = _platform_config()
        partial.pop("task_events_table_name")

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload": self._payload(), "platform_config": partial}),
        )

        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"
        assert "task_events_table_name" in r.json()["message"]
        with server._threads_lock:
            assert server._active_threads == []

    def test_a_non_object_block_returns_400(self, client, monkeypatch, env_guard):
        monkeypatch.setattr(server, "run_task", MagicMock())
        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {"agent_payload": self._payload(), "platform_config": "TASK_TABLE_NAME=x"}
            ),
        )
        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"

    def test_an_envelope_without_platform_config_is_still_accepted(
        self, client, monkeypatch, env_guard, capfd
    ):
        # P1 compatibility: image snapshot and orchestrator Lambda deploy on
        # independent cadences, so a new image must not require a Stage-B
        # orchestrator. It warns, loudly, rather than rejecting.
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload": self._payload()}))

        assert r.status_code == 200
        assert "no platform_config" in capfd.readouterr().out

    def test_s3_pointer_takes_the_config_from_the_outer_envelope(
        self, client, monkeypatch, env_guard
    ):
        # The producer's pointer form: the bare task payload lands in S3 and the
        # config rides beside the pointer, inside the 4 KB hook body.
        monkeypatch.setattr(
            server,
            "_fetch_microvm_payload_from_s3",
            lambda _uri: self._payload(task_id="t-outer"),
        )
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload_s3_uri": "s3://bucket/t-outer/payload.json",
                    "platform_config": _platform_config(task_table_name="outer-table"),
                }
            ),
        )

        assert r.status_code == 200
        assert r.json()["task_id"] == "t-outer"
        assert os.environ["TASK_TABLE_NAME"] == "outer-table"

    def test_s3_pointer_takes_the_config_merged_into_the_fetched_object(
        self, client, monkeypatch, env_guard
    ):
        # The producer ALSO merges the config into the S3 object, so the agent
        # gets it whichever end of the fetch it reads. A stray platform_config key
        # left in the bare payload is inert — the extractor reads named fields.
        fetched = self._payload(task_id="t-inner")
        fetched["platform_config"] = _platform_config(task_table_name="inner-table")
        monkeypatch.setattr(server, "_fetch_microvm_payload_from_s3", lambda _uri: fetched)
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload_s3_uri": "s3://bucket/t-inner/payload.json"}),
        )

        assert r.status_code == 200
        assert r.json()["task_id"] == "t-inner"
        assert os.environ["TASK_TABLE_NAME"] == "inner-table"

    def test_s3_object_may_itself_be_the_full_envelope(self, client, monkeypatch, env_guard):
        monkeypatch.setattr(
            server,
            "_fetch_microvm_payload_from_s3",
            lambda _uri: {
                "agent_payload": self._payload(task_id="t-nested"),
                "platform_config": _platform_config(task_table_name="nested-table"),
            },
        )
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload_s3_uri": "s3://bucket/t-nested/payload.json"}),
        )

        assert r.status_code == 200
        assert r.json()["task_id"] == "t-nested"
        assert os.environ["TASK_TABLE_NAME"] == "nested-table"

    def test_the_fetched_object_wins_over_the_outer_envelope(self, client, monkeypatch, env_guard):
        fetched = self._payload(task_id="t-prec")
        fetched["platform_config"] = _platform_config(task_table_name="inner-wins")
        monkeypatch.setattr(server, "_fetch_microvm_payload_from_s3", lambda _uri: fetched)
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload_s3_uri": "s3://bucket/t-prec/payload.json",
                    "platform_config": _platform_config(task_table_name="outer-loses"),
                }
            ),
        )

        assert r.status_code == 200
        assert os.environ["TASK_TABLE_NAME"] == "inner-wins"

    def test_a_nested_agent_payload_of_the_wrong_type_is_a_400(self, client, monkeypatch):
        monkeypatch.setattr(
            server,
            "_fetch_microvm_payload_from_s3",
            lambda _uri: {"agent_payload": "not-an-object"},
        )
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload_s3_uri": "s3://b/k"}))

        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_INVALID"
        assert "agent_payload in the S3 payload must be an object" in r.json()["message"]

    def test_resolve_returns_the_config_alongside_the_payload(self):
        payload, config = server._resolve_microvm_run_payload(
            json.dumps({"agent_payload": {"task_id": "t"}, "platform_config": {"a": "b"}})
        )
        assert payload == {"task_id": "t"}
        assert config == {"a": "b"}

    def test_resolve_returns_none_for_an_envelope_without_a_config(self):
        _payload, config = server._resolve_microvm_run_payload(
            json.dumps({"agent_payload": {"task_id": "t"}})
        )
        assert config is None


# --------------------------------------------------------------------------
# /validate + /terminate (ADR-021 P2)
# --------------------------------------------------------------------------


class TestMicrovmValidateHook:
    """A BUILD hook running under the BUILD role — so: shallow, and AWS-silent.

    ``CreateMicrovmImage`` runs ``/validate`` with the build role, which
    deliberately holds no Bedrock / Secrets Manager / DynamoDB grants. Every
    "deeper warm-up assertion" ADR-021 originally sketched here would therefore
    AccessDenied and fail every image build. The hook is a self-check, not a
    reachability probe.
    """

    def test_returns_200_with_the_individual_checks(self, client):
        r = client.post(VALIDATE_HOOK)
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "valid"
        assert body["checks"] == {
            "server_initialized": True,
            "hook_routes_registered": True,
            "python_version_supported": True,
            "platform_config_contract_loaded": True,
        }
        assert body["hook_prefix"] == server.MICROVM_HOOK_PREFIX
        assert body["platform_config_keys"] == len(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY)

    def test_makes_zero_aws_calls_even_with_a_log_group_configured(
        self, client, monkeypatch, capfd
    ):
        # The whole point. _debug_cw / _warn_cw build a CloudWatch Logs client
        # whenever LOG_GROUP_NAME is set, so a build hook must not use them; and
        # boto3.client() would populate boto3.DEFAULT_SESSION — a module global
        # holding the BUILD role's resolved credentials and region — which the
        # snapshot would then freeze in for every MicroVM launched from it.
        monkeypatch.setenv("LOG_GROUP_NAME", "/abca/agent")

        def forbidden(*_args, **_kwargs):
            raise AssertionError("a build hook must not make AWS calls")

        import boto3

        import aws_session

        monkeypatch.setattr(boto3, "client", forbidden)
        monkeypatch.setattr(boto3, "Session", forbidden)
        monkeypatch.setattr(aws_session, "platform_client", forbidden)
        monkeypatch.setattr(aws_session, "get_session", forbidden)
        monkeypatch.setattr(server, "_debug_cw", forbidden)
        monkeypatch.setattr(server, "_warn_cw", forbidden)

        assert client.post(VALIDATE_HOOK).status_code == 200
        # ...and it still logs, to stdout only.
        assert "/validate hook: ok" in capfd.readouterr().out

    def test_ready_is_also_aws_silent_with_a_log_group_configured(self, client, monkeypatch, capfd):
        # /ready runs under the same build role, so the same rule applies. It used
        # to route through _debug_cw, whose write can only FAIL under a role with
        # no Logs grant — and each failure bumps the shared _debug_cw_failures
        # counter, poisoning the "debug path is blind" signal on every build.
        monkeypatch.setenv("LOG_GROUP_NAME", "/abca/agent")

        def forbidden(*_args, **_kwargs):
            raise AssertionError("a build hook must not make AWS calls")

        monkeypatch.setattr(server, "_debug_cw", forbidden)
        monkeypatch.setattr(server, "_warn_cw", forbidden)

        assert client.post(READY_HOOK).status_code == 200
        assert "/ready hook" in capfd.readouterr().out

    def test_does_not_touch_credential_resolution(self, client, monkeypatch):
        import aws_session

        def forbidden(*_args, **_kwargs):
            raise AssertionError("/validate must not resolve credentials")

        monkeypatch.setattr(aws_session, "get_session", forbidden)
        monkeypatch.setattr(server, "resolve_github_token", forbidden)

        assert client.post(VALIDATE_HOOK).status_code == 200
        assert aws_session._session is None
        assert aws_session._scoped is None

    def test_starts_no_pipeline(self, client, monkeypatch):
        # The snapshot is taken right after the build hooks answer, so anything
        # started here would be frozen into the image.
        monkeypatch.setattr(server, "run_task", MagicMock())
        client.post(VALIDATE_HOOK)
        with server._threads_lock:
            assert server._active_threads == []

    def test_returns_503_while_the_module_is_still_initialising(self, client, monkeypatch):
        # Per the hook contract, 503 means "not ready yet". A permanently failing
        # check therefore fails the image build — the right outcome for a snapshot
        # that is genuinely broken.
        monkeypatch.setattr(server, "_module_initialized", False)
        r = client.post(VALIDATE_HOOK)
        assert r.status_code == 503
        assert r.json()["status"] == "not_ready"
        assert r.json()["failed_checks"] == ["server_initialized"]

    def test_reports_a_missing_hook_route(self, client, monkeypatch):
        monkeypatch.setattr(server, "MICROVM_HOOK_PREFIX", "/typo/prefix")
        r = client.post(VALIDATE_HOOK)
        assert r.status_code == 503
        assert "hook_routes_registered" in r.json()["failed_checks"]
        assert r.json()["missing_routes"] == [
            "/typo/prefix/ready",
            "/typo/prefix/run",
            "/typo/prefix/terminate",
            "/typo/prefix/validate",
        ]

    def test_reports_an_unsupported_interpreter(self, client, monkeypatch):
        monkeypatch.setattr(server, "_MIN_PYTHON_VERSION", (99, 0))
        r = client.post(VALIDATE_HOOK)
        assert r.status_code == 503
        assert "python_version_supported" in r.json()["failed_checks"]

    def test_reports_baked_secret_env_as_a_warning_not_a_failure(self, client, monkeypatch):
        # ADR-021 sub-decision 3: the snapshot must stay secret-free. REPORT-ONLY,
        # because the build environment's own credentials may legitimately be in
        # this process's env and failing here would fail every build. Names only.
        for name in server._SNAPSHOT_FORBIDDEN_SECRET_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_should_not_be_baked")
        r = client.post(VALIDATE_HOOK)
        assert r.status_code == 200
        assert r.json()["warnings"] == ["secret_env_present_in_snapshot:GITHUB_TOKEN"]
        assert "ghp_should_not_be_baked" not in r.text

    def test_no_warnings_on_a_clean_snapshot_env(self, client, monkeypatch):
        for name in server._SNAPSHOT_FORBIDDEN_SECRET_ENV:
            monkeypatch.delenv(name, raising=False)
        assert client.post(VALIDATE_HOOK).json()["warnings"] == []


class TestMicrovmTerminateHook:
    """Best-effort flush. Always 200, never a terminal status write."""

    def test_returns_200_with_no_body_at_all(self, client):
        # The hook must not turn a body-less call into FastAPI's 422: a 4xx here
        # reports a hook failure for a teardown that actually succeeded.
        r = client.post(TERMINATE_HOOK)
        assert r.status_code == 200
        assert r.json()["status"] == "acknowledged"
        assert r.json()["active_pipeline_threads"] == 0

    def test_echoes_the_microvm_id(self, client):
        r = client.post(TERMINATE_HOOK, json={"microvmId": "microvm-zzz"})
        assert r.status_code == 200
        assert r.json()["microvm_id"] == "microvm-zzz"

    def test_never_writes_terminal_task_status(self, client, monkeypatch):
        # The orchestrator owns terminal state: it finalizes the task and THEN
        # calls TerminateMicrovm, so a terminate hook that wrote a status would
        # race the finalization it follows and could clobber the real outcome.
        write_terminal = MagicMock()
        monkeypatch.setattr(server.task_state, "write_terminal", write_terminal)
        write_heartbeat = MagicMock()
        monkeypatch.setattr(server.task_state, "write_heartbeat", write_heartbeat)

        client.post(TERMINATE_HOOK, json={"microvmId": "m-1"})

        write_terminal.assert_not_called()
        write_heartbeat.assert_not_called()

    def test_returns_200_without_joining_a_running_pipeline(self, client, monkeypatch):
        # A drain can take minutes (that is lifespan's job on graceful shutdown);
        # the hook budget is 1-60 s, so /terminate must observe and return.
        release = threading.Event()
        entered = threading.Event()

        def slow_run_task(**_kwargs):
            entered.set()
            release.wait(timeout=10.0)

        monkeypatch.setattr(server, "run_task", slow_run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())
        try:
            client.post(
                RUN_HOOK,
                json=_run_hook_body(
                    {"agent_payload": {"task_id": "t-term", "repo_url": "o/r", "prompt": "x"}}
                ),
            )
            assert entered.wait(timeout=5.0)

            r = client.post(TERMINATE_HOOK, json={"microvmId": "m-live"})
            assert r.status_code == 200
            assert r.json()["active_pipeline_threads"] == 1
            # Still running: the hook did not stop or join it.
            with server._threads_lock:
                assert any(t.is_alive() for t in server._active_threads)
        finally:
            release.set()

    def test_emits_a_final_structured_log_line(self, client, capfd):
        client.post(TERMINATE_HOOK, json={"microvmId": "m-log"})
        out = capfd.readouterr().out
        assert "/terminate hook:" in out
        assert '"event": "microvm_terminate"' in out
        assert '"microvm_id": "m-log"' in out

    def test_still_returns_200_when_the_best_effort_step_fails(self, client, monkeypatch, capfd):
        def boom(*_args, **_kwargs):
            raise RuntimeError("log sink exploded")

        monkeypatch.setattr(server, "_debug_cw", boom)
        r = client.post(TERMINATE_HOOK, json={"microvmId": "m-boom"})
        assert r.status_code == 200
        # Best-effort, but not silent.
        assert "best-effort step failed" in capfd.readouterr().out


class TestMicrovmPayloadFetchAttribution:
    """Every outbound AWS call carries ABCA's solution attribution (#319)."""

    def test_the_s3_payload_fetch_goes_through_the_attributed_factory(self, monkeypatch):
        captured: dict = {}

        class _Body:
            @staticmethod
            def read():
                return b'{"task_id": "t-1"}'

        def fake_platform_client(service_name, **kwargs):
            captured["service"] = service_name
            captured["kwargs"] = kwargs
            return SimpleNamespace(get_object=lambda **_kw: {"Body": _Body})

        import aws_session

        monkeypatch.setattr(aws_session, "platform_client", fake_platform_client)

        assert server._fetch_microvm_payload_from_s3("s3://b/k") == {"task_id": "t-1"}
        assert captured["service"] == "s3"

    def test_the_fetch_client_carries_the_md_user_agent_segment(self, monkeypatch):
        # A naked boto3.client('s3') would silently drop the md/ segment. Assert on
        # the OUTCOME (the UA on the config) rather than on which helper was used.
        captured: dict = {}

        class _Body:
            @staticmethod
            def read():
                return b'{"task_id": "t-1"}'

        def fake_boto3_client(service_name, **kwargs):
            captured["service"] = service_name
            captured["config"] = kwargs.get("config")
            return SimpleNamespace(get_object=lambda **_kw: {"Body": _Body})

        import boto3

        monkeypatch.setattr(boto3, "client", fake_boto3_client)

        server._fetch_microvm_payload_from_s3("s3://b/k")

        import ua

        assert captured["service"] == "s3"
        assert ua.static_user_agent_extra() in captured["config"].user_agent_extra


class TestSnapshotCredentialHygiene:
    """Nothing on the server's import or /ready path may cache an SDK session.

    The MicroVM image is a SNAPSHOT: whatever module state exists when the
    snapshot is taken is replayed by every MicroVM launched from that image
    version. A boto3 session created during import or a build hook would freeze
    the BUILD role's resolved credential chain and the BUILD-time region into the
    image — inherited, stale and cross-role, by every task.

    Runs in a SUBPROCESS because the assertion is about process-global state
    (``sys.modules``, ``boto3.DEFAULT_SESSION``, ``aws_session._session``) that
    dozens of earlier tests in this suite have already populated in-process.
    """

    PROBE = """
import sys, time, threading
sys.path.insert(0, "src")
import server
import aws_session
from fastapi.testclient import TestClient

client = TestClient(server.app)
client.post("/aws/lambda-microvms/runtime/v1/ready")
client.post("/aws/lambda-microvms/runtime/v1/validate")

# Any AWS work would happen on a fire-and-forget daemon thread, so give one a
# chance to run before concluding that none exists.
for _ in range(20):
    if "boto3" in sys.modules:
        break
    time.sleep(0.05)

findings = {
    "boto3_imported": "boto3" in sys.modules,
    "botocore_imported": "botocore" in sys.modules,
    "cached_session": aws_session._session is not None,
    "scoped_resolved": aws_session._scoped is not None,
    "log_writer_threads": [
        t.name for t in threading.enumerate() if "cw-write" in t.name
    ],
}
print("FINDINGS:" + repr(findings))
"""

    def test_import_and_build_hooks_create_no_boto3_session(self):
        agent_dir = Path(__file__).resolve().parent.parent
        env = {
            **os.environ,
            # The hostile case: a snapshot that DID bake the log group would make
            # the old _debug_cw-based /ready spawn a CloudWatch writer.
            "LOG_GROUP_NAME": "/abca/agent",
            "AWS_REGION": "us-east-1",
            "PYTHONPATH": str(agent_dir / "src"),
        }
        proc = subprocess.run(
            [sys.executable, "-c", self.PROBE],
            cwd=str(agent_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
        line = next(
            (ln for ln in proc.stdout.splitlines() if ln.startswith("FINDINGS:")),
            None,
        )
        assert line is not None, proc.stdout
        findings = eval(line[len("FINDINGS:") :])  # noqa: S307 — our own repr()
        assert findings == {
            "boto3_imported": False,
            "botocore_imported": False,
            "cached_session": False,
            "scoped_resolved": False,
            "log_writer_threads": [],
        }


class TestMicrovmRunHookPreInstallAwsSilence:
    """Before ``platform_config`` is installed, ``/run`` may touch exactly ONE AWS seam.

    Same defect class the build hooks avoid, one phase later: until the install has
    run, ``LOG_GROUP_NAME`` is whatever the snapshot happens to carry, so a
    ``_debug_cw`` on this path would resolve credentials and pin
    ``boto3.DEFAULT_SESSION`` *before* the orchestrator's own region /
    ``AWS_SDK_UA_APP_ID`` / session role are in the environment. The sole permitted
    pre-install call is the S3 payload fetch, because the config is inside the
    object being fetched.

    Every test here runs with a **baked ``LOG_GROUP_NAME``** — the hostile case the
    fix exists for. Without it, ``_debug_cw`` degrades to stdout on its own and the
    assertions would pass vacuously.
    """

    def _payload(self, **extra) -> dict:
        return {
            "task_id": "t-silent",
            "repo_url": "org/repo",
            "prompt": "do it",
            "github_token": "ghp_x",
            **extra,
        }

    @pytest.fixture
    def seam_guard(self, monkeypatch):
        """Arm every AWS/credential seam to raise until the install has SUCCEEDED.

        The flag flips only on a successful ``_install_platform_config`` — so on a
        rejection path the seams stay armed for the whole request, which is exactly
        the property to assert there (a rejected run installed nothing, so it has
        no more right to an AWS call than it had before).
        """
        state: dict[str, Any] = {"install_phase_done": False, "violations": []}
        real_install = server._install_platform_config

        def spy_install(raw):
            result = real_install(raw)
            state["install_phase_done"] = True
            return result

        monkeypatch.setattr(server, "_install_platform_config", spy_install)

        def guard(name):
            def _seam(*_args, **_kwargs):
                if not state["install_phase_done"]:
                    state["violations"].append(name)
                    raise AssertionError(f"{name} touched before platform_config was installed")
                return MagicMock()

            return _seam

        import boto3

        import aws_session

        # Kept so a test can re-enable exactly the ONE permitted pre-install seam
        # (the S3 payload fetch) and assert on it positively.
        state["real_platform_client"] = aws_session.platform_client

        for module, attr in (
            (boto3, "client"),
            (boto3, "Session"),
            (aws_session, "platform_client"),
            (aws_session, "tenant_client"),
            (aws_session, "tenant_resource"),
            (aws_session, "get_session"),
            (server, "_debug_cw"),
            (server, "_warn_cw"),
            (server, "_debug_cw_exc"),
        ):
            monkeypatch.setattr(module, attr, guard(f"{module.__name__}.{attr}"))

        monkeypatch.setenv("LOG_GROUP_NAME", "/abca/agent")
        return state

    def test_no_cloudwatch_or_credential_seam_is_touched_before_the_install(
        self, client, monkeypatch, env_guard, seam_guard
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {"agent_payload": self._payload(), "platform_config": _platform_config()}
            ),
        )

        assert r.status_code == 200
        assert seam_guard["violations"] == []
        assert seam_guard["install_phase_done"] is True

    def test_the_received_line_is_stdout_only(
        self, client, monkeypatch, env_guard, seam_guard, capfd
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {"agent_payload": self._payload(), "platform_config": _platform_config()},
                microvm_id="microvm-quiet",
            ),
        )

        out = capfd.readouterr().out
        assert "[server/run-pre-config] /run hook received:" in out
        assert "microvm-quiet" in out

    def test_the_s3_payload_fetch_is_the_only_pre_install_aws_call(
        self, client, monkeypatch, env_guard, seam_guard
    ):
        # The permitted exception, asserted positively: exactly one client, for s3,
        # while the CloudWatch/credential seams stay armed.
        services: list[str] = []

        class _Body:
            @staticmethod
            def read():
                return json.dumps(self._payload(task_id="t-from-s3")).encode()

        def recording_client(service_name, **_kwargs):
            services.append(service_name)
            return SimpleNamespace(get_object=lambda **_kw: {"Body": _Body})

        import boto3

        import aws_session

        # Re-enable the one permitted seam, and only it: the fetch must still go
        # through the attributed factory (#319), which delegates to boto3.client.
        monkeypatch.setattr(aws_session, "platform_client", seam_guard["real_platform_client"])
        monkeypatch.setattr(boto3, "client", recording_client)
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload_s3_uri": "s3://payload-bucket/t-from-s3/payload.json",
                    "platform_config": _platform_config(),
                }
            ),
        )

        assert r.status_code == 200
        assert r.json()["task_id"] == "t-from-s3"
        assert services == ["s3"]
        assert seam_guard["violations"] == []

    def test_a_malformed_envelope_is_rejected_without_touching_a_seam(
        self, client, monkeypatch, seam_guard, capfd
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(RUN_HOOK, json={"microvmId": "m", "runHookPayload": "not json"})

        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_INVALID"
        assert seam_guard["violations"] == []
        assert seam_guard["install_phase_done"] is False
        # The reason still reaches an operator: stdout here, and the response body
        # (which the MicroVM service surfaces) in every case.
        assert "[server/run-pre-config] /run hook rejected:" in capfd.readouterr().out

    def test_a_failed_payload_fetch_is_reported_without_touching_a_seam(
        self, client, monkeypatch, seam_guard, capfd
    ):
        def boom(_uri):
            raise RuntimeError("AccessDenied")

        monkeypatch.setattr(server, "_fetch_microvm_payload_from_s3", boom)
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload_s3_uri": "s3://b/k"}))

        assert r.status_code == 500
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_UNREADABLE"
        assert seam_guard["violations"] == []
        out = capfd.readouterr().out
        assert "[server/run-pre-config] /run hook payload fetch FAILED" in out
        # The traceback is preserved on the stdout line (it is the only diagnostic
        # the response body does not carry).
        assert "Traceback" in out

    @pytest.mark.parametrize(
        "config,expected_code",
        [
            ({"ld_preload": "/tmp/evil.so"}, "MICROVM_RUN_PLATFORM_CONFIG_INVALID"),
            ({"log_group_name": "lg"}, "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"),
        ],
    )
    def test_a_rejected_platform_config_touches_no_seam(
        self, client, monkeypatch, env_guard, seam_guard, config, expected_code
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload": self._payload(), "platform_config": config}),
        )

        assert r.status_code == 400
        assert r.json()["code"] == expected_code
        # Nothing was installed, so nothing earned the right to an AWS call.
        assert seam_guard["violations"] == []
        assert seam_guard["install_phase_done"] is False

    def test_the_accepted_line_correlates_task_and_microvm_ids(
        self, client, monkeypatch, env_guard, capfd
    ):
        # The pre-install "received" line is stdout-only now, so the first line that
        # reaches the task's log group has to join both ids by itself.
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {"agent_payload": self._payload(), "platform_config": _platform_config()},
                microvm_id="microvm-joined",
            ),
        )

        out = capfd.readouterr().out
        assert "/run hook accepted task_id='t-silent' microvm_id='microvm-joined'" in out


class TestTerminateHookBodyTolerance:
    """``/terminate`` must answer 200 for ANY body — that is why it takes the raw request.

    A Pydantic body model is validated BEFORE the handler runs, so malformed JSON,
    a wrong content-type or a missing body would produce a 422 the handler never
    gets to prevent: a reported hook failure on a teardown that actually succeeded.
    """

    def test_malformed_json_still_returns_200(self, client, capfd):
        r = client.post(
            TERMINATE_HOOK,
            content=b'{"microvmId": "m-1"',  # truncated
            headers={"content-type": "application/json"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "acknowledged"
        assert r.json()["microvm_id"] == ""
        # Degraded, not silent.
        assert "/terminate hook body is not JSON" in capfd.readouterr().out

    def test_a_wrong_content_type_still_returns_200(self, client):
        r = client.post(
            TERMINATE_HOOK,
            content=b"microvmId=m-1",
            headers={"content-type": "text/plain"},
        )
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""

    def test_a_json_body_under_the_wrong_content_type_is_still_read(self, client):
        # The handler reads bytes, so it does not care what the sender declared.
        r = client.post(
            TERMINATE_HOOK,
            content=b'{"microvmId": "m-ct"}',
            headers={"content-type": "text/plain"},
        )
        assert r.status_code == 200
        assert r.json()["microvm_id"] == "m-ct"

    def test_an_empty_body_still_returns_200(self, client):
        r = client.post(TERMINATE_HOOK, content=b"")
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""

    def test_a_whitespace_only_body_still_returns_200(self, client):
        r = client.post(TERMINATE_HOOK, content=b"   \n ")
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""

    @pytest.mark.parametrize("body", [[1, 2, 3], "a string", 42, True])
    def test_a_non_object_json_body_still_returns_200(self, client, body):
        r = client.post(TERMINATE_HOOK, json=body)
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""

    @pytest.mark.parametrize("value", [42, None, ["m"], {"nested": "x"}])
    def test_a_non_string_microvm_id_degrades_to_empty(self, client, value):
        r = client.post(TERMINATE_HOOK, json={"microvmId": value})
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""

    def test_no_typed_body_model_is_left_on_the_route(self):
        # Structural guard: re-introducing a Pydantic body model would silently
        # restore the 422. FastAPI records body params in the route's dependant.
        routes: Any = server.app.routes
        route = next(r for r in routes if getattr(r, "path", None) == TERMINATE_HOOK)
        assert route.dependant.body_params == []

    def test_a_body_read_failure_still_returns_200(self, client, monkeypatch, capfd):
        # e.g. the service aborts mid-body as the VM goes down.
        async def boom():
            raise RuntimeError("connection reset")

        import starlette.requests

        monkeypatch.setattr(starlette.requests.Request, "body", lambda _self: boom())

        r = client.post(TERMINATE_HOOK, json={"microvmId": "m-x"})
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""
        assert "could not read its body" in capfd.readouterr().out


class TestParseTerminateMicrovmId:
    """Unit-level: the parser degrades, never raises."""

    def test_reads_the_service_camel_case_field(self):
        assert server._parse_terminate_microvm_id(b'{"microvmId": "m-1"}') == "m-1"

    def test_tolerates_the_snake_case_spelling(self):
        assert server._parse_terminate_microvm_id(b'{"microvm_id": "m-2"}') == "m-2"

    def test_camel_case_wins_when_both_are_present(self):
        raw = b'{"microvmId": "camel", "microvm_id": "snake"}'
        assert server._parse_terminate_microvm_id(raw) == "camel"

    @pytest.mark.parametrize(
        "raw",
        [
            b"",
            b"   ",
            b"{",
            b"not json",
            b"[1,2,3]",
            b'"a string"',
            b"{}",
            b'{"microvmId": null}',
            b'{"microvmId": 7}',
            b"\xff\xfe\x00bad utf8",
        ],
    )
    def test_every_unusable_body_yields_empty(self, raw):
        assert server._parse_terminate_microvm_id(raw) == ""

    def test_ignores_unrelated_fields(self):
        assert server._parse_terminate_microvm_id(b'{"reason": "idle", "x": 1}') == ""
