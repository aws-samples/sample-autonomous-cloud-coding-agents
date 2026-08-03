"""Tests for AgentCore FastAPI server behavior."""

from __future__ import annotations

import json
import threading
import time
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
    """K2 Stage 3: ``user_id`` is the platform Cognito ``sub`` threaded
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

    def test_ready_does_not_start_a_pipeline(self, client, monkeypatch):
        # A build hook must never run task work: the snapshot is taken right
        # after it answers, so anything it starts would be frozen into the image.
        monkeypatch.setattr(server, "run_task", MagicMock())
        client.post(READY_HOOK)
        with server._threads_lock:
            assert server._active_threads == []

    def test_validate_and_suspend_resume_terminate_are_NOT_served(self, client):
        # Declaring a hook nothing answers fails the corresponding build or
        # lifecycle transition, so the construct declares exactly /ready + /run.
        # This asserts the agent side of that: the others must 404.
        for hook in ("validate", "suspend", "resume", "terminate"):
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
