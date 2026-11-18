# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The per-task scoped session (``aws_session.py``) against real STS and IAM APIs.

``tests/test_aws_session.py`` checks the arguments handed to a mocked
``assume_role``. Here the agent really assumes a SessionRole with its
``{user_id, repo, task_id}`` session tags and uses the credentials it gets back.

What the emulator lets these tests establish, and what it does not:

* STS validates the request (role exists, trust policy allows ``sts:AssumeRole``
  and ``sts:TagSession``, tag shape) and returns credentials that DynamoDB and S3
  accept. That part behaves like AWS.
* For a role created in the emulator, DynamoDB and S3 also evaluate the role's
  identity policy, including ``dynamodb:LeadingKeys`` and
  ``${aws:PrincipalTag/...}`` — so a cross-tenant call is denied here. AWS states
  that this evaluation is not the same as the real one. The denial tests below
  are therefore a tripwire for the agent's wiring (tags reach STS, tenant data
  goes through the scoped session), never evidence that the policy is safe.
* The role policy below is a hand-written mirror of
  ``cdk/src/constructs/agent-session-role.ts``, not the deployed policy.
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

# AgentSessionRole.DDB_ITEM_ACTIONS (Scan is deliberately absent).
_APPROVALS_READ_ACTIONS = [
    "dynamodb:GetItem",
    "dynamodb:BatchGetItem",
    "dynamodb:Query",
    "dynamodb:ConditionCheckItem",
]
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
        for table in (emulator.task_table, emulator.task_events_table)
    ]
    # Approvals are read-only for the session (#1000): workers observe decisions and
    # use the rows in condition checks; requests go through the trusted writer.
    statements.append(
        {
            "Effect": "Allow",
            "Action": _APPROVALS_READ_ACTIONS,
            "Resource": f"{table_arn}/{emulator.task_approvals_table}",
            "Condition": {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["${aws:PrincipalTag/task_id}"]
                }
            },
        }
    )
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

    def test_a_scoped_worker_cannot_open_a_gate_without_the_trusted_writer(self, scoped, task_id):
        # Cloud workers request approvals through the trusted writer (#1000). Without
        # its endpoint the request fails closed instead of writing the row itself.
        scoped.table(scoped.task_table).put_item(Item={"task_id": task_id, "status": "RUNNING"})
        request_id = _generate_ulid()

        with pytest.raises(RuntimeError, match="APPROVAL_REQUESTS_API_URL is required"):
            task_state.transact_write_approval_request(
                task_id, request_id, approval_row(task_id, request_id)
            )

        assert task_state.get_approval_row(task_id, request_id) is None
        record = task_state.get_task(task_id)
        assert record is not None
        assert record["status"] == "RUNNING"

    def test_the_session_can_read_but_not_write_its_own_approval_rows(self, scoped, task_id):
        request_id = _generate_ulid()
        scoped.table(scoped.task_approvals_table).put_item(Item=approval_row(task_id, request_id))
        approvals = tenant_client("dynamodb")
        key = {"task_id": {"S": task_id}, "request_id": {"S": request_id}}

        assert approvals.get_item(TableName=scoped.task_approvals_table, Key=key)["Item"]
        with pytest.raises(ClientError) as denied:
            approvals.update_item(
                TableName=scoped.task_approvals_table,
                Key=key,
                UpdateExpression="SET #s = :s",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": {"S": "APPROVED"}},
            )
        assert denied.value.response["Error"]["Code"] == "AccessDeniedException"


class TestOtherTenantsDataIsOutOfReach:
    """Tripwire only — see the module docstring for what a denial here means."""

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
        # What pipeline.run_task calls first, before any work starts.
        with pytest.raises(SessionScopingError) as raised:
            is_scoped()
        # Every later tenant-data call is refused the same way; none runs unscoped.
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
