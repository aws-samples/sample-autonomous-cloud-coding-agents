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
import task_state


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset():
    # Restore the default registry after each test.
    original = list(hooks_mod.between_turns_hooks)
    yield
    hooks_mod.between_turns_hooks[:] = original


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
                sse_adapter=MagicMock(),
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
                sse_adapter=MagicMock(),
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
                sse_adapter=MagicMock(),
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
        sse_adapter = MagicMock()

        _run(
            hooks_mod.stop_hook(
                hook_input={},
                tool_use_id=None,
                hook_context=None,
                task_id="t-cancel-milestone",
                progress=progress,
                sse_adapter=sse_adapter,
            )
        )

        progress.write_agent_milestone.assert_called_once()
        call_kwargs = progress.write_agent_milestone.call_args.kwargs
        assert call_kwargs["milestone"] == "cancel_detected"
        sse_adapter.write_agent_milestone.assert_called_once()
