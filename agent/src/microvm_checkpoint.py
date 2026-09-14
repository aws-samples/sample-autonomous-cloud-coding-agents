# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Durable guest pause checks; the coordinator retains lifecycle intent ownership."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal

from microvm_lifecycle import ApprovalPark, LifecycleUnavailable
from progress_writer import _ProgressWriter

if TYPE_CHECKING:
    from microvm_lifecycle import ApprovalRecord


def _integer(value: Any) -> bool:
    return (
        isinstance(value, (int, Decimal))
        and not isinstance(value, bool)
        and value == int(value)
        and 0 <= value <= 2**53 - 1
    )


def _record(park: ApprovalPark) -> tuple[ApprovalRecord, int]:
    record = park.record
    if (
        record is None
        or not record.user_id
        or not isinstance(record.repo, str)
        or not _integer(record.timeout_s)
        or record.timeout_s <= 0
    ):
        raise LifecycleUnavailable("Original approval identity is unavailable")
    try:
        created = datetime.strptime(record.created_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except (TypeError, ValueError) as exc:
        raise LifecycleUnavailable("Original approval timestamp is invalid") from exc
    if created.strftime("%Y-%m-%dT%H:%M:%SZ") != record.created_at:
        raise LifecycleUnavailable("Original approval timestamp is not canonical")
    return record, int(created.timestamp() * 1000) + record.timeout_s * 1000


def _read(
    park: ApprovalPark, action: Literal["suspend", "resume"]
) -> tuple[Any, str, str, dict, int]:
    """Read current task/gate identity strongly; absence and mismatch fail closed."""
    from boto3.dynamodb.types import TypeDeserializer
    from botocore.config import Config

    from aws_session import tenant_client

    record, deadline_ms = _record(park)
    task_table = os.environ.get("TASK_TABLE_NAME", "").strip()
    approvals_table = os.environ.get("TASK_APPROVALS_TABLE_NAME", "").strip()
    if not task_table or not approvals_table:
        raise RuntimeError("Lifecycle task/approval tables are unavailable")
    client = tenant_client(
        "dynamodb",
        region_name=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
        config=Config(connect_timeout=2, read_timeout=2, retries={"total_max_attempts": 1}),
    )
    deserialize = TypeDeserializer().deserialize

    def read_item(table: str, key: dict) -> dict:
        item = client.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item")
        if not isinstance(item, dict):
            raise LifecycleUnavailable("Lifecycle task or approval is missing")
        return {key: deserialize(value) for key, value in item.items()}

    task = read_item(task_table, {"task_id": {"S": park.task_id}})
    metadata = task.get("compute_metadata")
    intent = task.get("microvm_lifecycle")
    if (
        task.get("task_id") != park.task_id
        or task.get("user_id") != record.user_id
        or task.get("repo", "") != record.repo
        or task.get("compute_type") != "lambda-microvm"
        or task.get("session_id") != park.microvm_id
        or not isinstance(metadata, dict)
        or metadata.get("microvmId") != park.microvm_id
        or task.get("status") != "AWAITING_APPROVAL"
        or task.get("awaiting_approval_request_id") != park.request_id
    ):
        raise LifecycleUnavailable("Lifecycle task identity or approval state changed")
    if (
        not isinstance(intent, dict)
        or not _integer(intent.get("version"))
        or intent["version"] != 1
        or not isinstance(intent.get("generation"), str)
        or not intent["generation"].strip()
        or intent.get("microvm_id") != park.microvm_id
        or intent.get("request_id") != park.request_id
        or intent.get("action") != action
        or not _integer(intent.get("requested_at_ms"))
        or not _integer(intent.get("deadline_ms"))
        or intent["deadline_ms"] != deadline_ms
    ):
        raise LifecycleUnavailable("Coordinator lifecycle intent does not match this approval")

    approval = read_item(
        approvals_table,
        {"task_id": {"S": park.task_id}, "request_id": {"S": park.request_id}},
    )
    statuses = (
        {"PENDING"}
        if action == "suspend"
        else {"PENDING", "APPROVED", "DENIED", "TIMED_OUT", "STRANDED"}
    )
    if (
        approval.get("task_id") != park.task_id
        or approval.get("request_id") != park.request_id
        or approval.get("user_id") != record.user_id
        or approval.get("repo") != record.repo
        or approval.get("created_at") != record.created_at
        or not _integer(approval.get("timeout_s"))
        or approval["timeout_s"] != record.timeout_s
        or approval.get("status") not in statuses
    ):
        raise LifecycleUnavailable("Original approval changed or cannot be reconciled")
    return client, task_table, approvals_table, intent, deadline_ms


def _transaction_checks(
    park: ApprovalPark, task_table: str, approvals_table: str, intent: dict
) -> list[dict]:
    """Recheck both rows atomically after validating their complete read shapes."""
    from boto3.dynamodb.types import TypeSerializer

    record, _ = _record(park)
    serialize = TypeSerializer().serialize
    values = {
        ":task": park.task_id,
        ":user": record.user_id,
        ":repo": record.repo,
        ":vm": park.microvm_id,
        ":request": park.request_id,
        ":awaiting": "AWAITING_APPROVAL",
        ":backend": "lambda-microvm",
        ":intent": intent,
    }
    task_check = {
        "TableName": task_table,
        "Key": {"task_id": {"S": park.task_id}},
        "ConditionExpression": (
            "task_id = :task AND user_id = :user AND "
            + (
                "(attribute_not_exists(repo) OR repo = :repo)"
                if not record.repo
                else "repo = :repo"
            )
            + " AND compute_type = :backend AND session_id = :vm"
            " AND compute_metadata.microvmId = :vm AND #status = :awaiting"
            " AND awaiting_approval_request_id = :request AND microvm_lifecycle = :intent"
        ),
        "ExpressionAttributeNames": {"#status": "status"},
        "ExpressionAttributeValues": {key: serialize(value) for key, value in values.items()},
    }
    approval_check = {
        "TableName": approvals_table,
        "Key": {"task_id": {"S": park.task_id}, "request_id": {"S": park.request_id}},
        "ConditionExpression": (
            "task_id = :task AND request_id = :request AND user_id = :user AND repo = :repo"
            " AND created_at = :created AND timeout_s = :timeout AND "
            + (
                "#status = :pending"
                if intent["action"] == "suspend"
                else "#status IN (:pending, :approved, :denied, :timed_out, :stranded)"
            )
        ),
        "ExpressionAttributeNames": {"#status": "status"},
        "ExpressionAttributeValues": {
            key: serialize(value)
            for key, value in {
                ":task": park.task_id,
                ":request": park.request_id,
                ":user": record.user_id,
                ":repo": record.repo,
                ":created": record.created_at,
                ":timeout": record.timeout_s,
                ":pending": "PENDING",
                **(
                    {
                        ":approved": "APPROVED",
                        ":denied": "DENIED",
                        ":timed_out": "TIMED_OUT",
                        ":stranded": "STRANDED",
                    }
                    if intent["action"] == "resume"
                    else {}
                ),
            }.items()
        },
    }
    return [task_check, approval_check]


def checkpoint_before_suspend(park: ApprovalPark) -> None:
    """Commit a marker only if the same task, sleep intent and pending gate hold."""
    record, _ = _record(park)
    client, task_table, approvals_table, intent, deadline_ms = _read(park, "suspend")
    if park.deadline.remaining_s() <= 0:
        raise LifecycleUnavailable("Approval deadline elapsed before checkpoint")
    # Never reuse an old transaction client token across HTTP requests: cached
    # success must not bypass conditions after a concurrent approval/cancellation.
    _ProgressWriter(
        park.task_id, user_id=record.user_id, repo=record.repo
    ).write_microvm_checkpoint(
        client=client,
        condition_checks=_transaction_checks(park, task_table, approvals_table, intent),
        metadata={
            "request_id": park.request_id,
            "microvm_id": park.microvm_id,
            "generation": intent["generation"],
            "approval_deadline_ms": deadline_ms,
        },
    )


def refresh_and_reconcile_after_resume(park: ApprovalPark) -> None:
    """Refresh before reading AWS; the original approval loop owns any decision."""
    from aws_session import refresh_microvm_credentials

    _record(park)
    refresh_microvm_credentials(park.task_id)
    client, task_table, approvals_table, intent, _ = _read(park, "resume")
    # This transaction writes no task/approval state. It acknowledges that both
    # identities still hold, including cancellation or intent changes after reads.
    # A concurrent valid decision is allowed; the original loop observes it.
    client.transact_write_items(
        TransactItems=[
            {"ConditionCheck": check}
            for check in _transaction_checks(park, task_table, approvals_table, intent)
        ]
    )
    # The existing approval loop checks its original stopwatch/UTC cap as soon
    # as the barrier opens. Expiry enters its timeout/late-decision path; a timely
    # approval already recorded must still win that conditional race.
