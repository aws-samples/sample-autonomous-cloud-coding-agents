# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Integration tests for the Stop-hook-based cancel detection path.

Cancel flows from the REST cancel Lambda (writes ``status=CANCELLED`` to
TaskTable) through the agent's between-turns hook (`_cancel_between_turns_hook`)
to the Stop hook's ``continue_=False`` signal, which tells the SDK to halt.
The pipeline then sees the CANCELLED status and skips post-hooks so no PR
is pushed on a cancelled task.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

import hooks as hooks_mod
import nudge_reader
import task_state


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset():
    # Restore the default registry after each test.
    original = list(hooks_mod.between_turns_hooks)
    nudge_reader._reset_cache_for_tests()
    hooks_mod._reset_injected_nudges_for_tests()
    yield
    hooks_mod.between_turns_hooks[:] = original
    nudge_reader._reset_cache_for_tests()
    hooks_mod._reset_injected_nudges_for_tests()


class TestCancelBetweenTurnsHook:
    def test_cancelled_task_sets_sentinel(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})
        ctx: dict = {"task_id": "t-cancel"}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        # Hook never injects text — cancel flows via the ctx sentinel.
        assert result == []
        assert ctx["_cancel_requested"] is True

    def test_running_task_does_not_set_sentinel(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "RUNNING"})
        ctx: dict = {"task_id": "t-run"}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        assert result == []
        assert "_cancel_requested" not in ctx

    def test_missing_task_record_does_not_set_sentinel(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: None)
        ctx: dict = {"task_id": "t-missing"}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        assert result == []
        assert "_cancel_requested" not in ctx

    def test_ddb_failure_fails_open(self, monkeypatch):
        """Transient DDB blip must NOT be confused with a cancel signal."""

        def _raise(_tid):
            raise task_state.TaskFetchError("simulated DDB blip")

        monkeypatch.setattr(task_state, "get_task", _raise)
        ctx: dict = {"task_id": "t-blip"}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        assert result == []
        # Fail-open: no sentinel set → next turn will re-check.
        assert "_cancel_requested" not in ctx

    def test_empty_task_id_is_noop(self):
        ctx: dict = {"task_id": ""}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        assert result == []
        assert "_cancel_requested" not in ctx


class TestStopHookHonoursCancel:
    def test_cancel_signal_returns_continue_false(self, monkeypatch):
        """Stop hook must return continue_=False when cancel is detected.

        This is the mechanism that actually halts the SDK agent loop.
        """
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})
        # Strip nudge hook to keep the test focused on cancel flow.
        hooks_mod.between_turns_hooks[:] = [hooks_mod._cancel_between_turns_hook]

        result = _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-cancel",
                progress=MagicMock(),
            )
        )
        assert result == {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }

    def test_cancel_wins_over_nudge(self, monkeypatch):
        """If cancel and a pending nudge fire in the same turn, cancel wins.

        A user who cancels a task should NOT have their last-minute nudge
        injected into a dying agent.
        """
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})

        # Fake a nudge hook that returns real content — cancel must still win.
        def _fake_nudge(_ctx):
            return ["<user_nudge>please do X</user_nudge>"]

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            _fake_nudge,
        ]

        result = _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-cancel-with-nudge",
                progress=MagicMock(),
            )
        )
        assert result == {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }
        # Specifically NOT the "decision=block" nudge-injection path.
        assert "decision" not in result
        assert "reason" not in result

    def test_running_task_nudge_still_injects(self, monkeypatch):
        """Cancel hook is fail-safe: doesn't interfere with normal nudge path."""
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "RUNNING"})

        def _fake_nudge(_ctx):
            return ["<user_nudge>reminder</user_nudge>"]

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            _fake_nudge,
        ]

        result = _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-running",
                progress=MagicMock(),
            )
        )
        assert result == {
            "decision": "block",
            "reason": "<user_nudge>reminder</user_nudge>",
        }

    def test_milestone_emitted_on_cancel_detect(self, monkeypatch):
        """Stream visibility: users should see a cancel_detected milestone."""
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})
        hooks_mod.between_turns_hooks[:] = [hooks_mod._cancel_between_turns_hook]

        progress = MagicMock()

        _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-cancel-milestone",
                progress=progress,
            )
        )

        progress.write_agent_milestone.assert_called_once()
        call_kwargs = progress.write_agent_milestone.call_args.kwargs
        assert call_kwargs["milestone"] == "cancel_detected"


class TestCancelShortCircuitsNudgeConsumption:
    """Regression for krokoko PR #52 review finding #3.

    Before the fix, :func:`stop_hook` iterated ALL between-turns hooks BEFORE
    checking ``_cancel_requested`` — so when cancel fired, the nudge hook had
    already run, mutated DDB (``mark_consumed`` + stamped ``_INJECTED_NUDGES``),
    and had its return value silently discarded by the cancel branch.  Users
    saw a 202 Accepted for their nudge but the instruction was never injected
    into the (dying) agent.

    The fix is two-layered:
    1. ``stop_hook`` breaks out of the dispatcher loop as soon as any hook
       sets ``_cancel_requested``, so the nudge hook never runs on a
       cancelled turn.
    2. ``_nudge_between_turns_hook`` itself early-returns when
       ``_cancel_requested`` is already present, as belt-and-braces in
       case a future refactor reorders the registry.
    """

    def test_nudge_hook_not_invoked_when_cancel_fires_first(self, monkeypatch):
        """Happy-path regression: cancel hook flips sentinel → nudge hook is
        never called → DDB query never issued → injected-nudges set untouched.
        """
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})

        nudge_calls = {"count": 0}

        def _spy_nudge(_ctx):
            nudge_calls["count"] += 1
            return ["<user_nudge>should never be injected</user_nudge>"]

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            _spy_nudge,
        ]

        result = _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-cancel-nudge-race",
                progress=MagicMock(),
            )
        )

        # Cancel-wins semantics unchanged.
        assert result == {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }
        # Critical invariant: the nudge hook was NEVER called.  Before the
        # fix, ``nudge_calls["count"]`` would have been 1 and the pending
        # DDB row would have been marked consumed.
        assert nudge_calls["count"] == 0
        # In-process dedup set must be untouched — the "task set" should not
        # have been created because the nudge hook never ran.
        assert "t-cancel-nudge-race" not in hooks_mod._INJECTED_NUDGES

    def test_real_nudge_reader_not_touched_on_cancel(self, monkeypatch):
        """End-to-end regression: with the ACTUAL ``_nudge_between_turns_hook``
        registered alongside the cancel hook, a pending DDB row MUST NOT be
        read or marked consumed when cancel fires in the same turn.

        This is the scenario the review was concerned about — a user submits
        a nudge, then immediately cancels, and the nudge disappears silently
        because it was consumed but never injected.
        """
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})

        table = MagicMock()
        # If the nudge hook runs, it would see this pending row.
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-cancel-real",
                    "nudge_id": "01NUDGE",
                    "message": "please add logging",
                    "created_at": "2026-05-05T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        # Default registry order: cancel first, nudge second.
        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            hooks_mod._nudge_between_turns_hook,
        ]

        result = _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-cancel-real",
                progress=MagicMock(),
            )
        )

        assert result["continue_"] is False
        # DDB must not have been queried — the nudge hook never ran.
        table.query.assert_not_called()
        # And therefore no ``mark_consumed`` call either.
        table.update_item.assert_not_called()

    def test_preloop_cancel_skips_all_hooks_via_internal_guard(self, monkeypatch):
        """If cancel is already flagged on ``ctx`` entering the dispatcher
        (e.g. a Phase 3 hook prepended to the registry sets it, or a future
        code path stamps the flag before hook dispatch), the nudge hook's
        own early-return covers it.

        Today ``stop_hook`` builds ``ctx`` fresh each call so the pre-loop
        case is not reachable from the normal SDK entry point, but the
        nudge hook's internal guard is tested here directly to document the
        second line of defence.
        """
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-preloop",
                    "nudge_id": "01PRELOOP",
                    "message": "should not be consumed",
                    "created_at": "2026-05-05T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        # Cancel sentinel already set on ctx entering the nudge hook.
        ctx = {"task_id": "t-preloop", "_cancel_requested": True}
        result = hooks_mod._nudge_between_turns_hook(ctx)

        assert result == []
        # Belt-and-braces check: the nudge hook returned before any DDB I/O.
        table.query.assert_not_called()
        table.update_item.assert_not_called()
        # And the in-process dedup set was not stamped.
        assert "t-preloop" not in hooks_mod._INJECTED_NUDGES

    def test_nudge_hook_internal_guard_fires_even_if_registry_reordered(self, monkeypatch):
        """If a future refactor accidentally puts nudge before cancel in the
        registry, the loop-level break no longer helps — but the nudge
        hook's own ``_cancel_requested`` check still has to short-circuit.

        Simulate this by registering a synthetic "early cancel" hook that
        flips the sentinel BEFORE the nudge hook, but keeping nudge second
        as usual.  The loop will break after the cancel hook (finding
        already covered); here we verify the nudge hook's internal guard
        by driving it directly with cancel already set in ctx and an
        attached progress writer.
        """
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-guard",
                    "nudge_id": "01GUARD",
                    "message": "must not inject",
                    "created_at": "ts",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        progress = MagicMock()
        ctx = {
            "task_id": "t-guard",
            "progress": progress,
            "_cancel_requested": True,
        }
        result = hooks_mod._nudge_between_turns_hook(ctx)

        assert result == []
        # The early-return happens before ``_emit_nudge_milestone`` — no
        # ``nudge_acknowledged`` event should be written for a cancelled task.
        progress.write_agent_milestone.assert_not_called()
        table.query.assert_not_called()
        table.update_item.assert_not_called()

    def test_running_task_nudge_still_consumed_normally(self, monkeypatch):
        """Negative control: the guard must not regress the happy path.

        A RUNNING task with a pending nudge should still flow through:
        cancel hook returns [] without setting the sentinel, nudge hook
        reads + consumes + injects as before.
        """
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "RUNNING"})

        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-live",
                    "nudge_id": "01LIVE",
                    "message": "add docs",
                    "created_at": "ts",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            hooks_mod._nudge_between_turns_hook,
        ]

        result = _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-live",
                progress=MagicMock(),
            )
        )

        assert result["decision"] == "block"
        assert "add docs" in result["reason"]
        table.query.assert_called_once()
        table.update_item.assert_called_once()
