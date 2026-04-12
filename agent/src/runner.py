"""Agent invocation: environment setup and Claude Agent SDK execution."""

import os
import subprocess
from urllib.parse import quote

from config import AGENT_WORKSPACE
from shell import log, truncate
from telemetry import _TrajectoryWriter


def _setup_agent_env(config: dict) -> tuple[str | None, str | None]:
    """Configure process environment for the Claude Code CLI subprocess.

    Sets Bedrock credentials, strips OTEL auto-instrumentation vars, and
    optionally enables CLI-native OTel telemetry.

    Returns (otlp_endpoint, otlp_protocol) for logging.
    """
    os.environ["CLAUDE_CODE_USE_BEDROCK"] = "1"
    os.environ["AWS_REGION"] = config["aws_region"]
    os.environ["ANTHROPIC_MODEL"] = config["anthropic_model"]
    os.environ["GITHUB_TOKEN"] = config["github_token"]
    os.environ["GH_TOKEN"] = config["github_token"]
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
            f"task.id={quote(config.get('task_id', 'unknown'), safe='')},"
            f"repo.url={quote(config.get('repo_url', 'unknown'), safe='')},"
            f"agent.model={quote(config.get('anthropic_model', 'unknown'), safe='')}"
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
    prompt: str, system_prompt: str, config: dict, cwd: str = AGENT_WORKSPACE
) -> dict:
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

    # Create trajectory writer and Cedar policy engine with hook matchers
    trajectory = _TrajectoryWriter(config.get("task_id", "unknown"))

    from hooks import build_hook_matchers
    from policy import PolicyEngine

    task_type = config.get("task_type", "new_task")
    repo_url = config.get("repo_url", "")
    cedar_policies = config.get("cedar_policies") or []
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

    hooks = build_hook_matchers(engine=policy_engine, trajectory=trajectory)

    options = ClaudeAgentOptions(
        model=config["anthropic_model"],
        system_prompt=system_prompt,
        allowed_tools=allowed_tools,
        permission_mode="bypassPermissions",
        cwd=cwd,
        max_turns=config["max_turns"],
        setting_sources=["project"],
        hooks=hooks,
        **({"max_budget_usd": config["max_budget_usd"]} if config.get("max_budget_usd") else {}),
        stderr=_on_stderr,
    )

    result: dict[str, object] = {"status": "unknown", "turns": 0, "cost_usd": None}
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
                result["turns"] += 1
                log("TURN", f"#{result['turns']} (model: {message.model})")

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
                    elif isinstance(block, ToolResultBlock):
                        status = "ERROR" if block.is_error else "ok"
                        content = (
                            block.content if isinstance(block.content, str) else str(block.content)
                        )
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
                    turn=result["turns"],
                    model=message.model,
                    thinking=turn_thinking.strip(),
                    text=turn_text.strip(),
                    tool_calls=turn_tool_calls,
                    tool_results=turn_tool_results,
                )

            elif isinstance(message, ResultMessage):
                message_counts["result"] += 1
                result["status"] = message.subtype
                result["cost_usd"] = getattr(message, "total_cost_usd", None)
                result["num_turns"] = getattr(message, "num_turns", 0)
                result["duration_ms"] = getattr(message, "duration_ms", 0)
                result["duration_api_ms"] = getattr(message, "duration_api_ms", 0)
                result["session_id"] = getattr(message, "session_id", "")

                # Capture token usage from ResultMessage
                raw_usage = getattr(message, "usage", None)
                if raw_usage is not None:
                    # Handle both object (dataclass) and dict forms
                    if isinstance(raw_usage, dict):
                        usage_dict: dict | None = {
                            "input_tokens": raw_usage.get("input_tokens", 0),
                            "output_tokens": raw_usage.get("output_tokens", 0),
                            "cache_read_input_tokens": raw_usage.get("cache_read_input_tokens", 0),
                            "cache_creation_input_tokens": raw_usage.get(
                                "cache_creation_input_tokens", 0
                            ),
                        }
                    else:
                        usage_dict = {
                            "input_tokens": getattr(raw_usage, "input_tokens", 0),
                            "output_tokens": getattr(raw_usage, "output_tokens", 0),
                            "cache_read_input_tokens": getattr(
                                raw_usage, "cache_read_input_tokens", 0
                            ),
                            "cache_creation_input_tokens": getattr(
                                raw_usage, "cache_creation_input_tokens", 0
                            ),
                        }
                    result["usage"] = usage_dict
                    if all(v == 0 for v in usage_dict.values()):
                        log(
                            "WARN",
                            f"All token usage values are zero — usage object "
                            f"type={type(raw_usage).__name__}",
                        )
                    else:
                        log(
                            "USAGE",
                            f"input={usage_dict['input_tokens']} "
                            f"output={usage_dict['output_tokens']} "
                            f"cache_read={usage_dict['cache_read_input_tokens']} "
                            f"cache_create={usage_dict['cache_creation_input_tokens']}",
                        )
                else:
                    usage_dict = None
                    result["usage"] = None

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
                    usage=usage_dict,
                )

            else:
                message_counts["other"] += 1
                log(
                    "MSG",
                    f"Unrecognized message type: {type(message).__name__}: "
                    f"{truncate(str(message), 300)}",
                )

    except Exception as e:
        log("ERROR", f"Exception during receive_response(): {type(e).__name__}: {e}")
        if result["status"] == "unknown":
            result["status"] = "error"
            result["error"] = f"receive_response() failed: {e}"

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
