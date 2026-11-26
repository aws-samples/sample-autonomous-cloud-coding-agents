# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

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
        def _raise(_tid):
            raise task_state.TaskFetchError("simulated DDB blip")

        monkeypatch.setattr(task_state, "get_task", _raise)
        ctx: dict = {"task_id": "t-blip"}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        assert result == []
        assert "_cancel_requested" not in ctx

    def test_empty_task_id_is_noop(self):
        ctx: dict = {"task_id": ""}
        result = hooks_mod._cancel_between_turns_hook(ctx)
        assert result == []
        assert "_cancel_requested" not in ctx


class TestStopHookHonoursCancel:
    def test_cancel_signal_returns_continue_false(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})
        hooks_mod.between_turns_hooks[:] = [hooks_mod._cancel_between_turns_hook]

        result = _run(
            hooks_mod.stop_hook(
                {},
                None,
                None,
                task_id="t-cancel",
                progress=MagicMock(),
            )
        )
        assert result == {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }

    def test_cancel_wins_over_nudge(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})

        def _fake_nudge(_ctx):
            return ["<user_nudge>please do X</user_nudge>"]

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            _fake_nudge,
        ]

        result = _run(
            hooks_mod.stop_hook(
                {},
                None,
                None,
                task_id="t-cancel-with-nudge",
                progress=MagicMock(),
            )
        )
        assert result == {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }
        assert "decision" not in result
        assert "reason" not in result

    def test_running_task_nudge_still_injects(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "RUNNING"})

        def _fake_nudge(_ctx):
            return ["<user_nudge>reminder</user_nudge>"]

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            _fake_nudge,
        ]

        result = _run(
            hooks_mod.stop_hook(
                {},
                None,
                None,
                task_id="t-running",
                progress=MagicMock(),
            )
        )
        assert result == {
            "decision": "block",
            "reason": "<user_nudge>reminder</user_nudge>",
        }

    def test_milestone_emitted_on_cancel_detect(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})
        hooks_mod.between_turns_hooks[:] = [hooks_mod._cancel_between_turns_hook]

        progress = MagicMock()

        _run(
            hooks_mod.stop_hook(
                {},
                None,
                None,
                task_id="t-cancel-milestone",
                progress=progress,
            )
        )

        progress.write_agent_milestone.assert_called_once()
        call_kwargs = progress.write_agent_milestone.call_args.kwargs
        assert call_kwargs["milestone"] == "cancel_detected"


class TestCancelShortCircuitsNudgeConsumption:
    def test_nudge_hook_not_invoked_when_cancel_fires_first(self, monkeypatch):
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
                {},
                None,
                None,
                task_id="t-cancel-nudge-race",
                progress=MagicMock(),
            )
        )

        assert result == {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }
        assert nudge_calls["count"] == 0
        assert "t-cancel-nudge-race" not in hooks_mod._INJECTED_NUDGES

    def test_real_nudge_reader_not_touched_on_cancel(self, monkeypatch):
        monkeypatch.setattr(task_state, "get_task", lambda _tid: {"status": "CANCELLED"})

        table = MagicMock()
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

        hooks_mod.between_turns_hooks[:] = [
            hooks_mod._cancel_between_turns_hook,
            hooks_mod._nudge_between_turns_hook,
        ]

        result = _run(
            hooks_mod.stop_hook(
                {},
                None,
                None,
                task_id="t-cancel-real",
                progress=MagicMock(),
            )
        )

        assert result["continue_"] is False
        table.query.assert_not_called()
        table.update_item.assert_not_called()

    def test_preloop_cancel_skips_all_hooks_via_internal_guard(self, monkeypatch):
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

        ctx = {"task_id": "t-preloop", "_cancel_requested": True}
        result = hooks_mod._nudge_between_turns_hook(ctx)

        assert result == []
        table.query.assert_not_called()
        table.update_item.assert_not_called()
        assert "t-preloop" not in hooks_mod._INJECTED_NUDGES

    def test_nudge_hook_internal_guard_fires_even_if_registry_reordered(self, monkeypatch):
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
        progress.write_agent_milestone.assert_not_called()
        table.query.assert_not_called()
        table.update_item.assert_not_called()

    def test_running_task_nudge_still_consumed_normally(self, monkeypatch):
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
                {},
                None,
                None,
                task_id="t-live",
                progress=MagicMock(),
            )
        )

        assert result["decision"] == "block"
        assert "add docs" in result["reason"]
        table.query.assert_called_once()
        table.update_item.assert_called_once()
