# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The approval-gate writes in ``task_state.py`` against real DynamoDB semantics.

``tests/test_task_state.py`` hands these functions a MagicMock client, because (as
``_get_ddb_client`` notes) moto did not fully emulate ``TransactWriteItems`` with
conditions across two tables. Here the transactions run: the conditions are
evaluated by the service, a cancelled transaction really leaves nothing behind,
and the cancellation reasons are the ones the SDK reports.
"""

from __future__ import annotations

import pytest

import task_state
from progress_writer import _generate_ulid

from .conftest import approval_row


def _task(task_id: str) -> dict:
    record = task_state.get_task(task_id)
    assert record is not None
    return record


@pytest.fixture
def running_task(agent_env, task_id) -> str:
    """A task the orchestrator created and the agent already marked RUNNING."""
    agent_env.table(agent_env.task_table).put_item(Item={"task_id": task_id, "status": "RUNNING"})
    return task_id


@pytest.fixture
def pending_request(running_task) -> str:
    """An approval the agent is waiting on for ``running_task``."""
    request_id = _generate_ulid()
    task_state.transact_write_approval_request(
        running_task, request_id, approval_row(running_task, request_id)
    )
    return request_id


class TestApprovalRequest:
    def test_pending_row_and_awaiting_status_are_written_together(self, running_task):
        request_id = _generate_ulid()
        row = approval_row(running_task, request_id)

        task_state.transact_write_approval_request(running_task, request_id, row)

        assert task_state.get_approval_row(running_task, request_id) == row
        task = _task(running_task)
        assert task["status"] == "AWAITING_APPROVAL"
        assert task["awaiting_approval_request_id"] == request_id
        # The stranded-approval sweep ages the task from this timestamp.
        assert task["status_created_at"].startswith("AWAITING_APPROVAL#")
        # updated_at moves with the status, to the same moment.
        assert task["status_created_at"] == "AWAITING_APPROVAL#" + task["updated_at"]

    def test_cancelled_task_gets_no_approval_row(self, agent_env, running_task):
        agent_env.table(agent_env.task_table).put_item(
            Item={"task_id": running_task, "status": "CANCELLED"}
        )
        request_id = _generate_ulid()

        with pytest.raises(task_state.ApprovalWriteError) as raised:
            task_state.transact_write_approval_request(
                running_task, request_id, approval_row(running_task, request_id)
            )

        # The Put passed its own condition and was still undone with the Update.
        codes = [reason["Code"] for reason in raised.value.cancellation_reasons]
        assert codes == ["None", "ConditionalCheckFailed"]
        assert task_state.get_approval_row(running_task, request_id) is None
        assert _task(running_task)["status"] == "CANCELLED"

    def test_same_request_cannot_be_recorded_twice(self, running_task, pending_request):
        with pytest.raises(task_state.ApprovalWriteError) as raised:
            task_state.transact_write_approval_request(
                running_task, pending_request, approval_row(running_task, pending_request)
            )

        codes = [reason["Code"] for reason in raised.value.cancellation_reasons]
        assert codes == ["ConditionalCheckFailed", "ConditionalCheckFailed"]


class TestResumeAndTimeout:
    def test_resume_returns_the_task_to_running(self, running_task, pending_request):
        task_state.transact_resume_from_approval(running_task, pending_request)

        task = _task(running_task)
        assert task["status"] == "RUNNING"
        assert "awaiting_approval_request_id" not in task
        assert task["status_created_at"].startswith("RUNNING#")

    def test_resume_for_a_different_request_is_refused(self, running_task, pending_request):
        with pytest.raises(task_state.ApprovalResumeError):
            task_state.transact_resume_from_approval(running_task, _generate_ulid())

        assert _task(running_task)["status"] == "AWAITING_APPROVAL"

    def test_timeout_only_wins_while_the_request_is_still_pending(
        self, running_task, pending_request
    ):
        timed_out = task_state.best_effort_update_approval_status(
            running_task, pending_request, "TIMED_OUT"
        )
        late_denial = task_state.best_effort_update_approval_status(
            running_task, pending_request, "DENIED", reason="too late"
        )

        assert (timed_out, late_denial) == (True, False)
        row = task_state.get_approval_row(running_task, pending_request)
        assert row is not None
        assert row["status"] == "TIMED_OUT"
        assert "deny_reason" not in row

    def test_gate_counter_is_created_then_incremented(self, running_task):
        assert task_state.increment_approval_gate_count_in_ddb(running_task) is True
        assert task_state.increment_approval_gate_count_in_ddb(running_task) is True

        assert _task(running_task)["approval_gate_count"] == 2
