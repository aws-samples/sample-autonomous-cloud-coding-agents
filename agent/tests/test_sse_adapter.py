# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for sse_adapter._SSEAdapter.

We avoid `pytest-asyncio` (not a dep in agent/pyproject.toml).  Instead each
test sets up its own loop, attaches the adapter to it, and drives the
producer/consumer interaction synchronously — matching the style in
``tests/test_hooks.py``.
"""

from __future__ import annotations

import asyncio
import threading
import time
from unittest.mock import MagicMock

import pytest

from sse_adapter import _SSEAdapter

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_adapter(max_queue_size: int = 1000) -> _SSEAdapter:
    return _SSEAdapter("task-xyz", max_queue_size=max_queue_size)


def _run_loop_thread(loop: asyncio.AbstractEventLoop) -> threading.Thread:
    """Run ``loop`` forever on a background thread; returns the thread."""
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    return t


def _stop_loop(loop: asyncio.AbstractEventLoop, thread: threading.Thread) -> None:
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=2.0)
    if not loop.is_closed():
        loop.close()


def _drain_next(adapter: _SSEAdapter, loop: asyncio.AbstractEventLoop, timeout: float = 1.0):
    """Schedule ``adapter.get()`` on the loop from the main thread, wait, return."""
    fut = asyncio.run_coroutine_threadsafe(adapter.get(), loop)
    return fut.result(timeout=timeout)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def loop_env():
    """Spawn a background asyncio loop and yield (loop, thread).

    Tests that need a running loop attached to an adapter use this fixture.
    """
    loop = asyncio.new_event_loop()
    thread = _run_loop_thread(loop)
    try:
        yield loop, thread
    finally:
        _stop_loop(loop, thread)


# ---------------------------------------------------------------------------
# Basic round-trip for each write_agent_* method
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_write_agent_turn_roundtrip(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_turn(
            turn=1, model="claude-4", thinking="hmm", text="hello", tool_calls_count=2
        )

        event = _drain_next(adapter, loop)
        assert event == {
            "type": "agent_turn",
            "turn": 1,
            "model": "claude-4",
            "thinking": "hmm",
            "text": "hello",
            "tool_calls_count": 2,
        }

    def test_write_agent_tool_call_roundtrip(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_tool_call(tool_name="Bash", tool_input="ls", turn=3)

        event = _drain_next(adapter, loop)
        assert event == {
            "type": "agent_tool_call",
            "tool_name": "Bash",
            "tool_input": "ls",
            "turn": 3,
        }

    def test_write_agent_tool_result_roundtrip(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_tool_result(
            tool_name="Bash", is_error=True, content="command not found", turn=4
        )

        event = _drain_next(adapter, loop)
        assert event == {
            "type": "agent_tool_result",
            "tool_name": "Bash",
            "is_error": True,
            "content": "command not found",
            "turn": 4,
        }

    def test_write_agent_milestone_roundtrip(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_milestone("repo_setup_complete", details="branch=main")

        event = _drain_next(adapter, loop)
        assert event == {
            "type": "agent_milestone",
            "milestone": "repo_setup_complete",
            "details": "branch=main",
        }

    def test_write_agent_cost_update_roundtrip(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_cost_update(
            cost_usd=0.0512, input_tokens=1000, output_tokens=500, turn=5
        )

        event = _drain_next(adapter, loop)
        assert event == {
            "type": "agent_cost_update",
            "cost_usd": 0.0512,
            "input_tokens": 1000,
            "output_tokens": 500,
            "turn": 5,
        }

    def test_write_agent_error_roundtrip(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_error(error_type="RuntimeError", message="kaboom")

        event = _drain_next(adapter, loop)
        assert event == {
            "type": "agent_error",
            "error_type": "RuntimeError",
            "message": "kaboom",
        }

    def test_write_agent_error_fallback_uses_undelivered_counter(self, loop_env):
        """If _enqueue itself raises inside write_agent_error, the last-ditch
        counter bump must NOT raise AttributeError — the adapter's contract
        is "never compound the problem we're trying to emit."

        Regression: a prior commit referenced ``self._dropped_count`` which
        does not exist on the class; only ``_undelivered_count`` does. The
        bug was a latent AttributeError on the catch-all path.
        """
        import unittest.mock as mock

        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        undelivered_before = adapter._undelivered_count  # noqa: SLF001
        with mock.patch.object(adapter, "_enqueue", side_effect=RuntimeError("boom")):
            # Must NOT raise — this is the "last-ditch" safety net.
            adapter.write_agent_error(error_type="X", message="y")

        assert adapter._undelivered_count == undelivered_before + 1  # noqa: SLF001


# ---------------------------------------------------------------------------
# FIFO ordering
# ---------------------------------------------------------------------------


class TestOrdering:
    def test_fifo_ordering_preserved(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        for i in range(20):
            adapter.write_agent_milestone(f"m{i}", details="")

        # Give the loop a moment to drain call_soon_threadsafe callbacks.
        time.sleep(0.05)

        seen = [_drain_next(adapter, loop)["milestone"] for _ in range(20)]
        assert seen == [f"m{i}" for i in range(20)]


# ---------------------------------------------------------------------------
# Subscriber lifecycle
# ---------------------------------------------------------------------------


class TestSubscribers:
    def test_write_before_attach_drops_silently(self):
        adapter = _make_adapter()
        assert adapter.has_subscribers is False

        adapter.write_agent_milestone("m1")
        adapter.write_agent_milestone("m2")

        assert adapter.dropped_count == 2

    def test_write_after_detach_drops_silently(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)
        adapter.detach_loop()
        assert adapter.has_subscribers is False

        adapter.write_agent_milestone("after-detach")
        assert adapter.dropped_count == 1

    def test_reattach_resumes_flow(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()

        # Phase 1: no subscriber — drops.
        adapter.write_agent_milestone("pre-attach")
        assert adapter.dropped_count == 1

        # Phase 2: attached — flows.
        adapter.attach_loop(loop)
        adapter.write_agent_milestone("during-1")
        time.sleep(0.02)
        ev1 = _drain_next(adapter, loop)
        assert ev1["milestone"] == "during-1"

        # Phase 3: detached — drops.
        adapter.detach_loop()
        adapter.write_agent_milestone("between")
        assert adapter.dropped_count == 2

        # Phase 4: reattached — flows again, counter is monotonic.
        adapter.attach_loop(loop)
        adapter.write_agent_milestone("during-2")
        time.sleep(0.02)
        ev2 = _drain_next(adapter, loop)
        assert ev2["milestone"] == "during-2"
        assert adapter.dropped_count == 2  # unchanged since reattach

    def test_has_subscribers_transitions(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()

        assert adapter.has_subscribers is False
        adapter.attach_loop(loop)
        assert adapter.has_subscribers is True
        adapter.detach_loop()
        assert adapter.has_subscribers is False

        adapter.attach_loop(loop)
        assert adapter.has_subscribers is True
        adapter.close()
        assert adapter.has_subscribers is False


# ---------------------------------------------------------------------------
# Backpressure — drop oldest
# ---------------------------------------------------------------------------


class TestBackpressure:
    def test_queue_full_drops_oldest(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter(max_queue_size=3)
        adapter.attach_loop(loop)

        # Fill to capacity.
        adapter.write_agent_milestone("m0")
        adapter.write_agent_milestone("m1")
        adapter.write_agent_milestone("m2")
        time.sleep(0.05)

        # One more — should drop m0, keep m1, m2, m3.
        adapter.write_agent_milestone("m3")
        time.sleep(0.05)

        assert adapter.dropped_count == 1

        seen = [_drain_next(adapter, loop)["milestone"] for _ in range(3)]
        assert seen == ["m1", "m2", "m3"]

    def test_queue_full_repeated_drops_accumulate(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter(max_queue_size=2)
        adapter.attach_loop(loop)

        for i in range(7):
            adapter.write_agent_milestone(f"m{i}")
        time.sleep(0.1)

        # 2 fit, 5 cause drops
        assert adapter.dropped_count == 5

        # The two survivors should be the newest two.
        seen = [_drain_next(adapter, loop)["milestone"] for _ in range(2)]
        assert seen == ["m5", "m6"]

    def test_dropped_count_monotonic(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter(max_queue_size=1)
        adapter.attach_loop(loop)

        prev = 0
        for i in range(10):
            adapter.write_agent_milestone(f"m{i}")
            time.sleep(0.005)
            assert adapter.dropped_count >= prev
            prev = adapter.dropped_count


# ---------------------------------------------------------------------------
# Close sentinel
# ---------------------------------------------------------------------------


class TestClose:
    def test_close_causes_get_to_return_none(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_milestone("m1")
        adapter.close()

        # First get delivers the real event.
        ev = _drain_next(adapter, loop)
        assert ev["milestone"] == "m1"

        # Second get returns None (sentinel).
        assert _drain_next(adapter, loop) is None

    def test_writes_after_close_drop_silently(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)
        adapter.close()

        adapter.write_agent_milestone("post-close")
        assert adapter.dropped_count == 1

    def test_close_is_idempotent(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.close()
        adapter.close()  # should not raise, should not enqueue a second sentinel

        assert _drain_next(adapter, loop) is None


# ---------------------------------------------------------------------------
# Threading
# ---------------------------------------------------------------------------


class TestThreading:
    def test_write_from_non_loop_thread(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        received: list = []

        def producer():
            adapter.write_agent_turn(turn=1, model="m", thinking="", text="t", tool_calls_count=0)

        t = threading.Thread(target=producer)
        t.start()
        t.join(timeout=1.0)

        received.append(_drain_next(adapter, loop))
        assert received[0]["type"] == "agent_turn"
        assert received[0]["text"] == "t"

    def test_concurrent_producers(self, loop_env):
        loop, _ = loop_env
        n_threads = 4
        per_thread = 25
        adapter = _make_adapter(max_queue_size=n_threads * per_thread * 2)
        adapter.attach_loop(loop)

        def producer(tid: int):
            for i in range(per_thread):
                adapter.write_agent_milestone(f"t{tid}-i{i}")

        threads = [threading.Thread(target=producer, args=(tid,)) for tid in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=2.0)

        time.sleep(0.1)

        seen: list[str] = []
        for _ in range(n_threads * per_thread):
            seen.append(_drain_next(adapter, loop)["milestone"])

        # All events present.
        assert len(seen) == n_threads * per_thread
        assert adapter.dropped_count == 0

        # Within each producer, ordering preserved.
        for tid in range(n_threads):
            prefix = f"t{tid}-"
            per = [s for s in seen if s.startswith(prefix)]
            assert per == [f"t{tid}-i{i}" for i in range(per_thread)]


# ---------------------------------------------------------------------------
# Loop-closed / error paths
# ---------------------------------------------------------------------------


class TestLoopClosed:
    def test_closed_loop_drops_silently(self):
        """If the attached loop is closed, writes must not raise."""
        loop = asyncio.new_event_loop()
        adapter = _make_adapter()
        adapter.attach_loop(loop)
        loop.close()

        # Must not raise.
        adapter.write_agent_turn(turn=1, model="m", thinking="", text="t", tool_calls_count=0)
        adapter.write_agent_error("E", "bad")

        assert adapter.dropped_count >= 2

    def test_call_soon_threadsafe_runtimeerror_caught(self):
        """Mock a loop whose call_soon_threadsafe raises RuntimeError; must be swallowed."""
        adapter = _make_adapter()

        fake_loop = MagicMock(spec=asyncio.AbstractEventLoop)
        fake_loop.is_closed.return_value = False
        fake_loop.call_soon_threadsafe.side_effect = RuntimeError("loop shutting down")

        adapter.attach_loop(fake_loop)

        # Must not raise.
        adapter.write_agent_milestone("x")
        assert adapter.dropped_count == 1

    def test_call_soon_threadsafe_generic_exception_caught(self):
        """Any unexpected exception from call_soon_threadsafe must be swallowed."""
        adapter = _make_adapter()

        fake_loop = MagicMock(spec=asyncio.AbstractEventLoop)
        fake_loop.is_closed.return_value = False
        fake_loop.call_soon_threadsafe.side_effect = ValueError("weird")

        adapter.attach_loop(fake_loop)
        adapter.write_agent_milestone("y")
        assert adapter.dropped_count == 1


# ---------------------------------------------------------------------------
# Payload integrity
# ---------------------------------------------------------------------------


class TestPayloadIntegrity:
    def test_large_tool_result_not_truncated(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        big = "x" * 100_000
        adapter.write_agent_tool_result(tool_name="Bash", is_error=False, content=big, turn=1)

        ev = _drain_next(adapter, loop)
        assert ev["content"] == big
        assert len(ev["content"]) == 100_000

    def test_large_turn_fields_not_truncated(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        big = "y" * 50_000
        adapter.write_agent_turn(turn=1, model="m", thinking=big, text=big, tool_calls_count=0)

        ev = _drain_next(adapter, loop)
        assert ev["thinking"] == big
        assert ev["text"] == big

    def test_cost_update_none_cost(self, loop_env):
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_cost_update(cost_usd=None, input_tokens=10, output_tokens=5, turn=1)

        ev = _drain_next(adapter, loop)
        assert ev["cost_usd"] is None
        assert ev["input_tokens"] == 10

    def test_write_agent_error_never_raises(self):
        """write_agent_error must be absolutely bulletproof — even with pathological input."""
        adapter = _make_adapter()  # no loop attached

        # Each of these must return without raising.
        adapter.write_agent_error("", "")
        adapter.write_agent_error("E", "x" * 1_000_000)
        adapter.write_agent_error("E", "\x00\x01\x02")
        adapter.write_agent_error("E" * 10_000, "msg")

        # All dropped (no subscribers) — no exception.
        assert adapter.dropped_count == 4

    def test_payload_fields_pass_through_unchanged(self, loop_env):
        """Adapter does no coercion / filtering — keys and values pass through."""
        loop, _ = loop_env
        adapter = _make_adapter()
        adapter.attach_loop(loop)

        adapter.write_agent_tool_call(tool_name="unusual-name_1", tool_input="{}", turn=99)

        ev = _drain_next(adapter, loop)
        assert set(ev.keys()) == {"type", "tool_name", "tool_input", "turn"}
        assert ev["tool_name"] == "unusual-name_1"
        assert ev["tool_input"] == "{}"
        assert ev["turn"] == 99
