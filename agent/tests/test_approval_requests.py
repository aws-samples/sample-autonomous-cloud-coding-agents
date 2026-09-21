# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from botocore.credentials import Credentials
from botocore.exceptions import ClientError

import approval_requests as broker
import task_state


def pending_request() -> task_state.ApprovalRow:
    return {
        "task_id": "task",
        "request_id": "request",
        "tool_name": "Bash",
        "tool_input_preview": '{"command":"git push"}',
        "tool_input_sha256": "a" * 64,
        "reason": "Protected operation",
        "severity": "high",
        "matching_rule_ids": ["protected"],
        "status": "PENDING",
        "created_at": "2026-09-18T00:00:00Z",
        "timeout_s": 0,
        "user_id": "owner",
        "repo": "owner/repo",
    }


@pytest.fixture
def transport(monkeypatch):
    monkeypatch.setenv(broker.API_ENV, "https://fixture.execute-api.us-east-1.amazonaws.com/v1/")
    session = MagicMock()
    session.get_credentials.return_value = Credentials(
        "testing", "testing-secret", "testing-session"
    )
    monkeypatch.setattr(broker, "get_session", lambda: session)
    post = MagicMock(
        return_value=SimpleNamespace(status_code=200, json=lambda: {"data": {"ok": True}})
    )
    monkeypatch.setattr(broker.requests, "post", post)
    return post


def test_scoped_signature_binds_the_task_path_and_does_not_redirect(transport):
    broker.record_request("create", "task", "request", approval={"status": "PENDING"})
    args, kwargs = transport.call_args
    assert args == ("https://fixture.execute-api.us-east-1.amazonaws.com/v1/tasks/task",)
    assert "execute-api/aws4_request" in kwargs["headers"]["Authorization"]
    assert kwargs["headers"]["X-Amz-Security-Token"] == "testing-session"
    assert "md/uksb-wt64nei4u6#agent" in kwargs["headers"]["User-Agent"]
    assert kwargs["allow_redirects"] is False
    assert json.loads(kwargs["data"])["task_id"] == "task"


@pytest.mark.parametrize(
    "url",
    [
        "http://fixture.execute-api.us-east-1.amazonaws.com/v1",
        "https://attacker.example/v1",
        "https://fixture.execute-api.us-east-1.amazonaws.com/v1?redirect=elsewhere",
    ],
)
def test_rejects_untrusted_endpoints_before_signing(transport, monkeypatch, url):
    monkeypatch.setenv(broker.API_ENV, url)
    with pytest.raises(ValueError):
        broker.record_request("create", "task", "request")
    transport.assert_not_called()


def test_new_writers_use_service_instead_of_direct_dynamodb(transport, monkeypatch):
    direct = MagicMock()
    monkeypatch.setattr(task_state, "_get_ddb_client", direct)
    task_state.transact_write_approval_request("task", "request", pending_request())
    assert task_state.best_effort_update_approval_status("task", "request", "TIMED_OUT")
    assert transport.call_count == 2
    direct.assert_not_called()


@pytest.mark.parametrize("operation", ["create", "timeout"])
def test_cloud_worker_missing_endpoint_reports_configuration_error(monkeypatch, operation):
    monkeypatch.delenv(broker.API_ENV, raising=False)
    monkeypatch.setenv("AGENT_SESSION_ROLE_ARN", "arn:aws:iam::123456789012:role/session")
    direct = MagicMock()
    monkeypatch.setattr(task_state, "_get_ddb_client", direct)
    with pytest.raises(RuntimeError, match=r"APPROVAL_REQUESTS_API_URL.*matching CDK"):
        if operation == "create":
            task_state.transact_write_approval_request("task", "request", pending_request())
        else:
            task_state.best_effort_update_approval_status("task", "request", "TIMED_OUT")
    direct.assert_not_called()


@pytest.mark.parametrize("status", ["APPROVED", "DENIED", "PENDING", "CANCELLED"])
def test_worker_api_cannot_record_a_human_decision(transport, status):
    with pytest.raises(ValueError, match="non-human timeouts"):
        task_state.best_effort_update_approval_status("task", "request", status)
    transport.assert_not_called()


def test_uncertain_service_write_does_not_fall_back_to_direct_dynamodb(transport, monkeypatch):
    direct = MagicMock()
    monkeypatch.setattr(task_state, "_get_ddb_client", direct)
    transport.side_effect = TimeoutError("reply lost")
    with pytest.raises(TimeoutError):
        task_state.transact_write_approval_request("task", "request", pending_request())
    direct.assert_not_called()


def test_timeout_race_preserves_human_winner_but_lease_loss_is_not_benign(transport):
    reasons = [{"Code": "ConditionalCheckFailed"}, {"Code": "None"}, {"Code": "None"}]
    transport.return_value = SimpleNamespace(
        status_code=409,
        json=lambda: {
            "error": {
                "code": "TransactionCanceledException",
                "details": {"cancellation_reasons": reasons},
            },
        },
    )
    assert not task_state.best_effort_update_approval_status("task", "request", "TIMED_OUT")
    reasons[-1] = {"Code": "ConditionalCheckFailed"}
    with pytest.raises(ClientError):
        task_state.best_effort_update_approval_status("task", "request", "TIMED_OUT")
