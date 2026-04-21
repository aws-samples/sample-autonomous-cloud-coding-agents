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
from dataclasses import dataclass, field
from typing import Any

from shell import log


@dataclass
class _Subscriber:
    """One consumer of the broadcast stream, with its own bounded queue.

    Drop-oldest backpressure applies per subscriber: a slow consumer cannot
    stall the others. ``dropped_count`` is maintained independently for
    per-subscriber observability.
    """

    queue: "asyncio.Queue[Any]"
    dropped_count: int = 0
    # Reserved for future per-subscriber filters / transforms. Currently unused.
    tags: dict[str, str] = field(default_factory=dict)

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
        # Multi-subscriber fan-out: every subscriber has its own bounded queue
        # with its own drop counter. Broadcasts write to every subscriber.
        # Rev-5 Branch A (§9.13.3) allows multiple CLI watchers to attach to
        # the same in-process pipeline via the {task_id: adapter} registry in
        # server.py.
        #
        # The default subscriber is created eagerly so that the legacy
        # single-subscriber API (``get()``) delivers events even when the
        # first ``write_*`` fires before the first ``get()`` — which is the
        # common pattern in tests. ``subscribe()`` adds ADDITIONAL queues.
        self._subscribers: list[_Subscriber] = []
        self._default_subscriber: _Subscriber = _Subscriber(
            queue=asyncio.Queue(maxsize=max_queue_size),
        )
        self._subscribers.append(self._default_subscriber)
        # Aggregate drop counter for "loop not attached / adapter closed"
        # cases — events that weren't delivered to ANY subscriber.
        self._undelivered_count = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closed = False

    # ------------------------------------------------------------------ lifecycle

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the adapter to an asyncio loop (called by the SSE handler).

        Until this is called, writes are silently dropped and counted.  The
        loop owns all subscriber queues; ``subscribe`` / ``get`` callers must
        await on this loop.
        """
        self._loop = loop
        log("[sse]", f"attach_loop task={self._task_id}")

    def detach_loop(self) -> None:
        """Unbind the loop (last SSE client disconnected).

        Further ``write_agent_*`` calls become silent drops until
        ``attach_loop`` is called again. Subscriber queues are kept intact so
        a reconnected observer picks up from where it left off (within
        buffer bounds).
        """
        self._loop = None
        log("[sse]", f"detach_loop task={self._task_id}")

    def close(self) -> None:
        """Signal end-of-stream to every subscriber.

        Broadcasts a terminal sentinel to all subscriber queues. Idempotent.
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
            loop.call_soon_threadsafe(self._broadcast_sentinel_from_loop)

    # ------------------------------------------------------------------ properties

    @property
    def dropped_count(self) -> int:
        """Sum of per-subscriber drop counts plus undelivered events."""
        per_sub = sum(sub.dropped_count for sub in self._subscribers)
        return per_sub + self._undelivered_count

    def get_dropped_count(self) -> int:  # alias, for callers that prefer a method
        return self.dropped_count

    @property
    def has_subscribers(self) -> bool:
        """True iff the adapter is ready to deliver events.

        The loop must be attached (``attach_loop`` called) and the adapter
        must not be closed. The default subscriber is always present, so
        ``subscribers`` non-emptiness is implied.
        """
        return self._loop is not None and not self._closed

    @property
    def subscriber_count(self) -> int:
        """Number of live subscriber queues."""
        return len(self._subscribers)

    # ------------------------------------------------------------------ consumer API

    def subscribe(self) -> "asyncio.Queue[Any]":
        """Register a new subscriber queue; returns the queue.

        Multiple observers (e.g. two CLI watchers attached to the same task)
        can call this independently. Each receives the full broadcast stream
        of future events — no replay of earlier events (late observers catch
        up via the DDB catch-up endpoint).

        Must be called on the adapter's asyncio loop after ``attach_loop``.
        """
        sub = _Subscriber(queue=asyncio.Queue(maxsize=self._max_queue_size))
        self._subscribers.append(sub)
        log(
            "[sse]",
            f"subscribe task={self._task_id} subscriber_count={len(self._subscribers)}",
        )
        if self._closed:
            # Adapter already closed — deliver sentinel immediately so the
            # new subscriber's get() returns None without blocking.
            with contextlib.suppress(Exception):
                sub.queue.put_nowait(_CLOSE_SENTINEL)
        return sub.queue

    def unsubscribe(self, queue: "asyncio.Queue[Any]") -> None:
        """Remove a subscriber. Call when the observer disconnects."""
        before = len(self._subscribers)
        self._subscribers = [s for s in self._subscribers if s.queue is not queue]
        if len(self._subscribers) < before:
            log(
                "[sse]",
                f"unsubscribe task={self._task_id} subscriber_count={len(self._subscribers)}",
            )

    async def get(self) -> dict | None:
        """Await the next event on the default subscriber (legacy API).

        Backward-compatible single-subscriber entrypoint. New code should
        prefer ``subscribe`` + per-observer consumption via the returned
        queue so multiple observers receive the full broadcast.

        Returns ``None`` when the close sentinel is dequeued.
        """
        item = await self._default_subscriber.queue.get()
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
            self._undelivered_count += 1
            return

        loop = self._loop
        if loop is None:
            # No loop attached — nothing to deliver to.
            self._undelivered_count += 1
            return

        try:
            if loop.is_closed():
                self._undelivered_count += 1
                return
            loop.call_soon_threadsafe(self._broadcast_from_loop, event)
        except RuntimeError:
            # Loop was closed between our check and the call, or similar.
            self._undelivered_count += 1
        except Exception as exc:
            self._undelivered_count += 1
            with contextlib.suppress(Exception):
                log("[sse]", f"enqueue dropped ({type(exc).__name__}): {exc}")

    def _broadcast_from_loop(self, event: dict) -> None:
        """Broadcast the event to every subscriber's queue.

        Runs on the asyncio loop thread (guaranteed by ``call_soon_threadsafe``
        callers), so per-subscriber ``put_nowait`` / ``get_nowait`` pairs are
        safe without explicit locking. Drop-oldest backpressure is applied per
        subscriber independently — one slow consumer does not stall the others.

        If no subscribers are registered, increments ``_undelivered_count`` —
        this is distinct from per-subscriber queue-full drops.
        """
        subs = list(self._subscribers)  # snapshot
        if not subs:
            self._undelivered_count += 1
            return
        for sub in subs:
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                # Drop-oldest policy per subscriber: pop one item (may be an
                # older event or previously enqueued sentinel), then push the
                # new event. Suppress the race where another coroutine drained
                # between our put and the pop.
                with contextlib.suppress(asyncio.QueueEmpty):
                    sub.queue.get_nowait()
                sub.dropped_count += 1
                try:
                    sub.queue.put_nowait(event)
                except asyncio.QueueFull:
                    # Extremely unlikely second-level full (would require a
                    # concurrent producer on this loop, which we don't have).
                    sub.dropped_count += 1
            except Exception as exc:
                sub.dropped_count += 1
                with contextlib.suppress(Exception):
                    log("[sse]", f"broadcast dropped ({type(exc).__name__}): {exc}")

    def _broadcast_sentinel_from_loop(self) -> None:
        """Broadcast the close sentinel to every subscriber."""
        subs = list(self._subscribers)
        for sub in subs:
            try:
                sub.queue.put_nowait(_CLOSE_SENTINEL)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    sub.queue.get_nowait()
                sub.dropped_count += 1
                with contextlib.suppress(asyncio.QueueFull):
                    sub.queue.put_nowait(_CLOSE_SENTINEL)
            except Exception:
                sub.dropped_count += 1

    # Backward-compatible alias preserved for one in-file caller further down.
    # New code should not reference this name.
    def _put_sentinel_from_loop(self) -> None:  # pragma: no cover - compat shim
        """Legacy shim; delegates to the broadcast form."""
        try:
            self._subscribers  # noqa: B018 (ruff: attr access test)
        except AttributeError:
            return
        # Maintain the old single-subscriber path by falling through to the
        # broadcast form — all subscribers get the sentinel.
        self._broadcast_sentinel_from_loop()

    # Legacy single-subscriber drop-oldest path. Kept so any older code still
    # linking here does not break during refactor; the new broadcast form is
    # the canonical path.
    def _put_from_loop(self, event: dict) -> None:  # pragma: no cover - compat shim
        self._broadcast_from_loop(event)

