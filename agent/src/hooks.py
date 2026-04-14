"""PreToolUse and PostToolUse hook callbacks for policy enforcement.

Integrates the PolicyEngine (Cedar, pre-execution) and the output scanner
(regex, post-execution) with the Claude Agent SDK's hook system to enforce
tool-use policies at runtime.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

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

    return {
        "PreToolUse": [HookMatcher(matcher=None, hooks=[_pre])],
        "PostToolUse": [HookMatcher(matcher=None, hooks=[_post])],
    }
