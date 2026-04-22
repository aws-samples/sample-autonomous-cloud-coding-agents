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


def test_sse_run_elsewhere_fails_closed_on_taskfetch_error(monkeypatch):
    """P0-b: When task_state raises TaskFetchError (DDB blip, throttling),
    _invoke_sse must NOT fall through to spawn. Falling through would
    duplicate pipelines on DDB instability.

    Expected: HTTP 503 TASK_STATE_UNAVAILABLE so the client retries.
    """
    async def scenario():
        spawn_calls: list = []
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: spawn_calls.append((a, kw)),
        )

        def _raise(_task_id: str) -> None:
            raise server.task_state.TaskFetchError("simulated DDB throttle")

        monkeypatch.setattr(server.task_state, "get_task", _raise)

        params = {"task_id": "t-ddb-err", "repo_url": "o/r"}
        resp = await server._invoke_sse(params)

        assert resp.status_code == 503
        body = json.loads(resp.body.decode())
        assert body["code"] == "TASK_STATE_UNAVAILABLE"
        assert spawn_calls == []
        with server._threads_lock:
            assert "t-ddb-err" not in server._active_sse_adapters

    asyncio.run(scenario())


def test_sse_hydrates_missing_params_from_task_table(monkeypatch):
    """P0-b/P0-e: For an interactive task with empty params (CLI SSE body
    carries only {task_id}), _invoke_sse must hydrate repo_url +
    task_description + max_turns + max_budget_usd + task_type + branch_name
    from the TaskTable record before spawning the pipeline.
    """
    async def scenario():
        captured_params: dict = {}

        def _capture(params: dict, sse_adapter=None) -> None:  # type: ignore[no-untyped-def]
            captured_params.update(params)

        monkeypatch.setattr(server, "_spawn_background", _capture)
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {
                "task_id": task_id,
                "execution_mode": "interactive",
                "repo": "owner/repo",
                "task_description": "hydrated from DDB",
                "max_turns": 25,
                "max_budget_usd": "2.5",
                "task_type": "new_task",
                "branch_name": "bgagent/t/hy",
            },
        )

        # CLI body carries only task_id (empty repo_url / description / etc.).
        params = {
            "task_id": "t-hydrate",
            "repo_url": "",
            "task_description": "",
            "issue_number": "",
            "max_turns": 0,
            "max_budget_usd": None,
            "task_type": "new_task",
            "branch_name": "",
            "pr_number": "",
        }
        try:
            resp = await server._invoke_sse(params)
            assert resp.media_type == "text/event-stream"
            assert captured_params["repo_url"] == "owner/repo"
            assert captured_params["task_description"] == "hydrated from DDB"
            assert captured_params["max_turns"] == 25
            assert captured_params["max_budget_usd"] == 2.5
            assert captured_params["branch_name"] == "bgagent/t/hy"
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-hydrate", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())


def test_sse_hydration_does_not_overwrite_caller_values(monkeypatch):
    """P0-e corollary: If the caller (orchestrator) supplied a value, hydration
    must NOT overwrite it with the TaskTable value. Only empty fields are
    filled from the record.
    """
    async def scenario():
        captured_params: dict = {}

        def _capture(params: dict, sse_adapter=None) -> None:  # type: ignore[no-untyped-def]
            captured_params.update(params)

        monkeypatch.setattr(server, "_spawn_background", _capture)
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {
                "task_id": task_id,
                "execution_mode": "interactive",
                "repo": "wrong/repo",  # should be ignored
                "task_description": "wrong description",  # should be ignored
            },
        )

        # Caller already set explicit values.
        params = {
            "task_id": "t-explicit",
            "repo_url": "correct/repo",
            "task_description": "correct description",
        }
        try:
            await server._invoke_sse(params)
            assert captured_params["repo_url"] == "correct/repo"
            assert captured_params["task_description"] == "correct description"
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-explicit", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())


def test_sse_returns_500_task_record_incomplete_on_missing_required(monkeypatch):
    """P0-e: post-hydration validation. If the record exists and is
    execution_mode=interactive but missing the minimum viable params
    (repo_url + either issue/description), return 500 TASK_RECORD_INCOMPLETE
    instead of letting the pipeline fail deep in setup_repo.
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
            lambda task_id: {
                "task_id": task_id,
                "execution_mode": "interactive",
                # Deliberately missing `repo` → repo_url stays empty.
                "task_description": "something",
            },
        )

        params = {"task_id": "t-missing-repo", "repo_url": "", "task_description": ""}
        resp = await server._invoke_sse(params)

        assert resp.status_code == 500
        body = json.loads(resp.body.decode())
        assert body["code"] == "TASK_RECORD_INCOMPLETE"
        assert "repo_url" in body["missing"]
        assert spawn_calls == []

    asyncio.run(scenario())


def test_validate_required_params_pr_types_require_pr_number():
    """PR-iteration and PR-review task_types need a pr_number regardless."""
    missing = server._validate_required_params({
        "repo_url": "o/r",
        "task_type": "pr_iteration",
        "pr_number": "",
    })
    assert missing == ["pr_number"]

    missing = server._validate_required_params({
        "repo_url": "o/r",
        "task_type": "pr_review",
        "pr_number": "42",
    })
    assert missing == []

    # new_task needs issue OR description.
    missing = server._validate_required_params({
        "repo_url": "o/r",
        "task_type": "new_task",
    })
    assert missing == ["issue_number_or_task_description"]

    missing = server._validate_required_params({
        "repo_url": "o/r",
        "task_type": "new_task",
        "task_description": "do the thing",
    })
    assert missing == []


# ---------------------------------------------------------------------------
# Rev-5 Round 1 — P1-3 (attach-path subscribe-failure) + OBS-4 (session info)
# ---------------------------------------------------------------------------


def test_sse_attach_subscribe_failure_returns_503_no_spawn(monkeypatch):
    """P1-3: If subscribe() raises on a live adapter (queue/close race), we
    must NOT fall through to spawn — that would duplicate the pipeline.
    Return 503 SSE_ATTACH_RACE instead so the client retries.
    """
    async def scenario():
        adapter = _SSEAdapter("t-race")
        adapter.attach_loop(asyncio.get_running_loop())

        # Pre-populate the registry so the attach path triggers.
        with server._threads_lock:
            server._active_sse_adapters["t-race"] = adapter

        # Force subscribe to raise.
        def _boom() -> None:
            raise RuntimeError("simulated subscribe race")

        monkeypatch.setattr(adapter, "subscribe", _boom)

        spawn_calls: list = []
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: spawn_calls.append((a, kw)),
        )

        try:
            params = {"task_id": "t-race", "repo_url": "o/r", "task_description": "x"}
            resp = await server._invoke_sse(params)

            # Must return a JSONResponse (not StreamingResponse).
            assert resp.status_code == 503
            body = json.loads(resp.body.decode())
            assert body["code"] == "SSE_ATTACH_RACE"
            # Critical: no duplicate spawn.
            assert spawn_calls == []
            # Registry unchanged (adapter still in place).
            with server._threads_lock:
                assert server._active_sse_adapters["t-race"] is adapter
        finally:
            with server._threads_lock:
                server._active_sse_adapters.pop("t-race", None)
            adapter.close()

    asyncio.run(scenario())


def test_sse_spawn_interactive_writes_session_info(monkeypatch):
    """OBS-4: the interactive-mode spawn path must call
    task_state.write_session_info so TaskTable has session_id +
    agent_runtime_arn for cancellation and observability.
    """
    async def scenario():
        session_info_calls: list[tuple] = []
        monkeypatch.setattr(
            server.task_state,
            "write_session_info",
            lambda task_id, sid, arn: session_info_calls.append((task_id, sid, arn)),
        )
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {"task_id": task_id, "execution_mode": "interactive"},
        )
        monkeypatch.setattr(
            server,
            "_spawn_background",
            lambda *a, **kw: None,  # no-op; we only care about the session write
        )
        monkeypatch.setenv("AGENT_RUNTIME_ARN", "arn:aws:bedrock-agentcore:us-east-1:9:runtime/jwt-obs4")

        params = {
            "task_id": "t-obs4",
            "session_id": "sess-obs4-abc",
            "repo_url": "o/r",
            "task_description": "x",
        }
        try:
            await server._invoke_sse(params)
            assert len(session_info_calls) == 1
            called_task_id, called_sid, called_arn = session_info_calls[0]
            assert called_task_id == "t-obs4"
            assert called_sid == "sess-obs4-abc"
            assert called_arn == "arn:aws:bedrock-agentcore:us-east-1:9:runtime/jwt-obs4"
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-obs4", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())


def test_sse_emits_attach_route_metric(monkeypatch):
    """OBS-1: attach path emits `SSE_ROUTE` metric with route='attach'."""
    async def scenario():
        adapter = _SSEAdapter("t-metric-attach")
        adapter.attach_loop(asyncio.get_running_loop())

        with server._threads_lock:
            server._active_sse_adapters["t-metric-attach"] = adapter

        metric_calls: list[tuple] = []
        monkeypatch.setattr(
            server,
            "_emit_sse_route_metric",
            lambda task_id, route, **kw: metric_calls.append((task_id, route, kw)),
        )

        try:
            params = {"task_id": "t-metric-attach", "repo_url": "o/r", "task_description": "x"}
            await server._invoke_sse(params)
            assert any(c[1] == "attach" for c in metric_calls)
        finally:
            with server._threads_lock:
                server._active_sse_adapters.pop("t-metric-attach", None)
            adapter.close()

    asyncio.run(scenario())


def test_sse_emits_spawn_route_metric(monkeypatch):
    """OBS-1: spawn path emits `SSE_ROUTE` metric with route='spawn'."""
    async def scenario():
        metric_calls: list[tuple] = []
        monkeypatch.setattr(
            server,
            "_emit_sse_route_metric",
            lambda task_id, route, **kw: metric_calls.append((task_id, route, kw)),
        )
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {"task_id": task_id, "execution_mode": "interactive"},
        )
        monkeypatch.setattr(server, "_spawn_background", lambda *a, **kw: None)

        params = {"task_id": "t-metric-spawn", "repo_url": "o/r", "task_description": "x"}
        try:
            await server._invoke_sse(params)
            assert any(c[0] == "t-metric-spawn" and c[1] == "spawn" for c in metric_calls)
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-metric-spawn", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())


def test_sse_logs_full_post_hydration_keyset(monkeypatch, capsys):
    """OBS-2: after hydration, log the populated keyset + origin (record vs caller).

    Used to distinguish "ran with wrong repo because hydration overwrote
    caller value" from "caller passed wrong repo" during triage.
    """
    async def scenario():
        monkeypatch.setattr(server, "_spawn_background", lambda *a, **kw: None)
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {
                "task_id": task_id,
                "execution_mode": "interactive",
                "repo": "owner/repo",
            },
        )

        params = {
            "task_id": "t-obs2",
            "repo_url": "",
            "task_description": "caller-provided",
        }
        try:
            await server._invoke_sse(params)
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-obs2", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())
    out = capsys.readouterr().out
    # The post-hydration debug line must include both the populated list
    # and origin mapping so operators can see where each field came from.
    assert "post-hydration params" in out
    assert "repo_url" in out
    assert "'record'" in out or 'record' in out
    assert "'caller'" in out or 'caller' in out


def test_sse_spawn_interactive_skips_session_write_when_env_and_header_missing(monkeypatch):
    """If neither AGENT_RUNTIME_ARN env nor session header is set, we
    should NOT call write_session_info (empty write would be a no-op but
    we prefer to skip entirely for clarity).
    """
    async def scenario():
        session_info_calls: list[tuple] = []
        monkeypatch.setattr(
            server.task_state,
            "write_session_info",
            lambda task_id, sid, arn: session_info_calls.append((task_id, sid, arn)),
        )
        monkeypatch.setattr(
            server.task_state,
            "get_task",
            lambda task_id: {"task_id": task_id, "execution_mode": "interactive"},
        )
        monkeypatch.setattr(server, "_spawn_background", lambda *a, **kw: None)
        monkeypatch.delenv("AGENT_RUNTIME_ARN", raising=False)

        params = {
            "task_id": "t-nosession",
            "session_id": "",
            "repo_url": "o/r",
            "task_description": "x",
        }
        try:
            await server._invoke_sse(params)
            assert session_info_calls == []
        finally:
            with server._threads_lock:
                adapter = server._active_sse_adapters.pop("t-nosession", None)
            if adapter is not None:
                adapter.close()

    asyncio.run(scenario())
