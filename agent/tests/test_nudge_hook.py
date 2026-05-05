# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Integration tests for the Stop-hook-based nudge injection path."""

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
    # Restore the default registry after each test.
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
        # mark_consumed should have been called once.
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
        """When nudges are injected, ``nudge_acknowledged`` milestone fires on the
        progress writer so the durable event stream shows a visible marker."""
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
        """Regression for AD-5 combined-turn ack: the ``nudge_acknowledged``
        milestone MUST be written before the hook returns the injection list.

        The durable event stream is how the CLI / fan-out dispatchers learn
        the nudge reached the agent.  If the SDK crashes between the hook's
        return and the next turn firing, the ack still has to be on the
        event table so operators don't think the nudge was lost.
        """
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
        # ``write_agent_milestone`` is a sync boto3 call in production; if a
        # future refactor makes it fire-and-forget, this test needs to grow
        # a flush barrier to keep the invariant guarded.
        progress.write_agent_milestone.side_effect = lambda **kw: call_order.append("milestone")

        result = hooks_mod._nudge_between_turns_hook(
            {
                "task_id": "t-1",
                "progress": progress,
            }
        )
        # Append after the hook returns so return-time is recorded relative
        # to the synchronous side_effect.
        call_order.append("return")

        # The milestone call must have landed BEFORE the return.
        assert call_order == ["milestone", "return"]
        assert len(result) == 1

    def test_nudge_ack_skipped_when_no_progress_in_ctx(self):
        """When ``ctx`` has no progress writer (e.g. hook invoked outside
        ``stop_hook``), the ack is skipped but injection still proceeds.

        Before this chunk the skip was silent; now it emits a DEBUG log so
        operators running with ``--trace`` can see ack delivery gaps.
        """
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

        # ctx without "progress" key
        result = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        # Injection still happens — AD-5 prefers steering the agent over
        # blocking on an ack delivery gap.
        assert len(result) == 1

    def test_nudge_ack_skipped_when_progress_writer_circuit_breaker_open(self):
        """When the progress writer's circuit breaker is tripped, the ack is
        skipped (with a WARN) but injection still proceeds."""
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
        progress._disabled = True  # circuit breaker open

        result = hooks_mod._nudge_between_turns_hook(
            {
                "task_id": "t-1",
                "progress": progress,
            }
        )

        # write_agent_milestone MUST NOT be called when the breaker is open
        # — emitting would violate the circuit-breaker contract and risk
        # tipping the writer further into a bad state.
        progress.write_agent_milestone.assert_not_called()
        # Injection still happens.
        assert len(result) == 1

    def test_nudge_milestone_emit_is_best_effort_on_progress_failure(self):
        """Milestone emission errors must not break injection."""
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
        # Injection must still succeed even if milestone write raises.
        result = hooks_mod._nudge_between_turns_hook(ctx)
        assert len(result) == 1

    def test_no_pending_no_milestone_emitted(self):
        """Don't spam milestones when there's nothing to inject."""
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
        """A second read_pending call (post-consume) returns [] and hook returns []."""
        table = MagicMock()
        # First call: one pending nudge.  Second call: table is now empty.
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
        # Freshly-imported registry: cancel runs first so it short-circuits
        # nudge injection on cancelled tasks; nudge second for running tasks.
        import importlib

        importlib.reload(hooks_mod)
        assert hooks_mod.between_turns_hooks[0] is hooks_mod._cancel_between_turns_hook
        assert hooks_mod.between_turns_hooks[1] is hooks_mod._nudge_between_turns_hook


class TestInProcessDedup:
    """Process-lifetime dedup guards against mark_consumed failures."""

    def test_already_injected_nudge_not_reinjected_even_if_mark_consumed_failed(self):
        """If mark_consumed persistently fails, read_pending keeps returning
        the same row, but the in-process dedup set prevents re-injection."""
        table = MagicMock()
        # Both reads return the SAME pending row (mark_consumed is failing).
        pending_row = {
            "task_id": "t-1",
            "nudge_id": "01ABC",
            "message": "persistent",
            "created_at": "ts",
            "consumed": False,
        }
        table.query.return_value = {"Items": [pending_row]}
        # Simulate mark_consumed failing repeatedly.
        table.update_item.side_effect = Exception("DDB throttled")
        nudge_reader._TABLE_CACHE = table

        first = hooks_mod._nudge_between_turns_hook({"task_id": "t-1"})
        assert len(first) == 1

        # Second call: same row still returned by read_pending, but dedup
        # set suppresses re-injection.
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
        # Same nudge_id "01A" appears for both tasks — each should still inject.
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
    """Fix 2: sync hooks must run off the asyncio loop via ``to_thread``."""

    def test_sync_hook_is_run_in_a_thread(self):
        main_thread_id = threading.get_ident()
        captured: dict[str, int] = {}

        def sync_hook(_ctx) -> list[str]:
            captured["tid"] = threading.get_ident()
            return ["ok"]

        hooks_mod.between_turns_hooks[:] = [sync_hook]
        result = _run(hooks_mod.stop_hook({}, None, {}, task_id="t-1"))
        assert result["decision"] == "block"
        # The sync hook must have executed on a worker thread, not the
        # asyncio event-loop thread that test_main is driving.
        assert captured["tid"] != main_thread_id


class TestStopWrapperTaskIdLogging:
    """Fix 5: Stop wrapper crashes must include task_id at ERROR severity."""

    def test_stop_wrapper_crash_logs_task_id_at_error(self, monkeypatch):
        logs: list[tuple[str, str]] = []

        def fake_log(prefix: str, text: str) -> None:
            logs.append((prefix, text))

        # Patch the ``log`` name imported into hooks_mod.
        monkeypatch.setattr(hooks_mod, "log", fake_log)

        # Make stop_hook raise — the _stop wrapper should catch, log, and
        # return an empty output.  We rebuild matchers to get a fresh _stop
        # closure bound to a distinct task_id.
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

        # Invoke the wrapped callback.
        _run(stop_callback({}, None, {}))

        # Find the ERROR log entry and assert it mentions task_id.
        error_entries = [(p, t) for (p, t) in logs if p == "ERROR"]
        assert len(error_entries) >= 1
        assert any("task-XYZ" in t for (_p, t) in error_entries)
