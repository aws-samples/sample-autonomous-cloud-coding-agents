# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""For a role created in the emulator, DynamoDB and S3 evaluate the role's
identity policy, including ``dynamodb:LeadingKeys`` and
``${aws:PrincipalTag/...}``. AWS states that this evaluation is not the same as
the real one.
"""

from __future__ import annotations

import json
import uuid

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import task_state
from aws_session import SessionScopingError, configure_session, is_scoped, tenant_client
from progress_writer import _generate_ulid, _ProgressWriter
from telemetry import upload_trace_to_s3

from .conftest import EMULATOR_ACCOUNT_ID, approval_row

_ASSUMABLE_BY_ACCOUNT = {"AWS": f"arn:aws:iam::{EMULATOR_ACCOUNT_ID}:root"}

_DDB_ITEM_ACTIONS = [
    "dynamodb:GetItem",
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:ConditionCheckItem",
]


def _trust_policy(actions: list[str]) -> str:
    statement = {"Effect": "Allow", "Principal": _ASSUMABLE_BY_ACCOUNT, "Action": actions}
    return json.dumps({"Version": "2012-10-17", "Statement": [statement]})


def _session_role_policy(emulator) -> str:
    table_arn = f"arn:aws:dynamodb:{emulator.region}:{EMULATOR_ACCOUNT_ID}:table"
    bucket_arn = f"arn:aws:s3:::{emulator.trace_bucket}"
    statements = [
        {
            "Effect": "Allow",
            "Action": _DDB_ITEM_ACTIONS,
            "Resource": f"{table_arn}/{table}",
            "Condition": {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["${aws:PrincipalTag/task_id}"]
                }
            },
        }
        for table in (
            emulator.task_table,
            emulator.task_events_table,
            emulator.task_approvals_table,
        )
    ]
    statements += [
        {
            "Effect": "Allow",
            "Action": "s3:PutObject",
            "Resource": f"{bucket_arn}/{prefix}/${{aws:PrincipalTag/{tag}}}/*",
        }
        for prefix, tag in (("traces", "user_id"), ("artifacts", "task_id"))
    ]
    return json.dumps({"Version": "2012-10-17", "Statement": statements})


@pytest.fixture(scope="module")
def roles(emulator):
    """A SessionRole like the deployed one, and one whose trust omits TagSession."""
    iam = emulator.client("iam")
    suffix = uuid.uuid4().hex[:8]
    session_role = f"abca-emu-{suffix}-SessionRole"
    untaggable_role = f"abca-emu-{suffix}-NoTagSession"

    arns = {
        "session": iam.create_role(
            RoleName=session_role,
            AssumeRolePolicyDocument=_trust_policy(["sts:AssumeRole", "sts:TagSession"]),
        )["Role"]["Arn"],
        "untaggable": iam.create_role(
            RoleName=untaggable_role,
            AssumeRolePolicyDocument=_trust_policy(["sts:AssumeRole"]),
        )["Role"]["Arn"],
        "absent": f"arn:aws:iam::{EMULATOR_ACCOUNT_ID}:role/abca-emu-{suffix}-Absent",
    }
    iam.put_role_policy(
        RoleName=session_role, PolicyName="tenant", PolicyDocument=_session_role_policy(emulator)
    )

    yield arns

    iam.delete_role_policy(RoleName=session_role, PolicyName="tenant")
    iam.delete_role(RoleName=session_role)
    iam.delete_role(RoleName=untaggable_role)


@pytest.fixture
def scoped(agent_env, roles, monkeypatch, task_id, user_id):
    """The agent as the pipeline leaves it: SessionRole set, session tags configured."""
    monkeypatch.setenv("AGENT_SESSION_ROLE_ARN", roles["session"])
    configure_session(user_id=user_id, repo="owner/repo", task_id=task_id)
    return agent_env


def _events(emulator, task_id: str) -> list[dict]:
    return emulator.table(emulator.task_events_table).query(
        KeyConditionExpression=Key("task_id").eq(task_id), ConsistentRead=True
    )["Items"]


class TestScopedCredentials:
    def test_tenant_clients_act_as_the_session_role_named_for_the_task(
        self, scoped, roles, task_id
    ):
        identity = tenant_client("sts").get_caller_identity()

        assert is_scoped() is True
        role_name = roles["session"].rsplit("/", 1)[1]
        assert identity["Arn"] == (
            f"arn:aws:sts::{EMULATOR_ACCOUNT_ID}:assumed-role/{role_name}/abca-{task_id}"
        )

    def test_agent_writes_its_own_events_trace_and_task_record(self, scoped, task_id, user_id):
        scoped.table(scoped.task_table).put_item(
            Item={"task_id": task_id, "user_id": user_id, "status": "RUNNING"}
        )

        _ProgressWriter(task_id, user_id=user_id).write_agent_milestone("clone_complete", "")
        uri = upload_trace_to_s3(task_id=task_id, user_id=user_id, body=b"\x1f\x8b trace")
        task_state.write_terminal(task_id, "COMPLETED", {"trace_s3_uri": uri})

        assert [e["metadata"]["milestone"] for e in _events(scoped, task_id)] == ["clone_complete"]
        assert uri == f"s3://{scoped.trace_bucket}/traces/{user_id}/{task_id}.jsonl.gz"
        record = task_state.get_task(task_id)
        assert record is not None
        assert (record["status"], record["trace_s3_uri"]) == ("COMPLETED", uri)
        assert record["updated_at"] == record["completed_at"]

    def test_approval_gate_transaction_spans_both_of_the_tasks_tables(self, scoped, task_id):
        scoped.table(scoped.task_table).put_item(Item={"task_id": task_id, "status": "RUNNING"})
        request_id = _generate_ulid()
        row = approval_row(task_id, request_id)

        task_state.transact_write_approval_request(task_id, request_id, row)
        task_state.transact_resume_from_approval(task_id, request_id)

        assert task_state.get_approval_row(task_id, request_id) == row
        record = task_state.get_task(task_id)
        assert record is not None
        assert record["status"] == "RUNNING"


class TestOtherTenantsDataIsOutOfReach:
    def test_event_for_another_task_is_denied_and_stops_the_writer(self, scoped, capsys):
        other_task = _generate_ulid()
        writer = _ProgressWriter(other_task)

        writer.write_agent_milestone("clone_complete", "")

        assert "AccessDeniedException" in capsys.readouterr().out
        assert writer._disabled is True
        assert _events(scoped, other_task) == []

    def test_trace_under_another_users_prefix_is_denied(self, scoped, task_id, capsys):
        other_user = str(uuid.uuid4())

        uri = upload_trace_to_s3(task_id=task_id, user_id=other_user, body=b"\x1f\x8b trace")

        assert uri is None
        assert "AccessDenied" in capsys.readouterr().out
        listing = scoped.client("s3").list_objects_v2(
            Bucket=scoped.trace_bucket, Prefix=f"traces/{other_user}/"
        )
        assert listing["KeyCount"] == 0

    def test_another_tasks_record_cannot_be_read(self, scoped):
        other_task = _generate_ulid()
        scoped.table(scoped.task_table).put_item(Item={"task_id": other_task, "status": "RUNNING"})

        with pytest.raises(task_state.TaskFetchError, match="AccessDeniedException"):
            task_state.get_task(other_task)


@pytest.mark.parametrize("role", ["absent", "untaggable"])
class TestSessionRoleThatCannotBeAssumed:
    @pytest.fixture
    def unassumable(self, agent_env, roles, role, monkeypatch, task_id, user_id):
        monkeypatch.setenv("AGENT_SESSION_ROLE_ARN", roles[role])
        configure_session(user_id=user_id, repo="owner/repo", task_id=task_id)
        return agent_env

    def test_scoping_fails_closed_and_nothing_reaches_tenant_data(
        self, unassumable, task_id, user_id
    ):
        with pytest.raises(SessionScopingError) as raised:
            is_scoped()
        with pytest.raises(SessionScopingError):
            tenant_client("sts")
        uri = upload_trace_to_s3(task_id=task_id, user_id=user_id, body=b"\x1f\x8b trace")

        cause = raised.value.__cause__
        assert isinstance(cause, ClientError)
        assert cause.operation_name == "AssumeRole"
        assert cause.response["Error"]["Code"] == "AccessDenied"
        assert uri is None
        listing = unassumable.client("s3").list_objects_v2(
            Bucket=unassumable.trace_bucket, Prefix=f"traces/{user_id}/"
        )
        assert listing["KeyCount"] == 0
