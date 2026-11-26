# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import asyncio
import threading
from unittest.mock import MagicMock

import pytest

import hooks as hooks_mod
import nudge_reader


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _reset():
    nudge_reader._reset_cache_for_tests()
    hooks_mod._reset_injected_nudges_for_tests()
    original = list(hooks_mod.between_turns_hooks)
    yield
    hooks_mod.between_turns_hooks[:] = original
    nudge_reader._reset_cache_for_tests()
    hooks_mod._reset_injected_nudges_for_tests()


class TestNudgeBetweenTurnsHook:
    def test_pending_nudge_produces_xml_injection(self, monkeypatch):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-1",
                    "nudge_id": "01ABC",
                    "message": "please prioritise error handling",
                    "created_at": "2026-04-22T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        result = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert len(result) == 1
        assert "<user_nudge" in result[0]
        assert "please prioritise error handling" in result[0]
        table.update_item.assert_called_once()

    def test_no_pending_nudges_returns_empty(self):
        table = MagicMock()
        table.query.return_value = {"Items": []}
        nudge_reader._TABLE_CACHE = table

        assert hooks_mod._nudge_between_turns_hook({"task_id": "t-1"}) == []

    def test_missing_task_id_returns_empty(self):
        assert hooks_mod._nudge_between_turns_hook({}) == []
        assert hooks_mod._nudge_between_turns_hook({"task_id": ""}) == []

    def test_ddb_error_returns_empty(self):
        table = MagicMock()
        table.query.side_effect = Exception("DDB down")
        nudge_reader._TABLE_CACHE = table
        assert hooks_mod._nudge_between_turns_hook({"task_id": "t-1"}) == []

    def test_nudge_injection_emits_milestone_on_progress(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-1",
                    "nudge_id": "01ABCDEFGHJKMNPQR9ST8V0WXZ",
                    "message": "focus on error handling",
                    "created_at": "2026-04-22T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        progress = MagicMock()
        ctx = {
            "task_id": "t-1",
            "progress": progress,
        }
        result = hooks_mod._nudge_between_turns_hook(ctx)
        assert len(result) == 1

        progress.write_agent_milestone.assert_called_once()
        _, kwargs = progress.write_agent_milestone.call_args
        assert kwargs["milestone"] == "nudge_acknowledged"
        assert "1 nudge(s) acknowledged" in kwargs["details"]
        assert "focus on error handling" in kwargs["details"]

    def test_nudge_ack_milestone_fires_before_injection_list_returns(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-1",
                    "nudge_id": "01ABCDEFGHJKMNPQR9ST8V0WXZ",
                    "message": "pivot to logging",
                    "created_at": "2026-04-22T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        call_order: list[str] = []
        progress = MagicMock()
        progress.write_agent_milestone.side_effect = lambda **kw: call_order.append("milestone")

        result = hooks_mod._nudge_between_turns_hook(
            {
                "task_id": "t-1",
                "progress": progress,
            }
        )
        call_order.append("return")

        assert call_order == ["milestone", "return"]
        assert len(result) == 1

    def test_nudge_ack_skipped_when_no_progress_in_ctx(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-1",
                    "nudge_id": "01ABC",
                    "message": "hi",
                    "created_at": "2026-04-22T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        result = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert len(result) == 1

    def test_nudge_ack_skipped_when_progress_writer_circuit_breaker_open(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-1",
                    "nudge_id": "01ABC",
                    "message": "keep going",
                    "created_at": "2026-04-22T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        progress = MagicMock()
        progress._disabled = True

        result = hooks_mod._nudge_between_turns_hook(
            {
                "task_id": "t-1",
                "progress": progress,
            }
        )

        progress.write_agent_milestone.assert_not_called()
        assert len(result) == 1

    def test_nudge_milestone_emit_is_best_effort_on_progress_failure(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {
                    "task_id": "t-1",
                    "nudge_id": "01XYZ",
                    "message": "hi",
                    "created_at": "2026-04-22T12:00:00Z",
                    "consumed": False,
                }
            ]
        }
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        progress = MagicMock()
        progress.write_agent_milestone.side_effect = RuntimeError("boom")
        ctx = {
            "task_id": "t-1",
            "progress": progress,
        }
        result = hooks_mod._nudge_between_turns_hook(ctx)
        assert len(result) == 1

    def test_no_pending_no_milestone_emitted(self):
        table = MagicMock()
        table.query.return_value = {"Items": []}
        nudge_reader._TABLE_CACHE = table

        progress = MagicMock()
        ctx = {
            "task_id": "t-1",
            "progress": progress,
        }
        assert hooks_mod._nudge_between_turns_hook(ctx) == []
        progress.write_agent_milestone.assert_not_called()

    def test_already_consumed_nudge_not_reinjected(self):
        table = MagicMock()
        table.query.side_effect = [
            {
                "Items": [
                    {
                        "task_id": "t-1",
                        "nudge_id": "01ABC",
                        "message": "first",
                        "created_at": "ts",
                        "consumed": False,
                    }
                ]
            },
            {"Items": []},
        ]
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        first = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert len(first) == 1

        second = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert second == []


class TestStopHook:
    def test_empty_hooks_allow_stop(self):
        hooks_mod.between_turns_hooks[:] = []
        result = _run(hooks_mod.stop_hook({}, None, {}, task_id="t-1"))
        assert result == {}

    def test_nudge_produces_block_decision(self):
        def fake(_ctx):
            return ["<user_nudge>steer</user_nudge>"]

        hooks_mod.between_turns_hooks[:] = [fake]
        result = _run(hooks_mod.stop_hook({}, None, {}, task_id="t-1"))
        assert result["decision"] == "block"
        assert "<user_nudge>steer</user_nudge>" in result["reason"]

    def test_hook_exception_swallowed(self):
        def broken(_ctx):
            raise RuntimeError("kaboom")

        def ok(_ctx):
            return ["still ok"]

        hooks_mod.between_turns_hooks[:] = [broken, ok]
        result = _run(hooks_mod.stop_hook({}, None, {}, task_id="t-1"))
        assert result["decision"] == "block"
        assert "still ok" in result["reason"]

    def test_multiple_hooks_joined(self):
        hooks_mod.between_turns_hooks[:] = [
            lambda _ctx: ["one"],
            lambda _ctx: ["two", "three"],
        ]
        result = _run(hooks_mod.stop_hook({}, None, {}, task_id="t-1"))
        assert "one" in result["reason"]
        assert "two" in result["reason"]
        assert "three" in result["reason"]

    def test_registry_default_contains_cancel_then_nudge(self):
        import importlib

        importlib.reload(hooks_mod)
        reg = hooks_mod.between_turns_hooks
        i_cancel = reg.index(hooks_mod._cancel_between_turns_hook)
        i_nudge = reg.index(hooks_mod._nudge_between_turns_hook)
        assert i_cancel == 0
        assert i_cancel < i_nudge


class TestInProcessDedup:
    def test_already_injected_nudge_not_reinjected_even_if_mark_consumed_failed(self):
        table = MagicMock()
        pending_row = {
            "task_id": "t-1",
            "nudge_id": "01ABC",
            "message": "persistent",
            "created_at": "ts",
            "consumed": False,
        }
        table.query.return_value = {"Items": [pending_row]}
        table.update_item.side_effect = Exception("DDB throttled")
        nudge_reader._TABLE_CACHE = table

        first = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert len(first) == 1

        second = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert second == []

    def test_different_nudge_ids_on_same_task_all_injected(self):
        table = MagicMock()
        table.query.side_effect = [
            {
                "Items": [
                    {
                        "task_id": "t-1",
                        "nudge_id": "01A",
                        "message": "first",
                        "created_at": "t1",
                        "consumed": False,
                    }
                ]
            },
            {
                "Items": [
                    {
                        "task_id": "t-1",
                        "nudge_id": "01B",
                        "message": "second",
                        "created_at": "t2",
                        "consumed": False,
                    }
                ]
            },
        ]
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        first = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        second = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert len(first) == 1
        assert "first" in first[0]
        assert len(second) == 1
        assert "second" in second[0]

    def test_different_tasks_do_not_share_dedup(self):
        table = MagicMock()
        table.query.side_effect = [
            {
                "Items": [
                    {
                        "task_id": "t-A",
                        "nudge_id": "01A",
                        "message": "for A",
                        "created_at": "t",
                        "consumed": False,
                    }
                ]
            },
            {
                "Items": [
                    {
                        "task_id": "t-B",
                        "nudge_id": "01A",
                        "message": "for B",
                        "created_at": "t",
                        "consumed": False,
                    }
                ]
            },
        ]
        table.update_item.return_value = {}
        nudge_reader._TABLE_CACHE = table

        a = hooks_mod._nudge_between_turns_hook({"task_id": "t-A"})
        b = hooks_mod._nudge_between_turns_hook({"task_id": "t-B"})
        assert len(a) == 1 and "for A" in a[0]
        assert len(b) == 1 and "for B" in b[0]


class TestStopHookThreading:
    def test_sync_hook_is_run_in_a_thread(self):
        main_thread_id = threading.get_ident()
        captured: dict[str, int] = {}

        def sync_hook(_ctx) -> list[str]:
            captured["tid"] = threading.get_ident()
            return ["ok"]

        hooks_mod.between_turns_hooks[:] = [sync_hook]
        result = _run(hooks_mod.stop_hook({}, None, {}, task_id="t-1"))
        assert result["decision"] == "block"
        assert captured["tid"] != main_thread_id


class TestStopWrapperTaskIdLogging:
    def test_stop_wrapper_crash_logs_task_id_at_error(self, monkeypatch):
        logs: list[tuple[str, str]] = []

        def fake_log(prefix: str, text: str) -> None:
            logs.append((prefix, text))

        monkeypatch.setattr(hooks_mod, "log", fake_log)

        async def broken_stop_hook(*_a, **_k):
            raise RuntimeError("boom")

        monkeypatch.setattr(hooks_mod, "stop_hook", broken_stop_hook)

        matchers = hooks_mod.build_hook_matchers(
            engine=MagicMock(),
            trajectory=None,
            task_id="task-XYZ",
        )
        stop_matcher = matchers["Stop"][0]
        stop_callback = stop_matcher.hooks[0]

        _run(stop_callback({}, None, {}))

        error_entries = [(p, t) for (p, t) in logs if p == "ERROR"]
        assert len(error_entries) >= 1
        assert any("task-XYZ" in t for (_p, t) in error_entries)
