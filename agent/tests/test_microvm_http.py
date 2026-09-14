# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Exercise production HTTP routes with real controller state and bounded work."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import Request

import microvm_http
import microvm_lifecycle as lifecycle
import server

PREFIX = server.MICROVM_HOOK_PREFIX


@dataclass
class Deadline:
    remaining: float = 60

    def remaining_s(self) -> float:
        return self.remaining


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def context():
    context = lifecycle.register_task("http-task", "http-vm")
    yield context
    lifecycle.unregister_task(context)


@pytest.fixture
def callbacks(monkeypatch):
    suspend, resume = MagicMock(), MagicMock()
    monkeypatch.setattr(microvm_http, "checkpoint_before_suspend", suspend)
    monkeypatch.setattr(microvm_http, "refresh_and_reconcile_after_resume", resume)
    return suspend, resume


@pytest.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server.app), base_url="http://test"
    ) as client:
        yield client


async def park(context):
    await context.tool_started("tool")
    deadline = Deadline()
    parked = context.park_approval("gate", "tool", deadline)
    assert parked is not None
    return parked, deadline


@pytest.mark.anyio
class TestLifecycleHttp:
    async def test_duplicate_hooks_acknowledge_without_repeating_work(
        self, context, callbacks, client
    ):
        suspend, resume = callbacks
        parked, deadline = await park(context)
        for body in [{"microvmId": "http-vm"}, {"microvmId": ""}]:
            response = await client.post(PREFIX + "/suspend", json=body)
            assert response.status_code == 200
            assert response.json()["request_id"] == "gate"
        suspend.assert_called_once_with(parked)
        leave = asyncio.create_task(context.leave_approval(parked))
        await asyncio.sleep(0.03)
        assert not leave.done()
        deadline.remaining = 0
        response = await client.post(PREFIX + "/resume", content=b"")
        assert response.status_code == 200
        await leave
        response = await client.post(PREFIX + "/resume", json={"microvmId": "http-vm"})
        assert response.status_code == 200
        resume.assert_called_once_with(parked)
        assert parked.deadline is deadline
        assert deadline.remaining_s() == 0
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409

    async def test_new_gate_cannot_reuse_an_old_wake_acknowledgment(
        self, context, callbacks, client
    ):
        parked, _ = await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        assert (await client.post(PREFIX + "/resume", json={})).status_code == 200
        await context.leave_approval(parked)
        context.tool_finished("tool")
        await context.tool_started("next-tool")
        next_park = context.park_approval("next-gate", "next-tool", Deadline())
        assert next_park is not None
        assert (await client.post(PREFIX + "/resume", json={})).status_code == 409
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        response = await client.post(PREFIX + "/resume", json={})
        assert response.status_code == 200
        assert response.json()["request_id"] == "next-gate"
        callbacks[1].assert_called_with(next_park)
        assert callbacks[1].call_count == 2

    @pytest.mark.parametrize(
        ("content", "status"),
        [
            (b"{", 400),
            (b"[]", 400),
            (b'{"microvmId":1}', 400),
            (b'{"microvmId":" http-vm"}', 400),
            (b"x" * 4097, 413),
        ],
    )
    async def test_invalid_body_never_reaches_lifecycle_work(
        self, context, callbacks, client, content, status
    ):
        await park(context)
        assert (await client.post(PREFIX + "/suspend", content=content)).status_code == status
        assert (await client.post(PREFIX + "/resume", content=content)).status_code == status
        for callback in callbacks:
            callback.assert_not_called()

    async def test_wrong_vm_or_no_registered_task_rejects(self, context, callbacks, client):
        await park(context)
        assert (
            await client.post(PREFIX + "/suspend", json={"microvmId": "another-vm"})
        ).status_code == 409
        lifecycle.unregister_task(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409
        assert (await client.post(PREFIX + "/resume", json={})).status_code == 409
        for callback in callbacks:
            callback.assert_not_called()

    async def test_unparked_resume_or_parallel_tools_never_acknowledges(
        self, context, callbacks, client
    ):
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409
        await park(context)
        assert (await client.post(PREFIX + "/resume", json={})).status_code == 409
        await context.tool_started("parallel")
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409
        for callback in callbacks:
            callback.assert_not_called()

    async def test_checkpoint_failure_keeps_guest_awake_and_disables_another_suspend(
        self, context, callbacks, client
    ):
        suspend, _ = callbacks
        parked, _ = await park(context)
        suspend.side_effect = RuntimeError("do-not-leak-secret")
        response = await client.post(PREFIX + "/suspend", json={})
        assert response.status_code == 503
        assert "do-not-leak-secret" not in response.text
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409
        await context.leave_approval(parked)

    async def test_failed_refresh_closes_barrier_without_retrying(self, context, callbacks, client):
        _, resume = callbacks
        await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        resume.side_effect = RuntimeError("do-not-leak-secret")
        response = await client.post(PREFIX + "/resume", json={})
        assert response.status_code == 503
        assert "do-not-leak-secret" not in response.text
        with pytest.raises(lifecycle.LifecycleUnavailable):
            await context.wait_until_open()
        assert (await client.post(PREFIX + "/resume", json={})).status_code == 409
        resume.assert_called_once()

    @pytest.mark.parametrize("action", ["suspend", "resume"])
    async def test_timed_out_callback_cannot_acknowledge_late(
        self, context, callbacks, client, monkeypatch, action
    ):
        await park(context)
        if action == "resume":
            assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()

        def block(_park):
            entered.set()
            try:
                assert release.wait(2)
            finally:
                finished.set()

        callbacks[action == "resume"].side_effect = block
        monkeypatch.setattr(microvm_http, "LIFECYCLE_HANDLER_BUDGET_S", 0.05)
        started = time.monotonic()
        try:
            response = await client.post(PREFIX + "/" + action, json={})
            assert response.status_code == 503
            assert response.json()["code"] == "MICROVM_LIFECYCLE_TIMEOUT"
            assert time.monotonic() - started < 0.5
            assert entered.is_set()
        finally:
            release.set()
            assert await asyncio.to_thread(finished.wait, 1)
        assert (await client.post(PREFIX + "/" + action, json={})).status_code == 409
        if action == "resume":
            with pytest.raises(lifecycle.LifecycleUnavailable):
                await context.wait_until_open()
        else:
            await context.wait_until_open()

    async def test_terminate_invalidates_an_inflight_refresh(
        self, context, callbacks, client, monkeypatch
    ):
        await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        entered, release = threading.Event(), threading.Event()

        def refresh(_park):
            entered.set()
            assert release.wait(2)

        callbacks[1].side_effect = refresh
        monkeypatch.setattr(server, "_debug_cw", MagicMock())
        request = asyncio.create_task(client.post(PREFIX + "/resume", json={}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (
                await client.post(PREFIX + "/terminate", content=b"bad body")
            ).status_code == 200
            with pytest.raises(lifecycle.LifecycleUnavailable):
                await context.wait_until_open()
        finally:
            release.set()
        assert (await request).status_code == 409
        with pytest.raises(lifecycle.LifecycleUnavailable):
            await context.wait_until_open()

    async def test_concurrent_resume_reports_busy_while_first_finishes(
        self, context, callbacks, client
    ):
        await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        entered, release = threading.Event(), threading.Event()

        def refresh(_park):
            entered.set()
            assert release.wait(2)

        callbacks[1].side_effect = refresh
        request = asyncio.create_task(client.post(PREFIX + "/resume", json={}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await client.post(PREFIX + "/resume", json={})).status_code == 409
        finally:
            release.set()
        assert (await request).status_code == 200
        callbacks[1].assert_called_once()

    async def test_request_body_read_shares_the_total_budget(self, context, callbacks, monkeypatch):
        await park(context)
        monkeypatch.setattr(microvm_http, "LIFECYCLE_HANDLER_BUDGET_S", 0.02)

        async def slow_receive():
            await asyncio.sleep(1)
            return {"type": "http.request", "body": b"{}", "more_body": False}

        request = Request({"type": "http", "method": "POST", "headers": []}, slow_receive)
        response = await microvm_http.microvm_suspend(request)
        assert response.status_code == 503
        for callback in callbacks:
            callback.assert_not_called()

    async def test_terminate_closes_barrier_and_answers_even_if_body_stalls(
        self, context, monkeypatch
    ):
        await park(context)
        monkeypatch.setattr(server, "_TERMINATE_BODY_BUDGET_SECONDS", 0.02)
        monkeypatch.setattr(server, "_debug_cw", MagicMock())

        async def slow_receive():
            with pytest.raises(lifecycle.LifecycleUnavailable):
                await context.wait_until_open()
            await asyncio.sleep(1)
            return {"type": "http.request", "body": b"{}", "more_body": False}

        request = Request({"type": "http", "method": "POST", "headers": []}, slow_receive)
        started = time.monotonic()
        response = await server.microvm_terminate(request)
        assert response["status"] == "acknowledged"
        assert time.monotonic() - started < 0.5

    async def test_expired_or_failed_progress_cannot_repeat_suspend_ack(
        self, context, callbacks, client
    ):
        _, deadline = await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        deadline.remaining = 0
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409
        deadline.remaining = 60
        context.progress_write_failed()
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 409
        callbacks[0].assert_called_once()

    async def test_validate_checks_new_routes_without_creating_aws_clients(
        self, monkeypatch, client
    ):
        forbidden = MagicMock(side_effect=AssertionError("build hook initialized AWS"))
        monkeypatch.setattr("aws_session.tenant_client", forbidden)
        monkeypatch.setattr("aws_session.platform_client", forbidden)
        response = await client.post(PREFIX + "/validate")
        assert response.status_code == 200
        assert response.json()["checks"]["hook_routes_registered"] is True
        forbidden.assert_not_called()
        assert 0 < microvm_http.LIFECYCLE_HANDLER_BUDGET_S < microvm_http.LIFECYCLE_HOOK_TIMEOUT_S
