# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Real-time SSE sibling of :mod:`progress_writer`.

Phase 1b introduces per-task live event streaming to CLI watchers.  Durability
is still owned by :class:`progress_writer._ProgressWriter` (DynamoDB
``TaskEventsTable``) — :class:`_SSEAdapter` is the ephemeral, real-time push
channel that feeds the SSE handler in ``server.py``.

Design contract (see ``docs/design/INTERACTIVE_AGENTS.md`` §5 and §9.10)::

    pipeline thread (sync)                          asyncio loop thread
    ─────────────────────                           ───────────────────
    write_agent_turn(...)  ──run_coroutine_threadsafe──▶  asyncio.Queue
    write_agent_tool_*()   ──call_soon_threadsafe──────▶      │
    ...                                                       ▼
                                               await adapter.get() → SSE frame

The semantic methods (``write_agent_*``) mirror ``_ProgressWriter`` 1:1 so
integration in ``pipeline.py`` / ``runner.py`` (Step 3) is symmetric — both
writers are called from the same call sites with the same arguments.

Guarantees:

* **Never raises.**  Fail-open: every enqueue path is wrapped to drop silently
  and bump ``dropped_count``.  The pipeline must be unaffected by whether a
  client is connected, whether the loop is closed, or whether the queue is
  full.
* **Thread-safe.**  Writes come from the pipeline's background thread; the
  queue belongs to the asyncio loop.  We bridge with
  ``loop.call_soon_threadsafe``.
* **Backpressure = drop-oldest.**  A real-time stream prioritises recency; on
  queue-full we pop one item and push the new one.  Counter only ever grows.
* **No-subscribers = drop silently.**  Before ``attach_loop`` and after
  ``detach_loop`` / ``close``, writes are silently dropped and counted.  The
  SSE handler is free to attach late (events published before attach are not
  buffered — durability lives in DDB via ``_ProgressWriter``).
* **Close sentinel.**  ``close()`` enqueues a distinguishable sentinel object;
  ``get()`` returns ``None`` when it dequeues the sentinel so the SSE handler
  can cleanly terminate its stream.

The wire-format translation (semantic dict → AG-UI ``TEXT_MESSAGE_*`` /
``TOOL_CALL_*`` frames) happens in the SSE handler, NOT here.  This adapter
only traffics in the same semantic dicts that :class:`_ProgressWriter` stores
in DDB ``metadata`` fields.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from shell import log

# Default ceiling: ~1000 events is several minutes of heavy agent activity at
# current emission rates (turn + several tool calls per turn).  Bounded so a
# stuck consumer cannot OOM the microVM.
_DEFAULT_MAX_QUEUE_SIZE = 1000


# Sentinel value for the close signal.  A unique object() is cheaper and safer
# than a string — no chance of collision with a real event dict.
_CLOSE_SENTINEL: object = object()


class _SSEAdapter:
    """Producer side of a per-task :class:`asyncio.Queue` for real-time events.

    One instance per task.  Lifecycle mirrors :class:`_ProgressWriter`:
    constructed by ``pipeline.run_task``, closed when the task finishes.

    Enqueue strategy — we use ``loop.call_soon_threadsafe`` (not
    ``asyncio.run_coroutine_threadsafe``) because ``Queue.put_nowait`` is a
    plain synchronous call; scheduling it as a callback avoids the overhead of
    wrapping it in a coroutine + Future and gives us synchronous, bounded
    behaviour from the producer thread's perspective.  The ``Future``-based API
    would also surface queue-full via ``QueueFull`` on an awaited result which
    the pipeline thread is not awaiting — dropping on the floor invisibly is
    exactly what we are trying to avoid.
    """

    def __init__(self, task_id: str, max_queue_size: int = _DEFAULT_MAX_QUEUE_SIZE) -> None:
        self._task_id = task_id
        self._max_queue_size = max_queue_size
        self._queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=max_queue_size)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closed = False
        self._dropped_count = 0

    # ------------------------------------------------------------------ lifecycle

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the adapter to an asyncio loop (called by the SSE handler).

        Until this is called, writes are silently dropped and counted.  The
        loop must own the queue; all ``get()`` calls must happen on this loop.
        """
        self._loop = loop
        log("[sse]", f"attach_loop task={self._task_id}")

    def detach_loop(self) -> None:
        """Unbind the loop (SSE client disconnected).

        Further ``write_agent_*`` calls become silent drops.  The queue is
        left intact so a subsequent ``attach_loop`` can resume streaming (any
        remaining items in the queue will be delivered to the next consumer).
        """
        self._loop = None
        log("[sse]", f"detach_loop task={self._task_id}")

    def close(self) -> None:
        """Signal end-of-stream.

        Enqueues a terminal sentinel (best-effort — if the queue is full we
        drop the oldest to make room, because the sentinel is load-bearing for
        the consumer's clean shutdown).  Idempotent.
        """
        if self._closed:
            return
        self._closed = True
        loop = self._loop
        if loop is None or loop.is_closed():
            # No consumer — nothing to signal.
            return
        # Loop already shutting down is harmless — we are in a shutdown path.
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(self._put_sentinel_from_loop)

    # ------------------------------------------------------------------ properties

    @property
    def dropped_count(self) -> int:
        """Number of events dropped due to queue full, no-subscribers, or error."""
        return self._dropped_count

    def get_dropped_count(self) -> int:  # alias, for callers that prefer a method
        return self._dropped_count

    @property
    def has_subscribers(self) -> bool:
        """True iff :meth:`attach_loop` is active and we are not closed."""
        return self._loop is not None and not self._closed

    # ------------------------------------------------------------------ consumer API

    async def get(self) -> dict | None:
        """Await the next event.

        Returns ``None`` when the close sentinel is dequeued, signalling the
        SSE handler to terminate its stream.  Must be awaited on the same loop
        that was passed to :meth:`attach_loop`.
        """
        item = await self._queue.get()
        if item is _CLOSE_SENTINEL:
            return None
        return item

    # ------------------------------------------------------------------ producer API

    def write_agent_turn(
        self,
        turn: int,
        model: str,
        thinking: str,
        text: str,
        tool_calls_count: int,
    ) -> None:
        """Emit an ``agent_turn`` event (after each AssistantMessage)."""
        self._enqueue(
            {
                "type": "agent_turn",
                "turn": turn,
                "model": model,
                "thinking": thinking,
                "text": text,
                "tool_calls_count": tool_calls_count,
            }
        )

    def write_agent_tool_call(self, tool_name: str, tool_input: str, turn: int) -> None:
        """Emit an ``agent_tool_call`` event (after each ToolUseBlock)."""
        self._enqueue(
            {
                "type": "agent_tool_call",
                "tool_name": tool_name,
                "tool_input": tool_input,
                "turn": turn,
            }
        )

    def write_agent_tool_result(
        self,
        tool_name: str,
        is_error: bool,
        content: str,
        turn: int,
    ) -> None:
        """Emit an ``agent_tool_result`` event (after each ToolResultBlock)."""
        self._enqueue(
            {
                "type": "agent_tool_result",
                "tool_name": tool_name,
                "is_error": is_error,
                "content": content,
                "turn": turn,
            }
        )

    def write_agent_milestone(self, milestone: str, details: str = "") -> None:
        """Emit an ``agent_milestone`` event.

        Note: parameter name matches :class:`_ProgressWriter.write_agent_milestone`
        (``details``, plural) for symmetric integration in Step 3.
        """
        self._enqueue(
            {
                "type": "agent_milestone",
                "milestone": milestone,
                "details": details,
            }
        )

    def write_agent_cost_update(
        self,
        cost_usd: float | None,
        input_tokens: int,
        output_tokens: int,
        turn: int,
    ) -> None:
        """Emit an ``agent_cost_update`` event (after each ResultMessage)."""
        self._enqueue(
            {
                "type": "agent_cost_update",
                "cost_usd": cost_usd,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "turn": turn,
            }
        )

    def write_agent_error(self, error_type: str, message: str) -> None:
        """Emit an ``agent_error`` event.

        Bulletproof: must NEVER raise, regardless of error_type/message content.
        We emit these when things are going wrong; failing here would compound
        the problem.
        """
        try:
            self._enqueue(
                {
                    "type": "agent_error",
                    "error_type": error_type,
                    "message": message,
                }
            )
        except Exception:
            # Last-ditch counter bump; do not log (log may also fail).
            self._dropped_count += 1

    # ------------------------------------------------------------------ internals

    def _enqueue(self, event: dict) -> None:
        """Thread-safe enqueue of a semantic event dict.

        Runs on the pipeline's background thread.  Never raises, never blocks.
        """
        if self._closed:
            self._dropped_count += 1
            return

        loop = self._loop
        if loop is None:
            # No subscriber attached — drop silently.
            self._dropped_count += 1
            return

        try:
            if loop.is_closed():
                self._dropped_count += 1
                return
            loop.call_soon_threadsafe(self._put_from_loop, event)
        except RuntimeError:
            # Loop was closed between our check and the call, or similar.
            self._dropped_count += 1
        except Exception as exc:
            self._dropped_count += 1
            with contextlib.suppress(Exception):
                log("[sse]", f"enqueue dropped ({type(exc).__name__}): {exc}")

    def _put_from_loop(self, event: dict) -> None:
        """Run on the asyncio loop — push the event, drop-oldest if full.

        ``call_soon_threadsafe`` guarantees we are on the loop thread here, so
        ``put_nowait`` / ``get_nowait`` are safe without the queue's internal
        asyncio locking.
        """
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop-oldest policy: pop one item (even if it's a previously
            # enqueued sentinel — unlikely since close() is idempotent and
            # single-shot), then push the new event.
            # Race: somebody else might have drained it; suppress and retry put.
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
            self._dropped_count += 1
            try:
                self._queue.put_nowait(event)
            except asyncio.QueueFull:
                # Extremely unlikely second-level full (would require a
                # concurrent producer on this loop, which we don't have).
                self._dropped_count += 1
        except Exception as exc:
            self._dropped_count += 1
            with contextlib.suppress(Exception):
                log("[sse]", f"put_from_loop dropped ({type(exc).__name__}): {exc}")

    def _put_sentinel_from_loop(self) -> None:
        """Run on the asyncio loop — push the close sentinel, drop-oldest if full."""
        try:
            self._queue.put_nowait(_CLOSE_SENTINEL)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
            self._dropped_count += 1
            try:
                self._queue.put_nowait(_CLOSE_SENTINEL)
            except asyncio.QueueFull:
                # If we still can't put the sentinel, we've lost the ability to
                # signal clean shutdown — SSE handler will time out instead.
                self._dropped_count += 1
        except Exception:
            self._dropped_count += 1
