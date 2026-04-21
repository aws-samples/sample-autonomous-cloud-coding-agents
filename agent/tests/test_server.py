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
        sub_queue = adapter.subscribe()
        gen = server._sse_event_stream(adapter, run_id="t-keepalive", sub_queue=sub_queue)
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


def test_sse_stream_client_disconnect_unsubscribes(monkeypatch):
    """If the generator is cancelled, this observer's queue is unsubscribed.

    Rev-5: disconnect is per-observer — the adapter and any other subscribers
    keep running, and the background pipeline keeps writing to DDB. We verify
    ``unsubscribe`` is called with this observer's queue.
    """
    monkeypatch.setattr(server, "_SSE_KEEPALIVE_SECONDS", 10.0)

    async def scenario():
        adapter = _SSEAdapter("t-disc")
        adapter.attach_loop(asyncio.get_running_loop())
        sub_queue = adapter.subscribe()

        unsubscribe_calls: list = []
        original = adapter.unsubscribe

        def spy(q):
            unsubscribe_calls.append(q)
            original(q)

        monkeypatch.setattr(adapter, "unsubscribe", spy)

        gen = server._sse_event_stream(adapter, run_id="t-disc", sub_queue=sub_queue)
        await gen.__anext__()  # RUN_STARTED
        await gen.aclose()
        assert unsubscribe_calls == [sub_queue]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Rev-5 Branch A (§9.13): attach-don't-spawn + /ping HealthyBusy + multi-sub
# ---------------------------------------------------------------------------


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


def test_sse_attach_does_not_spawn_second_pipeline(monkeypatch):
    """A second SSE invocation for a task_id in the registry attaches, doesn't spawn.

    Rev-5 attach-don't-spawn (§9.13.3).
    """
    # Pre-populate the registry as if a pipeline is already running for this task.
    async def scenario():
        adapter = _SSEAdapter("t-attach")
        adapter.attach_loop(asyncio.get_running_loop())

        spawn_calls: list = []
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: spawn_calls.append((a, kw)),
        )

        with server._threads_lock:
            server._active_sse_adapters["t-attach"] = adapter

        try:
            params = {
                "task_id": "t-attach",
                "repo_url": "o/r",
                "task_description": "x",
                "issue_number": "",
                "github_token": "ghp_x",
                "anthropic_model": "m",
                "max_turns": 10,
                "max_budget_usd": 1.0,
                "aws_region": "us-east-1",
                "session_id": "",
                "hydrated_context": None,
                "system_prompt_overrides": "",
                "prompt_version": "",
                "memory_id": "",
                "task_type": "new_task",
                "branch_name": "",
                "pr_number": "",
                "cedar_policies": [],
            }
            resp = await server._invoke_sse(params)
            # Attach path returns a StreamingResponse without calling _spawn_background.
            assert resp.media_type == "text/event-stream"
            assert spawn_calls == []
            # Registry still has the ORIGINAL adapter (attach does not replace it).
            with server._threads_lock:
                assert server._active_sse_adapters["t-attach"] is adapter
            # Two subscribers now exist (default + attach)
            assert adapter.subscriber_count >= 2
        finally:
            with server._threads_lock:
                server._active_sse_adapters.pop("t-attach", None)
            adapter.close()

    asyncio.run(scenario())


def test_multi_subscriber_broadcast():
    """Two subscribers on one adapter both receive every event."""
    async def scenario():
        adapter = _SSEAdapter("t-multi")
        adapter.attach_loop(asyncio.get_running_loop())
        q1 = adapter.subscribe()
        q2 = adapter.subscribe()

        adapter.write_agent_milestone("m1", "details-1")
        # Allow call_soon_threadsafe to run.
        await asyncio.sleep(0)

        ev1 = await asyncio.wait_for(q1.get(), timeout=1.0)
        ev2 = await asyncio.wait_for(q2.get(), timeout=1.0)
        assert ev1["type"] == "agent_milestone"
        assert ev2["type"] == "agent_milestone"
        assert ev1["milestone"] == ev2["milestone"] == "m1"

        adapter.close()

    asyncio.run(scenario())


def test_multi_subscriber_close_sentinel_fans_out():
    """close() delivers the sentinel to every subscriber."""
    async def scenario():
        adapter = _SSEAdapter("t-multi-close")
        adapter.attach_loop(asyncio.get_running_loop())
        q1 = adapter.subscribe()
        q2 = adapter.subscribe()

        adapter.close()
        await asyncio.sleep(0)

        from sse_adapter import _CLOSE_SENTINEL

        v1 = await asyncio.wait_for(q1.get(), timeout=1.0)
        v2 = await asyncio.wait_for(q2.get(), timeout=1.0)
        assert v1 is _CLOSE_SENTINEL
        assert v2 is _CLOSE_SENTINEL

    asyncio.run(scenario())


def test_registry_cleanup_on_pipeline_completion(monkeypatch):
    """_run_task_background's finally removes the adapter from the registry."""
    # Pre-populate a dummy adapter; call _run_task_background with
    # a patched run_task that returns immediately.
    monkeypatch.setattr(server, "run_task", lambda **_kwargs: None)
    monkeypatch.setattr(server.task_state, "write_heartbeat", MagicMock())
    monkeypatch.setattr(server.task_state, "write_terminal", MagicMock())

    adapter = _SSEAdapter("t-cleanup")
    # Note: no loop attached is fine — close() is a no-op in that case.
    with server._threads_lock:
        server._active_sse_adapters["t-cleanup"] = adapter

    server._run_task_background(
        repo_url="o/r",
        task_description="x",
        issue_number="",
        github_token="",
        anthropic_model="m",
        max_turns=5,
        max_budget_usd=None,
        aws_region="us-east-1",
        task_id="t-cleanup",
        sse_adapter=adapter,
    )

    with server._threads_lock:
        assert "t-cleanup" not in server._active_sse_adapters


# ---------------------------------------------------------------------------
# Rev-5 Branch A (§9.13.4): RUN_ELSEWHERE guard — SSE must refuse to spawn
# a pipeline on Runtime-JWT for tasks that were submitted via the
# orchestrator path.
# ---------------------------------------------------------------------------


def test_sse_run_elsewhere_returns_409_for_orchestrator_task(monkeypatch):
    """SSE invoke for an orchestrator-mode task returns 409 RUN_ELSEWHERE.

    Prevents duplicate pipeline execution when a CLI does
    ``bgagent watch --transport auto`` against a task that was submitted
    via plain ``bgagent submit`` (orchestrator → Runtime-IAM).
    """
    async def scenario():
        spawn_calls: list = []
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: spawn_calls.append((a, kw)),
        )
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {"task_id": task_id, "execution_mode": "orchestrator"},
        )

        params = {"task_id": "t-orch", "repo_url": "o/r", "task_description": "x"}
        resp = await server._invoke_sse(params)

        assert resp.status_code == 409
        body = json.loads(resp.body.decode())
        assert body["code"] == "RUN_ELSEWHERE"
        assert body["execution_mode"] == "orchestrator"
        # Critical: no pipeline spawned.
        assert spawn_calls == []
        # Registry must be untouched.
        with server._threads_lock:
            assert "t-orch" not in server._active_sse_adapters

    asyncio.run(scenario())


def test_sse_run_elsewhere_allows_interactive_task(monkeypatch):
    """SSE invoke for an interactive-mode task proceeds to spawn."""
    async def scenario():
        spawn_calls: list = []
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: spawn_calls.append((a, kw)),
        )
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {"task_id": task_id, "execution_mode": "interactive"},
        )

        params = {"task_id": "t-inter", "repo_url": "o/r", "task_description": "x"}
        try:
            resp = await server._invoke_sse(params)
            assert resp.media_type == "text/event-stream"
            assert len(spawn_calls) == 1
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-inter", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())


def test_sse_run_elsewhere_fails_open_when_record_missing(monkeypatch):
    """If TaskTable lookup returns None, the guard defers to spawn (fail-open).

    Preserves backward compat for tasks that predate rev 5 and blueprints
    that aren't persisted at create time.
    """
    async def scenario():
        spawn_calls: list = []
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: spawn_calls.append((a, kw)),
        )
        monkeypatch.setattr(server.task_state, "get_task", lambda task_id: None)

        params = {"task_id": "t-legacy", "repo_url": "o/r", "task_description": "x"}
        try:
            resp = await server._invoke_sse(params)
            assert resp.media_type == "text/event-stream"
            assert len(spawn_calls) == 1
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-legacy", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())
