# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Opt-in real SDK/CLI continuation test with a synthetic loopback model.

Run ABCA_TEST_SDK_CONTINUATION=1 uv run pytest tests/test_continuation_sdk_probe.py
--no-cov. No model service or real AWS credentials are used.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

AGENT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_ROOT))
sys.path.insert(0, str(AGENT_ROOT / "src"))

from continuation_session import CheckpointIdentity, CheckpointSessionStore, decode_checkpoint
from scripts.verify_microvm_credentials import MODEL, event_frame, model_response

IDENTITY = CheckpointIdentity("sdk-probe", "attempt-1", "request-1", "owner", "probe/owned")


def _tool_response(target: Path, tool_id: str) -> bytes:
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_" + tool_id,
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
            "content_block": {"type": "tool_use", "id": tool_id, "name": "Read", "input": {}},
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
            "delta": {"stop_reason": "tool_use", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        },
        {"type": "message_stop"},
    ]
    return b"".join(event_frame(event) for event in events)


async def _worker(directory: Path, endpoint: str, phase: str, decision: str) -> None:
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        project_key_for_directory,
    )
    from claude_agent_sdk.types import HookMatcher

    workspace = directory / "workspace"
    target = workspace / "owned.txt"
    original = phase == "original"
    store = (
        CheckpointSessionStore(project_key_for_directory(str(workspace)))
        if original
        else CheckpointSessionStore.restore((directory / "checkpoint.json").read_bytes(), IDENTITY)
    )
    saved = (
        None
        if original
        else decode_checkpoint((directory / "checkpoint.json").read_bytes(), IDENTITY)
    )
    audit: list[dict] = []

    def record(kind: str, **data) -> None:
        audit.append({"kind": kind, **data})
        (directory / f"{phase}-audit.json").write_text(json.dumps(audit))

    async def pre(data, tool_id, context):
        assert data["tool_name"] == "Read"
        assert data["tool_input"] == {"file_path": str(target)}
        record("pre", session_id=data["session_id"], tool_id=tool_id)
        if original:
            body = await store.checkpoint_pending(
                IDENTITY,
                session_id=data["session_id"],
                tool_use_id=tool_id,
                tool_name=data["tool_name"],
                tool_input=data["tool_input"],
            )
            pending = directory / "checkpoint.tmp"
            pending.write_bytes(body)
            pending.chmod(0o600)
            pending.replace(directory / "checkpoint.json")
            await asyncio.sleep(100)
            raise RuntimeError("Original process was not stopped")
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow" if decision == "approve" else "deny",
                "permissionDecisionReason": "Owned continuation diagnostic decision",
            }
        }

    async def post(data, tool_id, context):
        record("post", tool_id=tool_id)
        return {}

    env = {
        "CLAUDE_CONFIG_DIR": str(directory / f"{phase}-config"),
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
        "AWS_CONFIG_FILE": str(directory / "aws-config"),
        "AWS_SHARED_CREDENTIALS_FILE": str(directory / "aws-credentials"),
        "AWS_ACCESS_KEY_ID": "SYNTHETIC_NOT_VALID",
        "AWS_SECRET_ACCESS_KEY": "synthetic-not-valid-in-aws",
        "AWS_SESSION_TOKEN": "synthetic-not-valid-in-aws",
        "AWS_EC2_METADATA_DISABLED": "true",
    }
    options = ClaudeAgentOptions(
        model=MODEL,
        max_turns=3,
        cwd=str(workspace),
        tools=["Read"],
        permission_mode="bypassPermissions",
        setting_sources=[],
        settings=str(directory / "settings.json"),
        env=env,
        resume=saved["session_id"] if saved else None,
        session_store=store,
        session_store_flush="eager",
        stderr=lambda line: record("stderr", text=line),
        hooks={
            "PreToolUse": [HookMatcher(hooks=[pre], timeout=100)],
            "PostToolUse": [HookMatcher(hooks=[post])],
        },
    )
    async with ClaudeSDKClient(options=options) as client:
        prompt = (
            "Continue the saved task. The human decision was "
            + decision
            + ". The saved pending action was "
            + json.dumps(saved["action"])
            if saved
            else "Read the owned marker once, then stop."
        )
        await client.query(prompt)
        async for message in client.receive_response():
            if isinstance(message, ResultMessage):
                record("result", session_id=message.session_id, is_error=message.is_error)


@pytest.mark.skipif(
    os.environ.get("ABCA_TEST_SDK_CONTINUATION") != "1",
    reason="Opt-in pinned SDK/CLI subprocess diagnostic",
)
@pytest.mark.parametrize("decision", ["approve", "deny"])
def test_sdk_resumes_from_checkpoint_without_original_config(tmp_path, decision):
    import claude_agent_sdk

    assert importlib.metadata.version("claude-agent-sdk") == "0.2.110"
    cli = Path(claude_agent_sdk.__file__).parent / "_bundled/claude"
    version = subprocess.check_output([str(cli), "--version"], text=True, timeout=10).strip()
    assert version == "2.1.191 (Claude Code)"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "owned.txt"
    target.write_text("OWNED_CONTINUATION_MARKER\n")
    for phase in ("original", "restored"):
        (tmp_path / f"{phase}-config").mkdir()
    auth_sentinel = "SYNTHETIC_AUTH_FILE_MUST_NOT_BE_COPIED"
    (tmp_path / "original-config/.credentials.json").write_text(
        json.dumps({"sentinel": auth_sentinel})
    )
    (tmp_path / "settings.json").write_text("{}")
    (tmp_path / "aws-config").write_text("[default]\nregion = us-west-2\n")
    (tmp_path / "aws-credentials").write_text("")
    phase = ["original"]
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            del format, args

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"phase": phase[0], "body": body})
            results = [
                item
                for message in body.get("messages", [])
                for item in (
                    message.get("content", []) if isinstance(message.get("content"), list) else []
                )
                if isinstance(item, dict) and item.get("type") == "tool_result"
            ]
            response = model_response() if results else _tool_response(target, "toolu_" + phase[0])
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.amazon.eventstream")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    children = []
    logs = []

    def start(name):
        log = (tmp_path / f"{name}-process.log").open("w")
        logs.append(log)
        child = subprocess.Popen(
            [
                sys.executable,
                str(__file__),
                "--worker",
                name,
                "--directory",
                str(tmp_path),
                "--endpoint",
                endpoint,
                "--decision",
                decision,
            ],
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        children.append(child)
        return child

    try:
        first = start("original")
        limit = time.monotonic() + 30
        while not (tmp_path / "checkpoint.json").exists():
            assert first.poll() is None, (tmp_path / "original-process.log").read_text()
            assert time.monotonic() < limit, (tmp_path / "original-audit.json").read_text()
            time.sleep(0.05)
        body = (tmp_path / "checkpoint.json").read_bytes()
        saved = decode_checkpoint(body, IDENTITY)
        assert auth_sentinel.encode() not in body
        os.killpg(first.pid, signal.SIGKILL)
        assert first.wait(timeout=10) == -signal.SIGKILL
        original_audit = json.loads((tmp_path / "original-audit.json").read_text())
        assert not any(event["kind"] == "post" for event in original_audit)
        shutil.rmtree(tmp_path / "original-config")
        shutil.copytree(workspace, tmp_path / "workspace-copy")
        shutil.rmtree(workspace)
        shutil.copytree(tmp_path / "workspace-copy", workspace)
        phase[0] = "restored"
        second = start("restored")
        assert second.wait(timeout=35) == 0, (tmp_path / "restored-process.log").read_text()
        audit = json.loads((tmp_path / "restored-audit.json").read_text())
        assert [event["tool_id"] for event in audit if event["kind"] == "pre"] == ["toolu_restored"]
        posts = [event["tool_id"] for event in audit if event["kind"] == "post"]
        assert posts == (["toolu_restored"] if decision == "approve" else [])
        result = next(event for event in audit if event["kind"] == "result")
        assert not result["is_error"] and result["session_id"] == saved["session_id"]
        assert target.read_text() == "OWNED_CONTINUATION_MARKER\n"
        restored_requests = [request for request in requests if request["phase"] == "restored"]
        assert any(
            saved["action"]["tool_use_id"] in json.dumps(r["body"]) for r in restored_requests
        )
        proof = {
            "sdk": "0.2.110",
            "cli": version,
            "decision": decision,
            "session_id": saved["session_id"],
            "original_config_deleted": True,
            "pending_action_acknowledged": True,
            "auth_file_excluded": True,
            "restored_posts": posts,
            "only_synthetic_loopback": True,
        }
        (tmp_path / "verification.json").write_text(json.dumps(proof, indent=2))
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        for log in logs:
            log.close()
        (tmp_path / "model-requests.json").write_text(json.dumps(requests, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--decision", choices=["approve", "deny"], required=True)
    args = parser.parse_args()
    for key in tuple(os.environ):
        if key.startswith(("AWS_", "ANTHROPIC_", "CLAUDE_", "OTEL_", "BEDROCK_")):
            del os.environ[key]
    asyncio.run(
        asyncio.wait_for(_worker(args.directory, args.endpoint, args.worker, args.decision), 110)
    )
