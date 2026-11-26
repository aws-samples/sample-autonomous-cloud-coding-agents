# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import os
import re
import socket
import sys
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from task_state import ApprovalRow

EMULATOR_ACCOUNT_ID = "000000000000"
# An IP address, not ``localhost``: with a host name the JavaScript SDK addresses
# S3 buckets as ``<bucket>.localhost``, which the emulator's certificate does not cover.
_LOOPBACK_EMULATOR = re.compile(r"https://127\.0\.0\.1:\d+")
# Other AWS_* variables (profile, keys, per-service endpoint, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS)
# can make the SDK send a call somewhere other than the emulator, or sign it with real credentials.
_EXPECTED_AWS_ENV = frozenset(
    {
        "AWS_ENDPOINT_URL",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_CONFIG_FILE",
        "AWS_CA_BUNDLE",
        "AWS_EC2_METADATA_DISABLED",
        "AWS_DISABLE_HOST_PREFIX_INJECTION",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
    }
)
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"


def _refuse_non_loopback(event: str, args: tuple[Any, ...]) -> None:
    """A child process does not inherit an audit hook."""
    if event in ("socket.connect", "socket.sendto", "socket.sendmsg"):
        address = args[1]
        host = address[0] if isinstance(address, tuple) else None  # a str is a Unix socket path
    elif event in ("socket.getaddrinfo", "socket.gethostbyname"):
        host = args[0]
    else:
        return
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    if host is not None and host not in _LOOPBACK_HOSTS:
        raise PermissionError(
            f"emulator tests must not open a connection that leaves this machine, "
            f"and this one tried to reach {host!r}"
        )


# An audit hook cannot be removed again.
sys.addaudithook(_refuse_non_loopback)


def _why_not_an_emulator() -> str | None:
    endpoint = os.environ.get("AWS_ENDPOINT_URL", "")
    if not _LOOPBACK_EMULATOR.fullmatch(endpoint):
        return (
            f"AWS_ENDPOINT_URL must be https://127.0.0.1:<port> (it is {endpoint!r}); "
            "run these tests with `mise run test:integration`"
        )
    strays = sorted(
        name for name in os.environ if name.startswith("AWS_") and name not in _EXPECTED_AWS_ENV
    )
    if strays:
        return f"unexpected AWS configuration in the environment: {', '.join(strays)}"
    return None


@dataclass(frozen=True)
class Emulator:
    """A verified emulator plus the resources this pytest session created in it."""

    endpoint: str
    region: str
    ca_bundle: str
    session: Any
    task_table: str
    task_events_table: str
    task_approvals_table: str
    task_nudges_table: str
    trace_bucket: str
    log_group: str

    def client(self, service_name: str, **kwargs: Any) -> Any:
        return self.session.client(service_name, endpoint_url=self.endpoint, **kwargs)

    def table(self, name: str) -> Any:
        return self.session.resource("dynamodb", endpoint_url=self.endpoint).Table(name)


_TABLE_KEYS = {
    "task_table": [("task_id", "HASH")],
    "task_events_table": [("task_id", "HASH"), ("event_id", "RANGE")],
    "task_approvals_table": [("task_id", "HASH"), ("request_id", "RANGE")],
    "task_nudges_table": [("task_id", "HASH"), ("nudge_id", "RANGE")],
}


def _create_tables(ddb: Any, names: dict[str, str]) -> None:
    for field, name in names.items():
        keys = _TABLE_KEYS[field]
        ddb.create_table(
            TableName=name,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": k, "AttributeType": "S"} for k, _ in keys],
            KeySchema=[{"AttributeName": k, "KeyType": kind} for k, kind in keys],
        )
    # The emulator keeps a new table CREATING for three seconds. boto3's default
    # is to poll every 20 seconds.
    for name in names.values():
        ddb.get_waiter("table_exists").wait(
            TableName=name, WaiterConfig={"Delay": 1, "MaxAttempts": 30}
        )


@pytest.fixture(scope="session")
def emulator() -> Any:
    reason = _why_not_an_emulator()
    if reason:
        pytest.fail(reason, pytrace=False)
    try:
        socket.getaddrinfo("loopback-guard-check.invalid", 443)
    except OSError as exc:
        refused = isinstance(exc, PermissionError)
    else:
        refused = False
    if not refused:
        pytest.fail("the loopback-only audit hook did not refuse a name lookup", pytrace=False)

    import boto3
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError

    endpoint = os.environ["AWS_ENDPOINT_URL"]
    # The emulator keeps state in memory and has no reset call.
    run_id = uuid.uuid4().hex[:8]
    tables = {
        "task_table": f"abca-emu-{run_id}-TaskTable",
        "task_events_table": f"abca-emu-{run_id}-TaskEventsTable",
        "task_approvals_table": f"abca-emu-{run_id}-TaskApprovalsTable",
        "task_nudges_table": f"abca-emu-{run_id}-TaskNudgesTable",
    }
    emu = Emulator(
        endpoint=endpoint,
        region=_REGION,
        ca_bundle=os.environ.get("AWS_CA_BUNDLE", ""),
        session=boto3.Session(region_name=_REGION),
        trace_bucket=f"abca-emu-{run_id}-traces",
        log_group=f"/abca-emu/{run_id}/application",
        **tables,
    )

    fail_fast = Config(connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1})
    # A setting in the shared config file can turn AWS_ENDPOINT_URL off.
    sts = emu.session.client("sts", config=fail_fast)
    problem = None
    if sts.meta.endpoint_url != endpoint:
        problem = f"SDK clients resolve to {sts.meta.endpoint_url}, not to {endpoint}"
    else:
        try:
            account = sts.get_caller_identity()["Account"]
        except (BotoCoreError, ClientError) as exc:
            problem = f"AWS_ENDPOINT_URL={endpoint} is set but did not answer STS: {exc}"
        else:
            if account != EMULATOR_ACCOUNT_ID:
                problem = (
                    f"{endpoint} answered as account {account}, not the emulator's "
                    f"{EMULATOR_ACCOUNT_ID}; refusing to create test resources there"
                )
    if problem:
        pytest.fail(problem, pytrace=False)

    ddb, s3, logs = emu.client("dynamodb"), emu.client("s3"), emu.client("logs")
    _create_tables(ddb, tables)
    s3.create_bucket(Bucket=emu.trace_bucket)
    logs.create_log_group(logGroupName=emu.log_group)

    yield emu

    for name in tables.values():
        ddb.delete_table(TableName=name)
    for obj in s3.list_objects_v2(Bucket=emu.trace_bucket).get("Contents", []):
        s3.delete_object(Bucket=emu.trace_bucket, Key=obj["Key"])
    s3.delete_bucket(Bucket=emu.trace_bucket)
    logs.delete_log_group(logGroupName=emu.log_group)


def _reset_agent_module_state() -> None:
    import aws_session
    import nudge_reader
    import progress_writer
    import task_state

    aws_session.reset_session_cache()
    nudge_reader._reset_cache_for_tests()
    progress_writer._reset_circuit_breakers()
    task_state._table = None


@pytest.fixture(autouse=True)
def _isolated_agent_state(emulator: Emulator) -> Any:
    _reset_agent_module_state()
    yield
    _reset_agent_module_state()


@pytest.fixture
def agent_env(emulator: Emulator, monkeypatch: pytest.MonkeyPatch) -> Emulator:
    """The environment the stack gives the agent runtime (cdk/src/stacks/agent.ts)."""
    monkeypatch.setenv("AWS_REGION", emulator.region)
    monkeypatch.setenv("TASK_TABLE_NAME", emulator.task_table)
    monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", emulator.task_events_table)
    monkeypatch.setenv("TASK_APPROVALS_TABLE_NAME", emulator.task_approvals_table)
    monkeypatch.setenv("NUDGES_TABLE_NAME", emulator.task_nudges_table)
    monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", emulator.trace_bucket)
    return emulator


def approval_row(task_id: str, request_id: str) -> ApprovalRow:
    """A pending approval as the PreToolUse hook records it (design §10.1)."""
    return {
        "task_id": task_id,
        "request_id": request_id,
        "tool_name": "Bash",
        "tool_input_preview": "git push --force",
        "tool_input_sha256": "a" * 64,
        "reason": "Soft-deny: force_push_any",
        "severity": "high",
        "matching_rule_ids": ["force_push_any"],
        "status": "PENDING",
        "created_at": "2026-05-07T00:00:00Z",
        "timeout_s": 300,
        "ttl": 1_800_000_000,
        "user_id": "u-alice",
        "repo": "owner/repo",
    }


@pytest.fixture
def task_id() -> str:
    """A task id shaped like production ones (ULID), unique per test."""
    from progress_writer import _generate_ulid

    return _generate_ulid()


@pytest.fixture
def user_id() -> str:
    """A platform user id shaped like a Cognito ``sub``, unique per test."""
    return str(uuid.uuid4())
