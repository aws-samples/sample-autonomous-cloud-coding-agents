"""Tests for AgentCore FastAPI server behavior."""

from __future__ import annotations

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

    deadline = time.time() + 5.0
    while time.time() < deadline:
        r = client.get("/ping")
        if r.status_code == 503:
            break
        time.sleep(0.05)
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
        json={"input": {"task_id": "t-missing", "task_type": "pr_review"}},
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


def test_validate_required_params_pr_types_require_pr_number():
    """PR-iteration and PR-review task_types need a pr_number regardless."""
    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "task_type": "pr_iteration",
            "pr_number": "",
        }
    )
    assert missing == ["pr_number"]

    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "task_type": "pr_review",
            "pr_number": "42",
        }
    )
    assert missing == []

    # new_task needs issue OR description.
    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "task_type": "new_task",
        }
    )
    assert missing == ["issue_number_or_task_description"]

    missing = server._validate_required_params(
        {
            "repo_url": "o/r",
            "task_type": "new_task",
            "task_description": "do the thing",
        }
    )
    assert missing == []


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

    def test_user_id_non_string_logs_warn(self, capsys):
        # Silent coercion is a documented anti-pattern in project
        # guidelines — if Stage 4 later skips the S3 upload because
        # ``user_id`` is empty, a user investigating "my trace never
        # appeared" needs a signal in CloudWatch to correlate.
        server._extract_invocation_params(
            self._base_payload(user_id=12345, task_id="t-warn"),
            self._fake_req(),
        )
        captured = capsys.readouterr()
        assert "[server/warn]" in captured.out
        assert "user_id payload field is not a string" in captured.out
        assert "type=int" in captured.out
        assert "'t-warn'" in captured.out
