# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The ``--trace`` round trip across all three languages' halves (issue #61).

    agent (Python)       writes the gzipped JSONL trace to S3 and records its
                         URI on the task                      telemetry / pipeline / task_state
    API handler (TS)     checks ownership, HEADs the object, presigns a GET
                                                              cdk/src/handlers/get-trace-url.ts
    CLI (TS)             asks the API, downloads through the URL, gunzips
                                                              cli/src/commands/trace.ts

``test_trace_key_contract.py`` pins the key shape by reading the TypeScript as
text. Here the three halves run for real against one emulator: the Python side in
this process, the TypeScript sides in Node from source (``tsx``, a dev dependency
of ``@abca/cdk``). The only stand-ins are for what sits between them in a
deployment: ``cdk/test/emulator/trace-api-shim.ts`` for API Gateway and its
Cognito authorizer (so the CLI runs in API-key mode and its login path is not
exercised), and a ``put_item`` for the task record the orchestrator would have
created.
"""

from __future__ import annotations

import gzip
import json
import os
import subprocess
import threading
from pathlib import Path

import pytest
import requests

import task_state
from models import TaskConfig
from pipeline import _maybe_upload_trace
from progress_writer import _ProgressWriter
from telemetry import _TrajectoryWriter

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TSX = _REPO_ROOT / "node_modules" / ".bin" / "tsx"
_API_SHIM = _REPO_ROOT / "cdk" / "test" / "emulator" / "trace-api-shim.ts"
_CLI = _REPO_ROOT / "cli" / "src" / "bin" / "bgagent.ts"


@pytest.fixture(scope="module")
def trace_api(emulator):
    """Base URL of the real get-trace-url handler, served over HTTP for this module."""
    if not _TSX.exists():
        pytest.fail("Node dependencies are not installed (run `mise run install`)", pytrace=False)
    env = {
        **os.environ,
        "AWS_REGION": emulator.region,
        "NODE_EXTRA_CA_CERTS": emulator.ca_bundle,
        "TASK_TABLE_NAME": emulator.task_table,
        "TRACE_ARTIFACTS_BUCKET_NAME": emulator.trace_bucket,
    }
    shim = subprocess.Popen([_TSX, _API_SHIM], env=env, stdout=subprocess.PIPE, text=True)
    assert shim.stdout is not None
    first_line = shim.stdout.readline()
    try:
        port = json.loads(first_line)["port"]
    except (ValueError, KeyError, TypeError):
        shim.kill()
        shim.wait(timeout=30)
        shim.stdout.close()
        pytest.fail(f"trace API shim did not start: {first_line!r}")
    # The handler logs to stdout; keep reading so a full pipe can never stall it.
    drain = threading.Thread(target=shim.stdout.read, daemon=True)
    drain.start()

    yield f"http://127.0.0.1:{port}"

    shim.terminate()
    shim.wait(timeout=30)
    drain.join(timeout=30)
    shim.stdout.close()


@pytest.fixture
def bgagent(trace_api, emulator, tmp_path):
    """Run the real CLI as ``user`` against the handler; returns the finished process."""
    config_dir = tmp_path / "bgagent-config"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(json.dumps({"api_url": trace_api}))

    def _run(user: str, *args: str) -> subprocess.CompletedProcess[bytes]:
        env = {
            **os.environ,
            "BGAGENT_CONFIG_DIR": str(config_dir),
            # API-key mode skips the Cognito login; the shim reads it as the caller.
            "BGAGENT_API_KEY": user,
            "NODE_EXTRA_CA_CERTS": emulator.ca_bundle,
        }
        return subprocess.run(
            [_TSX, _CLI, *args], env=env, capture_output=True, timeout=90, check=False
        )

    return _run


@pytest.fixture
def traced_task(agent_env, task_id, user_id) -> bytes:
    """A finished ``--trace`` task, written by the agent's own code. Returns the artifact."""
    agent_env.table(agent_env.task_table).put_item(
        Item={"task_id": task_id, "user_id": user_id, "status": "RUNNING"}
    )
    trajectory = _TrajectoryWriter(task_id, accumulate=True)
    trajectory.write_turn(
        turn=1,
        model="claude",
        thinking="plan",
        text="Reading the repo — ünïcödé",
        tool_calls=[{"name": "Bash", "input": {"command": "ls"}}],
        tool_results=[{"tool_use_id": "t1", "content": "README.md\n" * 200, "is_error": False}],
    )
    trajectory.write_policy_decision("Bash", allowed=True, reason="permit", duration_ms=1.5)
    artifact = trajectory.dump_gzipped_jsonl()
    assert artifact is not None

    config = TaskConfig(
        repo_url="owner/repo",
        aws_region=agent_env.region,
        task_id=task_id,
        task_description="Do a thing",
        user_id=user_id,
        trace=True,
    )
    uri = _maybe_upload_trace(config, trajectory, _ProgressWriter(task_id, trace=True))
    task_state.write_terminal(task_id, "COMPLETED", {"trace_s3_uri": uri})
    return artifact


def _trace_url(api: str, task_id: str, caller: str) -> requests.Response:
    return requests.get(f"{api}/tasks/{task_id}/trace", headers={"X-API-Key": caller}, timeout=30)


class TestTraceRoundTrip:
    def test_cli_prints_the_jsonl_the_agent_wrote(self, traced_task, bgagent, task_id, user_id):
        result = bgagent(user_id, "trace", "download", task_id)

        assert result.returncode == 0, result.stderr.decode()
        assert result.stdout == gzip.decompress(traced_task)
        header, *events = [json.loads(line) for line in result.stdout.splitlines()]
        assert header["event"] == "TRAJECTORY_ARTIFACT_HEADER"
        assert [e["event"] for e in events] == ["TRAJECTORY_TURN", "POLICY_DECISION"]

    def test_cli_output_file_is_the_stored_artifact_byte_for_byte(
        self, traced_task, bgagent, task_id, user_id, tmp_path
    ):
        target = tmp_path / "trace.jsonl.gz"

        result = bgagent(user_id, "trace", "download", task_id, "-o", str(target))

        assert result.returncode == 0, result.stderr.decode()
        assert target.read_bytes() == traced_task

    def test_presigned_url_works_for_any_https_client_that_trusts_the_emulator(
        self, traced_task, trace_api, emulator, task_id, user_id
    ):
        issued = _trace_url(trace_api, task_id, user_id)
        assert issued.status_code == 200, issued.text

        download = requests.get(issued.json()["data"]["url"], verify=emulator.ca_bundle, timeout=30)

        assert download.status_code == 200
        assert download.content == traced_task
        assert download.headers["Content-Type"] == "application/gzip"
        assert "Content-Encoding" not in download.headers


class TestTraceUrlIsRefused:
    def test_for_a_caller_who_does_not_own_the_task(self, traced_task, trace_api, task_id):
        response = _trace_url(trace_api, task_id, "someone-else")

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"
        # The key-prefix guard further down answers with the same status and code;
        # the message is what shows that the record-ownership check refused this.
        assert response.json()["error"]["message"] == "You do not have access to this task."

    def test_until_the_agent_has_recorded_a_trace(
        self, agent_env, bgagent, trace_api, task_id, user_id
    ):
        agent_env.table(agent_env.task_table).put_item(
            Item={"task_id": task_id, "user_id": user_id, "status": "RUNNING"}
        )

        response = _trace_url(trace_api, task_id, user_id)
        result = bgagent(user_id, "trace", "download", task_id)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "TRACE_NOT_AVAILABLE"
        assert result.returncode != 0
        assert f"No trace artifact for task {task_id}" in result.stderr.decode()

    def test_when_the_recorded_object_is_gone_from_s3(
        self, traced_task, trace_api, emulator, task_id, user_id
    ):
        emulator.client("s3").delete_object(
            Bucket=emulator.trace_bucket, Key=f"traces/{user_id}/{task_id}.jsonl.gz"
        )

        response = _trace_url(trace_api, task_id, user_id)

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "TRACE_NOT_AVAILABLE"
