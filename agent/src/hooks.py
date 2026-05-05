"""PreToolUse, PostToolUse, and Stop hook callbacks.

- PreToolUse / PostToolUse: policy enforcement (Cedar policy engine and the
  output scanner for secrets/PII).
- Stop: between-turns nudge injection (Phase 2).  When the agent is about to
  stop a turn we check the TaskNudgesTable for pending user nudges and, if
  any are present, inject them as authoritative ``<user_nudge>`` blocks via
  the SDK's ``decision: "block"`` / ``reason: ...`` mechanism, which tells
  the CLI to continue with that text as the next user message.

A module-level registry ``between_turns_hooks`` lets future phases (e.g.
Phase 3 approval gates) append additional synthetic-message producers
without touching the Stop hook callback itself.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import nudge_reader
import task_state
from output_scanner import scan_tool_output
from shell import log

if TYPE_CHECKING:
    from policy import PolicyEngine
    from telemetry import _TrajectoryWriter


async def pre_tool_use_hook(
    hook_input: Any,
    tool_use_id: str | None,
    hook_context: Any,
    *,
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
) -> dict:
    """PreToolUse hook: evaluate tool call against Cedar policies.

    Returns a dict with hookSpecificOutput containing:
    - permissionDecision: "allow" or "deny"
    - permissionDecisionReason: explanation string
    """
    if not isinstance(hook_input, dict):
        log("WARN", "PreToolUse hook received non-dict input — denying")
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "invalid hook input",
            }
        }

    tool_name = hook_input.get("tool_name", "unknown")
    tool_input = hook_input.get("tool_input", {})
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except (json.JSONDecodeError, TypeError):
            log("WARN", f"PreToolUse hook failed to parse tool_input — denying {tool_name}")
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "unparseable tool input",
                }
            }

    decision = engine.evaluate_tool_use(tool_name, tool_input)

    # Emit telemetry for all non-permitted decisions (including fail-closed)
    if trajectory and decision.reason != "permitted":
        trajectory.write_policy_decision(
            tool_name, decision.allowed, decision.reason, decision.duration_ms
        )

    if not decision.allowed:
        log("POLICY", f"DENIED: {tool_name} — {decision.reason}")
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": decision.reason,
            }
        }

    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "permitted",
        }
    }


async def post_tool_use_hook(
    hook_input: Any,
    tool_use_id: str | None,
    hook_context: Any,
    *,
    trajectory: _TrajectoryWriter | None = None,
) -> dict:
    """PostToolUse hook: screen tool output for secrets/PII.

    Returns a dict with hookSpecificOutput.  When sensitive content is
    detected the response includes ``updatedMCPToolOutput`` containing the
    redacted version (steered enforcement — content is sanitized, not
    blocked).
    """
    _PASS_THROUGH: dict = {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}
    _FAIL_CLOSED: dict = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedMCPToolOutput": "[Output redacted: screening error — fail-closed]",
        }
    }

    if not isinstance(hook_input, dict):
        log("WARN", "PostToolUse hook received non-dict input — passing through")
        return _PASS_THROUGH

    tool_name = hook_input.get("tool_name", "unknown")

    if "tool_response" not in hook_input:
        log("WARN", f"PostToolUse hook: missing 'tool_response' key for {tool_name}")
        return _PASS_THROUGH

    tool_response = hook_input["tool_response"]

    # Normalise non-string responses
    if not isinstance(tool_response, str):
        tool_response = str(tool_response)

    try:
        result = scan_tool_output(tool_response)
    except Exception as exc:
        log("ERROR", f"Output scanner failed for {tool_name}: {type(exc).__name__}: {exc}")
        if trajectory:
            trajectory.write_output_screening_decision(
                tool_name, [f"SCANNER_ERROR: {type(exc).__name__}"], redacted=True, duration_ms=0.0
            )
        return _FAIL_CLOSED

    if result.has_sensitive_content:
        if trajectory:
            trajectory.write_output_screening_decision(
                tool_name, result.findings, redacted=True, duration_ms=result.duration_ms
            )
        log("POLICY", f"OUTPUT REDACTED: {tool_name} — {', '.join(result.findings)}")
        return {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "updatedMCPToolOutput": result.redacted_content,
            }
        }

    return _PASS_THROUGH


# ---------------------------------------------------------------------------
# Between-turns hook registry (Phase 2 nudges, extensible for Phase 3)
# ---------------------------------------------------------------------------

# A hook takes a context dict (currently ``{"task_id": str}``) and returns a
# list of synthetic user-message strings to inject before the agent's next
# turn.  An empty list means "no injection — allow normal stop".
BetweenTurnsHook = Callable[[dict], list[str]]


# Process-lifetime dedup map: task_id -> set of nudge_ids already injected in
# this process.  Guards against infinite re-injection if ``mark_consumed``
# persistently fails (DDB throttling, IAM drift) — without this, the same
# nudge would be re-injected every Stop hook firing until ``max_turns`` is
# exhausted.  Lives for the duration of the process (== task) so it doesn't
# leak across tasks in the same runtime.
_INJECTED_NUDGES: dict[str, set[str]] = {}


def _reset_injected_nudges_for_tests() -> None:
    """Test-only helper to clear the in-process injected-nudge dedup set."""
    global _INJECTED_NUDGES
    _INJECTED_NUDGES = {}


def _emit_nudge_milestone(ctx: dict, milestone: str, details: str) -> None:
    """Emit ``agent_milestone`` to the progress writer.

    Best-effort — swallow errors so stream visibility failures never block
    nudge injection itself.  ``ctx`` may carry a ``progress`` ref stamped by
    :func:`stop_hook`.  Skips (with a log line in each case) when:

    - no ``progress`` ref is stamped on ``ctx`` (tests, early-boot, or a
      hook invoked outside :func:`stop_hook`'s dispatch)
    - the progress writer's circuit breaker has tripped after repeated
      DDB write failures (``ProgressWriter._disabled``)
    - the underlying ``write_agent_milestone`` raises despite the writer's
      own fail-open contract

    Surfacing these as log lines (instead of silent drops) lets
    ``--trace`` mode and CloudWatch Logs show when an ack could not be
    delivered to the durable event stream.
    """
    progress = ctx.get("progress")
    if progress is None:
        log("DEBUG", f"nudge milestone {milestone!r} skipped: no progress writer in ctx")
        return
    # Only skip when ``_disabled`` is explicitly True on a real ProgressWriter.
    # ``getattr(..., False)`` is not safe — ``MagicMock`` returns an auto-mock
    # attribute for any access, which evaluates truthy.
    if getattr(progress, "_disabled", False) is True:
        log(
            "WARN",
            f"nudge milestone {milestone!r} skipped: progress writer circuit breaker open",
        )
        return
    try:
        progress.write_agent_milestone(milestone=milestone, details=details)
    except Exception as exc:  # pragma: no cover — defensive, writers never raise
        log("WARN", f"nudge milestone {milestone!r} progress write failed: {exc}")


def _nudge_between_turns_hook(ctx: dict) -> list[str]:
    """Read pending nudges for the task and return them as XML user messages.

    Best-effort: marks each nudge consumed after formatting.  If
    ``mark_consumed`` fails we still inject (the conditional-update contract
    means at-most-once delivery on success, at-least-once on mark failures —
    better to over-steer than to drop a user instruction).

    Additionally, a process-lifetime dedup set (``_INJECTED_NUDGES``)
    prevents infinite re-injection of the same nudge across turns if
    ``mark_consumed`` repeatedly fails.

    Emits a ``nudge_acknowledged`` ``agent_milestone`` event **before**
    returning the injected user-message list (combined-turn ack, see
    ``INTERACTIVE_AGENTS.md`` §AD-5) so the durable event stream records
    the ack in the same turn the nudge is consumed.  Emission is
    best-effort: if the progress writer's circuit breaker has tripped
    (repeated DDB write failures) or no ``progress`` ref is stamped on
    ``ctx``, the ack is logged but skipped and the injection still
    proceeds — better to steer the agent than block on a flaky event
    table.
    """
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []

    # Belt-and-braces second guard against the "cancel consumes nudges" hazard
    # (krokoko PR #52 review finding #3).  The primary guard is the loop-level
    # break in :func:`stop_hook` which short-circuits the dispatcher as soon as
    # any earlier hook sets ``_cancel_requested``.  That assumes
    # ``_cancel_between_turns_hook`` runs BEFORE this hook — true for the
    # module-level ``between_turns_hooks`` registry today (line 340), but a
    # future reorder (or a test that rebinds the list without preserving
    # order) would silently reintroduce the bug: ``read_pending`` +
    # ``mark_consumed`` would flip the DDB rows to consumed and stamp
    # ``_INJECTED_NUDGES`` for a dying agent that will never see the text.
    # Early-returning here makes the invariant structural — no nudges are
    # ever consumed once cancel is flagged, regardless of hook ordering.
    if ctx.get("_cancel_requested"):
        return []

    try:
        pending = nudge_reader.read_pending(task_id)
    except Exception as exc:
        log("WARN", f"nudge read_pending raised: {type(exc).__name__}: {exc}")
        return []

    # Filter out any nudges already injected in this process (regardless of
    # whether mark_consumed succeeded previously).
    already = _INJECTED_NUDGES.get(task_id, set())
    pending = [n for n in pending if n.get("nudge_id") not in already]

    if not pending:
        return []

    try:
        formatted = nudge_reader.format_as_user_message(pending)
    except Exception as exc:
        log("WARN", f"nudge format failed: {type(exc).__name__}: {exc}")
        return []

    # Record injection BEFORE mark_consumed so a persistent mark_consumed
    # failure cannot cause re-injection on a later turn.
    task_set = _INJECTED_NUDGES.setdefault(task_id, set())
    for n in pending:
        nid = n.get("nudge_id")
        if nid:
            task_set.add(nid)

    # Mark-consumed is best-effort; log failures but do not block injection.
    for n in pending:
        try:
            nudge_reader.mark_consumed(task_id, n["nudge_id"])
        except Exception as exc:
            log("WARN", f"nudge mark_consumed raised: {type(exc).__name__}: {exc}")

    count = len(pending)
    log("NUDGE", f"Injecting {count} nudge(s) for task {task_id}")

    # Short details string for the stream — preview the first nudge, total
    # count, and the nudge IDs for traceability.  Kept under ~120 chars so
    # it fits on a single terminal line.
    first_msg = (pending[0].get("message") or "")[:60]
    ids = ",".join(str(n.get("nudge_id", ""))[-8:] for n in pending)
    details = f"{count} nudge(s) acknowledged (ids=…{ids}): {first_msg}" + (
        "…" if count > 1 or len(first_msg) == 60 else ""
    )
    # AD-5: emit the ack BEFORE returning the injection list.
    _emit_nudge_milestone(ctx, "nudge_acknowledged", details)

    return [formatted] if formatted else []


def _cancel_between_turns_hook(ctx: dict) -> list[str]:
    """Detect user-initiated cancellation and signal the Stop hook to halt.

    Reads the task record from DynamoDB each turn.  If ``status == "CANCELLED"``
    sets ``ctx["_cancel_requested"] = True`` so :func:`stop_hook` returns
    ``continue_=False`` and the SDK tears the agent down cleanly.

    Fail-open: a ``TaskFetchError`` (transient DDB failure) is treated as
    "no cancel detected" to avoid stranding running tasks on blips.  This is
    symmetric with ``_nudge_between_turns_hook`` (also fail-open for DDB).
    Worst case a cancel is missed for one turn; the next turn will catch it.

    Returns ``[]`` always — the cancel signal flows via the ctx sentinel, not
    via injected text.  Injecting text would cause the SDK to continue the
    conversation, which is the opposite of what cancel needs.
    """
    task_id = ctx.get("task_id") or ""
    if not task_id:
        return []
    try:
        record = task_state.get_task(task_id)
    except task_state.TaskFetchError as exc:
        log("WARN", f"cancel hook get_task raised: {type(exc).__name__}: {exc}")
        return []
    if record and record.get("status") == "CANCELLED":
        ctx["_cancel_requested"] = True
        _emit_nudge_milestone(
            ctx,
            "cancel_detected",
            "Task cancelled by user; stopping agent after this turn.",
        )
    return []


# Global list of between-turns hooks.  Cancel MUST run first so it can
# short-circuit nudges on cancelled tasks (no point injecting nudges into a
# dying agent — worse, the nudge reader mutates DDB state that the agent will
# never act on; see krokoko PR #52 review finding #3).  The :func:`stop_hook`
# dispatcher breaks out of the loop as soon as ``_cancel_requested`` is set,
# and :func:`_nudge_between_turns_hook` early-returns when the flag is already
# present — belt-and-braces in case a future ``append`` reorders this list.
# Phase 3 (approval gates) should ``append`` additional hooks AFTER the
# nudge reader to preserve cancel-wins semantics.
between_turns_hooks: list[BetweenTurnsHook] = [
    _cancel_between_turns_hook,
    _nudge_between_turns_hook,
]


async def stop_hook(
    hook_input: Any,
    tool_use_id: str | None,
    hook_context: Any,
    *,
    task_id: str,
    progress: Any = None,
) -> dict:
    """Stop hook: run registered between-turns hooks; block if they produce text.

    Returning ``{"decision": "block", "reason": "<text>"}`` tells the SDK to
    continue the conversation with *text* as the next user message rather
    than actually stopping.  If no hook produces text we return an empty
    dict (allow stop).

    Each between-turns hook is invoked via ``asyncio.to_thread`` so that
    sync boto3 calls inside the hook (DDB query + update) do not stall the
    asyncio loop driving ``client.receive_response()``.

    ``progress`` is an optional writer ref threaded into each hook's ``ctx``
    so hooks can emit their own milestone / progress events without holding
    a module-global reference to it.
    """
    ctx = {
        "task_id": task_id,
        "progress": progress,
    }

    # Cancel-before-nudge short-circuit (krokoko PR #52 review finding #3).
    # Previously the loop ran ALL hooks before checking ``_cancel_requested``,
    # which meant the nudge hook's ``read_pending`` + ``mark_consumed`` path
    # executed even on cancelled tasks — flipping the DDB rows to consumed
    # and stamping ``_INJECTED_NUDGES`` for a dying agent.  The user saw a
    # 202 Accepted for their nudge but the injection was discarded when we
    # returned ``continue_=False`` below.  Breaking out of the loop as soon
    # as any hook sets ``_cancel_requested`` guarantees subsequent hooks
    # (notably the nudge reader) never run, so DDB state is never mutated
    # for work the agent will never do.  The registry at line 340 keeps
    # ``_cancel_between_turns_hook`` first so this break fires before the
    # nudge hook gets a chance.  ``_nudge_between_turns_hook`` also carries
    # an internal cancel-check as belt-and-braces in case a future refactor
    # reorders the registry.
    chunks: list[str] = []
    for hook in between_turns_hooks:
        try:
            produced = await asyncio.to_thread(hook, ctx)
        except Exception as exc:
            log(
                "WARN",
                f"between-turns hook raised (task_id={task_id}): {type(exc).__name__}: {exc}",
            )
            continue
        if produced:
            chunks.extend(produced)
        if ctx.get("_cancel_requested"):
            # Any text produced by earlier hooks in this same loop iteration
            # is discarded below — the ``_cancel_requested`` branch returns
            # ``continue_=False`` and never reads ``chunks``.  This is
            # intentional: cancel wins, and we would rather drop a
            # simultaneous nudge than inject into a dying agent.
            break

    # Cancel takes precedence over nudge injection.  ``continue_: False`` tells
    # the SDK to end the turn loop and return control to the caller, which
    # lets the pipeline see the CANCELLED status and skip post-hooks.
    if ctx.get("_cancel_requested"):
        return {
            "continue_": False,
            "stopReason": "Task cancelled by user",
        }

    if not chunks:
        return {}

    reason = "\n\n".join(chunks)
    return {"decision": "block", "reason": reason}


def build_hook_matchers(
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
    task_id: str = "",
    progress: Any = None,
) -> dict:
    """Build hook matchers dict for ClaudeAgentOptions.

    Returns a dict mapping HookEvent strings to lists of HookMatcher
    instances, ready to pass as ``hooks=...`` to ClaudeAgentOptions.

    The SDK expects ``dict[HookEvent, list[HookMatcher]]`` where HookMatcher
    has ``matcher: str | None`` and ``hooks: list[HookCallback]``.

    ``progress`` is forwarded to the Stop hook so that between-turns hooks
    can emit milestones (e.g. ``nudge_acknowledged``) that show up in the
    durable progress stream as a visible marker of Phase 2 nudge activity.
    """
    from claude_agent_sdk.types import (
        HookContext,
        HookInput,
        HookJSONOutput,
        HookMatcher,
        PostToolUseHookSpecificOutput,
        SyncHookJSONOutput,
    )

    # Closure-based wrapper matches the HookCallback signature exactly:
    # (HookInput, str | None, HookContext) -> Awaitable[HookJSONOutput]
    async def _pre(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        result = await pre_tool_use_hook(
            hook_input, tool_use_id, ctx, engine=engine, trajectory=trajectory
        )
        return SyncHookJSONOutput(**result)

    async def _post(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        try:
            result = await post_tool_use_hook(hook_input, tool_use_id, ctx, trajectory=trajectory)
            return SyncHookJSONOutput(**result)
        except Exception as exc:
            log("ERROR", f"PostToolUse wrapper crashed: {type(exc).__name__}: {exc}")
            fail_closed: PostToolUseHookSpecificOutput = {
                "hookEventName": "PostToolUse",
                "updatedMCPToolOutput": "[Output redacted: hook error — fail-closed]",
            }
            return SyncHookJSONOutput(hookSpecificOutput=fail_closed)

    async def _stop(
        hook_input: HookInput, tool_use_id: str | None, ctx: HookContext
    ) -> HookJSONOutput:
        # Capture task_id up-front so it can be included in any wrapper
        # crash log for post-hoc correlation with user complaints.
        stop_task_id = task_id
        try:
            result = await stop_hook(
                hook_input,
                tool_use_id,
                ctx,
                task_id=stop_task_id,
                progress=progress,
            )
        except Exception as exc:
            log(
                "ERROR",
                f"Stop wrapper crashed (task_id={stop_task_id}): {type(exc).__name__}: {exc}",
            )
            return SyncHookJSONOutput()
        # Empty dict == allow stop.  SyncHookJSONOutput(**{}) is fine.
        return SyncHookJSONOutput(**result)

    return {
        "PreToolUse": [HookMatcher(matcher=None, hooks=[_pre])],
        "PostToolUse": [HookMatcher(matcher=None, hooks=[_post])],
        "Stop": [HookMatcher(matcher=None, hooks=[_stop])],
    }
