# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""IAM-signed requests to the control-plane approval writer."""

import json
import os
import re
from http import HTTPStatus
from urllib.parse import urlsplit

import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import ClientError

from aws_session import get_session
from microvm_lifecycle import get_context
from ua import sanitize_ua_value, static_user_agent_extra

API_ENV = "APPROVAL_REQUESTS_API_URL"


def configured() -> bool:
    available = bool(os.environ.get(API_ENV))
    if not available and os.environ.get("AGENT_SESSION_ROLE_ARN"):
        raise RuntimeError(
            "APPROVAL_REQUESTS_API_URL is required for cloud approval requests; "
            "deploy matching CDK and worker images"
        )
    return available


def record_request(
    operation: str,
    task_id: str,
    request_id: str,
    *,
    approval: dict | None = None,
    reason: str | None = None,
) -> None:
    """Sign the task path with scoped credentials; never follow redirects."""
    endpoint = os.environ.get(API_ENV, "").rstrip("/")
    parsed = urlsplit(endpoint)
    match = re.fullmatch(
        r"[a-z0-9]+\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?", parsed.hostname or ""
    )
    if (
        parsed.scheme != "https"
        or not match
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.query
        or parsed.fragment
        or not re.fullmatch(r"/[A-Za-z0-9_-]+", parsed.path)
        or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id)
        or operation not in {"create", "timeout"}
    ):
        raise ValueError("Invalid approval request endpoint, task id or operation")
    payload = {"operation": operation, "task_id": task_id, "request_id": request_id}
    if approval is not None:
        payload["approval"] = approval
    if reason is not None:
        payload["reason"] = reason
    lifecycle = get_context(task_id)
    if lifecycle is not None:
        payload["worker_attempt_id"] = lifecycle.attempt_id
    body = json.dumps(payload, separators=(",", ":")).encode()
    user_agent = static_user_agent_extra()
    app_id = os.environ.get("AWS_SDK_UA_APP_ID")
    if app_id:
        user_agent += f" app/{sanitize_ua_value(app_id)}"
    url = f"{endpoint}/tasks/{task_id}"
    request = AWSRequest(
        method="POST",
        url=url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": user_agent},
    )
    credentials = get_session().get_credentials()
    if credentials is None:
        raise RuntimeError("Approval request credentials unavailable")
    SigV4Auth(credentials.get_frozen_credentials(), "execute-api", match.group(1)).add_auth(request)
    response = requests.post(
        url,
        data=body,
        headers=dict(request.headers),
        timeout=(5, 20),
        allow_redirects=False,
    )
    try:
        result = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"Approval service returned invalid JSON (HTTP {response.status_code})"
        ) from exc
    data = result.get("data") if isinstance(result, dict) else None
    if response.status_code == HTTPStatus.OK and isinstance(data, dict) and data.get("ok") is True:
        return
    error = result.get("error") if isinstance(result, dict) else None
    code = (
        error.get("code", "ApprovalServiceUnavailable")
        if isinstance(error, dict)
        else "ApprovalServiceUnavailable"
    )
    details = error.get("details") if isinstance(error, dict) else None
    reasons = details.get("cancellation_reasons", []) if isinstance(details, dict) else []
    raise ClientError(
        {
            "Error": {
                "Code": code,
                "Message": "Control plane did not acknowledge the approval write",
            },
            "CancellationReasons": reasons,
            "ResponseMetadata": {
                "HTTPStatusCode": response.status_code,
                "RequestId": error.get("request_id") if isinstance(error, dict) else None,
            },
        },
        "RecordApprovalRequest",
    )
