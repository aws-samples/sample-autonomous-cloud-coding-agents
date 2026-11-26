# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import json
import threading

import pytest

from shell import log_error_cw
from telemetry import _TrajectoryWriter, print_metrics


@pytest.fixture
def log_group(agent_env, monkeypatch) -> str:
    monkeypatch.setenv("LOG_GROUP_NAME", agent_env.log_group)
    return agent_env.log_group


def _messages(emulator, stream: str) -> list[str]:
    events = emulator.client("logs").get_log_events(
        logGroupName=emulator.log_group, logStreamName=stream, startFromHead=True
    )["events"]
    return [event["message"] for event in events]


class TestTrajectoryStream:
    def test_turns_and_decisions_are_written_in_order(self, emulator, log_group, task_id):
        writer = _TrajectoryWriter(task_id)

        writer.write_turn(
            turn=1, model="claude", thinking="", text="hi", tool_calls=[], tool_results=[]
        )
        writer.write_policy_decision("Bash", allowed=False, reason="hard deny", duration_ms=0.4)

        turn, decision = (json.loads(m) for m in _messages(emulator, f"trajectory/{task_id}"))
        assert (turn["event"], turn["task_id"], turn["turn"]) == ("TRAJECTORY_TURN", task_id, 1)
        assert decision == {
            "event": "POLICY_DECISION",
            "task_id": task_id,
            "tool_name": "Bash",
            "allowed": False,
            "reason": "hard deny",
            "duration_ms": 0.4,
        }

    def test_second_writer_for_a_task_appends_to_the_existing_stream(
        self, emulator, log_group, task_id
    ):
        _TrajectoryWriter(task_id).write_policy_decision("Read", True, "permit", 0.1)
        second = _TrajectoryWriter(task_id)

        second.write_policy_decision("Edit", True, "permit", 0.1)

        assert second._failure_count == 0
        tools = [json.loads(m)["tool_name"] for m in _messages(emulator, f"trajectory/{task_id}")]
        assert tools == ["Read", "Edit"]

    def test_missing_log_group_disables_cloudwatch_but_not_the_trace_accumulator(
        self, agent_env, task_id, monkeypatch, capsys
    ):
        monkeypatch.setenv("LOG_GROUP_NAME", f"{agent_env.log_group}-absent")
        writer = _TrajectoryWriter(task_id, accumulate=True)

        for _ in range(4):
            writer.write_policy_decision("Bash", True, "permit", 0.1)

        assert writer._disabled is True
        assert writer._failure_count == writer._MAX_FAILURES
        assert "ResourceNotFoundException" in capsys.readouterr().out
        assert len(writer._events) == 4

    def test_stream_is_created_once_the_log_group_exists(
        self, emulator, agent_env, task_id, monkeypatch
    ):
        group = f"{agent_env.log_group}-late"
        monkeypatch.setenv("LOG_GROUP_NAME", group)
        logs = emulator.client("logs")
        writer = _TrajectoryWriter(task_id)

        writer.write_policy_decision("Read", True, "permit", 0.1)
        logs.create_log_group(logGroupName=group)
        try:
            writer.write_policy_decision("Edit", True, "permit", 0.1)
            streams = logs.describe_log_streams(logGroupName=group)["logStreams"]
            events = [
                event
                for stream in streams
                for event in logs.get_log_events(
                    logGroupName=group,
                    logStreamName=stream["logStreamName"],
                    startFromHead=True,
                )["events"]
            ]
        finally:
            logs.delete_log_group(logGroupName=group)

        assert [s["logStreamName"] for s in streams] == [f"trajectory/{task_id}"]
        assert [json.loads(e["message"])["tool_name"] for e in events] == ["Edit"]
        assert (writer._failure_count, writer._disabled) == (1, False)


class TestMetricsAndErrorStreams:
    def test_metrics_report_is_written_with_native_types(self, emulator, log_group, task_id):
        print_metrics(
            {"task_id": task_id, "status": "success", "turns": 3, "cost_usd": 0.25, "error": None}
        )

        (report,) = _messages(emulator, f"metrics/{task_id}")
        assert json.loads(report) == {
            "event": "METRICS_REPORT",
            "task_id": task_id,
            "status": "success",
            "turns": 3,
            "cost_usd": 0.25,
            "error": None,
        }

    def test_fatal_error_is_mirrored_to_the_application_log_group(
        self, emulator, log_group, task_id
    ):
        log_error_cw("Agent failed: missing built-in hard-deny policies", task_id=task_id)
        for thread in threading.enumerate():
            if thread.name == "agent-error-cw-write":
                thread.join(timeout=30)

        assert _messages(emulator, f"agent_error/{task_id}") == [
            "[agent/error] Agent failed: missing built-in hard-deny policies"
        ]
