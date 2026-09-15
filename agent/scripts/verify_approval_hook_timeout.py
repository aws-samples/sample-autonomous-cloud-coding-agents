#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Opt-in pinned CLI approval callback probe; loopback model and synthetic keys.

Compare --configured microvm --delay 650 with --delay 650 for the CLI default.
An explicit --timeout 1 --delay 3 provides a short failure control. This is
outside the unit suite; it tests actual SDK/CLI transport, not VM freezing.
"""

import argparse
import asyncio
import importlib.metadata
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from verify_microvm_credentials import MODEL, event_frame, model_response

ROOT = Path(__file__).resolve().parents[2]
MAX_PROBE_DELAY_S = 900


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise RuntimeError(detail)


async def probe(timeout, delay, configured):
    import claude_agent_sdk
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, ResultMessage
    from claude_agent_sdk.types import HookMatcher

    cli = Path(claude_agent_sdk.__file__).parent / "_bundled/claude"
    version = subprocess.run(
        [str(cli), "--version"], capture_output=True, text=True, check=True, timeout=10
    ).stdout.strip()
    require(version == "2.1.191 (Claude Code)", "Probe requires reviewed CLI 2.1.191")
    require(
        importlib.metadata.version("claude-agent-sdk") == "0.2.110",
        "Probe requires reviewed SDK 0.2.110",
    )
    audit = []
    lifecycle = None
    pre_matcher = HookMatcher(timeout=timeout)
    if configured:
        sys.path.insert(0, str(ROOT / "agent/src"))
        from hooks import build_hook_matchers
        from microvm_lifecycle import register_task
        from policy import PolicyEngine

        if configured == "microvm":
            lifecycle = register_task("local-hook-probe", "local-probe-vm")
        # PolicyEngine logs with os.write(1), bypassing sys.stdout. Redirect
        # only synchronous setup, before the probe starts any server threads.
        saved_stdout = os.dup(1)
        try:
            os.dup2(2, 1)
            pre_matcher = build_hook_matchers(
                engine=PolicyEngine(task_type="new_task", repo="probe/owned"),
                task_id="local-hook-probe",
            )["PreToolUse"][0]
        finally:
            os.dup2(saved_stdout, 1)
            os.close(saved_stdout)
    with tempfile.TemporaryDirectory(prefix="abca-645-hook-timeout-") as directory:
        temp = Path(directory)
        target = temp / "owned-marker.txt"
        target.write_text("OWNED_READ_MARKER\n")
        settings = temp / "settings.json"
        settings.write_text("{}")
        aws_config = temp / "aws-config"
        aws_config.write_text("[default]\nregion = us-west-2\n")
        aws_creds = temp / "aws-credentials"
        aws_creds.write_text("")
        config = temp / "claude-config"
        config.mkdir()
        started = time.monotonic()

        def record(kind, **data):
            audit.append({"kind": kind, "elapsed_s": time.monotonic() - started, **data})

        def tool_response():
            events = [
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_tool",
                        "type": "message",
                        "role": "assistant",
                        "model": MODEL,
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 1, "output_tokens": 0},
                    },
                },
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_owned",
                        "name": "Read",
                        "input": {},
                    },
                },
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": json.dumps({"file_path": str(target)}),
                    },
                },
                {"type": "content_block_stop", "index": 0},
                {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": "tool_use",
                        "stop_sequence": None,
                    },
                    "usage": {"output_tokens": 1},
                },
                {"type": "message_stop"},
            ]
            return b"".join(event_frame(event) for event in events)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                del format, args

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                prior = [
                    item
                    for message in body.get("messages", [])
                    for item in message.get("content", [])
                    if isinstance(item, dict) and item.get("type") == "tool_result"
                ]
                record("model-request", results=prior)
                stream = model_response() if prior else tool_response()
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.amazon.eventstream")
                self.send_header("Content-Length", str(len(stream)))
                self.end_headers()
                self.wfile.write(stream)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{server.server_port}"

        async def pre(data, tool_id, ctx):
            require(data["tool_name"] == "Read", "Unexpected tool")
            require(data["tool_input"] == {"file_path": str(target)}, "Unexpected target")
            record("pre-start", tool_id=tool_id)
            try:
                await asyncio.sleep(delay)
                record("pre-allow")
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                        "permissionDecisionReason": "Owned local test gate released",
                    }
                }
            except BaseException as error:
                record("pre-cancelled", error_type=type(error).__name__)
                raise

        async def post(data, tool_id, ctx):
            record("post", tool_name=data["tool_name"])
            return {}

        env = {
            "CLAUDE_CONFIG_DIR": str(config),
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_MAX_RETRIES": "0",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "DISABLE_AUTOUPDATER": "1",
            "ANTHROPIC_BEDROCK_BASE_URL": endpoint,
            "AWS_ENDPOINT_URL": endpoint,
            "AWS_REGION": "us-west-2",
            "AWS_DEFAULT_REGION": "us-west-2",
            "AWS_CONFIG_FILE": str(aws_config),
            "AWS_SHARED_CREDENTIALS_FILE": str(aws_creds),
            "AWS_ACCESS_KEY_ID": "SYNTHETIC_NOT_VALID",
            "AWS_SECRET_ACCESS_KEY": "synthetic-not-valid-in-aws",
            "AWS_SESSION_TOKEN": "synthetic-not-valid-in-aws",
            "AWS_EC2_METADATA_DISABLED": "true",
        }
        errors = []
        # Retain production matcher settings, replacing only its callback with
        # a controlled wait so the transport's cancellation is observable.
        pre_matcher.hooks = [pre]
        try:
            options = ClaudeAgentOptions(
                model=MODEL,
                max_turns=2,
                cwd=directory,
                tools=["Read"],
                permission_mode="bypassPermissions",
                setting_sources=[],
                settings=str(settings),
                env=env,
                stderr=errors.append,
                hooks={
                    "PreToolUse": [pre_matcher],
                    "PostToolUse": [HookMatcher(hooks=[post])],
                },
            )
            async with ClaudeSDKClient(options=options) as client:
                await client.query("Read the owned marker once, then stop.")
                async for message in client.receive_response():
                    if isinstance(message, ResultMessage):
                        record("result", is_error=message.is_error)
            return {
                "sdk_version": "0.2.110",
                "cli_version": version,
                "timeout_s": pre_matcher.timeout,
                "delay_s": delay,
                "configured": configured,
                "audit": audit,
                "stderr": errors,
            }
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            if lifecycle:
                from microvm_lifecycle import unregister_task

                unregister_task(lifecycle)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=float)
    parser.add_argument("--delay", type=float, default=3)
    parser.add_argument("--configured", choices=["microvm", "standard"])
    args = parser.parse_args()
    if args.configured and args.timeout is not None:
        parser.error("--configured uses production settings; omit --timeout")
    if args.delay <= 0 or args.delay > MAX_PROBE_DELAY_S:
        parser.error("--delay must be within (0, 900] seconds")
    for key in tuple(os.environ):
        if key.startswith(("AWS_", "ANTHROPIC_", "CLAUDE_", "OTEL_", "BEDROCK_")):
            del os.environ[key]
    result = asyncio.run(
        asyncio.wait_for(probe(args.timeout, args.delay, args.configured), max(args.delay + 30, 45))
    )
    calls = [event for event in result["audit"] if event["kind"] == "pre-start"]
    posts = [event for event in result["audit"] if event["kind"] == "post"]
    outcomes = [
        item
        for event in result["audit"]
        if event["kind"] == "model-request"
        for item in event["results"]
    ]
    require(len(calls) == 1 and len(outcomes) == 1, "Expected one tool call and one result")
    if args.configured:
        require(len(posts) == 1 and not outcomes[0].get("is_error"), "Read did not complete")
        require("OWNED_READ_MARKER" in str(outcomes[0]["content"]), "Owned marker not read")
    elif args.timeout is not None and args.timeout < args.delay:
        require(not posts and outcomes[0].get("is_error"), "Expired hook permitted the tool")
        require(
            any(event["kind"] == "pre-cancelled" for event in result["audit"]),
            "Expected callback cancellation",
        )
    result["verified"] = True
    print(json.dumps(result, indent=2))
