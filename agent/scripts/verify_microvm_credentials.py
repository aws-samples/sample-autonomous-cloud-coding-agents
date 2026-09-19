#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Opt-in pinned Claude SDK/CLI credential probe; model and credentials are fake.

Run with agent/.venv/bin/python. This uses a loopback Bedrock event-stream server,
a temporary AWS profile and synthetic keys. It makes no paid model invocation.
It does not simulate a real VM snapshot or establish the AWS runtime provider's
refresh behavior. Keep it out of the ordinary unit suite.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import importlib.metadata
import json
import os
import re
import shlex
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TypedDict

MODEL = "us.anthropic.claude-sonnet-4-20250514-v1:0"


class ProbeState(TypedDict):
    key: str
    expiry: float
    fail: bool


def event_frame(event: dict) -> bytes:
    """Encode one AWS event-stream chunk containing an Anthropic streaming event."""
    headers = bytearray()
    for name, value in {
        ":event-type": "chunk",
        ":content-type": "application/json",
        ":message-type": "event",
    }.items():
        key, val = name.encode(), value.encode()
        headers += bytes([len(key)]) + key + b"\x07" + struct.pack(">H", len(val)) + val
    body = json.dumps({"bytes": base64.b64encode(json.dumps(event).encode()).decode()}).encode()
    prelude = struct.pack(">II", 16 + len(headers) + len(body), len(headers))
    frame = prelude + struct.pack(">I", zlib.crc32(prelude)) + headers + body
    return frame + struct.pack(">I", zlib.crc32(frame))


def model_response() -> bytes:
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_offline",
                "type": "message",
                "role": "assistant",
                "model": MODEL,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 0},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "Offline credential probe."},
        },
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        },
        {"type": "message_stop"},
    ]
    return b"".join(event_frame(event) for event in events)


HELPER = """\
import json, sys
from datetime import UTC, datetime
from pathlib import Path
state = json.loads(Path(sys.argv[1]).read_text())
if state["fail"]:
    print("synthetic credential renewal failure", file=sys.stderr)
    raise SystemExit(7)
creds = {
    "AccessKeyId": state["key"],
    "SecretAccessKey": "synthetic-secret-not-valid-in-aws",
    "SessionToken": "synthetic-session-not-valid-in-aws",
    "Expiration": datetime.fromtimestamp(state["expiry"], UTC).isoformat(),
}
with open(sys.argv[2], "a") as log:
    log.write(json.dumps({"key": state["key"]}) + "\\n")
print(json.dumps({"Credentials": creds} if sys.argv[3] == "export" else {"Version": 1, **creds}))
"""


async def probe(mode: str, *, ambient_fallback: bool) -> dict:
    import claude_agent_sdk
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, ResultMessage

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from microvm_credentials import ScopedCredentialBroker
    from microvm_lifecycle import MicrovmLifecycle

    requests: list[dict] = []
    initial_expiry = int(time.time()) + 12
    state: ProbeState = {"key": "SYNTHETIC_INITIAL", "expiry": initial_expiry, "fail": False}
    stream = model_response()
    sdk_version = importlib.metadata.version("claude-agent-sdk")
    cli = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
    cli_version = subprocess.run(
        [str(cli), "--version"], capture_output=True, text=True, check=True, timeout=5
    ).stdout.strip()
    if sdk_version != "0.2.110" or cli_version != "2.1.191 (Claude Code)":
        raise RuntimeError("Probe expectations require reviewed SDK 0.2.110 / Claude 2.1.191 pins")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            del format, args

        def do_GET(self):
            if self.path != "/credentials":
                self.send_error(404)
                return
            body = json.dumps(
                {
                    "AccessKeyId": "SYNTHETIC_AMBIENT",
                    "SecretAccessKey": "synthetic-ambient-secret",
                    "Token": "synthetic-ambient-token",
                    "SessionToken": "synthetic-ambient-token",
                    "Expiration": datetime.fromtimestamp(time.time() + 3600, UTC).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                }
            ).encode()
            requests.append({"kind": "ambient-provider"})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            key = re.search(r"Credential=([^/]+)", self.headers.get("Authorization", ""))
            requests.append(
                {
                    "kind": "model",
                    "key": key.group(1) if key else "missing",
                    "phase": state["key"],
                    "at": time.time(),
                    "path": self.path,
                }
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.amazon.eventstream")
            self.send_header("Content-Length", str(len(stream)))
            self.end_headers()
            self.wfile.write(stream)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    broker = None
    try:
        with tempfile.TemporaryDirectory(prefix="abca-645-credentials-") as directory:
            temp = Path(directory)
            helper, state_file, audit = (
                temp / name for name in ("helper.py", "state.json", "audit")
            )
            helper.write_text(HELPER)
            state_file.write_text(json.dumps(state))
            settings = temp / "settings.json"
            provider = (
                "export"
                if mode == "export"
                else "none"
                if mode == "ambient" or mode.startswith("broker")
                else "process"
            )
            command = shlex.join(
                [sys.executable, str(helper), str(state_file), str(audit), provider]
            )
            export_command = (
                shlex.join(
                    [
                        sys.executable,
                        str(Path(__file__).resolve().parents[1] / "src/bedrock_creds_helper.py"),
                    ]
                )
                if mode.startswith("broker")
                else command
            )
            settings.write_text(
                json.dumps(
                    {"awsCredentialExport": export_command}
                    if mode == "export" or mode.startswith("broker")
                    else {}
                )
            )
            config = temp / "aws-config"
            config.write_text(
                "[profile probe]\nregion = us-west-2\n"
                + (f"credential_process = {command}\n" if provider == "process" else "")
            )
            credentials = temp / "aws-credentials"
            credentials.write_text("")
            config_dir = temp / "claude-config"
            config_dir.mkdir()
            child_env = {
                "CLAUDE_CONFIG_DIR": str(config_dir),
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
                "AWS_PROFILE": "probe",
                "AWS_CONFIG_FILE": str(config),
                "AWS_SHARED_CREDENTIALS_FILE": str(credentials),
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI": endpoint + "/credentials"
                if ambient_fallback or mode.startswith("broker")
                else "",
                "ABCA_MICROVM_CREDENTIAL_BROKER": "1" if mode.startswith("broker") else "",
                "AWS_METADATA_SERVICE_TIMEOUT": "1",
                "AWS_METADATA_SERVICE_NUM_ATTEMPTS": "1",
                "AWS_MAX_ATTEMPTS": "1",
            }
            if mode.startswith("broker"):

                def scoped_provider():
                    requests.append(
                        {"kind": "broker-failure" if state["fail"] else "broker-provider"}
                    )
                    if state["fail"]:
                        raise RuntimeError("synthetic broker renewal failure")
                    return {
                        "AccessKeyId": state["key"],
                        "SecretAccessKey": "synthetic-scoped-secret",
                        "Token": "synthetic-scoped-token",
                        "Expiration": datetime.fromtimestamp(state["expiry"], UTC).strftime(
                            "%Y-%m-%dT%H:%M:%SZ"
                        ),
                    }

                broker = ScopedCredentialBroker(
                    MicrovmLifecycle("probe", "probe-vm"), provider=scoped_provider
                )
                child_env.update(broker.environment)
            errors: list[str] = []
            options = ClaudeAgentOptions(
                model=MODEL,
                max_turns=1,
                cwd=directory,
                setting_sources=[],
                settings=str(settings),
                env=child_env,
                stderr=errors.append,
            )
            results = []
            async with ClaudeSDKClient(options=options) as client:
                for phase in ("initial", "after-expiry"):
                    if phase == "after-expiry":
                        await asyncio.sleep(max(0, state["expiry"] - time.time()) + 0.3)
                        state.update(
                            key="SYNTHETIC_RENEWED",
                            expiry=time.time() + 3600,
                            fail=mode in {"process-failure", "broker-failure"},
                        )
                        pending = state_file.with_suffix(".pending")
                        pending.write_text(json.dumps(state))
                        pending.replace(state_file)
                    await client.query("Return one short sentence. Do not call tools.")
                    async for message in client.receive_response():
                        if isinstance(message, ResultMessage):
                            results.append(
                                {
                                    "phase": phase,
                                    "error": message.is_error,
                                    **({"detail": message.result} if message.is_error else {}),
                                }
                            )
            issued = (
                [json.loads(line) for line in audit.read_text().splitlines()]
                if audit.exists()
                else []
            )
            return {
                "mode": mode,
                "sdk_version": sdk_version,
                "cli_version": cli_version,
                "ambient_fallback": ambient_fallback,
                "initial_expiry": initial_expiry,
                "requests": requests,
                "issued": issued,
                "results": results,
                "stderr_lines": len(errors),
            }
    finally:
        if broker is not None:
            broker.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


def verify(result: dict) -> None:
    """Positive controls prevent a broken fake endpoint from proving safety."""
    model = [
        request
        for request in result["requests"]
        if request.get("path") == f"/model/{MODEL}/invoke-with-response-stream"
    ]
    initial = [request for request in model if request["phase"] == "SYNTHETIC_INITIAL"]
    after = [request for request in model if request["phase"] == "SYNTHETIC_RENEWED"]
    mode = result["mode"]
    expected_initial = "SYNTHETIC_AMBIENT" if mode == "ambient" else "SYNTHETIC_INITIAL"
    if (
        len(initial) != 1
        or initial[0]["key"] != expected_initial
        or initial[0]["at"] >= result["initial_expiry"]
    ):
        raise RuntimeError("Initial query must succeed with the expected key before its expiry")
    failed = mode == "broker-failure" or (
        mode == "process-failure" and not result["ambient_fallback"]
    )
    if [item["error"] for item in result["results"]] != [False, failed]:
        raise RuntimeError("Unexpected SDK result; credential-path proof failed")
    if failed:
        if after:
            raise RuntimeError("Renewal failure allowed a model request")
    else:
        expected = (
            "SYNTHETIC_INITIAL"
            if mode == "export"
            else "SYNTHETIC_AMBIENT"
            if mode in {"ambient", "process-failure"}
            else "SYNTHETIC_RENEWED"
        )
        if (
            len(after) != 1
            or after[0]["key"] != expected
            or after[0]["at"] <= result["initial_expiry"]
        ):
            raise RuntimeError("Post-expiry query did not use the expected credential path")
    result["verified"] = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=["export", "process", "process-failure", "ambient", "broker", "broker-failure"],
        required=True,
    )
    parser.add_argument("--ambient-fallback", action="store_true")
    args = parser.parse_args()
    if args.mode == "ambient" and not args.ambient_fallback:
        parser.error("ambient positive control requires --ambient-fallback")
    # This process exists only for the probe. Do not inherit operator credentials
    # or auth/telemetry settings into the real CLI. HOME is never reassigned.
    for key in tuple(os.environ):
        if key.startswith(("AWS_", "ANTHROPIC_", "CLAUDE_", "OTEL_", "BEDROCK_")):
            del os.environ[key]
    result = asyncio.run(
        asyncio.wait_for(probe(args.mode, ambient_fallback=args.ambient_fallback), 45)
    )
    verify(result)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
