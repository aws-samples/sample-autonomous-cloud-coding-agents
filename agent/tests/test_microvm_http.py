# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Exercise production HTTP routes with real controller state and bounded work."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass
from unittest.mock import MagicMock

import httpx
import pytest
from botocore.exceptions import ClientError
from fastapi import Request

import microvm_http
import microvm_lifecycle as lifecycle
import server
from microvm_diagnostics import lifecycle_stage

PREFIX = server.MICROVM_HOOK_PREFIX


def diagnostic_records(capsys):
    return [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("{") and '"event": "microvm_hook_' in line
    ]


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
    @pytest.mark.parametrize("action", ["suspend", "resume"])
    @pytest.mark.parametrize(
        ("outcome", "expected_status"),
        [("acknowledged", 200), ("unavailable", 409), ("invalid", 400), ("failed", 503)],
    )
    async def test_lifecycle_responses_close_even_when_client_requests_keep_alive(
        self, context, callbacks, client, action, outcome, expected_status
    ):
        await park(context)
        if action == "resume":
            assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        if outcome == "unavailable":
            lifecycle.unregister_task(context)
        elif outcome == "failed":
            callback = callbacks[0] if action == "suspend" else callbacks[1]
            callback.side_effect = RuntimeError("callback failed")
        response = await client.post(
            PREFIX + "/" + action,
            content=b"{" if outcome == "invalid" else b"{}",
            headers={"Connection": "keep-alive"},
        )
        assert response.status_code == expected_status
        assert response.headers["connection"] == "close"

    async def test_hooks_have_distinct_correlated_timelines(
        self, context, callbacks, client, capsys
    ):
        await park(context)
        for action in ["suspend", "resume"]:
            response = await client.post(PREFIX + "/" + action, json={})
            assert response.status_code == 200
        records = diagnostic_records(capsys)
        starts = [row for row in records if row["event"] == "microvm_hook_started"]
        ends = [row for row in records if row["event"] == "microvm_hook_finished"]
        assert len(starts) == len(ends) == 2
        assert starts[0]["hook_id"] != starts[1]["hook_id"]
        for start, end in zip(starts, ends, strict=True):
            assert start["hook_id"] == end["hook_id"]
            assert end["task_id"] == "http-task"
            assert end["microvm_id"] == "http-vm"
            assert end["request_id"] == "gate"
            assert end["pid"] > 0
            assert end["elapsed_ms"] >= 0
            assert end["http_status"] == 200
            assert end["code"] == "acknowledged"
            assert end["late"] is False
        assert ends[0]["phase"] == "suspend-ready"
        assert ends[1]["phase"] == "parked"

    async def test_failed_refresh_logs_stage_and_aws_identity_without_secrets(
        self, context, callbacks, client, capsys
    ):
        await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        capsys.readouterr()

        def fail_refresh(_park):
            with lifecycle_stage("credential-refresh"):
                raise ClientError(
                    {
                        "Error": {"Code": "AccessDenied", "Message": "secret-credential"},
                        "ResponseMetadata": {
                            "RequestId": "aws-request-123",
                            "HTTPHeaders": {"Authorization": "secret-header"},
                        },
                    },
                    "AssumeRole",
                )

        callbacks[1].side_effect = fail_refresh
        response = await client.post(PREFIX + "/resume", json={"ignored": "secret-body"})
        records = diagnostic_records(capsys)
        serialized = json.dumps(records) + response.text
        assert "secret-" not in serialized
        failure = next(row for row in records if row["event"] == "microvm_hook_stage_failed")
        assert failure["stage"] == "credential-refresh"
        assert failure["error_type"] == "ClientError"
        assert failure["aws_error_code"] == "AccessDenied"
        assert failure["aws_request_id"] == "aws-request-123"
        end = records[-1]
        assert end["stage"] == "credential-refresh"
        assert end["phase"] == "failed"
        assert end["http_status"] == response.status_code == 503
        assert all(row["hook_id"] == end["hook_id"] for row in records)
        with pytest.raises(lifecycle.LifecycleUnavailable):
            await context.wait_until_open()

    async def test_logging_failure_does_not_change_hook_result(
        self, context, callbacks, client, monkeypatch
    ):
        await park(context)
        monkeypatch.setattr(
            "microvm_diagnostics.print", MagicMock(side_effect=OSError("closed")), raising=False
        )
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        assert (await client.post(PREFIX + "/resume", json={})).status_code == 200
        await context.wait_until_open()

    async def test_timeout_reports_blocked_stage_and_marks_late_thread(
        self, context, callbacks, client, monkeypatch, capsys
    ):
        await park(context)
        assert (await client.post(PREFIX + "/suspend", json={})).status_code == 200
        capsys.readouterr()
        release, finished = threading.Event(), threading.Event()

        def slow_refresh(_park):
            try:
                with lifecycle_stage("credential-refresh"):
                    assert release.wait(2)
            finally:
                finished.set()

        callbacks[1].side_effect = slow_refresh
        monkeypatch.setattr(microvm_http, "LIFECYCLE_HANDLER_BUDGET_S", 0.05)
        try:
            response = await client.post(PREFIX + "/resume", json={})
            assert response.status_code == 503
            before = diagnostic_records(capsys)
            end = before[-1]
            assert end["stage"] == "credential-refresh"
            assert end["code"] == "MICROVM_LIFECYCLE_TIMEOUT"
            assert end["phase"] == "failed"
        finally:
            release.set()
            assert await asyncio.to_thread(finished.wait, 2)
        after = diagnostic_records(capsys)
        assert after
        assert all(row["late"] and row["hook_id"] == end["hook_id"] for row in after)
        assert all(row["event"] != "microvm_hook_finished" for row in after)
        with pytest.raises(lifecycle.LifecycleUnavailable):
            await context.wait_until_open()

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
        self, context, callbacks, client, capsys
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
        records = [row for row in diagnostic_records(capsys) if row["action"] == "resume"]
        ends = [row for row in records if row["event"] == "microvm_hook_finished"]
        assert [row["http_status"] for row in ends] == [409, 200]
        assert ends[0]["hook_id"] != ends[1]["hook_id"]
        for end in ends:
            matching = [row for row in records if row["hook_id"] == end["hook_id"]]
            assert matching[0]["event"] == "microvm_hook_started"
            assert matching[-1] == end

    async def test_request_body_read_shares_the_total_budget(
        self, context, callbacks, monkeypatch, capsys
    ):
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
        end = diagnostic_records(capsys)[-1]
        assert end["stage"] == "body-read"
        assert end["code"] == "MICROVM_LIFECYCLE_TIMEOUT"

    async def test_cancelled_handler_logs_cancellation_and_still_propagates_it(
        self, context, callbacks, capsys
    ):
        await park(context)
        entered = asyncio.Event()

        async def receive():
            entered.set()
            await asyncio.Event().wait()

        request = Request({"type": "http", "method": "POST", "headers": []}, receive)
        pending = asyncio.create_task(microvm_http.microvm_suspend(request))
        await entered.wait()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        end = diagnostic_records(capsys)[-1]
        assert end["code"] == "MICROVM_LIFECYCLE_CANCELLED"
        assert end["http_status"] is None
        assert end["stage"] == "body-read"
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
