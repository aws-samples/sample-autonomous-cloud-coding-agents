"""Per-task scoped AWS credentials for tenant-data access.

boto3 clients/resources for tenant data (the task's own DynamoDB rows and its
S3 trace/attachment objects) are built from a per-task SessionRole assumed with
session tags ``{user_id, repo, task_id}``, on refreshable credentials.

- ``AGENT_SESSION_ROLE_ARN`` unset: plain boto3 clients/resources on the
  ambient credential chain.
- ``AGENT_SESSION_ROLE_ARN`` set: a scoped session that cannot be built raises
  :class:`SessionScopingError`; there is no fallback to the ambient compute role.
"""

from __future__ import annotations

import os
import threading
from datetime import UTC
from typing import Any

SESSION_ROLE_ARN_ENV = "AGENT_SESSION_ROLE_ARN"

# AWS caps a role-chained session at 1 hour, whatever the role's
# ``MaxSessionDuration``.
_CHAINED_SESSION_DURATION_S = 3600

# IAM session-tag value constraints: keys <=128 chars, values <=256 chars.
_MAX_TAG_VALUE_LEN = 256

# botocore 1.44 changed its default retry mode from "legacy" (5 attempts, 10 for
# DynamoDB) to "standard" (3 attempts, 4 for DynamoDB, and a retry quota).
RETRY_MODE = "legacy"

_RETRY_MODE_ENV = "AWS_RETRY_MODE"

_lock = threading.Lock()
_session: Any = None
_scoped: bool | None = None
_ambient_lock = threading.Lock()
_ambient_credentials: dict[int, Any] = {}

_tags: dict[str, str] = {}


class SessionScopingError(RuntimeError):
    """Per-session IAM scoping was requested but could not be established.

    Raised when ``AGENT_SESSION_ROLE_ARN`` is set but the scoped session cannot
    be built.
    """


def fast_fail_config(read_timeout: int = 2) -> Any:
    """One attempt with short timeouts, for calls inside a MicroVM lifecycle budget."""
    from botocore.config import Config

    return Config(connect_timeout=2, read_timeout=read_timeout, retries={"total_max_attempts": 1})


def build_session_tags(user_id: str, repo: str, task_id: str) -> list[dict[str, str]]:
    """Build the AssumeRole ``Tags`` list from tenant identifiers.

    Only non-empty values are included. Values are truncated to the IAM limit.
    """
    pairs = (("user_id", user_id), ("repo", repo), ("task_id", task_id))
    return [{"Key": key, "Value": value[:_MAX_TAG_VALUE_LEN]} for key, value in pairs if value]


def configure_session(user_id: str, repo: str, task_id: str) -> None:
    """Record session-tag values in private module state for later use.

    Idempotent; safe to call before any tenant-data client is created. Does not
    itself assume the role — the first ``get_session()`` call does, with these
    tags, so this must run first.
    """
    global _tags
    tags = {
        key: value
        for key, value in (("user_id", user_id), ("repo", repo), ("task_id", task_id))
        if value
    }
    with _lock:
        if _session is not None and _tags != tags:
            raise SessionScopingError("Cannot change identity after creating the task session")
        _tags = tags


def release_session(task_id: str) -> None:
    """Forget the finished task's session so a reused server can start the next task.

    A session that belongs to a different task is left alone.
    """
    global _session, _scoped, _tags
    with _lock:
        if _tags.get("task_id", "") != task_id:
            return
        _session = None
        _scoped = None
        _tags = {}
    with _ambient_lock:
        _ambient_credentials.clear()


def reset_session_cache() -> None:
    """Drop the cached session and tags. For tests that toggle config."""
    global _session, _scoped, _tags
    with _lock:
        _session = None
        _scoped = None
        _tags = {}
    with _ambient_lock:
        _ambient_credentials.clear()


def _session_tags() -> list[dict[str, str]]:
    return [{"Key": key, "Value": value[:_MAX_TAG_VALUE_LEN]} for key, value in _tags.items()]


MAX_TAG_VALUE_LEN = _MAX_TAG_VALUE_LEN


def _build_scoped_session(role_arn: str) -> Any:
    import boto3
    from botocore.config import Config
    from botocore.credentials import (
        DeferredRefreshableCredentials,
    )
    from botocore.session import get_session as get_botocore_session

    import ua
    from microvm_lifecycle import get_context

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    task_id = _tags.get("task_id", "")
    # Role session name must be <=64 chars and match [\w+=,.@-].
    session_name = f"abca-{task_id}"[:64] or "abca-session"

    sts_config = fast_fail_config() if get_context(task_id) is not None else Config()
    sts_client = platform_client("sts", region_name=region, config=sts_config)
    tags = _session_tags()

    def _refresh() -> dict[str, str]:
        resp = sts_client.assume_role(
            RoleArn=role_arn,
            RoleSessionName=session_name,
            DurationSeconds=_CHAINED_SESSION_DURATION_S,
            Tags=tags,
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
    botocore_session.user_agent_extra = ua.static_user_agent_extra()
    _name_retry_mode(botocore_session)
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
    otherwise a plain session on the ambient credential chain.
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
                session = _build_scoped_session(role_arn)
                # Left to botocore, the role is assumed on the first signed request.
                session.get_credentials().get_frozen_credentials()
                _session = session
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
            from botocore.session import get_session as get_botocore_session

            import ua

            botocore_session = get_botocore_session()
            botocore_session.user_agent_extra = ua.static_user_agent_extra()
            _name_retry_mode(botocore_session)
            region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
            if region:
                botocore_session.set_config_variable("region", region)
            _session = boto3.Session(botocore_session=botocore_session)
            _scoped = False
        return _session


def is_scoped() -> bool:
    """Whether the current session uses tag-scoped assumed-role credentials."""
    if _scoped is None:
        get_session()
    return bool(_scoped)


def _retry_mode() -> str | None:
    return None if os.environ.get(_RETRY_MODE_ENV) else RETRY_MODE


def _name_retry_mode(botocore_session: Any) -> None:
    mode = _retry_mode()
    if mode:
        botocore_session.set_config_variable("retry_mode", mode)


def _base_client_config() -> Any:
    from botocore.config import Config

    import ua

    config = ua.client_config()
    mode = _retry_mode()
    return config.merge(Config(retries={"mode": mode})) if mode else config


def _merge_ua_config(kwargs: dict[str, Any]) -> dict[str, Any]:
    """botocore's ``Config.merge`` lets its argument win on every key it sets, and
    replaces the ``retries`` mapping whole.
    """
    from botocore.config import Config

    import ua

    ua_config = _base_client_config()
    existing = kwargs.get("config")
    if existing is None:
        kwargs["config"] = ua_config
        return kwargs

    caller_retries = getattr(existing, "retries", None)
    if caller_retries and ua_config.retries:
        ua_config = ua_config.merge(Config(retries={**ua_config.retries, **caller_retries}))
    caller_extra = getattr(existing, "user_agent_extra", None)
    if caller_extra:
        combined = f"{caller_extra} {ua.static_user_agent_extra()}"
        ua_config = ua_config.merge(Config(user_agent_extra=combined))
    kwargs["config"] = existing.merge(ua_config)
    return kwargs


def tenant_client(service_name: str, **kwargs: Any) -> Any:
    """boto3 client for tenant data.

    When the per-task SessionRole is configured, the client is built from the
    tag-scoped, refreshable session. Otherwise it delegates directly to
    ``boto3.client``, with the md/ UA merged in.
    """
    session = get_session()
    if is_scoped():
        return session.client(service_name, **kwargs)
    import boto3

    return boto3.client(service_name, **_merge_ua_config(kwargs))


def tenant_resource(service_name: str, **kwargs: Any) -> Any:
    """boto3 resource for tenant data. See :func:`tenant_client`."""
    session = get_session()
    if is_scoped():
        return session.resource(service_name, **kwargs)
    import boto3

    return boto3.resource(service_name, **_merge_ua_config(kwargs))


def platform_client(service_name: str, **kwargs: Any) -> Any:
    """boto3 client for **platform** (non-tenant) calls on the ambient chain.

    For platform resources (CloudWatch Logs, Secrets Manager,
    bedrock-agentcore), not tenant data: uses the compute role's ambient
    credentials and merges the static md/ solution attribution into any caller
    ``config``. (#319)
    """
    import boto3

    client = boto3.client(service_name, **_merge_ua_config(kwargs))
    credentials = getattr(getattr(client, "_request_signer", None), "_credentials", None)
    if credentials is not None:
        with _ambient_lock:
            _ambient_credentials[id(credentials)] = credentials
    return client


def _microvm_scoped_credentials(task_id: str) -> Any:
    session = get_session()
    with _lock:
        if not _scoped or not task_id or _tags.get("task_id") != task_id:
            raise SessionScopingError("MicroVM credentials require the original scoped task")
    return session.get_credentials()


def _locked_refresh(credentials: Any, *, force: bool) -> dict[str, str]:
    """Botocore has no public forced-refresh operation."""
    from botocore.credentials import RefreshableCredentials

    if not isinstance(credentials, RefreshableCredentials):
        raise SessionScopingError("MicroVM resume requires a refreshable credential provider")
    if not credentials._refresh_lock.acquire(timeout=2):
        raise TimeoutError("Credential refresh lock did not become available")
    try:
        if force or credentials.refresh_needed():
            credentials._protected_refresh(
                is_mandatory=force
                or credentials.refresh_needed(credentials._mandatory_refresh_timeout)
            )
        frozen = credentials._frozen_credentials
        expiry = credentials._expiry_time
        if (
            frozen is None
            or not frozen.access_key
            or not frozen.secret_key
            or not frozen.token
            or expiry is None
            or credentials._is_expired()
        ):
            raise SessionScopingError("Credential provider did not return usable temporary keys")
        return {
            "AccessKeyId": frozen.access_key,
            "SecretAccessKey": frozen.secret_key,
            "Token": frozen.token,
            "Expiration": expiry.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    finally:
        credentials._refresh_lock.release()


def export_microvm_credentials(task_id: str) -> dict[str, str]:
    """Serve only the original task's temporary keys to the local Claude broker."""
    return _locked_refresh(_microvm_scoped_credentials(task_id), force=False)


def refresh_microvm_credentials(task_id: str) -> None:
    """Refresh ambient callers first, then the same tag-scoped tenant object.

    Call only behind the closed guest resume barrier. Cached DynamoDB/S3 and
    platform clients keep their credential references. Unknown/static ambient
    providers fail closed.
    """
    tenant = _microvm_scoped_credentials(task_id)
    with _ambient_lock:
        ambient = tuple(_ambient_credentials.values())
    if not ambient:
        raise SessionScopingError("No runtime credential provider was recorded")
    for credentials in ambient:
        _locked_refresh(credentials, force=True)
    _locked_refresh(tenant, force=True)
