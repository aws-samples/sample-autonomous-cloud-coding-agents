# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Guest durable-state checks; optional DynamoDB Local cases execute conditions."""

from __future__ import annotations

import asyncio
import copy
import os
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

import microvm_checkpoint as checkpoint
from microvm_lifecycle import ApprovalPark, ApprovalRecord, LifecycleUnavailable
from progress_writer import _reset_circuit_breakers


@dataclass
class Deadline:
    remaining: float = 60

    def remaining_s(self) -> float:
        return self.remaining


def make_park() -> ApprovalPark:
    return ApprovalPark(
        task_id="task",
        microvm_id="vm",
        request_id="request",
        tool_use_id="tool",
        deadline=Deadline(),
        record=ApprovalRecord(
            "user", "owner/repo", datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), 60
        ),
    )


def make_rows(park: ApprovalPark) -> tuple[dict, dict]:
    record, deadline_ms = checkpoint._record(park)
    task = {
        "task_id": park.task_id,
        "user_id": record.user_id,
        "repo": record.repo,
        "status": "AWAITING_APPROVAL",
        "compute_type": "lambda-microvm",
        "session_id": park.microvm_id,
        "compute_metadata": {"microvmId": park.microvm_id, "endpoint": "https://synthetic.invalid"},
        "awaiting_approval_request_id": park.request_id,
        "microvm_lifecycle": {
            "version": 1,
            "generation": "suspend-generation",
            "microvm_id": park.microvm_id,
            "request_id": park.request_id,
            "action": "suspend",
            "requested_at_ms": int(datetime.now(UTC).timestamp() * 1000),
            "deadline_ms": deadline_ms,
        },
    }
    approval = {
        "task_id": park.task_id,
        "request_id": park.request_id,
        "user_id": record.user_id,
        "repo": record.repo,
        "created_at": record.created_at,
        "timeout_s": record.timeout_s,
        "status": "PENDING",
    }
    return task, approval


def serialize(item: dict) -> dict:
    return {key: TypeSerializer().serialize(value) for key, value in item.items()}


@pytest.fixture(autouse=True)
def _progress():
    _reset_circuit_breakers()
    yield
    _reset_circuit_breakers()


@pytest.fixture
def state(monkeypatch):
    monkeypatch.setenv("TASK_TABLE_NAME", "tasks")
    monkeypatch.setenv("TASK_APPROVALS_TABLE_NAME", "approvals")
    monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events")
    park = make_park()
    task, approval = make_rows(park)
    client = MagicMock()
    client.get_item.side_effect = lambda **kw: {
        "Item": serialize(task if kw["TableName"] == "tasks" else approval)
    }
    monkeypatch.setattr("aws_session.tenant_client", lambda *_a, **_kw: client)
    monkeypatch.setattr("aws_session.refresh_microvm_credentials", MagicMock())
    return park, task, approval, client


class TestCheckpoint:
    @pytest.mark.parametrize("repo", ["owner/repo", ""])
    def test_retained_request_can_suspend_and_resume_with_explicit_null_deadline(self, state, repo):
        from hooks import _ApprovalDeadline

        original, task, approval, client = state
        assert original.record is not None
        record = replace(original.record, timeout_s=0, repo=repo)
        park = replace(
            original,
            record=record,
            deadline=_ApprovalDeadline.from_recorded(record.created_at, 0),
        )
        new_task, new_approval = make_rows(park)
        task.update(new_task)
        if not repo:
            task.pop("repo")
        approval.update(new_approval)
        checkpoint.checkpoint_before_suspend(park)
        operations = client.transact_write_items.call_args.kwargs["TransactItems"]
        marker = {
            key: TypeDeserializer().deserialize(value)
            for key, value in operations[2]["Put"]["Item"].items()
        }
        assert marker["metadata"]["approval_deadline_ms"] is None
        assert task["microvm_lifecycle"]["deadline_ms"] is None
        task["microvm_lifecycle"].update(action="resume", generation="resume-generation")
        approval["status"] = "APPROVED"
        checkpoint.refresh_and_reconcile_after_resume(park)
        assert park.deadline.remaining_s() == float("inf")
        assert approval["status"] == "APPROVED"
        assert len(client.transact_write_items.call_args.kwargs["TransactItems"]) == 2

    @pytest.mark.parametrize("deadline_value", [0, True, "null", "missing"])
    def test_retained_request_rejects_non_null_or_missing_intent_deadline(
        self, state, deadline_value
    ):
        original, task, approval, client = state
        assert original.record is not None
        park = replace(original, record=replace(original.record, timeout_s=0))
        new_task, new_approval = make_rows(park)
        task.update(new_task)
        approval.update(new_approval)
        if deadline_value == "missing":
            task["microvm_lifecycle"].pop("deadline_ms")
        else:
            task["microvm_lifecycle"]["deadline_ms"] = deadline_value
        with pytest.raises(LifecycleUnavailable, match="intent"):
            checkpoint.checkpoint_before_suspend(park)
        client.transact_write_items.assert_not_called()

    def test_checkpoint_is_an_acknowledged_cross_table_transaction(self, state):
        park, task, approval, client = state
        checkpoint.checkpoint_before_suspend(park)
        assert all(call.kwargs["ConsistentRead"] for call in client.get_item.call_args_list)
        operations = client.transact_write_items.call_args.kwargs["TransactItems"]
        assert len(operations) == 3
        assert [op["ConditionCheck"]["TableName"] for op in operations[:2]] == [
            "tasks",
            "approvals",
        ]
        assert operations[0]["ConditionCheck"]["ExpressionAttributeValues"][":intent"] == (
            TypeSerializer().serialize(task["microvm_lifecycle"])
        )
        assert ":pending" in operations[1]["ConditionCheck"]["ConditionExpression"]
        put = operations[2]["Put"]
        assert put["TableName"] == "events"
        item = {key: TypeDeserializer().deserialize(value) for key, value in put["Item"].items()}
        assert item["task_id"] == park.task_id
        assert item["metadata"]["milestone"] == "microvm_suspend_checkpoint"
        assert item["metadata"]["generation"] == task["microvm_lifecycle"]["generation"]
        assert item["metadata"]["request_id"] == approval["request_id"]
        assert "ClientRequestToken" not in client.transact_write_items.call_args.kwargs
        assert task["status"] == "AWAITING_APPROVAL"
        assert approval["status"] == "PENDING"

    @pytest.mark.parametrize(
        ("row", "field", "value"),
        [
            ("task", "task_id", "other"),
            ("task", "user_id", "other"),
            ("task", "repo", "other/repo"),
            ("task", "status", "CANCELLED"),
            ("task", "compute_type", "agentcore"),
            ("task", "session_id", "other-vm"),
            ("task", "compute_metadata", {"microvmId": "other-vm"}),
            ("task", "awaiting_approval_request_id", "other-request"),
            ("intent", "version", 2),
            ("intent", "version", True),
            ("intent", "generation", ""),
            ("intent", "microvm_id", "other-vm"),
            ("intent", "request_id", "other-request"),
            ("intent", "action", "resume"),
            ("intent", "deadline_ms", 1),
            ("intent", "deadline_ms", None),
            ("intent", "requested_at_ms", -1),
            ("approval", "task_id", "other"),
            ("approval", "request_id", "other-request"),
            ("approval", "user_id", "other"),
            ("approval", "repo", "other/repo"),
            ("approval", "created_at", "2020-01-01T00:00:00Z"),
            ("approval", "timeout_s", 61),
            ("approval", "timeout_s", True),
            ("approval", "status", "APPROVED"),
        ],
    )
    def test_changed_identity_or_deadline_never_writes(self, state, row, field, value):
        park, task, approval, client = state
        target = {"task": task, "approval": approval, "intent": task["microvm_lifecycle"]}[row]
        target[field] = value
        with pytest.raises(LifecycleUnavailable):
            checkpoint.checkpoint_before_suspend(park)
        client.transact_write_items.assert_not_called()

    @pytest.mark.parametrize("stage", ["task", "approval", "write"])
    def test_missing_rows_and_uncertain_write_do_not_acknowledge(self, state, stage):
        park, task, _, client = state
        if stage == "write":
            client.transact_write_items.side_effect = TimeoutError("lost response")
            expected = TimeoutError
        else:
            client.get_item.side_effect = (
                [{}] if stage == "task" else [{"Item": serialize(task)}, {}]
            )
            expected = LifecycleUnavailable
        with pytest.raises(expected):
            checkpoint.checkpoint_before_suspend(park)

    def test_unconfigured_or_disabled_progress_cannot_checkpoint(self, state, monkeypatch):
        from progress_writer import _ProgressWriter

        park, _, _, client = state
        monkeypatch.delenv("TASK_EVENTS_TABLE_NAME")
        with pytest.raises(RuntimeError, match="progress table"):
            checkpoint.checkpoint_before_suspend(park)
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events")
        _ProgressWriter(park.task_id)._disabled = True
        with pytest.raises(RuntimeError, match="progress table"):
            checkpoint.checkpoint_before_suspend(park)
        client.transact_write_items.assert_not_called()

    def test_expired_original_deadline_cannot_suspend(self, state):
        park, _, _, client = state
        assert isinstance(park.deadline, Deadline)
        park.deadline.remaining = 0
        with pytest.raises(LifecycleUnavailable, match="deadline elapsed"):
            checkpoint.checkpoint_before_suspend(park)
        client.transact_write_items.assert_not_called()

    @pytest.mark.parametrize("status", ["PENDING", "APPROVED", "DENIED", "TIMED_OUT", "STRANDED"])
    def test_expired_wake_retains_original_gate_for_existing_decision_loop(
        self, state, status, monkeypatch
    ):
        park, task, approval, client = state
        task["microvm_lifecycle"].update(action="resume", generation="resume-generation")
        approval["status"] = status
        before = copy.deepcopy(approval)
        assert isinstance(park.deadline, Deadline)
        park.deadline.remaining = 0
        original_deadline = park.deadline
        refresh = MagicMock()
        monkeypatch.setattr("aws_session.refresh_microvm_credentials", refresh)
        client.get_item.side_effect = lambda **kw: (
            {"Item": serialize(task if kw["TableName"] == "tasks" else approval)}
            if refresh.called
            else pytest.fail("AWS read occurred before credential refresh")
        )
        checkpoint.refresh_and_reconcile_after_resume(park)
        refresh.assert_called_once_with(park.task_id)
        assert park.deadline is original_deadline
        assert park.deadline.remaining_s() == 0
        assert approval == before
        operations = client.transact_write_items.call_args.kwargs["TransactItems"]
        assert len(operations) == 2
        assert all(set(operation) == {"ConditionCheck"} for operation in operations)
        assert "IN (:pending, :approved" in operations[1]["ConditionCheck"]["ConditionExpression"]

    def test_failed_refresh_prevents_any_aws_reconciliation(self, state, monkeypatch):
        park, _, _, client = state
        monkeypatch.setattr(
            "aws_session.refresh_microvm_credentials", MagicMock(side_effect=RuntimeError("denied"))
        )
        with pytest.raises(RuntimeError, match="denied"):
            checkpoint.refresh_and_reconcile_after_resume(park)
        client.get_item.assert_not_called()
        client.transact_write_items.assert_not_called()


LOCAL_ENDPOINT = os.environ.get("ABCA_DDB_LOCAL_ENDPOINT", "")
if os.environ.get("CI") == "true" and not LOCAL_ENDPOINT:
    raise RuntimeError(
        "CI requires ABCA_DDB_LOCAL_ENDPOINT; checkpoint transaction tests must not skip"
    )


@pytest.fixture
def local_tables(monkeypatch):
    import boto3
    from botocore.config import Config

    # Never let an accidentally set endpoint create tables in an AWS account.
    endpoint = urlsplit(LOCAL_ENDPOINT)
    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1"
    client = boto3.client(
        "dynamodb",
        endpoint_url=LOCAL_ENDPOINT,
        region_name="us-west-2",
        aws_access_key_id="SYNTHETIC",
        aws_secret_access_key="synthetic",
        config=Config(connect_timeout=1, read_timeout=2, retries={"total_max_attempts": 1}),
    )
    names = {}
    try:
        for kind, sort_key, env in [
            ("tasks", None, "TASK_TABLE_NAME"),
            ("approvals", "request_id", "TASK_APPROVALS_TABLE_NAME"),
            ("events", "event_id", "TASK_EVENTS_TABLE_NAME"),
        ]:
            name = f"p3-{kind}-{uuid.uuid4().hex}"
            keys = ["task_id", *([sort_key] if sort_key else [])]
            client.create_table(
                TableName=name,
                KeySchema=[
                    {"AttributeName": key, "KeyType": "HASH" if index == 0 else "RANGE"}
                    for index, key in enumerate(keys)
                ],
                AttributeDefinitions=[{"AttributeName": key, "AttributeType": "S"} for key in keys],
                BillingMode="PAY_PER_REQUEST",
            )
            names[kind] = name
            monkeypatch.setenv(env, name)
        monkeypatch.setattr("aws_session.tenant_client", lambda *_a, **_kw: client)
        monkeypatch.setattr("aws_session.refresh_microvm_credentials", MagicMock())
        yield client, names
    finally:
        for name in names.values():
            client.delete_table(TableName=name)


@pytest.mark.skipif(not LOCAL_ENDPOINT, reason="opt-in DynamoDB Local condition verification")
class TestDynamoLocalCheckpoint:
    @pytest.mark.parametrize("race", [None, "cancel", "approve", "deadline", "intent"])
    def test_real_suspend_transaction_guards_races(self, local_tables, monkeypatch, race):
        client, names = local_tables
        park = make_park()
        task, approval = make_rows(park)
        client.put_item(TableName=names["tasks"], Item=serialize(task))
        client.put_item(TableName=names["approvals"], Item=serialize(approval))
        transact = client.transact_write_items

        def race_then_transact(**kwargs):
            if race == "cancel":
                task["status"] = "CANCELLED"
            elif race == "approve":
                approval["status"] = "APPROVED"
            elif race == "deadline":
                approval["timeout_s"] += 1
            elif race == "intent":
                task["microvm_lifecycle"].update(action="resume", generation="new-generation")
            client.put_item(TableName=names["tasks"], Item=serialize(task))
            client.put_item(TableName=names["approvals"], Item=serialize(approval))
            return transact(**kwargs)

        monkeypatch.setattr(client, "transact_write_items", race_then_transact)
        if race:
            with pytest.raises(ClientError) as error:
                checkpoint.checkpoint_before_suspend(park)
            assert error.value.response["Error"]["Code"] == "TransactionCanceledException"
        else:
            checkpoint.checkpoint_before_suspend(park)
        assert client.scan(TableName=names["events"], ConsistentRead=True)["Count"] == (
            0 if race else 1
        )

    @pytest.mark.parametrize("race", ["approve", "cancel"])
    def test_real_resume_transaction_accepts_decision_but_rejects_cancellation(
        self, local_tables, monkeypatch, race
    ):
        client, names = local_tables
        park = make_park()
        task, approval = make_rows(park)
        task["microvm_lifecycle"].update(action="resume", generation="wake")
        client.put_item(TableName=names["tasks"], Item=serialize(task))
        client.put_item(TableName=names["approvals"], Item=serialize(approval))
        transact = client.transact_write_items

        def race_then_transact(**kwargs):
            if race == "approve":
                approval["status"] = "APPROVED"
                client.put_item(TableName=names["approvals"], Item=serialize(approval))
            else:
                task["status"] = "CANCELLED"
                client.put_item(TableName=names["tasks"], Item=serialize(task))
            return transact(**kwargs)

        monkeypatch.setattr(client, "transact_write_items", race_then_transact)
        if race == "cancel":
            with pytest.raises(ClientError) as error:
                checkpoint.refresh_and_reconcile_after_resume(park)
            assert error.value.response["Error"]["Code"] == "TransactionCanceledException"
        else:
            checkpoint.refresh_and_reconcile_after_resume(park)
        assert client.scan(TableName=names["events"], ConsistentRead=True)["Count"] == 0

    @pytest.mark.parametrize("wake", ["approved", "expired_pending", "cancelled", "changed_intent"])
    def test_http_hooks_use_real_transactions_and_preserve_original_gate(self, local_tables, wake):
        import httpx

        import server
        from microvm_lifecycle import register_task, unregister_task

        client, names = local_tables
        original = make_park()
        task, approval = make_rows(original)
        client.put_item(TableName=names["tasks"], Item=serialize(task))
        client.put_item(TableName=names["approvals"], Item=serialize(approval))
        context = register_task(original.task_id, original.microvm_id)

        async def exercise():
            await context.tool_started(original.tool_use_id)
            park = context.park_approval(
                original.request_id, original.tool_use_id, original.deadline, record=original.record
            )
            assert park is not None
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=server.app), base_url="http://test"
            ) as http:
                prefix = server.MICROVM_HOOK_PREFIX
                for _ in range(2):
                    assert (await http.post(prefix + "/suspend", json={})).status_code == 200
                assert client.scan(TableName=names["events"], ConsistentRead=True)["Count"] == 1
                task["microvm_lifecycle"].update(action="resume", generation="wake")
                if wake == "approved":
                    approval["status"] = "APPROVED"
                elif wake == "expired_pending":
                    assert isinstance(original.deadline, Deadline)
                    original.deadline.remaining = 0
                elif wake == "cancelled":
                    task["status"] = "CANCELLED"
                else:
                    task["microvm_lifecycle"]["request_id"] = "another-gate"
                client.put_item(TableName=names["tasks"], Item=serialize(task))
                client.put_item(TableName=names["approvals"], Item=serialize(approval))

                response = await http.post(prefix + "/resume", json={"microvmId": "vm"})
                if wake in {"cancelled", "changed_intent"}:
                    assert response.status_code == 409
                    with pytest.raises(LifecycleUnavailable):
                        await context.wait_until_open()
                else:
                    assert response.status_code == 200
                    await asyncio.wait_for(context.leave_approval(park), timeout=1)
                    assert park.deadline is original.deadline
                    if wake == "expired_pending":
                        assert park.deadline.remaining_s() == 0
                    assert (await http.post(prefix + "/resume", json={})).status_code == 200
                for kind, expected in [("tasks", task), ("approvals", approval)]:
                    rows = client.scan(TableName=names[kind], ConsistentRead=True)["Items"]
                    assert rows == [serialize(expected)]
                assert client.scan(TableName=names["events"], ConsistentRead=True)["Count"] == 1

        try:
            asyncio.run(exercise())
        finally:
            unregister_task(context)
