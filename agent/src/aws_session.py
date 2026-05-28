"""Per-task scoped AWS credentials for tenant-data access.

This module centralizes how the agent obtains boto3 clients/resources for
**tenant data** (the task's own DynamoDB rows and its S3 trace/attachment
objects). Instead of using the long-lived compute role (AgentCore Runtime
``ExecutionRole`` or ECS Fargate task role) directly, the agent assumes a
per-task **SessionRole** with session tags ``{user_id, repo, task_id}`` and
uses the resulting short-lived, tag-scoped credentials. The SessionRole's IAM
policy self-constrains via ``aws:PrincipalTag/*`` conditions
(``dynamodb:LeadingKeys`` on ``task_id`` for the task tables, an S3 prefix
condition on ``user_id`` for the trace bucket), so a compromised session can
only reach its own task's data — not other tenants'.

Two properties matter for correctness:

1. **Refreshable, not one-shot.** The agent runs under credentials that are
   themselves an assumed role, so the agent's own ``sts:AssumeRole`` is *role
   chaining*, which AWS hard-caps at 1 hour regardless of the role's
   ``MaxSessionDuration``. Tasks can run up to ``maxLifetime`` (8 h), so a
   single ``assume_role()`` call would yield credentials that expire mid-task
   and fail every subsequent call with ``ExpiredToken``. We wrap the assume
   call in botocore ``RefreshableCredentials`` so boto3 transparently
   re-assumes before expiry.

2. **Backend-agnostic.** The same code path works whether the agent boots
   under an AgentCore execution role or an ECS task role — both are valid
   assuming principals in the SessionRole trust policy.

**Fail-safe:** when ``AGENT_SESSION_ROLE_ARN`` is unset (local dev, tests, or
a deployment that has not yet provisioned the SessionRole), this module
returns plain boto3 clients/resources backed by the ambient credential chain
— identical to the pre-feature behavior. Scoping is additive and never blocks
task execution.
"""

from __future__ import annotations

import os
import threading
from typing import Any

# Env var holding the per-task SessionRole ARN. Set by the orchestrator on the
# compute environment (AgentCore runtime env / ECS container overrides).
SESSION_ROLE_ARN_ENV = "AGENT_SESSION_ROLE_ARN"

# Env vars carrying the session-tag values. The agent exports these from its
# resolved TaskConfig at startup (see ``configure_session``) so that lazily
# created clients downstream can pick them up without threading config through
# every call site.
USER_ID_ENV = "AGENT_SESSION_USER_ID"
REPO_ENV = "AGENT_SESSION_REPO"
TASK_ID_ENV = "AGENT_SESSION_TASK_ID"

# Role chaining caps the assumed session at 1 hour. Request the maximum the
# cap allows; botocore refreshes well before this elapses.
_CHAINED_SESSION_DURATION_S = 3600

# IAM session-tag value constraints: keys <=128 chars, values <=256 chars.
_MAX_TAG_VALUE_LEN = 256

_lock = threading.Lock()
_session: Any = None  # cached boto3.Session (scoped or plain)
_scoped: bool | None = None  # None until first resolution; True if tag-scoped


def configure_session(user_id: str, repo: str, task_id: str) -> None:
    """Export session-tag values to the environment for later client creation.

    Called once at agent startup from the resolved ``TaskConfig``. Idempotent;
    safe to call before any tenant-data client is created. Does not itself
    assume the role — assumption is deferred until the first client is built so
    that a missing SessionRole never delays startup.
    """
    if user_id:
        os.environ[USER_ID_ENV] = user_id
    if repo:
        os.environ[REPO_ENV] = repo
    if task_id:
        os.environ[TASK_ID_ENV] = task_id


def reset_session_cache() -> None:
    """Drop the cached session. For tests that toggle env between cases."""
    global _session, _scoped
    with _lock:
        _session = None
        _scoped = None


def _session_tags() -> list[dict[str, str]]:
    """Build the AssumeRole ``Tags`` list from the configured env values.

    Only non-empty values are included. Values are truncated to the IAM limit
    so an over-long repo slug can never make ``AssumeRole`` fail closed.
    """
    pairs = (
        ("user_id", os.environ.get(USER_ID_ENV, "")),
        ("repo", os.environ.get(REPO_ENV, "")),
        ("task_id", os.environ.get(TASK_ID_ENV, "")),
    )
    return [{"Key": key, "Value": value[:_MAX_TAG_VALUE_LEN]} for key, value in pairs if value]


def _build_scoped_session(role_arn: str) -> Any:
    """Build a boto3 Session backed by refreshable assumed-role credentials.

    The refresh callback re-invokes ``sts:AssumeRole`` (with session tags) each
    time botocore decides the cached credentials are near expiry, so a task
    running past the 1-hour role-chaining cap keeps working.
    """
    import boto3
    from botocore.credentials import (
        DeferredRefreshableCredentials,
    )
    from botocore.session import get_session as get_botocore_session

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    task_id = os.environ.get(TASK_ID_ENV, "")
    # Role session name must be <=64 chars and match [\w+=,.@-]. task_id is a
    # 12-char hex slug; prefix keeps CloudTrail entries identifiable.
    session_name = f"abca-{task_id}"[:64] or "abca-session"

    # A dedicated STS client built from the *ambient* (compute-role) chain.
    # This is the role-chaining caller; the assumed SessionRole credentials it
    # returns must NOT be used to build it, or refresh would recurse.
    sts_client = boto3.client("sts", region_name=region)

    def _refresh() -> dict[str, str]:
        resp = sts_client.assume_role(
            RoleArn=role_arn,
            RoleSessionName=session_name,
            DurationSeconds=_CHAINED_SESSION_DURATION_S,
            Tags=_session_tags(),
        )
        creds = resp["Credentials"]
        return {
            "access_key": creds["AccessKeyId"],
            "secret_key": creds["SecretAccessKey"],
            "token": creds["SessionToken"],
            # botocore expects an ISO8601 string; the SDK returns a datetime.
            "expiry_time": creds["Expiration"].isoformat(),
        }

    botocore_session = get_botocore_session()
    # Deferred: the first assume_role happens on first credential use, not now,
    # so a transient STS hiccup at startup doesn't crash the agent before it
    # has even begun.
    botocore_session._credentials = DeferredRefreshableCredentials(
        method="sts-assume-role-session-tags",
        refresh_using=_refresh,
    )
    if region:
        botocore_session.set_config_variable("region", region)
    return boto3.Session(botocore_session=botocore_session)


def get_session() -> Any:
    """Return the cached boto3 Session for tenant-data access.

    Tag-scoped (assumed SessionRole) when ``AGENT_SESSION_ROLE_ARN`` is set;
    otherwise a plain session on the ambient credential chain (fail-safe).
    """
    global _session, _scoped
    if _session is not None:
        return _session
    with _lock:
        if _session is not None:
            return _session
        import boto3

        role_arn = os.environ.get(SESSION_ROLE_ARN_ENV, "").strip()
        if role_arn:
            try:
                _session = _build_scoped_session(role_arn)
                _scoped = True
            except Exception:
                # Building the session (not yet assuming) should not fail, but
                # if botocore/boto3 import shape changes, fall back rather than
                # break task execution. The actual assume_role still runs
                # lazily and will surface its own errors at call time.
                _session = boto3.Session(
                    region_name=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
                )
                _scoped = False
        else:
            _session = boto3.Session(
                region_name=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
            )
            _scoped = False
        return _session


def is_scoped() -> bool:
    """Whether the current session uses tag-scoped assumed-role credentials."""
    if _scoped is None:
        get_session()
    return bool(_scoped)


def tenant_client(service_name: str, **kwargs: Any) -> Any:
    """boto3 client for tenant data.

    When the per-task SessionRole is configured, the client is built from the
    tag-scoped, refreshable session. Otherwise it delegates directly to
    ``boto3.client`` — behaviorally identical to the pre-feature code path
    (and transparent to callers/tests that mock ``boto3.client``).
    """
    session = get_session()
    if is_scoped():
        return session.client(service_name, **kwargs)
    import boto3

    return boto3.client(service_name, **kwargs)


def tenant_resource(service_name: str, **kwargs: Any) -> Any:
    """boto3 resource for tenant data. See :func:`tenant_client`."""
    session = get_session()
    if is_scoped():
        return session.resource(service_name, **kwargs)
    import boto3

    return boto3.resource(service_name, **kwargs)
