import os
import sys
import uuid
from datetime import UTC

from models import AttachmentConfig, TaskConfig
from shared_constants import SHARED_CONSTANTS
from shell import log

AGENT_WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/workspace")

DEFAULT_WORKFLOW_ID = "coding/new-task-v1"
REPO_LESS_DEFAULT_WORKFLOW_ID = "default/agent-v1"
PR_WORKFLOW_IDS = frozenset(("coding/pr-iteration-v1", "coding/pr-review-v1", "coding/restack-v1"))
NEEDS_INPUT_MARKER = "[[ABCA_NEEDS_INPUT]]"
_KNOWN_WRITEABLE_WORKFLOW_IDS = frozenset(
    (
        "coding/new-task-v1",
        "coding/pr-iteration-v1",
        "coding/restack-v1",
    )
)


def resolve_github_token() -> str:
    """Resolve GitHub token from Secrets Manager or environment variable.

    In deployed mode, GITHUB_TOKEN_SECRET_ARN is set and the token is fetched
    from Secrets Manager on first call, then cached in os.environ.
    For local development, falls back to GITHUB_TOKEN.
    """
    cached = os.environ.get("GITHUB_TOKEN", "")
    if cached:
        return cached
    secret_arn = os.environ.get("GITHUB_TOKEN_SECRET_ARN")
    if secret_arn:
        from aws_session import platform_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = platform_client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_arn)
        token = resp["SecretString"]
        os.environ["GITHUB_TOKEN"] = token
        return token
    return ""


# AgentCore keys a cached grant by the whole token request, customParameters
# included: the same user and provider return the cached token when these are
# passed and "needs consent" when they are omitted.
_LINEAR_VAULT_CONTRACT = SHARED_CONSTANTS["linear_vault"]
_LINEAR_VAULT_SCOPES = list(_LINEAR_VAULT_CONTRACT["scopes"])
_LINEAR_VAULT_CUSTOM_PARAMS = dict(_LINEAR_VAULT_CONTRACT["custom_parameters"])
# USER_FEDERATION requires a return URL; it is never visited here.
_LINEAR_VAULT_RETURN_URL = "http://localhost:8080/oauth/callback"


def _resolve_linear_token_via_vault(
    channel_metadata: dict[str, str] | None = None,
) -> str:
    if os.environ.get("LINEAR_VAULT_ENABLED") != "true":
        return ""
    workload_name = os.environ.get("LINEAR_WORKLOAD_IDENTITY_NAME", "")
    if not workload_name:
        return ""

    provider_name = ""
    workspace_id = ""
    recorded_user_id = ""
    if channel_metadata:
        provider_name = channel_metadata.get("linear_provider_name", "")
        workspace_id = channel_metadata.get("linear_workspace_id", "")
        recorded_user_id = channel_metadata.get("linear_vault_user_id", "")
    if not provider_name or not workspace_id:
        return ""

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        log("WARN", "_resolve_linear_token_via_vault: AWS_REGION not set; skipping vault")
        return ""

    try:
        import boto3  # noqa: F401  -- availability probe for the graceful skip below
        from botocore.exceptions import BotoCoreError, ClientError

        from aws_session import platform_client
    except ImportError as e:
        log("WARN", f"_resolve_linear_token_via_vault: boto3 unavailable ({e}); skipping")
        # nosemgrep: py-silent-success-masking -- optional vault token; boto3 unavailable
        return ""

    user_id = recorded_user_id.strip() or f"linear-workspace-{workspace_id}"

    try:
        client = platform_client("bedrock-agentcore", region_name=region)
        wat = client.get_workload_access_token_for_user_id(
            workloadName=workload_name,
            userId=user_id,
        )
        workload_token = wat.get("workloadAccessToken", "")
        if not workload_token:
            log("WARN", "_resolve_linear_token_via_vault: no workload token; falling back to SM")
            return ""

        resp = client.get_resource_oauth2_token(
            workloadIdentityToken=workload_token,
            resourceCredentialProviderName=provider_name,
            scopes=_LINEAR_VAULT_SCOPES,
            oauth2Flow="USER_FEDERATION",
            resourceOauth2ReturnUrl=_LINEAR_VAULT_RETURN_URL,
            customParameters=_LINEAR_VAULT_CUSTOM_PARAMS,
        )
        access = resp.get("accessToken", "")
        if access:
            log(
                "INFO",
                f"linear_vault_token_ok workspace_id={workspace_id} provider={provider_name}",
            )
            return access
        log(
            "WARN",
            "_resolve_linear_token_via_vault: consent required (no cached grant); SM fallback",
        )
        return ""
    except (ClientError, BotoCoreError) as e:
        log(
            "WARN",
            f"_resolve_linear_token_via_vault: vault call failed ({type(e).__name__}); SM fallback",
        )
        # nosemgrep: py-silent-success-masking -- vault unavailable; SM fallback follows
        return ""


def resolve_linear_api_token(  # noqa: C901 -- 34 when the ceiling of 15 was set; must not grow
    channel_metadata: dict[str, str] | None = None, *, force: bool = False
) -> str:
    """Resolve the Linear OAuth access token and cache it in ``LINEAR_API_TOKEN``.

    Tries the AgentCore Identity Token Vault first, for workspaces onboarded
    through the vault, then the per-workspace Secrets Manager secret named by
    ``linear_oauth_secret_arn`` in ``channel_metadata``.

    **The agent never refreshes the token**: Linear rotates the refresh_token on
    every use (https://linear.app/developers/oauth-2-0-authentication) and the
    agent runtime has ``secretsmanager:GetSecretValue`` only. If the stored
    token is expiring this fails closed (empty string).

    A pre-set ``LINEAR_API_TOKEN`` env var short-circuits the lookup. ``force``
    skips that short-circuit and resolves again; when nothing can be resolved
    then, the cached value stays in place.

    Returns an empty string when the credential is absent.
    """
    cached = os.environ.get("LINEAR_API_TOKEN", "")
    if cached and not force:
        return cached

    vault_token = _resolve_linear_token_via_vault(channel_metadata)
    if vault_token:
        os.environ["LINEAR_API_TOKEN"] = vault_token
        return vault_token

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
        from datetime import datetime

        import boto3  # noqa: F401  -- availability probe for the graceful skip below
        from botocore.exceptions import BotoCoreError, ClientError

        from aws_session import platform_client
    except ImportError as e:
        log("WARN", f"resolve_linear_api_token: boto3 unavailable ({e}); skipping")
        # nosemgrep: py-silent-success-masking -- optional Linear reactions token; boto3 unavailable
        return ""

    sm = platform_client("secretsmanager", region_name=region)

    def _fetch_token() -> dict | None:
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
            expiry = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))  # noqa: FURB162 -- the rewrite is not equivalent for malformed input
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
        log(severity, f"resolve_linear_api_token failed: {type(e).__name__}: {e}")
        # nosemgrep: py-silent-success-masking -- SM fetch logged; empty token disables Linear
        return ""
    if token_obj is None:
        return ""

    if _is_expiring(token_obj.get("expires_at", "")):
        log(
            "WARN",
            "resolve_linear_api_token: stored token is expiring and the agent does not "
            "refresh (Linear rotates refresh_tokens; agent lacks PutSecretValue). "
            "Failing closed until a Lambda has stored a new token.",
        )
        return ""

    access = token_obj.get("access_token", "")
    if access:
        os.environ["LINEAR_API_TOKEN"] = access
    return access


_JIRA_TASK_CREDENTIAL_ENV_VARS = (
    "JIRA_API_TOKEN",
    "JIRA_APP_ACTOR_CONFIGURED",
    "JIRA_APP_ACTOR_PROXY_URL",
    "JIRA_APP_ACTOR_SHARED_SECRET",
)


def clear_jira_task_credentials() -> None:
    """Remove Jira credentials left by an earlier task in this process."""
    for name in _JIRA_TASK_CREDENTIAL_ENV_VARS:
        os.environ.pop(name, None)


def resolve_jira_oauth_token(channel_metadata: dict[str, str] | None = None) -> str:  # noqa: C901 -- 21 when the ceiling of 15 was set; must not grow
    """Resolve Jira outbound credentials from Secrets Manager.

    Reads the secret named by ``jira_oauth_secret_arn`` in ``channel_metadata``.
    A tenant configured with a Forge app actor gets ``JIRA_APP_ACTOR_*``
    environment variables; older tenants retain ``JIRA_API_TOKEN`` as an
    explicit migration fallback.

    **The agent never refreshes the token**: Atlassian rotates the refresh_token
    on every use and the agent runtime has ``secretsmanager:GetSecretValue``
    only. If the stored token is already expiring/expired this fails closed
    (empty string).
    """
    secret_arn = ""
    if channel_metadata:
        secret_arn = channel_metadata.get("jira_oauth_secret_arn", "")
    if not secret_arn:
        secret_arn = os.environ.get("JIRA_OAUTH_SECRET_ARN", "")
    cached = os.environ.get("JIRA_API_TOKEN", "")
    if cached and not secret_arn and channel_metadata is None:
        return cached

    if channel_metadata is not None or secret_arn:
        clear_jira_task_credentials()
    if not secret_arn:
        return ""

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        log("WARN", "resolve_jira_oauth_token: AWS_REGION not set; cannot resolve token")
        return ""

    try:
        import json
        from datetime import datetime

        import boto3  # noqa: F401  -- availability probe for the graceful skip below
        from botocore.exceptions import BotoCoreError, ClientError

        from aws_session import platform_client
    except ImportError as e:
        log("WARN", f"resolve_jira_oauth_token: boto3 unavailable ({e}); skipping")
        return ""  # nosemgrep: py-silent-success-masking -- Jira feedback is advisory

    sm = platform_client("secretsmanager", region_name=region)

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
            return None  # nosemgrep: py-silent-success-masking -- bad secret disables writes

    def _is_expiring(expires_at_iso: str, threshold_seconds: int = 60) -> bool:
        try:
            expiry = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))  # noqa: FURB162 -- the rewrite is not equivalent for malformed input
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
        return ""  # nosemgrep: py-silent-success-masking -- feedback cannot fail the task
    if token_obj is None:
        return ""
    if not isinstance(token_obj, dict):
        log(
            "ERROR",
            f"resolve_jira_oauth_token: secret '{secret_arn}' contains non-object JSON; "
            "tenant requires re-onboarding",
        )
        return ""

    app_actor_fields = (
        "app_actor_proxy_url",
        "app_actor_shared_secret",
        "app_actor_account_id",
        "app_actor_display_name",
        "app_actor_configured_at",
    )
    raw_app_proxy_url = token_obj.get("app_actor_proxy_url", "")
    raw_app_shared_secret = token_obj.get("app_actor_shared_secret", "")
    app_proxy_url = raw_app_proxy_url if isinstance(raw_app_proxy_url, str) else ""
    app_shared_secret = raw_app_shared_secret if isinstance(raw_app_shared_secret, str) else ""
    if any(field in token_obj for field in app_actor_fields):
        os.environ["JIRA_APP_ACTOR_CONFIGURED"] = "1"
        if app_proxy_url:
            os.environ["JIRA_APP_ACTOR_PROXY_URL"] = app_proxy_url
        if app_shared_secret:
            os.environ["JIRA_APP_ACTOR_SHARED_SECRET"] = app_shared_secret

    if _is_expiring(token_obj.get("expires_at", "")):
        suffix = (
            " Forge app-actor writes remain enabled."
            if os.environ.get("JIRA_APP_ACTOR_CONFIGURED") == "1"
            else " Jira OAuth fallback writes will be skipped for this task."
        )
        log(
            "WARN",
            "resolve_jira_oauth_token: stored token is expiring and the agent does not "
            "refresh (Atlassian rotates refresh_tokens; agent lacks PutSecretValue). "
            f"Failing closed for OAuth.{suffix}",
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
    haiku_model: str = "",
    max_turns: int = 10,
    max_budget_usd: float | None = None,
    aws_region: str = "",
    dry_run: bool = False,
    task_id: str = "",
    system_prompt_overrides: str = "",
    build_command: str = "",
    lint_command: str = "",
    resolved_workflow: dict | None = None,
    branch_name: str = "",
    pr_number: str = "",
    base_branch: str | None = None,
    merge_branches: list[str] | None = None,
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
        "ANTHROPIC_MODEL", "global.anthropic.claude-opus-5-5"
    )
    # Bedrock needs a geo-prefixed inference-profile id here, not a bare model id.
    resolved_haiku_model = haiku_model or os.environ.get(
        "ANTHROPIC_DEFAULT_HAIKU_MODEL", "global.anthropic.claude-haiku-5-5"
    )

    workflow = resolved_workflow or {"id": DEFAULT_WORKFLOW_ID, "version": "1.0.0"}
    workflow_id = workflow.get("id", DEFAULT_WORKFLOW_ID)
    is_pr_workflow = workflow_id in PR_WORKFLOW_IDS

    from workflow import WorkflowValidationError, load_workflow, policy_principal_for

    try:
        workflow_obj = load_workflow(workflow_id)
        policy_principal = policy_principal_for(workflow_obj)
        workflow_read_only = workflow_obj.read_only
        workflow_requires_repo = workflow_obj.resolved_requires_repo
        workflow_allowed_tools = list(workflow_obj.agent_config.allowed_tools)
    except WorkflowValidationError as exc:
        log("ERROR", f"workflow {workflow_id!r} failed to load ({exc}); using fallback policy")
        policy_principal = "pr_review" if workflow_id == "coding/pr-review-v1" else "new_task"
        workflow_read_only = workflow_id not in _KNOWN_WRITEABLE_WORKFLOW_IDS
        workflow_requires_repo = workflow_id != REPO_LESS_DEFAULT_WORKFLOW_ID
        workflow_allowed_tools = []

    errors = []
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
        haiku_model=resolved_haiku_model,
        dry_run=dry_run,
        max_turns=max_turns,
        max_budget_usd=max_budget_usd,
        system_prompt_overrides=system_prompt_overrides,
        build_command=build_command,
        lint_command=lint_command,
        resolved_workflow=workflow,
        policy_principal=policy_principal,
        read_only=workflow_read_only,
        allowed_tools=workflow_allowed_tools,
        requires_repo=workflow_requires_repo,
        is_pr_workflow=is_pr_workflow,
        branch_name=branch_name,
        pr_number=pr_number,
        base_branch=base_branch,
        merge_branches=merge_branches or [],
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
            trace=os.environ.get("TRACE", "").lower() in ("1", "true", "yes"),
            user_id=os.environ.get("USER_ID", ""),
        )
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
