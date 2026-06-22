"""Agent configuration: constants and config-builder."""

import os
import sys
import uuid
from datetime import UTC

from models import AttachmentConfig, TaskConfig
from shell import log

AGENT_WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/workspace")

# The platform default workflow id used when a payload omits resolved_workflow
# (local/batch runs). Mirrors the create-task boundary's coding default.
DEFAULT_WORKFLOW_ID = "coding/new-task-v1"
# The repo-less platform default workflow (#248 Phase 3) — the one first-party
# id whose ``requires_repo`` is false. Used by the load-failure fallback to
# decide repo-optionality without loading the file.
REPO_LESS_DEFAULT_WORKFLOW_ID = "default/agent-v1"
# First-party workflow ids that operate on an existing pull request.
PR_WORKFLOW_IDS = frozenset(("coding/pr-iteration-v1", "coding/pr-review-v1"))
# First-party workflow ids that are writeable (NOT read-only). Used only by the
# load-failure fallback to bias an unrecognised id toward read-only (fail closed
# on the write-deny invariant). pr-review-v1 is intentionally excluded (it is
# read-only); default/agent-v1 is excluded because its conservative posture
# should fail closed too.
_KNOWN_WRITEABLE_WORKFLOW_IDS = frozenset(("coding/new-task-v1", "coding/pr-iteration-v1"))


def resolve_github_token() -> str:
    """Resolve GitHub token from Secrets Manager or environment variable.

    In deployed mode, GITHUB_TOKEN_SECRET_ARN is set and the token is fetched
    from Secrets Manager on first call, then cached in os.environ.
    For local development, falls back to GITHUB_TOKEN.
    """
    # Return cached value if already resolved
    cached = os.environ.get("GITHUB_TOKEN", "")
    if cached:
        return cached
    secret_arn = os.environ.get("GITHUB_TOKEN_SECRET_ARN")
    if secret_arn:
        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_arn)
        token = resp["SecretString"]
        # Cache in env so downstream tools (git, gh CLI) work unchanged
        os.environ["GITHUB_TOKEN"] = token
        return token
    return ""


def resolve_linear_api_token(channel_metadata: dict[str, str] | None = None) -> str:
    """Resolve the Linear OAuth access token from Secrets Manager.

    Phase 2.0b-O2: the orchestrator stamps ``linear_oauth_secret_arn``
    into the task record's ``channel_metadata`` at task-creation time.
    Pass that dict in via ``channel_metadata`` (the pipeline does this
    automatically). We fetch the per-workspace secret, parse the token
    JSON, refresh if expiring, and cache the access_token in
    ``LINEAR_API_TOKEN`` so downstream consumers (the Linear MCP's
    ``${LINEAR_API_TOKEN}`` placeholder in ``.mcp.json`` and
    ``linear_reactions.py``'s GraphQL Authorization header) keep working
    unchanged.

    For local development, a pre-set ``LINEAR_API_TOKEN`` env var
    short-circuits the lookup so the agent can run outside the runtime.

    Returns an empty string when the credential is absent — the agent-side
    MCP config then renders with an unresolved ``${LINEAR_API_TOKEN}``
    placeholder and the Linear MCP fails closed. This function is only
    called when ``channel_source == 'linear'``.

    Phase 2.0a (parked) used AgentCore Identity. Phase 2.0b-O2 reads
    Secrets Manager directly because AgentCore Identity's USER_FEDERATION
    flow has an open service-side bug (see memory/project_oauth_2_0b.md).
    """
    cached = os.environ.get("LINEAR_API_TOKEN", "")
    if cached:
        return cached

    # Prefer the per-task channel_metadata; fall back to env var so the
    # function can be called early (e.g. before pipeline construction)
    # via LINEAR_OAUTH_SECRET_ARN if the orchestrator set it that way.
    secret_arn = ""
    if channel_metadata:
        secret_arn = channel_metadata.get("linear_oauth_secret_arn", "")
    if not secret_arn:
        secret_arn = os.environ.get("LINEAR_OAUTH_SECRET_ARN", "")
    if not secret_arn:
        return ""

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        log("WARN", "resolve_linear_api_token: AWS_REGION not set; cannot resolve token")
        return ""

    try:
        import json
        from datetime import datetime, timedelta

        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:
        log("WARN", f"resolve_linear_api_token: boto3 unavailable ({e}); skipping")
        # nosemgrep: py-silent-success-masking -- optional Linear MCP; boto3 unavailable
        return ""

    sm = boto3.client("secretsmanager", region_name=region)

    def _fetch_token() -> dict | None:
        """Fetch + parse the per-workspace OAuth secret.

        Returns the parsed dict, or None if the SM payload can't be
        decoded as JSON (corrupted byte, missing SecretString key,
        etc.). The caller treats None like a missing secret — agent
        proceeds without Linear MCP rather than crashing the task
        pipeline thread on a raw traceback.
        """
        resp = sm.get_secret_value(SecretId=secret_arn)
        try:
            return json.loads(resp["SecretString"])
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            log(
                "ERROR",
                f"resolve_linear_api_token: secret '{secret_arn}' is not valid JSON "
                f"({type(e).__name__}: {e}); workspace requires re-onboarding",
            )
            # nosemgrep: py-silent-success-masking -- corrupt OAuth JSON; None means no token
            return None

    def _is_expiring(expires_at_iso: str, threshold_seconds: int = 60) -> bool:
        try:
            expiry = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))
        except ValueError:
            # Malformed timestamp: treat as expiring so the refresh path runs.
            # Log so a bad write earlier in the chain doesn't silently trigger
            # a refresh on every single task with no diagnostic trace.
            log(
                "WARN",
                f"_is_expiring: malformed expires_at '{expires_at_iso}'; treating as expiring",
            )
            return True
        return (expiry - datetime.now(UTC)).total_seconds() < threshold_seconds

    def _try_refresh_once(current: dict) -> tuple[str, dict | None]:
        """Single Linear /oauth/token POST.

        Returns one of:
          - ("success", new_token_dict)
          - ("invalid_grant", None) — Linear rejected the refresh_token,
            usually because another caller rotated it first
          - ("failure", None) — any other error (network, 5xx, missing
            fields). No retry; surface upward.
        """
        try:
            import urllib.error
            import urllib.parse
            import urllib.request
        except ImportError:
            return ("failure", None)

        body = urllib.parse.urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": current["refresh_token"],
                "client_id": current["client_id"],
                "client_secret": current["client_secret"],
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.linear.app/oauth/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected -- URL is hardcoded to https://api.linear.app/oauth/token above; no user-controlled input
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # Body may carry `{"error": "invalid_grant", ...}` even on 400.
            err_code = None
            try:
                err_payload = json.loads(e.read().decode("utf-8"))
                err_code = err_payload.get("error")
            except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
                # Body wasn't JSON or wasn't readable — caller will see
                # status code only, no error code.
                pass
            log(
                "WARN",
                f"resolve_linear_api_token refresh rejected: status={e.code} error={err_code}",
            )
            if err_code == "invalid_grant":
                return ("invalid_grant", None)
            return ("failure", None)
        except (urllib.error.URLError, OSError) as e:
            # Genuine network failures (DNS, timeout, TCP reset). Other
            # exceptions (KeyError on missing field, TypeError on bad
            # JSON shape) are programmer errors and should propagate
            # with a clear stack trace rather than being swallowed.
            log("WARN", f"resolve_linear_api_token refresh failed: {type(e).__name__}: {e}")
            return ("failure", None)

        if "access_token" not in payload:
            return ("failure", None)

        now = datetime.now(UTC)
        # Linear's `expires_in` is documented and reliably sent; if it's
        # missing we assume the access token is already valid for as long
        # as the refresh-token call took to round-trip — set expiry to now.
        if "expires_in" in payload:
            future = now + timedelta(seconds=int(payload["expires_in"]))
            expires_at_iso = future.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        else:
            expires_at_iso = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        next_token = {
            **current,
            "access_token": payload["access_token"],
            "refresh_token": payload.get("refresh_token", current["refresh_token"]),
            "expires_at": expires_at_iso,
            "scope": payload.get("scope", current["scope"]),
            "updated_at": now.isoformat().replace("+00:00", "Z"),
        }

        # Phase 2.0b-O2 review item S1: agent runtime no longer has
        # `secretsmanager:PutSecretValue` on the OAuth secret prefix —
        # the agent executes untrusted repo code, and writing tokens
        # back means a compromised agent could overwrite any
        # workspace's token. Lambdas (trusted code) handle persistence.
        # The freshly-refreshed in-memory token still works for THIS
        # task; the rotated refresh_token is lost when the agent exits,
        # but Linear's grace window (~30 min on replays) absorbs that
        # for the rare case where this agent refreshed strictly before
        # any Lambda did.

        # Positive-path log so operators diagnosing intermittent 401s have
        # a breadcrumb showing which workspace refreshed and to what expiry.
        ws_id = next_token.get("workspace_id", "?")
        ws_slug = next_token.get("workspace_slug", "?")
        log(
            "INFO",
            f"linear_oauth_refresh_ok workspace_id={ws_id} "
            f"workspace_slug={ws_slug} new_expires_at={expires_at_iso}",
        )
        return ("success", next_token)

    def _refresh(current: dict) -> dict | None:
        """Refresh with one retry on invalid_grant after re-reading the secret.

        Linear rotates refresh_tokens on every use. Concurrent callers
        (Lambda + agent + CLI) racing the same secret will see one
        succeed and the rest get `invalid_grant`. On invalid_grant,
        re-read SM (bypassing the just-failed token) and retry once if
        the refresh_token actually changed.
        """
        kind, refreshed = _try_refresh_once(current)
        if kind == "success":
            return refreshed
        if kind == "failure":
            return None

        # invalid_grant: maybe a concurrent caller refreshed first.
        log(
            "WARN",
            "resolve_linear_api_token: invalid_grant — re-reading secret to check "
            "for concurrent refresh",
        )
        try:
            fresh = _fetch_token()
        except (ClientError, BotoCoreError) as e:
            log("WARN", f"resolve_linear_api_token: re-read after invalid_grant failed: {e}")
            # nosemgrep: py-silent-success-masking -- transient SM re-read after invalid_grant
            return None
        if fresh is None:
            # Secret is unreadable (corrupted JSON). Already logged inside
            # _fetch_token; no point retrying refresh against bad data.
            return None

        if fresh.get("refresh_token") == current.get("refresh_token"):
            # No race — Linear truly rejected this refresh_token.
            log(
                "ERROR",
                "resolve_linear_api_token: refresh_token permanently rejected; re-onboard required",
            )
            return None

        # Concurrent caller rotated the token. If the freshly-read value
        # is itself usable, just take it.
        if not _is_expiring(fresh.get("expires_at", "")):
            log(
                "INFO",
                "resolve_linear_api_token: concurrent refresh detected; using freshly-read token",
            )
            return fresh

        # Concurrent refresh produced a token that's also already
        # expiring (rare). Retry once with the new refresh_token.
        kind2, refreshed2 = _try_refresh_once(fresh)
        if kind2 == "success":
            return refreshed2
        return None

    try:
        token_obj = _fetch_token()
    except (ClientError, BotoCoreError) as e:
        code = ""
        if hasattr(e, "response"):
            code = getattr(e, "response", {}).get("Error", {}).get("Code", "") or ""
        is_hard_failure = code in ("AccessDeniedException", "ResourceNotFoundException")
        severity = "ERROR" if is_hard_failure else "WARN"
        log(severity, f"resolve_linear_api_token failed: {type(e).__name__}: {e}")
        # nosemgrep: py-silent-success-masking -- SM fetch logged; empty token disables Linear
        return ""
    if token_obj is None:
        # Corrupted secret JSON; already logged inside _fetch_token.
        # Fail closed — Linear MCP renders with unresolved placeholder.
        return ""

    if _is_expiring(token_obj.get("expires_at", "")):
        refreshed = _refresh(token_obj)
        if refreshed:
            token_obj = refreshed

    access = token_obj.get("access_token", "")
    if access:
        os.environ["LINEAR_API_TOKEN"] = access
    return access


def resolve_jira_oauth_token(channel_metadata: dict[str, str] | None = None) -> str:
    """Resolve the Jira Cloud OAuth access token from Secrets Manager.

    The orchestrator stamps ``jira_oauth_secret_arn`` into the task
    record's ``channel_metadata`` at task-creation time. We fetch the
    per-tenant secret, parse the token JSON, and cache the access_token in
    ``JIRA_API_TOKEN`` so the agent-side Jira REST calls
    (``jira_reactions``) can authorize.

    **The agent never refreshes the token.** Unlike Linear, Atlassian
    *rotates the refresh_token on every use* — a successful refresh
    invalidates the stored refresh_token and returns a new one. The agent
    runtime has ``secretsmanager:GetSecretValue`` ONLY (no ``PutSecretValue``;
    a compromised agent must not be able to overwrite any tenant's OAuth
    bundle), so it cannot persist the rotated token. If the agent refreshed,
    it would consume the stored refresh_token, keep the replacement only in
    memory for this one task, and leave Secrets Manager holding a dead
    refresh_token — the next Lambda/agent resolve would get ``invalid_grant``
    and the tenant would require re-onboarding. So we deliberately do NOT
    refresh here: the trusted Lambda path (``jira-oauth-resolver.ts``, which
    has ``PutSecretValue``) owns all refreshes, and the agent uses whatever
    access_token the Lambdas have most-recently written.

    If the stored token is already expiring/expired, we fail closed — return
    an empty string and let the advisory Jira comments no-op. The
    orchestrator resolves (and refreshes) the token just before starting the
    session, so in practice the agent reads a freshly-written token with a
    full lifetime ahead of it.

    For local development, a pre-set ``JIRA_API_TOKEN`` env var
    short-circuits the lookup so the agent can run outside the runtime.

    This function is only called when ``channel_source == 'jira'``.
    """
    cached = os.environ.get("JIRA_API_TOKEN", "")
    if cached:
        return cached

    secret_arn = ""
    if channel_metadata:
        secret_arn = channel_metadata.get("jira_oauth_secret_arn", "")
    if not secret_arn:
        secret_arn = os.environ.get("JIRA_OAUTH_SECRET_ARN", "")
    if not secret_arn:
        return ""

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        log("WARN", "resolve_jira_oauth_token: AWS_REGION not set; cannot resolve token")
        return ""

    try:
        import json
        from datetime import datetime

        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:
        log("WARN", f"resolve_jira_oauth_token: boto3 unavailable ({e}); skipping")
        return ""

    sm = boto3.client("secretsmanager", region_name=region)

    def _fetch_token() -> dict | None:
        resp = sm.get_secret_value(SecretId=secret_arn)
        try:
            return json.loads(resp["SecretString"])
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            log(
                "ERROR",
                f"resolve_jira_oauth_token: secret '{secret_arn}' is not valid JSON "
                f"({type(e).__name__}: {e}); tenant requires re-onboarding",
            )
            return None

    def _is_expiring(expires_at_iso: str, threshold_seconds: int = 60) -> bool:
        try:
            expiry = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))
        except ValueError:
            log(
                "WARN",
                f"_is_expiring: malformed expires_at '{expires_at_iso}'; treating as expiring",
            )
            return True
        return (expiry - datetime.now(UTC)).total_seconds() < threshold_seconds

    try:
        token_obj = _fetch_token()
    except (ClientError, BotoCoreError) as e:
        code = ""
        if hasattr(e, "response"):
            code = getattr(e, "response", {}).get("Error", {}).get("Code", "") or ""
        is_hard_failure = code in ("AccessDeniedException", "ResourceNotFoundException")
        severity = "ERROR" if is_hard_failure else "WARN"
        log(severity, f"resolve_jira_oauth_token failed: {type(e).__name__}: {e}")
        return ""
    if token_obj is None:
        return ""

    # Fail closed if the stored token is expiring — the agent cannot refresh
    # without burning Atlassian's rotating refresh_token (see docstring). The
    # Lambda path owns refresh; advisory Jira comments simply no-op here.
    if _is_expiring(token_obj.get("expires_at", "")):
        log(
            "WARN",
            "resolve_jira_oauth_token: stored token is expiring and the agent does not "
            "refresh (Atlassian rotates refresh_tokens; agent lacks PutSecretValue). "
            "Failing closed — Jira comments will be skipped for this task.",
        )
        return ""

    access = token_obj.get("access_token", "")
    if access:
        os.environ["JIRA_API_TOKEN"] = access
    return access


def build_config(
    repo_url: str = "",
    task_description: str = "",
    issue_number: str = "",
    github_token: str = "",
    anthropic_model: str = "",
    max_turns: int = 10,
    max_budget_usd: float | None = None,
    aws_region: str = "",
    dry_run: bool = False,
    task_id: str = "",
    system_prompt_overrides: str = "",
    resolved_workflow: dict | None = None,
    branch_name: str = "",
    pr_number: str = "",
    channel_source: str = "",
    channel_metadata: dict[str, str] | None = None,
    trace: bool = False,
    user_id: str = "",
    approval_timeout_s: int | None = None,
    initial_approvals: list[str] | None = None,
    initial_approval_gate_count: int = 0,
    approval_gate_cap: int | None = None,
    attachments: list[dict] | None = None,
) -> TaskConfig:
    """Build and validate configuration from explicit parameters.

    Parameters fall back to environment variables if empty.
    """
    resolved_repo_url = repo_url or os.environ.get("REPO_URL", "")
    resolved_issue_number = issue_number or os.environ.get("ISSUE_NUMBER", "")
    resolved_task_description = task_description or os.environ.get("TASK_DESCRIPTION", "")
    resolved_github_token = github_token or resolve_github_token()
    resolved_aws_region = aws_region or os.environ.get("AWS_REGION", "")
    resolved_anthropic_model = anthropic_model or os.environ.get(
        "ANTHROPIC_MODEL", "us.anthropic.claude-sonnet-4-6"
    )

    # Resolve the workflow id (the create-task boundary already pinned it; local
    # batch runs default to the coding workflow). Required-input validation is
    # owned by the create-task boundary now; the agent re-checks only the
    # pr_number/issue/description shape needed to run.
    workflow = resolved_workflow or {"id": DEFAULT_WORKFLOW_ID, "version": "1.0.0"}
    workflow_id = workflow.get("id", DEFAULT_WORKFLOW_ID)
    is_pr_workflow = workflow_id in PR_WORKFLOW_IDS

    # Load the workflow up-front: it drives the Cedar principal, the read_only
    # flag, AND whether a repo is required (#248 Phase 3). Fall back to id-based
    # mapping when the file can't be loaded (e.g. a registry-only id in a future
    # phase) — a repo-less default is the safe assumption only for non-coding.
    from workflow import WorkflowValidationError, load_workflow, policy_principal_for

    try:
        workflow_obj = load_workflow(workflow_id)
        policy_principal = policy_principal_for(workflow_obj)
        workflow_read_only = workflow_obj.read_only
        workflow_requires_repo = workflow_obj.resolved_requires_repo
        workflow_allowed_tools = list(workflow_obj.agent_config.allowed_tools)
    except WorkflowValidationError as exc:
        # The pinned workflow file failed to load (corrupt YAML, schema drift, a
        # future registry-only id). This is the one place read_only/requires_repo
        # can be wrong without a loud failure, so: (1) log it, and (2) fail
        # *closed* — assume read-only (deny writes) for any id we don't recognise
        # as a known writeable coding workflow, rather than fail-open to writeable.
        log("ERROR", f"workflow {workflow_id!r} failed to load ({exc}); using fallback policy")
        policy_principal = "pr_review" if workflow_id == "coding/pr-review-v1" else "new_task"
        # Known writeable coding workflows are the only ids that fall back to
        # writeable; everything else (incl. an unrecognised id) is read-only.
        workflow_read_only = workflow_id not in _KNOWN_WRITEABLE_WORKFLOW_IDS
        # requires_repo: the repo-less platform default is the only id that does
        # NOT require a repo; every other id (coding or unknown) requires one.
        workflow_requires_repo = workflow_id != REPO_LESS_DEFAULT_WORKFLOW_ID
        # Tool surface is unknown without the file; empty = the runner falls back
        # to its built-in full surface. read_only (above, fail-closed) still drops
        # Write/Edit, so the write-deny invariant holds even on this path.
        workflow_allowed_tools = []

    errors = []
    # Repo + GitHub token are required only for repo-bound workflows; a repo-less
    # workflow (requires_repo:false) runs from task_description/attachments alone.
    if workflow_requires_repo:
        if not resolved_repo_url:
            errors.append("repo_url is required (e.g., 'owner/repo')")
        if not resolved_github_token:
            errors.append("github_token is required")
    if not resolved_aws_region:
        errors.append("aws_region is required for Bedrock")
    if is_pr_workflow:
        if not pr_number:
            errors.append(f"pr_number is required for the {workflow_id!r} workflow")
    elif not resolved_issue_number and not resolved_task_description:
        errors.append("Either issue_number or task_description is required")

    if errors:
        raise ValueError("; ".join(errors))

    # Validate attachment descriptors into typed models (Pydantic validation
    # surfaces schema mismatches between the orchestrator and agent early).
    validated_attachments: list[AttachmentConfig] = []
    if attachments:
        for i, raw_att in enumerate(attachments):
            try:
                validated_attachments.append(AttachmentConfig.model_validate(raw_att))
            except Exception as e:
                log("ERROR", f"Attachment[{i}] validation failed: {e}")
                raise ValueError(f"Attachment[{i}] validation failed: {e}") from e

    return TaskConfig(
        repo_url=resolved_repo_url,
        issue_number=resolved_issue_number,
        task_description=resolved_task_description,
        github_token=resolved_github_token,
        aws_region=resolved_aws_region,
        anthropic_model=resolved_anthropic_model,
        dry_run=dry_run,
        max_turns=max_turns,
        max_budget_usd=max_budget_usd,
        system_prompt_overrides=system_prompt_overrides,
        resolved_workflow=workflow,
        policy_principal=policy_principal,
        read_only=workflow_read_only,
        allowed_tools=workflow_allowed_tools,
        requires_repo=workflow_requires_repo,
        is_pr_workflow=is_pr_workflow,
        branch_name=branch_name,
        pr_number=pr_number,
        task_id=task_id or uuid.uuid4().hex[:12],
        channel_source=channel_source,
        channel_metadata=channel_metadata or {},
        trace=trace,
        user_id=user_id,
        approval_timeout_s=approval_timeout_s,
        initial_approvals=initial_approvals or [],
        initial_approval_gate_count=initial_approval_gate_count,
        approval_gate_cap=approval_gate_cap,
        attachments=validated_attachments,
    )


def get_config() -> TaskConfig:
    """Parse configuration from environment variables (local batch mode)."""
    try:
        return build_config(
            repo_url=os.environ.get("REPO_URL", ""),
            task_description=os.environ.get("TASK_DESCRIPTION", ""),
            issue_number=os.environ.get("ISSUE_NUMBER", ""),
            github_token=os.environ.get("GITHUB_TOKEN", ""),
            anthropic_model=os.environ.get("ANTHROPIC_MODEL", ""),
            max_turns=int(os.environ.get("MAX_TURNS", "100")),
            max_budget_usd=float(os.environ.get("MAX_BUDGET_USD", "0")) or None,
            aws_region=os.environ.get("AWS_REGION", ""),
            dry_run=os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes"),
            # Local-batch ``--trace`` parity (design §10.1). Without
            # these env vars a developer running the agent outside
            # AgentCore could never exercise the trace path. Both are
            # opt-in; empty ``USER_ID`` with ``TRACE=1`` logs a skip
            # warning (see ``pipeline.run_task``) rather than writing
            # an unreachable ``traces//`` key.
            trace=os.environ.get("TRACE", "").lower() in ("1", "true", "yes"),
            user_id=os.environ.get("USER_ID", ""),
        )
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
