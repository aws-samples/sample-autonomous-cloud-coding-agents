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
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture(autouse=True)
def reset_server_state():
    """Reset the pipeline registry, joining any thread still running on the way out.

    A thread that is still alive after the join fails the test that started it.
    """
    server._background_pipeline_failed = False
    with server._threads_lock:
        server._active_threads.clear()
    yield
    for thread in threading.enumerate():
        if thread.name.startswith("pipeline-") and thread.is_alive():
            thread.join(timeout=10)
    for thread in threading.enumerate():
        if thread.name.endswith("-cw-write"):
            thread.join(timeout=10)
    server._background_pipeline_failed = False
    with server._threads_lock:
        server._active_threads.clear()
    leaked = [
        thread.name
        for thread in threading.enumerate()
        if thread.name.startswith("pipeline-") or thread.name.endswith("-cw-write")
    ]
    assert not leaked, f"threads outlived the test that started them (10 s join): {leaked}"


_TWO_TESTS_AROUND_A_LATE_PIPELINE = """
import threading
from unittest.mock import MagicMock

import server
from tests.test_server import reset_server_state  # the fixture under test, autouse here too

first_stub = MagicMock(name="the first test's run_task")
release = threading.Event()
pipeline = None


def test_first_ends_before_its_pipeline_has_looked_up_run_task(monkeypatch):
    global pipeline
    monkeypatch.setattr(server, "run_task", first_stub)

    def body(**kwargs):
        if not release.wait(timeout=30):
            return  # nothing released it: end, rather than run whatever run_task is by then
        server.run_task(**kwargs)  # looked up when executed, as in _run_task_background

    monkeypatch.setattr(server, "_run_task_background", body)
    pipeline = server._spawn_background({"task_id": "first"})
    join = pipeline.join

    def join_and_release(timeout=None):
        release.set()  # the thread reaches run_task only once something waits for it
        join(timeout)

    monkeypatch.setattr(pipeline, "join", join_and_release)


def test_second_is_not_reached_by_the_first_tests_pipeline(monkeypatch):
    second_stub = MagicMock(name="the second test's run_task")
    monkeypatch.setattr(server, "run_task", second_stub)
    release.set()  # only a thread that nothing joined still waits: it runs into this test
    pipeline.join(timeout=10)

    second_stub.assert_not_called()
    first_stub.assert_called_once_with(task_id="first")
"""


def test_a_pipeline_thread_never_reaches_the_run_task_stub_of_the_next_test(tmp_path):
    (tmp_path / "test_late_pipeline.py").write_text(_TWO_TESTS_AROUND_A_LATE_PIPELINE)
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-c",
            "pyproject.toml",
            "-p",
            "tests.conftest",
            "-p",
            "no:cacheprovider",
            str(tmp_path),
        ],
        cwd=str(Path(__file__).resolve().parent.parent),
        env={name: value for name, value in os.environ.items() if name != "PYTEST_ADDOPTS"},
        capture_output=True,
        text=True,
        timeout=110,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "2 passed" in proc.stdout, proc.stdout + proc.stderr


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
    assert started.wait(timeout=3)


def test_sync_path_preserved_for_application_json_accept(client, monkeypatch):
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
    monkeypatch.setattr(server, "_background_pipeline_failed", False)
    with server._threads_lock:
        server._active_threads.clear()
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.json() == {"status": "healthy"}


def test_ping_reports_healthybusy_when_pipeline_alive(client, monkeypatch):
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
    assert spawn_calls == []


def test_spawn_background_resets_pipeline_failed_flag(monkeypatch):
    server._background_pipeline_failed = True
    with server._threads_lock:
        server._active_threads.clear()

    monkeypatch.setattr(server, "_run_task_background", lambda **_kwargs: None)

    thread = server._spawn_background(
        {"task_id": "t-reset", "repo_url": "o/r", "task_description": "x"}
    )
    thread.join(timeout=2)

    assert server._background_pipeline_failed is False

    with server._threads_lock:
        server._active_threads.clear()


def test_run_task_background_starts_and_stops_heartbeat(monkeypatch):
    heartbeat_calls: list[str] = []

    def fake_write_heartbeat(task_id: str) -> None:
        heartbeat_calls.append(task_id)

    monkeypatch.setattr(server.task_state, "write_heartbeat", fake_write_heartbeat)
    monkeypatch.setattr(server, "_HEARTBEAT_INTERVAL_SECONDS", 0.05)

    def fake_run_task(**_kwargs):
        time.sleep(0.15)

    monkeypatch.setattr(server, "run_task", fake_run_task)
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

    assert len(heartbeat_calls) >= 1
    assert heartbeat_calls[0] == "t-heartbeat"


def test_a_reused_server_runs_successive_tasks(monkeypatch):
    import aws_session

    aws_session.reset_session_cache()
    monkeypatch.delenv(aws_session.SESSION_ROLE_ARN_ENV, raising=False)
    monkeypatch.setattr(server.task_state, "write_heartbeat", lambda _task_id: None)
    monkeypatch.setattr(server.task_state, "write_terminal", lambda *a, **kw: None)
    seen: list[str] = []

    def fake_run_task(**kwargs):
        aws_session.configure_session(user_id="u", repo="o/r", task_id=kwargs["task_id"])
        with patch("boto3.Session", return_value=MagicMock()):
            aws_session.get_session()
        seen.append(kwargs["task_id"])

    monkeypatch.setattr(server, "run_task", fake_run_task)

    def run(task_id: str) -> None:
        server._run_task_background(
            task_id=task_id,
            repo_url="o/r",
            task_description="x",
            issue_number="",
            github_token="",
            anthropic_model="",
            max_turns=10,
            max_budget_usd=None,
            aws_region="us-east-1",
        )

    run("t-first")
    run("t-second")

    assert seen == ["t-first", "t-second"]
    assert aws_session._session is None


def test_run_task_background_propagates_correlation_envelope(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(
        server,
        "propagate_correlation_context",
        lambda session_id, **kw: calls.append({"session_id": session_id, **kw}),
    )
    monkeypatch.setattr(server, "run_task", lambda **_kwargs: None)
    monkeypatch.setattr(server.task_state, "write_heartbeat", lambda *a, **kw: None)
    monkeypatch.setattr(server.task_state, "write_terminal", lambda *a, **kw: None)

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
    missing = server._validate_required_params(
        {
            "resolved_workflow": {"id": "default/agent-v1", "version": "1.0.0"},
            "task_description": "Summarise these papers",
        }
    )
    assert missing == []

    missing = server._validate_required_params(
        {
            "resolved_workflow": {"id": "coding/new-task-v1", "version": "1.0.0"},
            "task_description": "do the thing",
        }
    )
    assert missing == ["repo_url"]


def test_drain_threads_joins_active_threads():
    stop = threading.Event()

    def worker():
        stop.wait(timeout=1)

    t = threading.Thread(target=worker, name="drain-test")
    t.start()
    with server._threads_lock:
        server._active_threads.clear()
        server._active_threads.append(t)

    stop.set()
    server._drain_threads(timeout=5)
    assert not t.is_alive()

    with server._threads_lock:
        server._active_threads.clear()


def test_debug_cw_write_blocking_no_log_group_is_noop(monkeypatch):
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    server._debug_cw("hello", task_id="t")


def test_debug_cw_exc_appends_the_traceback(monkeypatch, capfd):
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    try:
        raise RuntimeError("kaboom")
    except RuntimeError as exc:
        server._debug_cw_exc("something FAILED", exc, task_id="t")
    out = capfd.readouterr().out
    assert "something FAILED [RuntimeError: kaboom]" in out
    assert "Traceback" in out


def test_debug_cw_write_blocking_reports_a_boto_error_on_stdout(monkeypatch, capfd):
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

    out = capfd.readouterr().out
    assert (
        "[server/debug/self] CloudWatch write failed: RuntimeError: simulated boto failure" in out
    )
    assert "hello" not in out


def test_warn_cw_prints_stamped_line_to_stdout(monkeypatch, capfd):
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    server._warn_cw("something went wrong", task_id="t-1")
    captured = capfd.readouterr()
    assert "[server/warn] something went wrong" in captured.out


def test_warn_cw_no_log_group_is_noop(monkeypatch):
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


def test_warn_cw_write_blocking_reports_a_boto_error_on_stdout(monkeypatch, capfd):
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

    out = capfd.readouterr().out
    assert "[server/warn/self] CloudWatch write failed: RuntimeError: simulated boto failure" in out
    assert "malformed payload" not in out


def test_warn_cw_write_blocking_uses_server_warn_stream(monkeypatch):
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


class _FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


class TestExtractTrace:
    def _base_payload(self, **extra):
        return {
            "repo_url": "org/repo",
            "task_description": "Fix it",
            "task_id": "t-1",
            **extra,
        }

    def _fake_req(self) -> Any:
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
        params = server._extract_invocation_params(
            self._base_payload(user_id=12345),
            self._fake_req(),
        )
        assert params["user_id"] == ""

    def test_user_id_non_string_logs_warn(self, capfd):
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


READY_HOOK = f"{server.MICROVM_HOOK_PREFIX}/ready"
RUN_HOOK = f"{server.MICROVM_HOOK_PREFIX}/run"
VALIDATE_HOOK = f"{server.MICROVM_HOOK_PREFIX}/validate"
TERMINATE_HOOK = f"{server.MICROVM_HOOK_PREFIX}/terminate"


_TEST_ACCOUNT = "123456789012"


def _platform_config_value(key: str) -> str:
    if key not in server.MICROVM_PLATFORM_CONFIG_ARN_KEYS:
        return f"value-for-{key}"
    if key.endswith("_role_arn"):
        return f"arn:aws:iam::{_TEST_ACCOUNT}:role/for-{key}"
    return f"arn:aws:secretsmanager:us-east-1:{_TEST_ACCOUNT}:secret:for-{key}"


def _platform_config(**overrides) -> dict:
    config = {
        key: _platform_config_value(key) for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
    }
    config.update(overrides)
    return config


def _run_hook_body(envelope: dict, microvm_id: str = "microvm-abc") -> dict:
    """The service passes ``runHookPayload`` through as an opaque STRING (it never
    parses it), so the double encoding here is the real wire shape.
    """
    return {"microvmId": microvm_id, "runHookPayload": json.dumps(envelope)}


_PORTABLE_WARMUP = (sys.executable, "--version")


@pytest.fixture
def warm_ready(monkeypatch):
    """Pin ``/ready``'s warm-up to :data:`_PORTABLE_WARMUP` and nothing optional."""
    monkeypatch.setattr(server, "_READY_WARMUP_REQUIRED", _PORTABLE_WARMUP)
    monkeypatch.setattr(server, "_READY_WARMUP_OPTIONAL", ())


class TestMicrovmReadyHook:
    def test_ready_returns_200_once_the_server_is_up_and_warm(self, client, warm_ready):
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

    def test_ready_does_not_start_a_pipeline(self, client, monkeypatch, warm_ready):
        monkeypatch.setattr(server, "run_task", MagicMock())
        client.post(READY_HOOK)
        with server._threads_lock:
            assert server._active_threads == []

    def test_suspend_and_resume_require_a_registered_task(self, client):
        for hook in ("suspend", "resume"):
            response = client.post(f"{server.MICROVM_HOOK_PREFIX}/{hook}")
            assert response.status_code == 409
            assert response.json()["code"] == "MICROVM_LIFECYCLE_UNAVAILABLE"


class TestMicrovmReadyHookWarmUp:
    def test_the_warm_up_execs_every_command_once_required_first(self, client, monkeypatch):
        calls: list[list[str]] = []

        def fake_run(argv, **kwargs):
            calls.append(list(argv))
            assert kwargs["capture_output"] is True
            assert kwargs["check"] is False
            return subprocess.CompletedProcess(argv, 0, stdout="2.1.191 (Claude Code)\n", stderr="")

        monkeypatch.setattr(server.subprocess, "run", fake_run)
        assert client.post(READY_HOOK).status_code == 200
        assert calls[0] == ["claude", "--version"]
        assert calls == [list(server._READY_WARMUP_REQUIRED)] + [
            list(argv) for argv in server._READY_WARMUP_OPTIONAL
        ]

    def test_claude_is_the_only_REQUIRED_warm_up(self):
        assert server._READY_WARMUP_REQUIRED[0] == "claude"
        assert "claude" not in [argv[0] for argv in server._READY_WARMUP_OPTIONAL]
        for argv in (server._READY_WARMUP_REQUIRED, *server._READY_WARMUP_OPTIONAL):
            assert argv[1:] == ("--version",)

    def test_a_required_warm_up_timeout_reports_503_not_ready(self, client, monkeypatch, capfd):
        def slow(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

        monkeypatch.setattr(server.subprocess, "run", slow)
        r = client.post(READY_HOOK)
        assert r.status_code == 503
        assert r.json()["status"] == "not_ready"
        assert any("claude" in f for f in r.json()["failed_warmups"])
        out = capfd.readouterr().out
        assert "warm-up of 'claude' FAILED" in out
        assert "TimeoutExpired" in out

    def test_a_missing_binary_reports_503(self, client, monkeypatch):
        def missing(argv, **kwargs):
            raise FileNotFoundError(argv[0])

        monkeypatch.setattr(server.subprocess, "run", missing)
        assert client.post(READY_HOOK).status_code == 503

    def test_a_nonzero_exit_reports_503(self, client, monkeypatch):
        def broken(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="Exec format error")

        monkeypatch.setattr(server.subprocess, "run", broken)
        r = client.post(READY_HOOK)
        assert r.status_code == 503
        assert r.json()["failed_warmups"] == ["claude:exit1"]

    def test_a_BEST_EFFORT_failure_still_reports_ready(self, client, monkeypatch, capfd):
        def selective(argv, **kwargs):
            if argv[0] == "claude":
                return subprocess.CompletedProcess(argv, 0, stdout="2.1.191\n", stderr="")
            raise FileNotFoundError(argv[0])

        monkeypatch.setattr(server.subprocess, "run", selective)
        r = client.post(READY_HOOK)
        assert r.status_code == 200
        assert r.json() == {"status": "ready"}
        out = capfd.readouterr().out
        assert "warmed 'claude'" in out
        assert "warm-up of 'git' FAILED" in out

    def test_an_unexpected_subprocess_error_becomes_503_not_500(self, client, monkeypatch):
        def exploding(argv, **kwargs):
            raise OSError("resource temporarily unavailable")

        monkeypatch.setattr(server.subprocess, "run", exploding)
        assert client.post(READY_HOOK).status_code == 503

    def test_the_warm_up_makes_no_aws_call_even_with_a_log_group_baked(
        self, client, monkeypatch, capfd, warm_ready
    ):
        monkeypatch.setenv("LOG_GROUP_NAME", "/abca/agent")

        def forbidden(*_args, **_kwargs):
            raise AssertionError("the /ready warm-up must not make AWS calls")

        monkeypatch.setattr(server, "_debug_cw", forbidden)
        monkeypatch.setattr(server, "_warn_cw", forbidden)
        assert client.post(READY_HOOK).status_code == 200
        assert "warmed" in capfd.readouterr().out

    def test_warm_snapshot_binaries_returns_only_required_failures(self, monkeypatch):
        monkeypatch.setattr(server, "_READY_WARMUP_REQUIRED", ("nope-required", "--version"))
        monkeypatch.setattr(server, "_READY_WARMUP_OPTIONAL", (("nope-optional", "--version"),))

        def missing(argv, **kwargs):
            raise FileNotFoundError(argv[0])

        monkeypatch.setattr(server.subprocess, "run", missing)
        assert server._warm_snapshot_binaries() == ["nope-required:FileNotFoundError"]


class _FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class TestMicrovmReadyWarmUpBudget:
    @pytest.fixture
    def clock(self, monkeypatch):
        fake = _FakeClock()
        monkeypatch.setattr(server, "_time_for_debug", fake)
        return fake

    @staticmethod
    def _timeout_recorder(clock: _FakeClock, *, hang: tuple[str, ...] = (), fail: bool = False):
        seen: list[tuple[str, float]] = []

        def fake_run(argv, **kwargs):
            timeout = kwargs["timeout"]
            seen.append((argv[0], timeout))
            if argv[0] in hang:
                clock.advance(timeout)
                raise subprocess.TimeoutExpired(argv, timeout)
            if fail:
                clock.advance(timeout)
                raise subprocess.TimeoutExpired(argv, timeout)
            clock.advance(0.1)
            return subprocess.CompletedProcess(argv, 0, stdout="v1\n", stderr="")

        return fake_run, seen

    def test_the_ceiling_leaves_margin_inside_the_hook_budget(self):
        assert server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS >= 60
        assert (
            server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS
            < server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        )
        from shared_constants import SHARED_CONSTANTS

        budgets = SHARED_CONSTANTS["microvm_hook_budgets"]
        ready_hook_budget = budgets["ready_hook_timeout_seconds"]
        assert ready_hook_budget > server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        assert budgets["warmup_total_budget_seconds"] == (server._READY_WARMUP_TOTAL_BUDGET_SECONDS)
        assert budgets["warmup_required_timeout_seconds"] == (
            server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS
        )
        assert ready_hook_budget - server._READY_WARMUP_TOTAL_BUDGET_SECONDS >= 30

    def test_ALL_commands_slow_still_answers_within_the_ceiling(self, client, clock, monkeypatch):
        fake_run, seen = self._timeout_recorder(clock, fail=True)
        monkeypatch.setattr(server.subprocess, "run", fake_run)
        started = clock.now

        r = client.post(READY_HOOK)

        assert r.status_code == 503
        elapsed = clock.now - started
        assert elapsed <= server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        assert [name for name, _ in seen] == ["claude"]
        assert seen[0][1] == server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS

    def test_every_command_slow_but_none_skipped_stays_under_the_ceiling(
        self, client, clock, monkeypatch
    ):
        fake_run, seen = self._timeout_recorder(clock, hang=("git", "node"))
        monkeypatch.setattr(server.subprocess, "run", fake_run)
        started = clock.now

        assert client.post(READY_HOOK).status_code == 200

        assert clock.now - started <= server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        optional_timeouts = [timeout for name, timeout in seen if name != "claude"]
        assert optional_timeouts == sorted(optional_timeouts, reverse=True)
        assert sum(t for _, t in seen) <= (
            server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS
            + server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        )

    def test_a_HUNG_optional_command_never_blocks_the_200(self, client, clock, monkeypatch, capfd):
        fake_run, seen = self._timeout_recorder(clock, hang=("git", "node"))
        monkeypatch.setattr(server.subprocess, "run", fake_run)

        r = client.post(READY_HOOK)

        assert r.status_code == 200
        assert r.json() == {"status": "ready"}
        out = capfd.readouterr().out
        assert "warmed 'claude'" in out
        assert "warm-up of 'git' FAILED" in out
        assert [name for name, _ in seen] == ["claude", "git"]
        assert "skipping best-effort warm-up of 'node'" in out

    def test_the_required_command_gets_its_OWN_budget_not_a_share(self, client, clock, monkeypatch):
        fake_run, seen = self._timeout_recorder(clock)
        monkeypatch.setattr(server.subprocess, "run", fake_run)
        assert client.post(READY_HOOK).status_code == 200
        assert seen[0] == ("claude", server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS)

    def test_an_optional_command_is_skipped_when_the_remainder_is_useless(
        self, clock, monkeypatch, capfd
    ):
        monkeypatch.setattr(server, "_READY_WARMUP_REQUIRED", ("req", "--version"))
        monkeypatch.setattr(server, "_READY_WARMUP_OPTIONAL", (("opt", "--version"),))
        started = clock.now

        def fake_run(argv, **kwargs):
            clock.advance(server._READY_WARMUP_TOTAL_BUDGET_SECONDS)
            return subprocess.CompletedProcess(argv, 0, stdout="v\n", stderr="")

        monkeypatch.setattr(server.subprocess, "run", fake_run)
        assert server._warm_snapshot_binaries() == []
        assert clock.now - started == server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        assert "skipping best-effort warm-up of 'opt'" in capfd.readouterr().out


class TestMicrovmRunHookInlinePayload:
    def test_accepts_the_payload_and_starts_the_pipeline_asynchronously(
        self, client, monkeypatch, baked_platform_env
    ):
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
        assert body["microvm_id"] == "microvm-inline"

        assert started.wait(timeout=5.0), "pipeline thread did not start"
        assert seen["task_id"] == "t-microvm-1"
        assert seen["repo_url"] == "org/repo"
        assert seen["task_description"] == "Fix the bug"

    def test_returns_before_the_pipeline_finishes(self, client, monkeypatch, baked_platform_env):
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
            assert r.status_code == 200
            assert entered.wait(timeout=5.0)
            with server._threads_lock:
                assert any(t.is_alive() for t in server._active_threads)
        finally:
            release.set()

    def test_uses_the_same_model_id_and_prompt_aliases_as_invocations(
        self, client, monkeypatch, baked_platform_env
    ):
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
    def test_fetches_the_payload_from_s3_and_starts_the_pipeline(
        self, client, monkeypatch, baked_platform_env
    ):
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

        with pytest.raises(server._PayloadFetchError, match="expected an object"):
            server._fetch_microvm_payload_from_s3("s3://b/k")
        assert not issubclass(server._PayloadFetchError, ValueError)

    def test_s3_failure_returns_500_and_starts_nothing(self, client, monkeypatch):
        def boom(_uri):
            raise RuntimeError("AccessDenied")

        monkeypatch.setattr(server, "_fetch_microvm_payload_from_s3", boom)
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload_s3_uri": "s3://bucket/key"}))

        assert r.status_code == 500
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_UNREADABLE"
        assert "AccessDenied" in r.json()["message"]
        with server._threads_lock:
            assert server._active_threads == []


class TestMicrovmRunHookRejections:
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
        monkeypatch.setattr(server, "run_task", MagicMock())
        r = client.post(RUN_HOOK, json={})
        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_INVALID"

    def test_incomplete_task_record_reuses_the_invocations_rejection_shape(
        self, client, monkeypatch, baked_platform_env
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload": {"task_id": "t-bad"}}),
        )

        assert r.status_code == 400
        body = r.json()
        assert body["code"] == "TASK_RECORD_INCOMPLETE"
        assert "repo_url" in body["missing"]
        with server._threads_lock:
            assert server._active_threads == []


class TestMicrovmRunHookHeaderPosture:
    def test_session_id_and_workload_token_resolve_empty(
        self, client, monkeypatch, baked_platform_env
    ):
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
        fake_request: Any = _FakeRequest()
        params = server._extract_invocation_params(
            {"task_id": "t-hdr", "repo_url": "o/r", "prompt": "x"}, fake_request
        )
        assert params["session_id"] == ""
        assert params["workload_access_token"] == ""


class TestInvocationParamContract:
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
        import inspect

        params = server._extract_invocation_params(self._payload(), self._fake_req())
        sig = inspect.signature(server._run_task_background)
        sig.bind(**params)

    def test_base_branch_and_merge_branches_extracted_and_accepted(self):
        import inspect

        params = server._extract_invocation_params(
            self._payload(base_branch="bgagent/taskA/a", merge_branches=["b1", "b2"]),
            self._fake_req(),
        )
        assert params["base_branch"] == "bgagent/taskA/a"
        assert params["merge_branches"] == ["b1", "b2"]
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


@pytest.fixture
def baked_platform_env(env_guard):
    """Simulate a legacy/hand-built image that BAKES its own required config."""
    for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS:
        os.environ[server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]] = _platform_config_value(key)
    os.environ["GITHUB_TOKEN"] = "ghp_baked_for_tests"  # noqa: S105 -- test placeholder, not a secret
    yield


@pytest.fixture
def env_guard():
    """Snapshot/restore ``os.environ`` around a test that installs into it."""
    before = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(before)


class TestPlatformConfigContract:
    def test_allowlist_is_sourced_from_the_shared_contract(self):
        from shared_constants import SHARED_CONSTANTS

        contract = SHARED_CONSTANTS["microvm_platform_config"]
        assert contract["env_by_key"] == server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY
        assert frozenset(contract["required"]) == server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS

    def test_wire_contract_is_exactly_the_documented_key_set(self):
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
            "anthropic_model": "ANTHROPIC_MODEL",
            "tool_gateway_url": "ABCA_TOOL_GATEWAY_URL",
            "linear_vault_enabled": "LINEAR_VAULT_ENABLED",
            "linear_workload_identity_name": "LINEAR_WORKLOAD_IDENTITY_NAME",
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


class TestHookBudgetContract:
    def test_budgets_are_sourced_from_the_shared_contract(self):
        from shared_constants import SHARED_CONSTANTS

        budgets = SHARED_CONSTANTS["microvm_hook_budgets"]
        assert budgets["warmup_total_budget_seconds"] == server._READY_WARMUP_TOTAL_BUDGET_SECONDS
        assert (
            budgets["warmup_required_timeout_seconds"]
            == server._READY_WARMUP_REQUIRED_TIMEOUT_SECONDS
        )

    def test_the_shipped_contract_satisfies_its_own_invariant(self):
        server._validate_hook_budget_contract()

    @pytest.mark.parametrize(
        "budgets,match",
        [
            (
                {
                    "ready_hook_timeout_seconds": 300,
                    "warmup_total_budget_seconds": 300,
                    "warmup_required_timeout_seconds": 120,
                },
                "must be < ready_hook_timeout_seconds",
            ),
            (
                {
                    "ready_hook_timeout_seconds": 300,
                    "warmup_total_budget_seconds": 240,
                    "warmup_required_timeout_seconds": 240,
                },
                "must be < warmup_total_budget_seconds",
            ),
            (
                {
                    "ready_hook_timeout_seconds": 0,
                    "warmup_total_budget_seconds": 240,
                    "warmup_required_timeout_seconds": 120,
                },
                "must be a positive integer",
            ),
            (
                {
                    "ready_hook_timeout_seconds": 300,
                    "warmup_total_budget_seconds": "240",
                    "warmup_required_timeout_seconds": 120,
                },
                "must be a positive integer",
            ),
            (
                {
                    "ready_hook_timeout_seconds": 300,
                    "warmup_total_budget_seconds": 240,
                    "warmup_required_timeout_seconds": None,
                },
                "warmup_required_timeout_seconds must be a positive integer",
            ),
        ],
        ids=["total-equals-hook", "required-equals-total", "zero", "string", "missing"],
    )
    def test_a_contract_that_cannot_hold_fails_the_image_build(self, monkeypatch, budgets, match):
        monkeypatch.setattr(server, "_HOOK_BUDGETS", budgets)
        with pytest.raises(ValueError, match=match):
            server._validate_hook_budget_contract()


class TestInstallPlatformConfig:
    def test_absent_block_installs_nothing(self, env_guard):
        assert server._install_platform_config(None) == []
        assert "TASK_TABLE_NAME" not in os.environ

    def test_installs_the_allowlisted_keys_as_upper_snake_env_vars(self, env_guard):
        installed = server._install_platform_config(_platform_config())
        assert installed == sorted(
            server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]
            for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        )
        assert os.environ["TASK_TABLE_NAME"] == "value-for-task_table_name"
        assert os.environ["AGENT_SESSION_ROLE_ARN"] == _platform_config_value(
            "agent_session_role_arn"
        )

    def test_every_allowlisted_key_is_installable(self, env_guard):
        full = {
            key: _platform_config_value(key) for key in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY
        }
        installed = server._install_platform_config(full)
        assert sorted(installed) == sorted(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.values())
        for key, env_name in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.items():
            assert os.environ[env_name] == _platform_config_value(key)

    def test_payload_wins_over_a_pre_existing_image_env_value(self, env_guard):
        os.environ["TASK_TABLE_NAME"] = "baked-into-the-snapshot"
        server._install_platform_config(_platform_config(task_table_name="live-table"))
        assert os.environ["TASK_TABLE_NAME"] == "live-table"

    def test_unknown_key_rejects_the_whole_block_and_installs_nothing(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(ld_preload="/tmp/evil.so"))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "ld_preload" in str(excinfo.value)
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
        os.environ["LOG_GROUP_NAME"] = "from-the-image"
        installed = server._install_platform_config(_platform_config(log_group_name=value))
        assert "LOG_GROUP_NAME" not in installed
        assert os.environ["LOG_GROUP_NAME"] == "from-the-image"

    @pytest.mark.parametrize(
        ("char", "label"),
        [
            ("\x00", "NUL"),
            ("\n", "newline"),
            ("\r", "carriage-return"),
            ("\t", "tab"),
            ("\x1b", "escape-ANSI-introducer"),
            ("\x0b", "vertical-tab-splitlines-boundary"),
            ("\x7f", "delete"),
        ],
    )
    def test_a_control_character_in_a_value_is_a_structured_400(self, char, label, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(log_group_name=f"grp{char}injected"))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "control-characters" in str(excinfo.value)
        assert "LOG_GROUP_NAME" not in os.environ

    def test_the_forbidden_set_is_the_whole_C0_range_plus_DEL(self):
        assert (
            frozenset(chr(code) for code in range(0x20)) | {"\x7f"}
            == server._PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS
        )
        assert " " not in server._PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS

    @pytest.mark.parametrize(
        ("char", "label"), [("\x85", "NEL"), ("\u2028", "LS"), ("\u2029", "PS")]
    )
    def test_the_non_C0_splitlines_boundaries_are_a_DOCUMENTED_residual(
        self, char, label, env_guard
    ):
        assert char not in server._PLATFORM_CONFIG_FORBIDDEN_VALUE_CHARS
        installed = server._install_platform_config(
            _platform_config(log_group_name=f"grp{char}suffix")
        )
        assert "LOG_GROUP_NAME" in installed

    def test_a_TRAILING_control_byte_is_refused_rather_than_silently_cleaned(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(log_group_name="grp\x1b"))
        assert "control-characters" in str(excinfo.value)

    def test_surrounding_whitespace_is_STRIPPED_from_installed_values(self, env_guard):
        padded_arn = f"  arn:aws:secretsmanager:us-east-1:{_TEST_ACCOUNT}:secret:gh  "
        server._install_platform_config(
            _platform_config(task_table_name="  tbl  ", github_token_secret_arn=padded_arn)
        )
        assert os.environ["TASK_TABLE_NAME"] == "tbl"
        assert os.environ["GITHUB_TOKEN_SECRET_ARN"] == padded_arn.strip()

    def test_a_control_character_installs_NOTHING_at_all(self, env_guard):
        for env_name in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.values():
            os.environ.pop(env_name, None)
        with pytest.raises(server._PlatformConfigError):
            server._install_platform_config(_platform_config(log_group_name="a\x00b"))
        assert [
            env_name
            for env_name in server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY.values()
            if env_name in os.environ
        ] == []

    def test_a_control_character_in_a_value_never_reaches_os_environ_as_a_500(self, client):
        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": {"task_id": "t", "repo_url": "o/r", "prompt": "x"},
                    "platform_config": _platform_config(log_group_name="a\x00b"),
                }
            ),
        )
        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"

    def test_an_arn_in_a_foreign_account_is_rejected(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(
                _platform_config(
                    github_token_secret_arn=(
                        "arn:aws:secretsmanager:us-east-1:111122223333"
                        ":secret:bgagent-linear-oauth-victim"
                    )
                )
            )
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "github_token_secret_arn:foreign-partition-or-account" in str(excinfo.value)
        assert "GITHUB_TOKEN_SECRET_ARN" not in os.environ

    def test_an_in_account_redirect_is_NOT_rejected(self, env_guard):
        installed = server._install_platform_config(
            _platform_config(
                github_token_secret_arn=(
                    f"arn:aws:secretsmanager:us-east-1:{_TEST_ACCOUNT}"
                    ":secret:bgagent-jira-oauth-OTHERWORKSPACE-AbCdEf"
                )
            )
        )
        assert "GITHUB_TOKEN_SECRET_ARN" in installed

    def test_a_wholesale_partition_swap_is_NOT_rejected(self, env_guard):
        installed = server._install_platform_config(
            _platform_config(
                agent_session_role_arn=f"arn:aws-cn:iam::{_TEST_ACCOUNT}:role/r",
                github_token_secret_arn=(
                    f"arn:aws-cn:secretsmanager:cn-north-1:{_TEST_ACCOUNT}:secret:gh"
                ),
            )
        )
        assert "GITHUB_TOKEN_SECRET_ARN" in installed
        assert "AGENT_SESSION_ROLE_ARN" in installed

    def test_an_arn_in_a_foreign_partition_is_rejected(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(
                _platform_config(
                    github_token_secret_arn=(
                        f"arn:aws-cn:secretsmanager:cn-north-1:{_TEST_ACCOUNT}:secret:gh"
                    )
                )
            )
        assert "foreign-partition-or-account" in str(excinfo.value)

    def test_a_malformed_arn_is_rejected(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(
                _platform_config(github_token_secret_arn="not-an-arn-at-all")
            )
        assert "github_token_secret_arn:malformed" in str(excinfo.value)

    def test_every_arn_key_is_checked_not_just_the_github_one(self, env_guard):
        foreign = "arn:aws:secretsmanager:us-east-1:111122223333:secret:x"
        for key in server.MICROVM_PLATFORM_CONFIG_ARN_KEYS:
            if key == server.MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY:
                continue
            with pytest.raises(server._PlatformConfigError) as excinfo:
                server._install_platform_config(_platform_config(**{key: foreign}))
            assert f"{key}:foreign-partition-or-account" in str(excinfo.value), key

    def test_a_cross_region_arn_in_the_SAME_account_is_allowed(self, env_guard):
        installed = server._install_platform_config(
            _platform_config(
                github_token_secret_arn=(
                    f"arn:aws:secretsmanager:eu-west-1:{_TEST_ACCOUNT}:secret:gh"
                )
            )
        )
        assert "GITHUB_TOKEN_SECRET_ARN" in installed

    def test_a_malformed_ANCHOR_is_rejected_rather_than_disarming_the_check(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(agent_session_role_arn="arn:bogus"))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "anchor" in str(excinfo.value)

    @pytest.mark.parametrize(
        ("anchor", "label"),
        [
            (f"arn:zz:a:b:{_TEST_ACCOUNT}:c", "six-junk-fields"),
            ("arn:aws:s3:::bucket/key", "well-formed-but-not-iam"),
            (f"arn:aws:sts::{_TEST_ACCOUNT}:assumed-role/x/y", "iam-adjacent-but-sts"),
        ],
    )
    def test_a_SHAPE_VALID_but_non_IAM_anchor_is_rejected(self, anchor, label, env_guard):
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config(_platform_config(agent_session_role_arn=anchor))
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INVALID"
        assert "anchor" in str(excinfo.value)

    def test_the_anchor_shapes_the_PRODUCER_really_sends_are_accepted(self, env_guard):
        for anchor in (
            f"arn:aws:iam::{_TEST_ACCOUNT}:role/backgroundagent-dev-AgentSessionRole",
            f"arn:aws:iam::{_TEST_ACCOUNT}:role/service-path/nested/SessionRole",
            f"arn:aws-cn:iam::{_TEST_ACCOUNT}:role/SessionRole",
            f"arn:aws-us-gov:iam::{_TEST_ACCOUNT}:role/SessionRole",
        ):
            installed = server._install_platform_config(
                _platform_config(
                    agent_session_role_arn=anchor,
                    github_token_secret_arn=(
                        f"arn:{anchor.split(':')[1]}:secretsmanager:us-east-1"
                        f":{_TEST_ACCOUNT}:secret:gh"
                    ),
                )
            )
            assert "AGENT_SESSION_ROLE_ARN" in installed, anchor

    def test_the_anchor_key_is_contract_guaranteed_to_be_required(self):
        assert (
            server.MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY
            in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        )
        assert (
            server.MICROVM_PLATFORM_CONFIG_ACCOUNT_ANCHOR_KEY
            in server.MICROVM_PLATFORM_CONFIG_ARN_KEYS
        )

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
        with pytest.raises(server._PlatformConfigError) as excinfo:
            server._install_platform_config({})
        assert excinfo.value.code == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"

    def test_the_two_codes_are_distinct(self, env_guard):
        with pytest.raises(server._PlatformConfigError) as invalid:
            server._install_platform_config({"bogus_key": "x"})
        with pytest.raises(server._PlatformConfigError) as incomplete:
            server._install_platform_config({"log_group_name": "lg"})
        assert invalid.value.code != incomplete.value.code


class TestMicrovmRunHookPlatformConfig:
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
                    "agent_payload": self._payload(task_id="t-pc-inline"),
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
        seen: dict = {}

        def fake_resolve_github_token():
            seen["gh_arn"] = os.environ.get("GITHUB_TOKEN_SECRET_ARN")
            seen["session_role"] = os.environ.get("AGENT_SESSION_ROLE_ARN")
            seen["threads_at_resolve"] = len(server._active_threads)
            return "ghp_resolved"

        monkeypatch.setattr(server, "resolve_github_token", fake_resolve_github_token)
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        payload = self._payload(task_id="t-pc-order")
        payload.pop("github_token")
        r = client.post(
            RUN_HOOK,
            json=_run_hook_body(
                {
                    "agent_payload": payload,
                    "platform_config": _platform_config(
                        github_token_secret_arn=(
                            f"arn:aws:secretsmanager:us-east-1:{_TEST_ACCOUNT}:secret:live"
                        )
                    ),
                }
            ),
        )

        assert r.status_code == 200
        assert seen["gh_arn"] == f"arn:aws:secretsmanager:us-east-1:{_TEST_ACCOUNT}:secret:live"
        assert seen["session_role"] == _platform_config_value("agent_session_role_arn")
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

    def test_an_envelope_without_platform_config_is_accepted_when_the_image_bakes_it(
        self, client, monkeypatch, baked_platform_env, capfd
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        r = client.post(
            RUN_HOOK,
            json=_run_hook_body({"agent_payload": self._payload(task_id="t-pc-baked")}),
        )

        assert r.status_code == 200
        assert "[server/run-pre-config] /run hook received no platform_config" in (
            capfd.readouterr().out
        )

    def test_no_platform_config_and_no_baked_env_is_refused_not_run_unscoped(
        self, client, monkeypatch, env_guard, capfd
    ):
        run_task = MagicMock()
        monkeypatch.setattr(server, "run_task", run_task)
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())
        for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS:
            os.environ.pop(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key], None)

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload": self._payload()}))

        assert r.status_code == 400
        body = r.json()
        assert body["code"] == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"
        assert body["missing_env"] == sorted(
            server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key]
            for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS
        )
        assert "AGENT_SESSION_ROLE_ARN" in body["missing_env"]
        run_task.assert_not_called()
        assert "/run hook REJECTED: no platform_config" in capfd.readouterr().out

    def test_a_partially_baked_env_names_only_what_is_actually_missing(
        self, client, monkeypatch, baked_platform_env
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())
        os.environ.pop("AGENT_SESSION_ROLE_ARN", None)

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload": self._payload()}))

        assert r.status_code == 400
        assert r.json()["missing_env"] == ["AGENT_SESSION_ROLE_ARN"]

    def test_s3_pointer_takes_the_config_from_the_outer_envelope(
        self, client, monkeypatch, env_guard
    ):
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

    def test_a_nested_agent_payload_of_the_wrong_type_is_a_retryable_500(self, client, monkeypatch):
        monkeypatch.setattr(
            server,
            "_fetch_microvm_payload_from_s3",
            lambda _uri: {"agent_payload": "not-an-object"},
        )
        monkeypatch.setattr(server, "run_task", MagicMock())

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload_s3_uri": "s3://b/k"}))

        assert r.status_code == 500
        assert r.json()["code"] == "MICROVM_RUN_PAYLOAD_UNREADABLE"
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


class TestMicrovmValidateHook:
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
            "image_lifecycle_protocol_supported": True,
        }
        assert body["hook_prefix"] == server.MICROVM_HOOK_PREFIX
        assert body["platform_config_keys"] == len(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY)

    def test_makes_zero_aws_calls_even_with_a_log_group_configured(
        self, client, monkeypatch, capfd
    ):
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
        assert "/validate hook: ok" in capfd.readouterr().out

    def test_ready_is_also_aws_silent_with_a_log_group_configured(
        self, client, monkeypatch, capfd, warm_ready
    ):
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
        monkeypatch.setattr(server, "run_task", MagicMock())
        client.post(VALIDATE_HOOK)
        with server._threads_lock:
            assert server._active_threads == []

    def test_returns_503_while_the_module_is_still_initialising(self, client, monkeypatch):
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
            "/typo/prefix/resume",
            "/typo/prefix/run",
            "/typo/prefix/suspend",
            "/typo/prefix/terminate",
            "/typo/prefix/validate",
        ]

    def test_reports_an_unsupported_interpreter(self, client, monkeypatch):
        monkeypatch.setattr(server, "_MIN_PYTHON_VERSION", (99, 0))
        r = client.post(VALIDATE_HOOK)
        assert r.status_code == 503
        assert "python_version_supported" in r.json()["failed_checks"]

    def test_reports_baked_secret_env_as_a_warning_not_a_failure(self, client, monkeypatch):
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

    def test_the_warning_also_reaches_the_BUILD_LOG_not_just_the_response(
        self, client, monkeypatch, capfd
    ):
        for name in server._SNAPSHOT_FORBIDDEN_SECRET_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_should_not_be_baked")

        r = client.post(VALIDATE_HOOK)

        assert r.status_code == 200
        out = capfd.readouterr().out
        assert "/validate hook WARNING: secret-bearing env var(s) present" in out
        assert "GITHUB_TOKEN" in out
        assert "ghp_should_not_be_baked" not in out

    def test_no_warning_line_on_a_clean_snapshot(self, client, monkeypatch, capfd):
        for name in server._SNAPSHOT_FORBIDDEN_SECRET_ENV:
            monkeypatch.delenv(name, raising=False)
        client.post(VALIDATE_HOOK)
        assert "/validate hook WARNING" not in capfd.readouterr().out

    @pytest.mark.parametrize(
        "marker",
        [None, str(server.SHARED_CONSTANTS["microvm_lifecycle"]["protocol_version"]), "", "999"],
    )
    def test_build_rejects_an_image_marker_the_source_does_not_support(
        self, client, monkeypatch, marker
    ):
        contract = server.SHARED_CONSTANTS["microvm_lifecycle"]
        key = contract["image_protocol_env"]
        if marker is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, marker)
        forbidden = MagicMock(side_effect=AssertionError("image validation contacted AWS"))
        monkeypatch.setattr("aws_session.platform_client", forbidden)
        monkeypatch.setattr("aws_session.tenant_client", forbidden)
        response = client.post(VALIDATE_HOOK)
        expected = marker in (None, str(contract["protocol_version"]))
        assert response.status_code == (200 if expected else 503)
        assert response.json()["checks"]["image_lifecycle_protocol_supported"] is expected
        forbidden.assert_not_called()


class TestMicrovmTerminateHook:
    def test_returns_200_with_no_body_at_all(self, client):
        r = client.post(TERMINATE_HOOK)
        assert r.status_code == 200
        assert r.json()["status"] == "acknowledged"
        assert r.json()["active_pipeline_threads"] == 0

    def test_echoes_the_microvm_id(self, client):
        r = client.post(TERMINATE_HOOK, json={"microvmId": "microvm-zzz"})
        assert r.status_code == 200
        assert r.json()["microvm_id"] == "microvm-zzz"

    def test_an_EMPTY_microvm_id_is_expected_normal_and_earns_no_warning(self, client, capfd):
        # The MicroVM service sends an empty ``microvmId`` on this hook, unlike on /run.
        r = client.post(TERMINATE_HOOK, json={"microvmId": ""})
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""
        out = capfd.readouterr().out
        assert "[server/warn]" not in out
        assert '"microvm_id": ""' in out
        assert '"active_pipeline_threads": 0' in out

    def test_never_writes_terminal_task_status(self, client, monkeypatch):
        write_terminal = MagicMock()
        monkeypatch.setattr(server.task_state, "write_terminal", write_terminal)
        write_heartbeat = MagicMock()
        monkeypatch.setattr(server.task_state, "write_heartbeat", write_heartbeat)

        client.post(TERMINATE_HOOK, json={"microvmId": "m-1"})

        write_terminal.assert_not_called()
        write_heartbeat.assert_not_called()

    def test_returns_200_without_joining_a_running_pipeline(
        self, client, monkeypatch, baked_platform_env
    ):
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
        assert "best-effort step failed" in capfd.readouterr().out

    def test_an_unreadable_thread_count_reports_None_not_a_confident_zero(
        self, client, monkeypatch, capfd
    ):
        class _UnreadableThreadList(list):
            def __iter__(self):
                raise RuntimeError("thread registry read exploded")

        monkeypatch.setattr(server, "_active_threads", _UnreadableThreadList())

        r = client.post(TERMINATE_HOOK, json={"microvmId": "m-unknown"})

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "acknowledged"
        assert body["active_pipeline_threads"] is None
        assert body["microvm_id"] == "m-unknown"
        assert "best-effort step failed" in capfd.readouterr().out


class TestMicrovmPayloadFetchAttribution:
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
    PROBE = """
import sys, time, threading
sys.path.insert(0, "src")
import server
import aws_session
from fastapi.testclient import TestClient

client = TestClient(server.app)
# /ready warms the snapshot's heavyweight binaries by exec'ing them (ADR-021
# P2-F5). `claude` is not installed in a CI checkout, so pin the warm-up to a
# binary that always exists: the property under test is that a build hook's
# subprocess exec creates no boto3 session, not WHICH binary it warms.
server._READY_WARMUP_REQUIRED = (sys.executable, "--version")
server._READY_WARMUP_OPTIONAL = ()
assert client.post("/aws/lambda-microvms/runtime/v1/ready").status_code == 200
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
    def _payload(self, **extra) -> dict:
        return {
            "task_id": "t-silent",
            "repo_url": "org/repo",
            "prompt": "do it",
            "github_token": "ghp_x",
            **extra,
        }

    @pytest.fixture(autouse=True)
    def _disable_background_pipeline(self, monkeypatch):
        monkeypatch.setattr(server, "_spawn_background", MagicMock())

    @pytest.fixture
    def seam_guard(self, monkeypatch):
        """Arm every AWS/credential seam to raise until the pre-install phase is OVER.

        Two things end that phase, and only two:

        * ``_install_platform_config`` returning a **non-empty** env list.
        * ``_extract_invocation_params`` being entered.

        A rejection path reaches neither, so the seams stay armed for the whole
        request.
        """
        state: dict[str, Any] = {
            "install_phase_done": False,
            "installed_env": None,
            "violations": [],
        }
        real_install = server._install_platform_config
        real_extract = server._extract_invocation_params

        def spy_install(raw):
            result = real_install(raw)
            state["installed_env"] = result
            if result:
                state["install_phase_done"] = True
            return result

        def spy_extract(*args, **kwargs):
            state["install_phase_done"] = True
            return real_extract(*args, **kwargs)

        monkeypatch.setattr(server, "_install_platform_config", spy_install)
        monkeypatch.setattr(server, "_extract_invocation_params", spy_extract)

        def guard(name):
            def _seam(*_args, **_kwargs):
                if not state["install_phase_done"]:
                    state["violations"].append(name)
                    raise AssertionError(f"{name} touched before platform_config was installed")
                return MagicMock()

            return _seam

        import boto3

        import aws_session

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

    @pytest.mark.parametrize("with_config", [True, False], ids=["with-config", "no-config"])
    def test_no_cloudwatch_or_credential_seam_is_touched_before_the_install(
        self, client, monkeypatch, baked_platform_env, seam_guard, capfd, with_config
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

        envelope: dict[str, Any] = {"agent_payload": self._payload()}
        if with_config:
            envelope["platform_config"] = _platform_config()

        r = client.post(RUN_HOOK, json=_run_hook_body(envelope))

        assert r.status_code == 200
        assert seam_guard["violations"] == []
        assert seam_guard["install_phase_done"] is True
        if with_config:
            assert seam_guard["installed_env"]
        else:
            assert seam_guard["installed_env"] == []
            assert (
                "[server/run-pre-config] /run hook received no platform_config"
                in capfd.readouterr().out
            )

    def test_the_no_config_REJECTION_also_touches_no_seam(
        self, client, monkeypatch, env_guard, seam_guard, capfd
    ):
        monkeypatch.setattr(server, "run_task", MagicMock())
        for key in server.MICROVM_PLATFORM_CONFIG_REQUIRED_KEYS:
            os.environ.pop(server.MICROVM_PLATFORM_CONFIG_ENV_BY_KEY[key], None)

        r = client.post(RUN_HOOK, json=_run_hook_body({"agent_payload": self._payload()}))

        assert r.status_code == 400
        assert r.json()["code"] == "MICROVM_RUN_PLATFORM_CONFIG_INCOMPLETE"
        assert seam_guard["violations"] == []
        assert "/run hook REJECTED: no platform_config" in capfd.readouterr().out

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
        assert seam_guard["violations"] == []
        assert seam_guard["install_phase_done"] is False

    def test_the_accepted_line_correlates_task_and_microvm_ids(
        self, client, monkeypatch, env_guard, capfd
    ):
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
    def test_malformed_json_still_returns_200(self, client, capfd):
        r = client.post(
            TERMINATE_HOOK,
            content=b'{"microvmId": "m-1"',
            headers={"content-type": "application/json"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "acknowledged"
        assert r.json()["microvm_id"] == ""
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
        routes: Any = server.app.routes
        route = next(r for r in routes if getattr(r, "path", None) == TERMINATE_HOOK)
        assert route.dependant.body_params == []

    def test_a_body_read_failure_still_returns_200(self, client, monkeypatch, capfd):
        async def boom():
            raise RuntimeError("connection reset")

        import starlette.requests

        monkeypatch.setattr(starlette.requests.Request, "body", lambda _self: boom())

        r = client.post(TERMINATE_HOOK, json={"microvmId": "m-x"})
        assert r.status_code == 200
        assert r.json()["microvm_id"] == ""
        assert "could not read its body" in capfd.readouterr().out


class TestParseTerminateMicrovmId:
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


@pytest.mark.parametrize("crash", [False, True])
def test_microvm_pipeline_registers_identity_and_always_removes_lifecycle(monkeypatch, crash):
    from microvm_lifecycle import get_context

    monkeypatch.delenv("API_TIMEOUT_MS", raising=False)
    observed = []

    def run_task(**kwargs):
        context = get_context("lifecycle-server-task")
        assert context is not None
        assert context.microvm_id == "microvm-server"
        assert "microvm_id" not in kwargs
        assert os.environ["API_TIMEOUT_MS"] == "120000"
        observed.append(context)
        if crash:
            raise RuntimeError("pipeline crashed")

    monkeypatch.setattr(server, "run_task", run_task)
    monkeypatch.setattr(server, "_heartbeat_worker", lambda *_: None)
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())
    server._run_task_background(
        repo_url="owner/repo",
        task_description="test",
        issue_number="",
        github_token="test-token",
        anthropic_model="model",
        max_turns=1,
        max_budget_usd=None,
        aws_region="us-west-2",
        task_id="lifecycle-server-task",
        microvm_id="microvm-server",
    )
    assert len(observed) == 1
    assert get_context("lifecycle-server-task") is None
    assert server._background_pipeline_failed is crash
