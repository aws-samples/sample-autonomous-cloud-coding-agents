# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Guest-side pause barrier for ADR-021.

This controller does not call AWS or decide approvals. The server owns one
controller per running MicroVM task; tool hooks register work and the *original*
approval deadline. HTTP lifecycle handlers supply the durable checkpoint and
credential-refresh operations; this controller owns permission to release work.

Returning from a suspend callback is not proof that AWS actually froze the VM.
Once acknowledged, the barrier opens only after a successful resume callback.
There is deliberately no timer that releases coding after an ambiguous suspend:
the supervisor must wake or terminate within its bounded recovery window.
"""

from __future__ import annotations

import asyncio
import math
import os
import random
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable


class ApprovalDeadline(Protocol):
    def remaining_s(self) -> float: ...


class LifecycleUnavailable(RuntimeError):
    """The guest cannot establish a safe lifecycle boundary."""


def reseed_random() -> None:
    """Give each run/wake fresh application PRNG state; secrets still use OS RNG."""
    random.seed(os.urandom(32))


@dataclass(frozen=True)
class ApprovalRecord:
    """Original durable gate fields, captured when its request is written."""

    user_id: str
    repo: str
    created_at: str
    timeout_s: int


@dataclass(frozen=True)
class ApprovalPark:
    task_id: str
    microvm_id: str
    request_id: str
    tool_use_id: str
    deadline: ApprovalDeadline
    record: ApprovalRecord | None = None


class MicrovmLifecycle:
    """Synchronize tool execution, approval exit, and bounded lifecycle work.

    Locks protect only local state; never hold one across an await or AWS call.
    Timed-out callbacks can finish in a worker thread, but only this controller
    can commit a transition, and its generation check rejects late completion.
    """

    def __init__(self, task_id: str, microvm_id: str) -> None:
        if not task_id or not microvm_id:
            raise ValueError("Lifecycle requires task and MicroVM identity")
        self.task_id = task_id
        self.microvm_id = microvm_id
        self._lock = threading.Lock()
        self._tools: set[str] = set()
        self._park: ApprovalPark | None = None
        self._phase = "active"
        self._generation = 0
        self._activities = 0
        self._progress_failed = False
        self._suspend_ineligible = False
        self._slept_request_id: str | None = None
        self._last_resume_park: ApprovalPark | None = None

    def _check_open(self) -> bool:
        if self._phase in {"closed", "failed"}:
            raise LifecycleUnavailable("Lifecycle barrier is closed")
        return self._phase in {"active", "parked"}

    async def wait_until_open(self) -> None:
        # A thread-safe local predicate works across the server and pipeline's
        # separate event loops. No AWS calls or new approval timeout are needed.
        while True:
            with self._lock:
                if self._check_open():
                    return
            await asyncio.sleep(0.02)

    async def tool_started(self, tool_use_id: str | None) -> None:
        while True:
            await self.wait_until_open()
            with self._lock:
                if not self._check_open():
                    continue
                if not tool_use_id or tool_use_id in self._tools:
                    # Preserve existing tool behavior, but unknown/duplicate
                    # identities cannot prove that every parallel tool stopped.
                    self._suspend_ineligible = True
                else:
                    self._tools.add(tool_use_id)
                return

    def tool_finished(self, tool_use_id: str | None) -> None:
        with self._lock:
            self._tools.discard(tool_use_id or "")

    def disable_suspend(self) -> None:
        """Retain normal execution when detached work cannot be accounted for."""
        with self._lock:
            self._suspend_ineligible = True

    def park_approval(
        self,
        request_id: str,
        tool_use_id: str | None,
        deadline: ApprovalDeadline,
        *,
        record: ApprovalRecord | None = None,
    ) -> ApprovalPark | None:
        with self._lock:
            if (
                not request_id
                or not tool_use_id
                or tool_use_id not in self._tools
                or self._park is not None
                or self._phase != "active"
            ):
                self._suspend_ineligible = True
                return None
            park = ApprovalPark(
                self.task_id, self.microvm_id, request_id, tool_use_id, deadline, record
            )
            self._park = park
            # A new gate cannot acknowledge a wake using the previous gate's
            # cached result. Its own suspend must establish a fresh safe point.
            self._last_resume_park = None
            self._phase = "parked"
            return park

    async def leave_approval(self, park: ApprovalPark) -> None:
        """Remove the safe point *before* the hook changes task state/returns."""
        while True:
            await self.wait_until_open()
            with self._lock:
                if not self._check_open():
                    continue
                if self._park is not park:
                    raise LifecycleUnavailable("Approval park changed")
                self._park = None
                self._phase = "active"
                return

    @contextmanager
    def activity(self):
        """Drain synchronous progress and heartbeat work before suspension.

        Best-effort writers must explicitly report missing/failed acknowledgments
        with progress_write_failed(). A later successful event cannot recover a
        dropped earlier event, so that failure remains latched for the task.
        """
        with self._lock:
            if not self._check_open():
                # Do not silently write with pre-wake credentials. The progress
                # writer catches this like its existing best-effort failures.
                raise LifecycleUnavailable("Guest activity is paused")
            self._activities += 1
        try:
            yield
        finally:
            with self._lock:
                self._activities -= 1

    @asynccontextmanager
    async def approval_poll(self):
        """Pause new approval reads and drain an already-running read safely."""
        while True:
            await self.wait_until_open()
            with self._lock:
                if not self._check_open():
                    continue
                self._activities += 1
                break
        try:
            yield
        finally:
            with self._lock:
                self._activities -= 1

    def progress_write_failed(self) -> None:
        with self._lock:
            self._progress_failed = True

    @staticmethod
    def _budget(seconds: float) -> float:
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError("Lifecycle budget must be finite and positive")
        return time.monotonic() + seconds

    async def suspend(
        self, checkpoint: Callable[[ApprovalPark], None], *, budget_s: float
    ) -> ApprovalPark:
        """Drain progress, then require an acknowledged gate/checkpoint check.

        ``checkpoint`` must synchronously verify durable task/gate identity and
        deadline and raise on any failed or uncertain write/read. Returning None
        means acknowledged success, never a best-effort event method.
        """
        end = self._budget(budget_s)
        with self._lock:
            park = self._park
            if (
                self._phase == "suspend-ready"
                and park is not None
                and not self._progress_failed
                and park.deadline.remaining_s() > 0
            ):
                # An already-acknowledged HTTP retry neither checkpoints again
                # nor opens the barrier. Expired/unsafe retries remain closed.
                return park
            if (
                park is None
                or self._phase != "parked"
                or self._suspend_ineligible
                or park.request_id == self._slept_request_id
                or self._progress_failed
                or self._tools != {park.tool_use_id}
                or park.deadline.remaining_s() <= 0
            ):
                raise LifecycleUnavailable("Task is not safely parked for suspend")
            self._phase = "suspending"
            self._generation += 1
            generation = self._generation
        try:
            while True:
                with self._lock:
                    self._assert_transition(generation, "suspending")
                    if self._progress_failed:
                        raise LifecycleUnavailable("Progress was not acknowledged")
                    drained = self._activities == 0
                if drained:
                    break
                if time.monotonic() >= end:
                    raise TimeoutError("Progress did not drain within lifecycle budget")
                await asyncio.sleep(min(0.02, max(0, end - time.monotonic())))
            await self._run_bounded(checkpoint, park, end)
            with self._lock:
                self._assert_transition(generation, "suspending")
                if self._progress_failed or park.deadline.remaining_s() <= 0:
                    raise LifecycleUnavailable("Suspend checkpoint is no longer safe")
                self._phase = "suspend-ready"
            return park
        except BaseException:
            # An unacknowledged checkpoint never authorizes a freeze. In-flight
            # progress may finish later; new suspension stays off after failure.
            with self._lock:
                if self._generation == generation and self._phase == "suspending":
                    self._phase = "parked"
                    self._suspend_ineligible = True
                    self._generation += 1
            raise

    async def resume(
        self, refresh_and_reconcile: Callable[[ApprovalPark], None], *, budget_s: float
    ) -> ApprovalPark:
        """Release the original wait only after credentials and state are safe.

        Callback ownership is intentionally narrow: refresh credentials and read
        the existing gate, without deciding it, changing its deadline, or calling
        leave_approval. Timeout/cancellation closes the barrier permanently; a
        late thread must not release coding. The supervisor owns termination.
        """
        end = self._budget(budget_s)
        with self._lock:
            park = self._park
            if self._phase in {"active", "parked"} and self._last_resume_park is not None:
                # A duplicate wake acknowledgment cannot renew the approval
                # timeout or re-run credential refresh on an executing task.
                return self._last_resume_park
            if self._phase != "suspend-ready" or park is None:
                raise LifecycleUnavailable("No acknowledged suspend to resume")
            self._phase = "resuming"
            self._generation += 1
            generation = self._generation
        try:
            await self._run_bounded(refresh_and_reconcile, park, end)
            reseed_random()
            with self._lock:
                self._assert_transition(generation, "resuming")
                self._phase = "parked"
                # One sleep per approval gate. A duplicate suspend must not
                # race the newly released decision loop.
                self._slept_request_id = park.request_id
                self._last_resume_park = park
            return park
        except BaseException:
            with self._lock:
                if self._generation == generation and self._phase == "resuming":
                    self._phase = "failed"
                    self._generation += 1
            raise

    def _assert_transition(self, generation: int, phase: str) -> None:
        if self._generation != generation or self._phase != phase:
            raise LifecycleUnavailable("Lifecycle transition was superseded")

    @staticmethod
    async def _run_bounded(
        callback: Callable[[ApprovalPark], None], park: ApprovalPark, end: float
    ) -> None:
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Lifecycle budget expired")
        await asyncio.wait_for(asyncio.to_thread(callback, park), timeout=remaining)

    def close(self) -> None:
        """Invalidate in-flight callbacks before pipeline teardown."""
        with self._lock:
            self._phase = "closed"
            self._generation += 1
            self._park = None
            self._tools.clear()


_registry_lock = threading.Lock()
_contexts: dict[str, MicrovmLifecycle] = {}


def register_task(task_id: str, microvm_id: str) -> MicrovmLifecycle:
    with _registry_lock:
        if _contexts:
            raise LifecycleUnavailable("A MicroVM pipeline is already registered")
        context = MicrovmLifecycle(task_id, microvm_id)
        _contexts[task_id] = context
        return context


def get_context(task_id: str | None) -> MicrovmLifecycle | None:
    with _registry_lock:
        return _contexts.get(task_id or "")


def get_registered_context() -> MicrovmLifecycle | None:
    """The service hook belongs to the sole task registered by this VM's /run."""
    with _registry_lock:
        return next(iter(_contexts.values()), None)


def unregister_task(context: MicrovmLifecycle) -> None:
    with _registry_lock:
        context.close()
        if _contexts.get(context.task_id) is context:
            del _contexts[context.task_id]
