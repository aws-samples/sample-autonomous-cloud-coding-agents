"""Agent invocation: environment setup and Claude Agent SDK execution.

Between-turns injection seam (Phase 2 Nudges)
---------------------------------------------
User nudges and other synthetic mid-task steering messages are injected via
the Claude Agent SDK's ``Stop`` hook (registered in ``hooks.build_hook_matchers``),
NOT the message-receive loop below.

Rationale for the Stop hook seam:
  * The SDK's ``ClaudeSDKClient.receive_response()`` generator is
    single-producer; calling ``client.query()`` mid-stream races with the
    CLI subprocess's stdin and is not reliable.
  * The Stop hook fires at a well-defined point — after the agent finishes a
    turn and before it decides to stop.  Returning
    ``{"decision": "block", "reason": "<text>"}`` causes the SDK to continue
    the conversation with ``<text>`` as the next user message, which is
    exactly the semantics we need for nudge injection.
  * A module-level registry ``hooks.between_turns_hooks`` lets Phase 3
    approval gates add additional hooks without touching this file.

Turn counting (``result.turns``) is incremented on ``AssistantMessage`` only
and is NOT affected by the Stop hook's block/continue decision — nudge
injection does not double-count turns.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any
from urllib.parse import quote

from config import AGENT_WORKSPACE
from models import AgentResult, TaskConfig, TokenUsage
from progress_writer import _ProgressWriter
from shell import log, truncate
from telemetry import _TrajectoryWriter


def _format_tool_result(block) -> tuple[str, str]:
    """Extract status label and content string from a ToolResultBlock."""
    status = "ERROR" if block.is_error else "ok"
    content = block.content if isinstance(block.content, str) else str(block.content)
    return status, content


def _parse_token_usage(raw_usage: Any) -> TokenUsage:
    """Normalize a raw usage value (dict or dataclass) into a TokenUsage model."""
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


def _setup_agent_env(config: TaskConfig) -> tuple[str | None, str | None]:
    """Configure process environment for the Claude Code CLI subprocess.

    Sets Bedrock credentials, strips OTEL auto-instrumentation vars, and
    optionally enables CLI-native OTel telemetry.

    Returns (otlp_endpoint, otlp_protocol) for logging.
    """
    os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
    os.environ["AWS_REGION"] = config.aws_region
    os.environ["ANTHROPIC_MODEL"] = config.anthropic_model
    os.environ["GITHUB_TOKEN"] = config.github_token
    os.environ["GH_TOKEN"] = config.github_token
    # DO NOT set ANTHROPIC_LOG — any logging level causes the CLI to write to
    # stderr, which fills the OS pipe buffer (64 KB) and deadlocks the
    # single-threaded Node.js CLI process (blocked stderr write prevents stdout
    # writes, while the SDK is waiting on stdout).  The stderr callback in
    # ClaudeAgentOptions cannot drain fast enough to prevent this.
    os.environ.pop("ANTHROPIC_LOG", None)
    os.environ["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "anthropic.claude-haiku-4-5-20251001-v1:0"

    # Save OTLP endpoint/protocol configured by ADOT auto-instrumentation
    # before stripping, so we can re-use it for Claude Code CLI telemetry.
    otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    otlp_protocol = os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL")

    # Strip OTEL auto-instrumentation vars from os.environ so target-repo
    # child processes (mise run build, pytest, semgrep, etc.) don't attempt
    # Python OTEL auto-instrumentation using the agent's packages.
    # The agent's own TracerProvider is already configured at startup — it does
    # not re-read env vars, so removing them is safe.
    for key in [k for k in os.environ if k.startswith("OTEL_")]:
        del os.environ[key]
    pythonpath = os.environ.get("PYTHONPATH", "")
    if pythonpath:
        cleaned = os.pathsep.join(
            p for p in pythonpath.split(os.pathsep) if "opentelemetry" not in p
        )
        if cleaned:
            os.environ["PYTHONPATH"] = cleaned
        else:
            os.environ.pop("PYTHONPATH", None)

    # Enable Claude Code CLI's native OTel telemetry if an OTLP endpoint is
    # available.  The CLI exports events (tool results, API requests/errors,
    # tool decisions) as OTLP logs with per-prompt granularity — beyond the
    # aggregate ResultMessage at session end.
    #
    # Gated on ENABLE_CLI_TELEMETRY env var (opt-in) because the ADOT sidecar
    # in AgentCore Runtime is only confirmed to forward traces (configured via
    # CfnRuntimeLogsMixin.TRACES.toXRay() in CDK). Whether the sidecar also
    # forwards OTLP logs is unconfirmed. Set ENABLE_CLI_TELEMETRY=1 in the
    # runtime environment to enable and verify logs appear in CloudWatch.
    #
    # Configuration choices based on AWS documentation:
    #   - OTEL_METRICS_EXPORTER=none: All AWS ADOT examples disable metrics
    #     export. CloudWatch does not ingest OTLP metrics from the sidecar.
    #   - OTEL_TRACES_EXPORTER=none: Explicitly disabled. The agent's own
    #     custom spans (task.pipeline, task.agent_execution, etc.) already
    #     provide trace-level coverage via the Python ADOT auto-instrumentation.
    #   - OTEL_LOGS_EXPORTER=otlp: SDK events (tool_result, api_request, etc.)
    #     are the primary telemetry of interest and are exported as OTLP logs.
    #   - OTEL_EXPORTER_OTLP_LOGS_HEADERS: Includes the application log group
    #     name so that, if the exporter sends directly to CloudWatch's OTLP
    #     endpoint, logs land in the correct log group. Ignored by the sidecar
    #     if it has its own routing config.
    #   - Protocol defaults to http/protobuf (AWS-recommended for OTLP).
    #
    # NOTE: These env vars are set on os.environ (process-global) because the
    # Claude Agent SDK spawns the CLI subprocess from the process environment.
    # This is safe for single-task-per-container deployments (AgentCore Runtime
    # allocates one session per container).  If concurrent tasks ever share a
    # process, this must be revisited (pass env via subprocess instead).
    if os.environ.get("ENABLE_CLI_TELEMETRY") == "1":
        if not otlp_endpoint:
            log("WARN", "OTEL_EXPORTER_OTLP_ENDPOINT not set by ADOT")
            # Default to http/protobuf on port 4318 (AWS-recommended protocol).
            otlp_endpoint = "http://localhost:4318"
        if not otlp_protocol:
            otlp_protocol = "http/protobuf"

        os.environ["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
        os.environ["OTEL_METRICS_EXPORTER"] = "none"
        os.environ["OTEL_TRACES_EXPORTER"] = "none"
        os.environ["OTEL_LOGS_EXPORTER"] = "otlp"
        os.environ["OTEL_EXPORTER_OTLP_PROTOCOL"] = otlp_protocol
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = otlp_endpoint
        os.environ["OTEL_LOG_TOOL_DETAILS"] = "1"

        # Route OTLP logs to the application log group. This header is used
        # when sending directly to CloudWatch's OTLP logs endpoint
        # (https://logs.{region}.amazonaws.com/v1/logs). If the exporter
        # sends to the ADOT sidecar instead, the sidecar may ignore this.
        log_group = os.environ.get("LOG_GROUP_NAME", "")
        if log_group:
            os.environ["OTEL_EXPORTER_OTLP_LOGS_HEADERS"] = f"x-aws-log-group={log_group}"

        # Tag all SDK telemetry with task metadata for correlation in CloudWatch.
        # Values are percent-encoded per the OTEL_RESOURCE_ATTRIBUTES spec to
        # handle any special characters (commas, equals, spaces) in config values.
        os.environ["OTEL_RESOURCE_ATTRIBUTES"] = (
            f"task.id={quote(config.task_id or 'unknown', safe='')},"
            f"repo.url={quote(config.repo_url or 'unknown', safe='')},"
            f"agent.model={quote(config.anthropic_model or 'unknown', safe='')}"
        )
        log(
            "AGENT",
            f"Claude Code telemetry enabled: endpoint={otlp_endpoint} "
            f"protocol={otlp_protocol} logs_log_group={log_group or '(not set)'}",
        )
    else:
        log("AGENT", "Claude Code CLI telemetry disabled (set ENABLE_CLI_TELEMETRY=1 to enable)")

    return otlp_endpoint, otlp_protocol


async def run_agent(
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

    # Log SDK and CLI versions for diagnosing protocol mismatches
    import claude_agent_sdk as _sdk

    sdk_version = getattr(_sdk, "__version__", "unknown")
    log("AGENT", f"claude-agent-sdk version: {sdk_version}")
    cli_path = subprocess.run(["which", "claude"], capture_output=True, text=True, timeout=5)
    if cli_path.returncode == 0:
        cli_ver = subprocess.run(
            ["claude", "--version"], capture_output=True, text=True, timeout=10
        )
        log("AGENT", f"claude CLI: {cli_path.stdout.strip()} version={cli_ver.stdout.strip()}")
    else:
        log("WARN", "claude CLI not found on PATH")

    # All tools are allowed at the SDK level; Cedar policy engine enforces
    # per-task-type restrictions via PreToolUse hooks.
    allowed_tools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"]

    # Create trajectory writer and Cedar policy engine with hook matchers.
    # ``trace=config.trace`` is load-bearing: this writer emits the turn /
    # tool_call / tool_result / error previews that the --trace flag is
    # meant to raise to 4 KB. The pipeline.py milestone writer is a
    # separate instance; dropping trace here silently no-ops the feature
    # for every preview field that matters.
    #
    # When the caller (pipeline.py) injects a pre-built ``trajectory`` we
    # use it as-is so the pipeline can retain access to the accumulator
    # after ``run_agent`` returns (the --trace S3 upload runs in
    # pipeline.py on terminal state — see design §10.1). For standalone
    # invocations we fall back to a fresh writer with no accumulator.
    if trajectory is None:
        trajectory = _TrajectoryWriter(config.task_id or "unknown")
    progress = _ProgressWriter(config.task_id or "unknown", trace=config.trace)

    # Map tool_use_id → tool_name so we can label ToolResultBlocks that arrive
    # in UserMessages (ToolResultBlock carries only the id, not the name).
    tool_use_id_to_name: dict[str, str] = {}

    from hooks import build_hook_matchers
    from policy import PolicyEngine

    task_type = config.task_type
    repo_url = config.repo_url
    cedar_policies = config.cedar_policies
    policy_engine = PolicyEngine(
        task_type=task_type,
        repo=repo_url,
        extra_policies=cedar_policies if cedar_policies else None,
    )
    log(
        "AGENT",
        f"Cedar policy engine initialized for task_type={task_type}"
        + (f" with {len(cedar_policies)} extra policies" if cedar_policies else ""),
    )

    hooks = build_hook_matchers(
        engine=policy_engine,
        trajectory=trajectory,
        task_id=config.task_id or "",
        progress=progress,
    )

    options = ClaudeAgentOptions(
        model=config.anthropic_model,
        system_prompt=system_prompt,
        allowed_tools=allowed_tools,
        permission_mode="bypassPermissions",
        cwd=cwd,
        max_turns=config.max_turns,
        setting_sources=["project"],
        hooks=hooks,
        max_budget_usd=config.max_budget_usd,
        stderr=_on_stderr,
    )

    result = AgentResult()
    message_counts = {"system": 0, "assistant": 0, "result": 0, "other": 0}

    # Use ClaudeSDKClient (connect/query/receive_response) instead of the
    # standalone query() function.  This matches the official AWS sample:
    # https://github.com/aws-samples/sample-deploy-ClaudeAgentSDK-based-agents-to-AgentCore-Runtime
    client = ClaudeSDKClient(options=options)
    log("AGENT", "Connecting to Claude Code CLI subprocess...")
    await client.connect()
    log("AGENT", "Connected. Sending prompt...")
    await client.query(prompt=prompt)
    log("AGENT", "Prompt sent. Receiving messages...")
    try:
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
                result.turns += 1
                log("TURN", f"#{result.turns} (model: {message.model})")

                # Per-turn accumulators for trajectory
                turn_thinking = ""
                turn_text = ""
                turn_tool_calls: list[dict] = []
                turn_tool_results: list[dict] = []

                for block in message.content:
                    if isinstance(block, ThinkingBlock):
                        log("THINK", truncate(block.thinking, 200))
                        turn_thinking += block.thinking + "\n"
                    elif isinstance(block, TextBlock):
                        print(block.text, flush=True)
                        turn_text += block.text + "\n"
                    elif isinstance(block, ToolUseBlock):
                        tool_input = block.input
                        if block.name == "Bash":
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
                        # Track for later correlation with ToolResultBlocks in UserMessages
                        tool_use_id = getattr(block, "id", "") or getattr(block, "tool_use_id", "")
                        if tool_use_id:
                            tool_use_id_to_name[tool_use_id] = block.name
                    elif isinstance(block, ToolResultBlock):
                        status, content = _format_tool_result(block)
                        log("RESULT", f"[{status}] {truncate(content)}")
                        turn_tool_results.append(
                            {
                                "tool_use_id": getattr(block, "tool_use_id", ""),
                                "is_error": block.is_error,
                                "content": content,
                            }
                        )

                # Write trajectory event for this turn
                trajectory.write_turn(
                    turn=result.turns,
                    model=message.model,
                    thinking=turn_thinking.strip(),
                    text=turn_text.strip(),
                    tool_calls=turn_tool_calls,
                    tool_results=turn_tool_results,
                )

                # Write progress events for this turn
                progress.write_agent_turn(
                    turn=result.turns,
                    model=message.model,
                    thinking=turn_thinking.strip(),
                    text=turn_text.strip(),
                    tool_calls_count=len(turn_tool_calls),
                )
                for tc in turn_tool_calls:
                    progress.write_agent_tool_call(
                        tool_name=tc["name"],
                        tool_input=str(tc.get("input", "")),
                        turn=result.turns,
                    )
                # Tool result events are written from the UserMessage branch
                # (ToolResultBlocks arrive as UserMessage content, not in
                # AssistantMessage content).

            elif isinstance(message, ResultMessage):
                message_counts["result"] += 1
                result.status = message.subtype
                result.cost_usd = getattr(message, "total_cost_usd", None)
                result.num_turns = getattr(message, "num_turns", 0)
                result.duration_ms = getattr(message, "duration_ms", 0)
                result.duration_api_ms = getattr(message, "duration_api_ms", 0)
                result.session_id = getattr(message, "session_id", "") or ""

                # Capture token usage from ResultMessage
                raw_usage = getattr(message, "usage", None)
                usage: TokenUsage | None = None
                if raw_usage is not None:
                    # Handle both object (dataclass) and dict forms
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
                    f"status={message.subtype} turns={message.num_turns} "
                    f"cost=${message.total_cost_usd or 0:.4f} "
                    f"duration={message.duration_ms / 1000:.1f}s",
                )
                if message.is_error and message.result:
                    log("ERROR", message.result)

                # Write trajectory result summary
                trajectory.write_result(
                    subtype=message.subtype,
                    num_turns=getattr(message, "num_turns", 0),
                    cost_usd=getattr(message, "total_cost_usd", None),
                    duration_ms=getattr(message, "duration_ms", 0),
                    duration_api_ms=getattr(message, "duration_api_ms", 0),
                    session_id=getattr(message, "session_id", ""),
                    usage=usage,
                )

                # Write progress cost update event
                input_toks = usage.input_tokens if usage else 0
                output_toks = usage.output_tokens if usage else 0
                progress.write_agent_cost_update(
                    cost_usd=getattr(message, "total_cost_usd", None),
                    input_tokens=input_toks,
                    output_tokens=output_toks,
                    turn=getattr(message, "num_turns", 0),
                )

            elif isinstance(message, UserMessage):
                message_counts["other"] += 1
                # UserMessage carries tool results fed back to the model.
                # For hook-denied calls, content is a ToolResultBlock with
                # is_error=True and the denial reason.
                if isinstance(message.content, list):
                    for block in message.content:
                        if isinstance(block, ToolResultBlock):
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
        log("ERROR", f"Exception during receive_response(): {type(e).__name__}: {e}")
        progress.write_agent_error(error_type=type(e).__name__, message=str(e))
        if result.status == "unknown":
            result.status = "error"
            result.error = f"receive_response() failed: {e}"

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
