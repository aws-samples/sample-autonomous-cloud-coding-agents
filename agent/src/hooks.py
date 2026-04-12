"""PreToolUse hook callback for Cedar policy enforcement.

Integrates the PolicyEngine with the Claude Agent SDK's hook system
to enforce tool-use policies at runtime.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

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


def build_hook_matchers(
    engine: PolicyEngine,
    trajectory: _TrajectoryWriter | None = None,
) -> dict:
    """Build hook matchers dict for ClaudeAgentOptions.

    Returns a dict mapping HookEvent strings to lists of HookMatcher
    instances, ready to pass as ``hooks=...`` to ClaudeAgentOptions.

    The SDK expects ``dict[HookEvent, list[HookMatcher]]`` where HookMatcher
    has ``matcher: str | None`` and ``hooks: list[HookCallback]``.
    """
    from claude_agent_sdk.types import (
        HookContext,
        HookInput,
        HookJSONOutput,
        HookMatcher,
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
        return SyncHookJSONOutput(**result)  # type: ignore[typeddict-item]

    return {
        "PreToolUse": [HookMatcher(matcher=None, hooks=[_pre])],
    }
