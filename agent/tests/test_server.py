"""Tests for AgentCore FastAPI server behavior."""

import asyncio
import json
import threading
import time
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import server
from sse_adapter import _SSEAdapter


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


# ---------------------------------------------------------------------------
# Phase 1b: content-type negotiation + SSE stream tests
# ---------------------------------------------------------------------------


def _invocation_payload(task_id: str = "task-sse-1") -> dict:
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
    """No Accept header → existing JSON acceptance shape preserved."""
    started = threading.Event()

    def fake_run_task(**kwargs):
        assert kwargs.get("sse_adapter") is None  # sync path never passes adapter
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


def test_sse_path_triggered_by_event_stream_accept(client, monkeypatch):
    """Accept: text/event-stream → SSE response with AG-UI frames."""

    # Fake run_task: write one turn and return.
    def fake_run_task(**kwargs):
        adapter = kwargs["sse_adapter"]
        adapter.write_agent_turn(turn=1, model="m", thinking="", text="hello", tool_calls_count=0)

    monkeypatch.setattr(server, "run_task", fake_run_task)
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

    with client.stream(
        "POST",
        "/invocations",
        json=_invocation_payload("t-sse-1"),
        headers={"Accept": "text/event-stream"},
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers.get("cache-control", "").startswith("no-cache")
        assert resp.headers.get("x-accel-buffering") == "no"

        body = b""
        for chunk in resp.iter_bytes():
            body += chunk
            if b"RUN_FINISHED" in body or b"RUN_ERROR" in body:
                break

    text = body.decode()
    # Must start with RUN_STARTED
    assert "RUN_STARTED" in text
    # TEXT_MESSAGE triple emitted
    assert "TEXT_MESSAGE_START" in text
    assert "TEXT_MESSAGE_CONTENT" in text
    assert "TEXT_MESSAGE_END" in text
    # Terminal is RUN_FINISHED (no errors)
    assert "RUN_FINISHED" in text
    assert "RUN_ERROR" not in text
    # Frames are data: json\n\n
    assert "data: " in text

    # Each JSON frame should parse cleanly.
    data_lines = [line[6:] for line in text.splitlines() if line.startswith("data: ")]
    for raw in data_lines:
        parsed = json.loads(raw)
        assert "type" in parsed
        assert "timestamp" in parsed


def test_sse_path_emits_run_error_when_agent_error_seen(client, monkeypatch):
    """An agent_error from the pipeline → terminal RUN_ERROR, not RUN_FINISHED."""

    def fake_run_task(**kwargs):
        adapter = kwargs["sse_adapter"]
        adapter.write_agent_error(error_type="RuntimeError", message="boom")

    monkeypatch.setattr(server, "run_task", fake_run_task)
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

    with client.stream(
        "POST",
        "/invocations",
        json=_invocation_payload("t-sse-err"),
        headers={"Accept": "text/event-stream"},
    ) as resp:
        body = b""
        for chunk in resp.iter_bytes():
            body += chunk
            if b"RUN_ERROR" in body or b"RUN_FINISHED" in body:
                break

    text = body.decode()
    assert "RUN_ERROR" in text
    assert "RUN_FINISHED" not in text


def test_sse_wants_matching_logic():
    """Accept header substring matching is case-insensitive and permissive."""
    from unittest.mock import MagicMock as _MM

    def make(accept):
        req = _MM()
        req.headers = {"accept": accept} if accept is not None else {}
        # MagicMock .get() won't behave — use real dict via __getitem__ shim
        req.headers = {"accept": accept} if accept is not None else {"accept": ""}
        return req

    assert server._wants_sse(make("text/event-stream"))
    assert server._wants_sse(make("TEXT/EVENT-STREAM"))
    assert server._wants_sse(make("application/json, text/event-stream;q=0.9"))
    assert not server._wants_sse(make("application/json"))
    assert not server._wants_sse(make("*/*"))
    assert not server._wants_sse(make(""))


def test_sse_keepalive_on_idle(monkeypatch):
    """With no events, the stream should emit `: ping\\n\\n` comments."""
    monkeypatch.setattr(server, "_SSE_KEEPALIVE_SECONDS", 0.05)

    async def scenario():
        adapter = _SSEAdapter("t-keepalive")
        adapter.attach_loop(asyncio.get_running_loop())
        gen = server._sse_event_stream(adapter, run_id="t-keepalive")
        first = await gen.__anext__()
        assert b"RUN_STARTED" in first
        second = await gen.__anext__()
        assert second == b": ping\n\n"

        adapter.close()
        remaining = b""
        async for frame in gen:
            remaining += frame
        assert b"RUN_FINISHED" in remaining

    asyncio.run(scenario())


def test_sse_stream_client_disconnect_calls_detach(monkeypatch):
    """If the generator is cancelled, detach_loop is called and background runs on."""
    monkeypatch.setattr(server, "_SSE_KEEPALIVE_SECONDS", 10.0)

    async def scenario():
        adapter = _SSEAdapter("t-disc")
        adapter.attach_loop(asyncio.get_running_loop())

        detach_calls: list[bool] = []
        original = adapter.detach_loop

        def spy():
            detach_calls.append(True)
            original()

        monkeypatch.setattr(adapter, "detach_loop", spy)

        gen = server._sse_event_stream(adapter, run_id="t-disc")
        await gen.__anext__()  # RUN_STARTED
        await gen.aclose()
        assert detach_calls == [True]

    asyncio.run(scenario())
