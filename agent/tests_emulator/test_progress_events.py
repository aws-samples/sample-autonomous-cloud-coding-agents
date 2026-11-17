# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""``_ProgressWriter`` against a real DynamoDB API (the emulator's).

``tests/test_progress_writer.py`` drives the writer with a MagicMock table and
hand-built ``ClientError``s. Here the same code talks to DynamoDB semantics: the
item has to survive the SDK's type marshalling and the service's validation, and
the errors the circuit breaker classifies are the ones the service really sends.
"""

from __future__ import annotations

import time
from decimal import Decimal

from boto3.dynamodb.conditions import Key

from progress_writer import _TTL_SECONDS, _ProgressWriter


def _events(emulator, task_id: str) -> list[dict]:
    """All events for a task, oldest first.

    Ordered by the microsecond ``timestamp`` rather than by the table's sort key:
    ``event_id`` only orders events to the millisecond, so two written within one
    millisecond can come back from DynamoDB in either order.
    """
    response = emulator.table(emulator.task_events_table).query(
        KeyConditionExpression=Key("task_id").eq(task_id), ConsistentRead=True
    )
    return sorted(response["Items"], key=lambda event: event["timestamp"])


class TestProgressEventsReachDynamoDB:
    def test_typed_events_round_trip_with_the_documented_item_shape(self, agent_env, task_id):
        writer = _ProgressWriter(task_id, user_id="user-1", repo="owner/repo")

        writer.write_agent_milestone("clone_complete", "Repository cloned")
        writer.write_agent_turn(
            turn=1, model="claude", thinking="", text="Reading files", tool_calls_count=2
        )
        writer.write_agent_cost_update(cost_usd=0.1234, input_tokens=10, output_tokens=20, turn=1)
        writer.write_approval_pre_approvals_loaded(count=2, scopes=["tool_type:Bash", "rule:r1"])

        events = _events(agent_env, task_id)
        assert [e["event_type"] for e in events] == [
            "agent_milestone",
            "agent_turn",
            "agent_cost_update",
            "agent_milestone",
        ]
        milestone, turn, cost, approvals = events
        assert milestone["metadata"] == {
            "milestone": "clone_complete",
            "details": "Repository cloned",
        }
        # Empty strings and nested lists are stored as given; numbers come back as
        # DynamoDB numbers (the writer converts floats to Decimal for the SDK).
        assert turn["metadata"]["thinking_preview"] == ""
        assert turn["metadata"]["tool_calls_count"] == 2
        assert cost["metadata"]["cost_usd"] == Decimal("0.1234")
        assert approvals["metadata"]["scopes"] == ["tool_type:Bash", "rule:r1"]
        for event in events:
            assert event["task_id"] == task_id
            assert event["user_id"] == "user-1"
            assert event["repo"] == "owner/repo"
            assert len(event["event_id"]) == 26
            assert abs(int(event["ttl"]) - (time.time() + _TTL_SECONDS)) < 60
        # The sort key's time prefix follows emission order, which is what lets
        # `bgagent watch` page through the table by event_id.
        time_prefixes = [event["event_id"][:10] for event in events]
        assert time_prefixes == sorted(time_prefixes)

    def test_unknown_cost_is_stored_as_null(self, agent_env, task_id):
        _ProgressWriter(task_id).write_agent_cost_update(
            cost_usd=None, input_tokens=1, output_tokens=2, turn=1
        )

        (event,) = _events(agent_env, task_id)
        assert event["metadata"]["cost_usd"] is None
        assert "user_id" not in event
        assert "repo" not in event

    def test_runner_and_pipeline_writers_share_one_stream(self, agent_env, task_id):
        runner_writer = _ProgressWriter(task_id)
        pipeline_writer = _ProgressWriter(task_id, trace=True)

        runner_writer.write_agent_tool_call("Bash", "ls", turn=1)
        pipeline_writer.write_agent_milestone("pr_created", "x" * 5000)

        tool_call, milestone = _events(agent_env, task_id)
        assert tool_call["metadata"]["tool_name"] == "Bash"
        # trace=True raises the preview cap from 200 chars to 4 KB.
        assert milestone["metadata"]["details"] == "x" * 4096 + "..."


class TestProgressWriterOnRealServiceErrors:
    def test_item_over_400kb_is_dropped_without_tripping_the_breaker(
        self, agent_env, task_id, capsys
    ):
        writer = _ProgressWriter(task_id)

        writer.write_approval_pre_approvals_loaded(count=500, scopes=["s" * 1000] * 500)
        writer.write_agent_milestone("after_oversized", "still alive")

        assert "dropped event due to permanent DDB error" in capsys.readouterr().out
        assert writer._disabled is False
        assert writer._failure_count == 0
        assert [e["metadata"]["milestone"] for e in _events(agent_env, task_id)] == [
            "after_oversized"
        ]

    def test_missing_table_opens_the_breaker_on_the_first_write(
        self, agent_env, task_id, monkeypatch, capsys
    ):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", f"{agent_env.task_events_table}-absent")
        writer = _ProgressWriter(task_id)

        writer.write_agent_milestone("first", "")
        writer.write_agent_milestone("second", "")

        # One line for the first write; the second never reaches DynamoDB.
        out = capsys.readouterr().out
        assert out.count("disabling progress writer") == 1
        assert "ResourceNotFoundException" in out
        assert writer._disabled is True
        assert _ProgressWriter(task_id)._disabled is True
