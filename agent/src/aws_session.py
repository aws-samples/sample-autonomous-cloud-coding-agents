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

**Fail-safe vs. fail-closed:**

- When ``AGENT_SESSION_ROLE_ARN`` is **unset** (local dev, tests, or a
  deployment that has not yet provisioned the SessionRole), this module returns
  plain boto3 clients/resources backed by the ambient credential chain —
  identical to the pre-feature behavior. Scoping is opt-in and its absence does
  not block task execution.
- When ``AGENT_SESSION_ROLE_ARN`` **is set**, scoping has been *requested*, so a
  failure to build the scoped session is treated as a hard error: this module
  raises :class:`SessionScopingError` rather than silently degrading to the
  ambient (cross-tenant) compute role. For a tenant-isolation control, silently
  running unscoped is the most dangerous failure mode — the agent keeps working
  but stops isolating tenants — so we fail **closed** (abort the task) instead.
"""

from __future__ import annotations

import os
import threading
from typing import Any

# Env var holding the per-task SessionRole ARN. Set by the orchestrator on the
# compute environment (AgentCore runtime env / ECS container overrides).
SESSION_ROLE_ARN_ENV = "AGENT_SESSION_ROLE_ARN"

# Role chaining caps the assumed session at 1 hour. Request the maximum the
# cap allows; botocore refreshes well before this elapses.
_CHAINED_SESSION_DURATION_S = 3600

# IAM session-tag value constraints: keys <=128 chars, values <=256 chars.
_MAX_TAG_VALUE_LEN = 256

_lock = threading.Lock()
_session: Any = None  # cached boto3.Session (scoped or plain)
_scoped: bool | None = None  # None until first resolution; True if tag-scoped

# Session-tag values, set once at startup by ``configure_session`` from the
# resolved TaskConfig. Kept in private module state — NOT os.environ — so the
# tenant identifiers are not inherited by the untrusted repo subprocesses the
# agent spawns (build/test/tooling). Read by ``_session_tags`` at assume time.
_tags: dict[str, str] = {}


class SessionScopingError(RuntimeError):
    """Per-session IAM scoping was requested but could not be established.

    Raised when ``AGENT_SESSION_ROLE_ARN`` is set but the scoped session cannot
    be built. Fails the task closed rather than silently falling back to the
    ambient (cross-tenant) compute role.
    """


def configure_session(user_id: str, repo: str, task_id: str) -> None:
    """Record session-tag values in private module state for later use.

    Called once at agent startup from the resolved ``TaskConfig``. Idempotent;
    safe to call before any tenant-data client is created. Does not itself
    assume the role — assumption is deferred until the first client is built so
    that a missing SessionRole never delays startup. Values are stored in a
    module global (not ``os.environ``) so tenant identifiers do not leak into
    spawned subprocesses.
    """
    global _tags
    _tags = {
        key: value
        for key, value in (("user_id", user_id), ("repo", repo), ("task_id", task_id))
        if value
    }


def reset_session_cache() -> None:
    """Drop the cached session and tags. For tests that toggle config."""
    global _session, _scoped, _tags
    with _lock:
        _session = None
        _scoped = None
        _tags = {}


def _session_tags() -> list[dict[str, str]]:
    """Build the AssumeRole ``Tags`` list from the configured tag values.

    Only non-empty values are included (filtered at ``configure_session``).
    Values are truncated to the IAM limit so an over-long repo slug can never
    make ``AssumeRole`` fail closed.
    """
    return [{"Key": key, "Value": value[:_MAX_TAG_VALUE_LEN]} for key, value in _tags.items()]


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
    task_id = _tags.get("task_id", "")
    # Role session name must be <=64 chars and match [\w+=,.@-]. task_id is a
    # short slug (a ULID, ~26 chars, in the API path; a 12-char hex fallback
    # when the agent generates its own) — well under 64. The ``abca-`` prefix
    # keeps CloudTrail entries identifiable. Truncate defensively regardless.
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
            # Scoping was requested. Build the scoped session or FAIL CLOSED —
            # never silently downgrade to the ambient compute role, which can
            # reach every tenant's data (that is exactly what this control
            # prevents).
            try:
                _session = _build_scoped_session(role_arn)
                _scoped = True
            except Exception as exc:
                from shell import log_error_cw

                log_error_cw(
                    "SESSION_SCOPING_FAILED: AGENT_SESSION_ROLE_ARN is set but the "
                    f"scoped session could not be built ({type(exc).__name__}: {exc}). "
                    "Failing closed — refusing to run on unscoped ambient credentials, "
                    "which would disable tenant isolation.",
                    task_id=_tags.get("task_id") or None,
                )
                raise SessionScopingError(
                    "per-session IAM scoping requested via "
                    f"{SESSION_ROLE_ARN_ENV} but could not be established"
                ) from exc
        else:
            # Scoping not requested (local/dev/tests, or pre-provisioning):
            # plain ambient session, behaviorally identical to pre-feature code.
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
