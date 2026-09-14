# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Concurrency regressions for the guest approval/sleep boundary."""

import asyncio
import threading
from unittest.mock import Mock

import pytest

from hooks import _ApprovalDeadline
from microvm_lifecycle import (
    LifecycleUnavailable,
    MicrovmLifecycle,
    get_context,
    register_task,
    unregister_task,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def reset_progress_state():
    from progress_writer import _reset_circuit_breakers

    _reset_circuit_breakers()
    yield
    _reset_circuit_breakers()


async def parked(context=None):
    context = context or MicrovmLifecycle("task", "microvm")
    deadline = Mock(remaining_s=Mock(return_value=300))
    await context.tool_started("tool")
    park = context.park_approval("request", "tool", deadline)
    assert park is not None
    return context, park


@pytest.mark.anyio
async def test_suspend_blocks_decision_and_new_tool_until_refresh_finishes():
    context, park = await parked()
    checkpoint = Mock()
    await context.suspend(checkpoint, budget_s=1)
    checkpoint.assert_called_once_with(park)
    decision = asyncio.create_task(context.leave_approval(park))
    new_tool = asyncio.create_task(context.tool_started("parallel"))
    await asyncio.sleep(0.04)
    assert not decision.done()
    assert not new_tool.done()
    refreshing = threading.Event()
    release = threading.Event()

    def refresh(same_park):
        assert same_park is park
        refreshing.set()
        assert release.wait(2)

    wake = asyncio.create_task(context.resume(refresh, budget_s=1))
    try:
        assert await asyncio.to_thread(refreshing.wait, 1)
        assert not decision.done()
        assert not new_tool.done()
    finally:
        release.set()
    await wake
    await asyncio.wait_for(asyncio.gather(decision, new_tool), 1)


@pytest.mark.anyio
async def test_parallel_tool_prevents_suspend_until_its_post_hook():
    context, park = await parked()
    await context.tool_started("other")
    checkpoint = Mock()
    with pytest.raises(LifecycleUnavailable):
        await context.suspend(checkpoint, budget_s=1)
    checkpoint.assert_not_called()
    context.tool_finished("other")
    assert await context.suspend(checkpoint, budget_s=1) is park


@pytest.mark.anyio
@pytest.mark.parametrize(
    "reason", ["unknown-tool", "duplicate-tool", "detached-tool", "dropped-event"]
)
async def test_unaccounted_work_or_progress_disables_sleep_without_blocking_tools(reason):
    context, park = await parked()
    if reason == "unknown-tool":
        await context.tool_started(None)
    elif reason == "duplicate-tool":
        await context.tool_started("tool")
    elif reason == "detached-tool":
        context.disable_suspend()
    else:
        context.progress_write_failed()
        with context.activity():
            pass  # A later success does not recover the lost event.
    with pytest.raises(LifecycleUnavailable):
        await context.suspend(Mock(), budget_s=1)
    await context.leave_approval(park)
    await context.tool_started("next")


@pytest.mark.anyio
async def test_suspend_drains_inflight_progress_before_checkpoint():
    context, park = await parked()
    entered = threading.Event()
    release = threading.Event()

    def write():
        with context.activity():
            entered.set()
            assert release.wait(2)

    writer = asyncio.create_task(asyncio.to_thread(write))
    assert await asyncio.to_thread(entered.wait, 1)
    checkpoint = Mock()
    suspend = asyncio.create_task(context.suspend(checkpoint, budget_s=1))
    try:
        await asyncio.sleep(0.04)
        checkpoint.assert_not_called()
    finally:
        release.set()
    await writer
    assert await suspend is park
    checkpoint.assert_called_once()


@pytest.mark.anyio
async def test_failed_inflight_progress_rejects_suspend():
    context, park = await parked()
    entered = threading.Event()
    release = threading.Event()

    def write():
        with context.activity():
            entered.set()
            assert release.wait(2)
            context.progress_write_failed()

    writer = asyncio.create_task(asyncio.to_thread(write))
    assert await asyncio.to_thread(entered.wait, 1)
    checkpoint = Mock()
    suspend = asyncio.create_task(context.suspend(checkpoint, budget_s=1))
    await asyncio.sleep(0.04)
    release.set()
    await writer
    with pytest.raises(LifecycleUnavailable):
        await suspend
    checkpoint.assert_not_called()
    await context.leave_approval(park)


@pytest.mark.anyio
async def test_checkpoint_failure_releases_unsuspended_wait_and_disables_retry():
    context, park = await parked()
    with pytest.raises(OSError, match="durability"):
        await context.suspend(Mock(side_effect=OSError("durability")), budget_s=1)
    with pytest.raises(LifecycleUnavailable):
        await context.suspend(Mock(), budget_s=1)
    await context.leave_approval(park)


@pytest.mark.anyio
async def test_expiry_during_checkpoint_refuses_freeze():
    context, park = await parked()

    def checkpoint(_):
        park.deadline.remaining_s.return_value = 0

    with pytest.raises(LifecycleUnavailable):
        await context.suspend(checkpoint, budget_s=1)
    await context.leave_approval(park)


@pytest.mark.anyio
async def test_late_refresh_after_timeout_cannot_release_coding():
    context, park = await parked()
    await context.suspend(Mock(), budget_s=1)
    entered = threading.Event()
    release = threading.Event()
    completed = threading.Event()

    def refresh(_):
        entered.set()
        assert release.wait(2)
        completed.set()

    wake = asyncio.create_task(context.resume(refresh, budget_s=0.1))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        with pytest.raises(TimeoutError):
            await wake
        with pytest.raises(LifecycleUnavailable):
            await context.leave_approval(park)
    finally:
        release.set()
    assert await asyncio.to_thread(completed.wait, 1)
    with pytest.raises(LifecycleUnavailable):
        await context.tool_started("next")
    with pytest.raises(LifecycleUnavailable):
        await context.resume(Mock(), budget_s=1)


@pytest.mark.anyio
async def test_close_during_refresh_invalidates_completion():
    context, park = await parked()
    await context.suspend(Mock(), budget_s=1)
    with pytest.raises(LifecycleUnavailable, match="superseded"):
        await context.resume(lambda _: context.close(), budget_s=1)
    with pytest.raises(LifecycleUnavailable):
        await context.leave_approval(park)


@pytest.mark.anyio
async def test_resume_failure_and_cancellation_stay_closed():
    for failure in (OSError("STS unavailable"), asyncio.CancelledError()):
        context, park = await parked()
        await context.suspend(Mock(), budget_s=1)
        with pytest.raises(type(failure)):
            await context.resume(Mock(side_effect=failure), budget_s=1)
        with pytest.raises(LifecycleUnavailable):
            await context.leave_approval(park)


@pytest.mark.anyio
async def test_concurrent_lifecycle_calls_do_not_share_transition_ownership():
    context, park = await parked()
    entered = threading.Event()
    release = threading.Event()

    def checkpoint(_):
        entered.set()
        assert release.wait(2)

    suspend = asyncio.create_task(context.suspend(checkpoint, budget_s=1))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        with pytest.raises(LifecycleUnavailable):
            await context.suspend(Mock(), budget_s=1)
        with pytest.raises(LifecycleUnavailable):
            await context.resume(Mock(), budget_s=1)
    finally:
        release.set()
    await suspend
    await context.resume(Mock(), budget_s=1)
    # The same gate cannot sleep again while the released waiter catches up.
    with pytest.raises(LifecycleUnavailable):
        await context.suspend(Mock(), budget_s=1)
    await context.leave_approval(park)
    context.tool_finished("tool")
    await context.tool_started("next")
    next_park = context.park_approval("next-gate", "next", park.deadline)
    assert await context.suspend(Mock(), budget_s=1) is next_park


@pytest.mark.anyio
async def test_original_deadline_survives_freeze_and_expired_resume(monkeypatch):
    clock = {"wall": 1000.0, "mono": 50.0}
    # Patch only the module method through a proxy; replacing global monotonic
    # would also freeze asyncio's own timeout scheduler.
    monkeypatch.setattr(
        "hooks.time",
        Mock(time=lambda: clock["wall"], monotonic=lambda: clock["mono"]),
    )
    deadline = _ApprovalDeadline.from_recorded("1970-01-01T00:16:40Z", 300)
    context = MicrovmLifecycle("task", "microvm")
    await context.tool_started("tool")
    park = context.park_approval("request", "tool", deadline)
    await context.suspend(Mock(), budget_s=1)
    clock["wall"] += 400  # Guest monotonic clock did not advance while frozen.
    refresh = Mock()
    assert await context.resume(refresh, budget_s=1) is park
    assert park.deadline is deadline
    assert park.deadline.remaining_s() == 0
    refresh.assert_called_once_with(park)
    await context.leave_approval(park)


@pytest.mark.anyio
async def test_leaving_approval_before_suspend_wins_without_checkpoint():
    context, park = await parked()
    await context.leave_approval(park)
    checkpoint = Mock()
    with pytest.raises(LifecycleUnavailable):
        await context.suspend(checkpoint, budget_s=1)
    checkpoint.assert_not_called()


def test_registry_rejects_second_pipeline_and_unregister_uses_identity():
    context = register_task("task", "microvm")
    try:
        assert get_context("task") is context
        assert get_context("other") is None
        with pytest.raises(LifecycleUnavailable):
            register_task("other", "other-vm")
        unregister_task(MicrovmLifecycle("task", "other-vm"))
        assert get_context("task") is context
    finally:
        unregister_task(context)
    assert get_context("task") is None


@pytest.mark.anyio
async def test_progress_writer_acknowledgments_are_shared_and_missing_table_refuses_sleep(
    monkeypatch,
):
    from progress_writer import _ProgressWriter

    context = register_task("progress-task", "microvm")
    try:
        await context.tool_started("tool")
        context.park_approval("gate", "tool", Mock(remaining_s=Mock(return_value=300)))
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events")
        writer = _ProgressWriter("progress-task")
        writer._table = Mock()
        writer._put_event("agent_milestone", {"message": "saved"})
        writer._table.put_item.assert_called_once()

        # A second writer's dropped event must invalidate the same task's
        # barrier, even after the first writer successfully writes again.
        missing = _ProgressWriter("progress-task")
        missing._table_name = None
        missing._put_event("agent_milestone", {"message": "lost"})
        writer._put_event("agent_milestone", {"message": "later success"})
        with pytest.raises(LifecycleUnavailable):
            await context.suspend(Mock(), budget_s=1)
    finally:
        unregister_task(context)


@pytest.mark.anyio
async def test_real_progress_writer_failure_cannot_acknowledge_suspend(monkeypatch):
    from progress_writer import _ProgressWriter

    context = register_task("write-error-task", "microvm")
    try:
        await context.tool_started("tool")
        context.park_approval("gate", "tool", Mock(remaining_s=Mock(return_value=300)))
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events")
        writer = _ProgressWriter("write-error-task")
        writer._table = Mock()
        writer._table.put_item.side_effect = OSError("write reply lost")
        writer._put_event("agent_milestone", {"message": "uncertain"})
        with pytest.raises(LifecycleUnavailable):
            await context.suspend(Mock(), budget_s=1)
    finally:
        unregister_task(context)


@pytest.mark.anyio
async def test_resume_reseeds_from_fresh_os_entropy_after_refresh(monkeypatch):
    from microvm_lifecycle import reseed_random

    entropy = Mock(side_effect=[b"r" * 32, b"w" * 32])
    seed = Mock()
    monkeypatch.setattr("microvm_lifecycle.os.urandom", entropy)
    monkeypatch.setattr("microvm_lifecycle.random.seed", seed)
    reseed_random()  # Same entry point used by /run.
    context, _ = await parked()
    await context.suspend(Mock(), budget_s=1)

    def refresh(_):
        seed.assert_called_once_with(b"r" * 32)

    await context.resume(refresh, budget_s=1)
    assert [call.args for call in entropy.call_args_list] == [(32,), (32,)]
    assert [call.args for call in seed.call_args_list] == [(b"r" * 32,), (b"w" * 32,)]


@pytest.mark.anyio
async def test_heartbeat_does_not_write_until_resume_finishes(monkeypatch):
    import server

    context = register_task("heartbeat-task", "microvm")
    write = Mock()
    monkeypatch.setattr(server.task_state, "write_heartbeat", write)
    try:
        await context.tool_started("tool")
        context.park_approval("gate", "tool", Mock(remaining_s=Mock(return_value=300)))
        await context.suspend(Mock(), budget_s=1)
        server._heartbeat_worker(context.task_id, Mock(wait=Mock(side_effect=[False, True])))
        write.assert_not_called()
        await context.resume(Mock(), budget_s=1)
        server._heartbeat_worker(context.task_id, Mock(wait=Mock(side_effect=[False, True])))
        write.assert_called_once_with(context.task_id)
    finally:
        unregister_task(context)


@pytest.mark.anyio
@pytest.mark.parametrize("background", [False, True, "serialized"])
async def test_sdk_failure_hook_releases_tool_and_detached_work_disables_sleep(
    monkeypatch, background
):
    import hooks

    async def allow(*args, **kwargs):
        return {"hookSpecificOutput": {"permissionDecision": "allow"}}

    monkeypatch.setattr(hooks, "pre_tool_use_hook", allow)
    context = register_task("sdk-tools-task", "microvm")
    try:
        matchers = hooks.build_hook_matchers(engine=Mock(), task_id=context.task_id)
        pre = matchers["PreToolUse"][0].hooks[0]
        tool_input = (
            '{"run_in_background": true}'
            if background == "serialized"
            else {"run_in_background": background}
        )
        await pre({"tool_name": "Bash", "tool_input": tool_input}, "first", {})
        await matchers["PostToolUseFailure"][0].hooks[0]({}, "first", {})
        await pre({"tool_name": "Bash", "tool_input": {}}, "approval", {})
        context.park_approval("gate", "approval", Mock(remaining_s=Mock(return_value=300)))
        if background:
            with pytest.raises(LifecycleUnavailable):
                await context.suspend(Mock(), budget_s=1)
        else:
            await context.suspend(Mock(), budget_s=1)
    finally:
        unregister_task(context)


@pytest.mark.anyio
@pytest.mark.parametrize("already_started", [False, True])
async def test_late_sdk_callback_keeps_closed_context_after_registry_removal(
    monkeypatch, already_started
):
    import hooks

    entered = asyncio.Event()
    release = asyncio.Event()

    async def allow(*args, **kwargs):
        entered.set()
        await release.wait()
        return {"hookSpecificOutput": {"permissionDecision": "allow"}}

    monkeypatch.setattr(hooks, "pre_tool_use_hook", allow)
    monkeypatch.setattr(hooks, "log_error_cw", Mock())
    context = register_task("late-sdk-task", "microvm")
    matchers = hooks.build_hook_matchers(engine=Mock(), task_id=context.task_id)
    pre = matchers["PreToolUse"][0].hooks[0]
    pending = None
    try:
        if already_started:
            pending = asyncio.create_task(pre({"tool_input": {}}, "tool", {}))
            await asyncio.wait_for(entered.wait(), 1)
        unregister_task(context)
        release.set()
        result = await pending if pending else await pre({"tool_input": {}}, "tool", {})
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
        assert entered.is_set() is already_started
    finally:
        release.set()
        unregister_task(context)
        if pending:
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.anyio
@pytest.mark.parametrize("budget", [0, -1, float("nan"), float("inf")])
async def test_bad_budget_does_not_close_approval_gate(budget):
    context, park = await parked()
    with pytest.raises(ValueError):
        await context.suspend(Mock(), budget_s=budget)
    await context.leave_approval(park)
