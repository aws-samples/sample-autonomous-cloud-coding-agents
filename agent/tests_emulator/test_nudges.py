# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""``nudge_reader`` against real DynamoDB semantics.

``tests/test_nudge_reader.py`` hands the reader a MagicMock table, which returns
the rows the test scripted whatever the expressions say. Here the service
evaluates them: the filter on ``consumed``, the alias that reserved word needs,
and the condition that lets a nudge be consumed only once.
"""

from __future__ import annotations

import nudge_reader
from progress_writer import _generate_ulid


def _nudge(task_id: str, message: str, *, consumed: bool) -> dict:
    """A nudge row as ``cdk/src/handlers/nudge-task.ts`` writes it."""
    return {
        "task_id": task_id,
        "nudge_id": _generate_ulid(),
        "user_id": "u-alice",
        "message": message,
        "created_at": "2026-05-07T00:00:00.000Z",
        "consumed": consumed,
        "ttl": 1_800_000_000,
    }


class TestNudgeDelivery:
    def test_a_pending_nudge_is_read_and_then_consumed_exactly_once(self, agent_env, task_id):
        table = agent_env.table(agent_env.task_nudges_table)
        pending = _nudge(task_id, "use the v2 endpoint", consumed=False)
        table.put_item(Item=pending)
        table.put_item(Item=_nudge(task_id, "delivered earlier", consumed=True))
        # The rate-limit counter of the same handler shares the table.
        table.put_item(
            Item={
                "task_id": f"RATE#{task_id}",
                "nudge_id": "MINUTE#202605070000",
                "count": 1,
                "ttl": 1_800_000_000,
            }
        )
        key = {"task_id": task_id, "nudge_id": pending["nudge_id"]}

        assert nudge_reader.read_pending(task_id) == [
            {
                "nudge_id": pending["nudge_id"],
                "message": "use the v2 endpoint",
                "created_at": pending["created_at"],
            }
        ]

        first = nudge_reader.mark_consumed(task_id, pending["nudge_id"])
        second = nudge_reader.mark_consumed(task_id, pending["nudge_id"])

        assert (first, second) == (True, False)
        assert nudge_reader.read_pending(task_id) == []
        stored = table.get_item(Key=key, ConsistentRead=True)["Item"]
        assert stored["consumed"] is True
        assert stored["consumed_at"]
