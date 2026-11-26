from __future__ import annotations

import os
import subprocess
from typing import Any, Literal

from clarification_tool import (
    CLARIFICATION_SERVER_NAME,
    CLARIFICATION_TOOL_NAME,
    build_clarification_server,
)
from config import AGENT_WORKSPACE
from gateway_tools import GATEWAY_SERVER_NAME, build_gateway_server
from hooks import _map_strings, _screened
from models import AgentResult, TaskConfig, TokenUsage
from output_scanner import scan_tool_output
from progress_writer import _ProgressWriter
from shell import _clean_env, log, log_error_cw, truncate
from telemetry import _TrajectoryWriter


def _screened_text(value: Any) -> str:
    if isinstance(value, str):
        return _screened(value)
    # ``str()`` of a dict or a list escapes the quotes, tabs and newlines inside its strings.
    return scan_tool_output(str(_map_strings(value, _screened))).redacted_content


def _format_tool_result(block) -> tuple[str, str]:
    """A call that failed does not pass the PostToolUse hook, and the CLI does not
    take every rewrite of that hook."""
    status = "ERROR" if block.is_error else "ok"
    return status, _screened_text(block.content)


def _result_error_text(message: Any) -> str:
    """The CLI's error subtypes (turn limit, budget, error during execution) send no
    ``result``: their reason is in ``errors``."""
    text = str(getattr(message, "result", None) or "").strip()
    if text:
        return text
    subtype = getattr(message, "subtype", "unknown")
    text = f"Agent session error (subtype={subtype!r})"
    if subtype == "error_max_turns":
        return text
    errors = "; ".join(str(error) for error in getattr(message, "errors", None) or [])
    return f"{text}: {_screened(errors)}" if errors else text


def _parse_token_usage(raw_usage: Any) -> TokenUsage:
    fields = (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    )
    if isinstance(raw_usage, dict):
        values = {f: raw_usage.get(f, 0) for f in fields}
    else:
        values = {f: getattr(raw_usage, f, 0) for f in fields}
    return TokenUsage(**values)


def _setup_bedrock_cost_attribution(config: TaskConfig) -> None:
    import json

    from aws_session import MAX_TAG_VALUE_LEN, build_session_tags

    role_arn = os.environ.get("AGENT_SESSION_ROLE_ARN", "").strip()
    tags = build_session_tags(config.user_id, config.repo_url, config.task_id)
    if role_arn and tags:
        try:
            from bedrock_creds_helper import write_attribution_file

            write_attribution_file(role_arn, tags)
        except OSError as exc:
            log("WARN", f"Bedrock attribution file not written ({exc}); spend will be untagged")

    # Bedrock limits request-metadata keys/values to 256 chars.
    metadata = {t["Key"]: t["Value"][:MAX_TAG_VALUE_LEN] for t in tags}
    if metadata:
        os.environ["ANTHROPIC_CUSTOM_HEADERS"] = (
            f"X-Amzn-Bedrock-Request-Metadata: {json.dumps(metadata, separators=(',', ':'))}"
        )


def _setup_agent_env(config: TaskConfig) -> None:
    os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
    # Claude Code 2.1.311 and later load model settings on Bedrock from a signed
    # file on downloads.claude.ai, which the platform's DNS allowlist
    # (cdk/src/constructs/dns-firewall.ts) does not name.
    os.environ["CLAUDE_CODE_MODEL_CATALOG"] = "off"
    os.environ["AWS_REGION"] = config.aws_region
    os.environ["ANTHROPIC_MODEL"] = config.anthropic_model
    os.environ["GITHUB_TOKEN"] = config.github_token
    os.environ["GH_TOKEN"] = config.github_token

    _setup_bedrock_cost_attribution(config)
    # At any ANTHROPIC_LOG level the CLI fills the 64 KB stderr pipe faster than the
    # SDK's ``stderr`` callback drains it, and the blocked write deadlocks the CLI.
    os.environ.pop("ANTHROPIC_LOG", None)
    os.environ["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = config.haiku_model

    cleaned = _clean_env()
    for key in os.environ.keys() - cleaned.keys():
        del os.environ[key]
    os.environ.update(cleaned)


def _initialize_policy_engine_and_hooks(
    *,
    config: TaskConfig,
    trajectory: _TrajectoryWriter | None,
    progress: _ProgressWriter,
) -> tuple[Any, dict]:
    from hooks import build_hook_matchers
    from policy import PolicyEngine

    cedar_policies = config.cedar_policies
    engine_kwargs: dict = {}
    if config.initial_approvals:
        engine_kwargs["initial_approvals"] = list(config.initial_approvals)
    if config.approval_timeout_s is not None:
        engine_kwargs["task_default_timeout_s"] = config.approval_timeout_s
    if config.initial_approval_gate_count:
        engine_kwargs["initial_approval_gate_count"] = config.initial_approval_gate_count
    if config.approval_gate_cap is not None:
        engine_kwargs["approval_gate_cap"] = config.approval_gate_cap
    policy_engine = PolicyEngine(
        task_type=config.policy_principal,
        repo=config.repo_url,
        read_only=config.read_only,
        blueprint_policies=cedar_policies or None,
        **engine_kwargs,
    )
    if config.approval_gate_cap is not None:
        cap_log = f" approval_gate_cap={config.approval_gate_cap} approval_gate_cap_source=threaded"
    else:
        cap_log = " approval_gate_cap=unset approval_gate_cap_source=engine_default"
    log(
        "AGENT",
        f"Cedar policy engine initialized for task_type={config.policy_principal}"
        + (f" with {len(cedar_policies)} extra policies" if cedar_policies else "")
        + cap_log,
    )

    progress.write_approval_pre_approvals_loaded(
        count=len(config.initial_approvals),
        scopes=list(config.initial_approvals),
    )

    hooks = build_hook_matchers(
        engine=policy_engine,
        trajectory=trajectory,
        task_id=config.task_id or "",
        progress=progress,
        user_id=config.user_id or "",
        repo_url=config.repo_url or "",
    )
    return policy_engine, hooks


_FULL_TOOL_SURFACE = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"]
_WRITE_TOOLS = frozenset(("Write", "Edit"))
_NO_CLARIFICATION_WORKFLOW_IDS = frozenset(
    (
        "coding/pr-iteration-v1",
        "coding/pr-review-v1",
        "coding/restack-v1",
        "default/agent-v1",
        "knowledge/web-research-v1",
    )
)

# Agent SDK: ``allowed_tools`` only auto-approves. An unlisted tool falls through to
# ``permission_mode``, and ``bypassPermissions`` allows it. ``disallowed_tools``
# removes a tool from the model's context. The sub-agent spawner is ``Task`` or
# ``Agent``, depending on the CLI version.
# The tools listed start, resume, watch or schedule work that runs in the background
# or later. Background Bash is a ``run_in_background`` parameter of Bash, not a tool name.
_DISALLOWED_TOOLS = [
    "Workflow",
    "Task",
    "Agent",
    "Monitor",
    "SendMessage",
    "CronCreate",
    "CronDelete",
    "CronList",
    "ScheduleWakeup",
]


def _resolve_allowed_tools(config: TaskConfig) -> list[str]:
    tools = list(config.allowed_tools) if config.allowed_tools else list(_FULL_TOOL_SURFACE)
    if config.read_only:
        tools = [t for t in tools if t not in _WRITE_TOOLS]
    return tools


def _resolve_setting_sources(config: TaskConfig) -> list[Literal["user", "project", "local"]]:
    return ["project"] if config.repo_url else []


#: ADR-021 P2-F5: on a MicroVM restored from a snapshot that never touched the
#: 225 MiB ``claude`` binary, the first ``exec`` must fault all of its pages in from
#: lazily-restored storage.
_CLAUDE_VERSION_PROBE_TIMEOUT_S = 60

_WHICH_CLAUDE_TIMEOUT_S = 5


def _log_claude_cli_version() -> None:
    try:
        cli_path = subprocess.run(
            ["which", "claude"], capture_output=True, text=True, timeout=_WHICH_CLAUDE_TIMEOUT_S
        )
        if cli_path.returncode != 0:
            log("WARN", "claude CLI not found on PATH")
            return
        cli_ver = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=_CLAUDE_VERSION_PROBE_TIMEOUT_S,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        log("WARN", f"claude CLI version probe failed (non-fatal): {type(exc).__name__}: {exc}")
        return
    log("AGENT", f"claude CLI: {cli_path.stdout.strip()} version={cli_ver.stdout.strip()}")


def _register_gateway_server(mcp_servers: dict[str, Any]) -> None:
    gateway_server = build_gateway_server()
    if gateway_server is not None:
        mcp_servers[GATEWAY_SERVER_NAME] = gateway_server
        log("AGENT", "AgentCore Gateway tool bridge registered (mcp__abca_gateway__*)")


async def run_agent(  # noqa: C901 -- 40 since #904 (37 when the ceiling of 15 was set); must not grow
    prompt: str,
    system_prompt: str,
    config: TaskConfig,
    cwd: str = AGENT_WORKSPACE,
    trajectory: _TrajectoryWriter | None = None,
) -> AgentResult:
    """Invoke the Claude Agent SDK and stream output."""
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ThinkingBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )

    _setup_agent_env(config)

    stderr_line_count = 0

    def _on_stderr(line: str) -> None:
        nonlocal stderr_line_count
        stderr_line_count += 1
        log("CLI", line.rstrip())

    import claude_agent_sdk as _sdk

    sdk_version = getattr(_sdk, "__version__", "unknown")
    log("AGENT", f"claude-agent-sdk version: {sdk_version}")
    _log_claude_cli_version()

    allowed_tools = _resolve_allowed_tools(config)

    if trajectory is None:
        trajectory = _TrajectoryWriter(config.task_id or "unknown")
    progress = _ProgressWriter(
        config.task_id or "unknown",
        trace=config.trace,
        user_id=config.user_id,
        repo=config.repo_url,
    )

    tool_use_id_to_name: dict[str, str] = {}

    _policy_engine, hooks = _initialize_policy_engine_and_hooks(
        config=config,
        trajectory=trajectory,
        progress=progress,
    )

    mcp_servers: dict[str, Any] = {}
    workflow_id = (config.resolved_workflow or {}).get("id", "")
    offer_clarification = not config.read_only and workflow_id not in _NO_CLARIFICATION_WORKFLOW_IDS
    if offer_clarification:
        clar_server = build_clarification_server()
        if clar_server is not None:
            mcp_servers[CLARIFICATION_SERVER_NAME] = clar_server
            allowed_tools = [*allowed_tools, CLARIFICATION_TOOL_NAME]

    _register_gateway_server(mcp_servers)

    options = ClaudeAgentOptions(
        model=config.anthropic_model,
        system_prompt=system_prompt,
        allowed_tools=allowed_tools,
        disallowed_tools=list(_DISALLOWED_TOOLS),
        permission_mode="bypassPermissions",
        cwd=cwd,
        max_turns=config.max_turns,
        setting_sources=_resolve_setting_sources(config),
        hooks=hooks,
        max_budget_usd=config.max_budget_usd,
        stderr=_on_stderr,
        mcp_servers=mcp_servers,
    )

    result = AgentResult()
    message_counts = {"system": 0, "assistant": 0, "result": 0, "other": 0}
    answer_id: str | None = None

    client = ClaudeSDKClient(options=options)
    from microvm_credentials import ScopedCredentialBroker
    from microvm_lifecycle import get_context

    broker = None
    try:
        lifecycle = get_context(config.task_id or "")
        if lifecycle is not None:
            broker = ScopedCredentialBroker(lifecycle)
            options.env.update(broker.environment)
        log("AGENT", "Connecting to Claude Code CLI subprocess...")
        await client.connect()
        log("AGENT", "Connected. Sending prompt...")
        await client.query(prompt=prompt)
        log("AGENT", "Prompt sent. Receiving messages...")
        async for message in client.receive_response():
            if isinstance(message, SystemMessage):
                message_counts["system"] += 1
                log("SYS", f"{message.subtype}: {message.data}")
                if message.subtype == "init" and isinstance(message.data, dict):
                    cli_ver = message.data.get("claude_code_version", "?")
                    log("SYS", f"CLI reports version: {cli_ver}")
                log("AGENT", "Waiting for next message from CLI...")

            elif isinstance(message, AssistantMessage):
                message_counts["assistant"] += 1
                # The CLI sends an answer as one message per content block
                # (thinking, text, each tool call), all with the id of the answer,
                # and a tool result may arrive between two of them.
                if message.message_id is None or message.message_id != answer_id:
                    result.turns += 1
                answer_id = message.message_id
                log("TURN", f"#{result.turns} (model: {message.model})")

                turn_thinking = ""
                turn_text = ""
                turn_tool_calls: list[dict] = []

                for block in message.content:
                    if isinstance(block, ThinkingBlock):
                        log("THINK", truncate(block.thinking, 200))
                        turn_thinking += block.thinking + "\n"
                    elif isinstance(block, TextBlock):
                        print(block.text, flush=True)
                        turn_text += block.text + "\n"
                    elif isinstance(block, ToolUseBlock):
                        tool_input = block.input
                        if block.name == CLARIFICATION_TOOL_NAME:
                            q = ""
                            if isinstance(tool_input, dict):
                                q = str(tool_input.get("question", "")).strip()
                            result.clarification_question = (
                                q or result.clarification_question or " "
                            )
                            log("TOOL", f"request_clarification: {truncate(q, 300)}")
                        elif block.name == "Bash":
                            cmd = tool_input.get("command", "")
                            log("TOOL", f"Bash: {truncate(cmd, 300)}")
                        elif block.name in ("Read", "Glob", "Grep"):
                            log("TOOL", f"{block.name}: {truncate(str(tool_input))}")
                        elif block.name in ("Write", "Edit"):
                            path = tool_input.get("file_path", "")
                            log("TOOL", f"{block.name}: {path}")
                        else:
                            log("TOOL", f"{block.name}: {truncate(str(tool_input))}")
                        turn_tool_calls.append({"name": block.name, "input": tool_input})
                        tool_use_id = getattr(block, "id", "") or getattr(block, "tool_use_id", "")
                        if tool_use_id:
                            tool_use_id_to_name[tool_use_id] = block.name

                trajectory.write_turn(
                    turn=result.turns,
                    model=message.model,
                    thinking=turn_thinking.strip(),
                    text=turn_text.strip(),
                    tool_calls=turn_tool_calls,
                    tool_results=[],
                )

                progress.write_agent_turn(
                    turn=result.turns,
                    model=message.model,
                    thinking=_screened(turn_thinking.strip()),
                    text=_screened(turn_text.strip()),
                    tool_calls_count=len(turn_tool_calls),
                )
                for tc in turn_tool_calls:
                    progress.write_agent_tool_call(
                        tool_name=tc["name"],
                        tool_input=_screened_text(tc.get("input", "")),
                        turn=result.turns,
                    )

            elif isinstance(message, ResultMessage):
                message_counts["result"] += 1
                subtype = getattr(message, "subtype", "unknown")
                result.status = subtype
                result.cost_usd = getattr(message, "total_cost_usd", None)
                result.num_turns = getattr(message, "num_turns", 0)
                result.session_id = getattr(message, "session_id", "") or ""

                err_payload = getattr(message, "result", None)
                is_terminal_error = bool(getattr(message, "is_error", False))
                if not is_terminal_error and err_payload:
                    result.result_text = str(err_payload)
                # The Claude Code CLI may emit ResultMessage with subtype "success"
                # while setting is_error for Bedrock entitlement / model-access failures.
                if is_terminal_error:
                    err_text = _result_error_text(message)
                    log("ERROR", err_text)
                    result.error = err_text
                    result.status = "error"
                elif subtype == "error" and err_payload:
                    result.error = str(err_payload)
                    log("ERROR", result.error)

                raw_usage = getattr(message, "usage", None)
                usage: TokenUsage | None = None
                if raw_usage is not None:
                    usage = _parse_token_usage(raw_usage)
                    result.usage = usage
                    if all(v == 0 for v in usage.model_dump().values()):
                        log(
                            "WARN",
                            f"All token usage values are zero — usage object "
                            f"type={type(raw_usage).__name__}",
                        )
                    else:
                        log(
                            "USAGE",
                            f"input={usage.input_tokens} "
                            f"output={usage.output_tokens} "
                            f"cache_read={usage.cache_read_input_tokens} "
                            f"cache_create={usage.cache_creation_input_tokens}",
                        )

                log(
                    "DONE",
                    f"status={result.status} turns={result.num_turns} "
                    f"cost=${result.cost_usd or 0:.4f} "
                    f"duration={message.duration_ms / 1000:.1f}s",
                )
                if message.is_error and message.result:
                    log_error_cw(str(message.result), task_id=config.task_id or None)

                trajectory.write_result(
                    subtype=result.status,
                    num_turns=result.num_turns,
                    cost_usd=result.cost_usd,
                    duration_ms=getattr(message, "duration_ms", 0),
                    duration_api_ms=getattr(message, "duration_api_ms", 0),
                    session_id=getattr(message, "session_id", ""),
                    usage=usage,
                )

                input_toks = usage.input_tokens if usage else 0
                output_toks = usage.output_tokens if usage else 0
                progress.write_agent_cost_update(
                    cost_usd=result.cost_usd,
                    input_tokens=input_toks,
                    output_tokens=output_toks,
                    turn=result.turns,
                )

            elif isinstance(message, UserMessage):
                message_counts["other"] += 1
                if isinstance(message.content, list):
                    for block in message.content:
                        if isinstance(block, ToolResultBlock):
                            # A later project hook can deny a call our pre-hook
                            # allowed without emitting either post-tool hook.
                            if lifecycle is not None and block.is_error:
                                lifecycle.tool_finished(block.tool_use_id)
                            status, content = _format_tool_result(block)
                            log("RESULT", f"[{status}] {truncate(content)}")
                            tool_name = tool_use_id_to_name.get(
                                getattr(block, "tool_use_id", ""), ""
                            )
                            progress.write_agent_tool_result(
                                tool_name=tool_name,
                                is_error=bool(block.is_error),
                                content=content,
                                turn=result.turns,
                            )
                            trajectory.write_tool_result(
                                turn=result.turns,
                                tool_name=tool_name,
                                is_error=bool(block.is_error),
                                content=content,
                            )
                elif isinstance(message.content, str):
                    log("USER", truncate(message.content))

            else:
                message_counts["other"] += 1
                log(
                    "MSG",
                    f"Unrecognized message type: {type(message).__name__}: "
                    f"{truncate(str(message), 300)}",
                )

    except Exception as e:
        log_error_cw(
            f"Exception during Claude session: {type(e).__name__}: {e}",
            task_id=config.task_id or None,
        )
        err_text = _screened(str(e))
        progress.write_agent_error(error_type=type(e).__name__, message=err_text)
        if result.status == "unknown":
            result.status = "error"
            result.error = f"Claude session failed: {err_text}"
    finally:
        try:
            await client.disconnect()
        finally:
            if broker is not None:
                broker.close()

    log("AGENT", f"Generator finished. Messages received: {message_counts}")
    log("AGENT", f"CLI stderr lines received: {stderr_line_count}")
    if message_counts["assistant"] == 0 and message_counts["system"] > 0:
        log(
            "WARN",
            "Got init SystemMessage but zero AssistantMessages. The CLI subprocess "
            "started but produced no turns. Likely causes: (1) Bedrock API auth/connectivity "
            "failure, (2) SDK↔CLI protocol mismatch, (3) CLI crash after init. "
            "Check [CLI] stderr lines above for errors.",
        )
    if message_counts["result"] == 0:
        log(
            "WARN",
            "No ResultMessage received from the agent SDK — "
            "agent metrics (cost, turns) will be unavailable",
        )

    return result
