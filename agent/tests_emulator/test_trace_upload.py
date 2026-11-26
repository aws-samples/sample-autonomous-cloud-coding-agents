# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import gzip
import json

from boto3.dynamodb.conditions import Key

from models import TaskConfig
from pipeline import _maybe_upload_trace
from progress_writer import _ProgressWriter
from telemetry import _TrajectoryWriter, upload_trace_to_s3


def _task_config(task_id: str, user_id: str, *, trace: bool) -> TaskConfig:
    return TaskConfig(
        repo_url="owner/repo",
        aws_region="us-east-1",
        task_id=task_id,
        task_description="Do a thing",
        user_id=user_id,
        trace=trace,
    )


def _recorded_trajectory(task_id: str) -> _TrajectoryWriter:
    trajectory = _TrajectoryWriter(task_id, accumulate=True)
    trajectory.write_turn(
        turn=1,
        model="claude",
        thinking="plan",
        text="Reading the repo — ünïcödé",
        tool_calls=[{"name": "Bash", "input": {"command": "ls"}}],
        tool_results=[{"tool_use_id": "t1", "content": "README.md", "is_error": False}],
    )
    trajectory.write_policy_decision("Bash", allowed=True, reason="permit", duration_ms=1.5)
    trajectory.write_result(
        subtype="success",
        num_turns=1,
        cost_usd=0.01,
        duration_ms=1200,
        duration_api_ms=900,
        session_id="session-1",
        usage=None,
    )
    return trajectory


def _artifact(trajectory: _TrajectoryWriter) -> bytes:
    artifact = trajectory.dump_gzipped_jsonl()
    assert artifact is not None
    return artifact


def _stored_trace(emulator, user_id: str, task_id: str) -> dict:
    return emulator.client("s3").get_object(
        Bucket=emulator.trace_bucket, Key=f"traces/{user_id}/{task_id}.jsonl.gz"
    )


class TestTraceUploadReachesS3:
    def test_artifact_is_stored_byte_for_byte_under_the_callers_prefix(
        self, agent_env, task_id, user_id
    ):
        artifact = _artifact(_recorded_trajectory(task_id))

        uri = upload_trace_to_s3(task_id=task_id, user_id=user_id, body=artifact)

        assert uri == f"s3://{agent_env.trace_bucket}/traces/{user_id}/{task_id}.jsonl.gz"
        stored = _stored_trace(agent_env, user_id, task_id)
        assert stored["Body"].read() == artifact
        # An HTTP client that received the object with
        # Content-Encoding: gzip would decompress it behind the CLI's back.
        assert stored["ContentType"] == "application/gzip"
        assert "ContentEncoding" not in stored

    def test_stored_artifact_is_header_plus_events_as_jsonl(self, agent_env, task_id, user_id):
        artifact = _artifact(_recorded_trajectory(task_id))
        upload_trace_to_s3(task_id=task_id, user_id=user_id, body=artifact)

        body = _stored_trace(agent_env, user_id, task_id)["Body"].read()
        header, *events = [json.loads(line) for line in gzip.decompress(body).splitlines()]
        assert header["event"] == "TRAJECTORY_ARTIFACT_HEADER"
        assert header["task_id"] == task_id
        assert header["accumulated_events"] == 3
        assert [e["event"] for e in events] == [
            "TRAJECTORY_TURN",
            "POLICY_DECISION",
            "TRAJECTORY_RESULT",
        ]
        assert events[0]["text"] == "Reading the repo — ünïcödé"

    def test_missing_bucket_fails_open(self, agent_env, task_id, user_id, monkeypatch, capsys):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", f"{agent_env.trace_bucket}-absent")

        uri = upload_trace_to_s3(task_id=task_id, user_id=user_id, body=b"\x1f\x8b")

        assert uri is None
        assert "S3 put_object failed: NoSuchBucket" in capsys.readouterr().out


class TestPipelineTraceUpload:
    def test_upload_announces_the_artifact_on_the_event_stream(self, agent_env, task_id, user_id):
        config = _task_config(task_id, user_id, trace=True)
        progress = _ProgressWriter(task_id, trace=True, user_id=user_id, repo=config.repo_url)

        uri = _maybe_upload_trace(config, _recorded_trajectory(task_id), progress)

        assert uri == f"s3://{agent_env.trace_bucket}/traces/{user_id}/{task_id}.jsonl.gz"
        (event,) = agent_env.table(agent_env.task_events_table).query(
            KeyConditionExpression=Key("task_id").eq(task_id), ConsistentRead=True
        )["Items"]
        assert event["metadata"] == {"milestone": "trajectory_uploaded", "details": uri}

    def test_task_without_trace_uploads_nothing(self, agent_env, task_id, user_id):
        config = _task_config(task_id, user_id, trace=False)

        uri = _maybe_upload_trace(config, _recorded_trajectory(task_id), _ProgressWriter(task_id))

        assert uri is None
        listing = agent_env.client("s3").list_objects_v2(
            Bucket=agent_env.trace_bucket, Prefix=f"traces/{user_id}/"
        )
        assert listing["KeyCount"] == 0
