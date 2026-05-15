"""Agent configuration: constants and config-builder."""

import os
import sys
import uuid

from models import TaskConfig, TaskType
from shell import log

AGENT_WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/workspace")

# Task types that operate on an existing pull request.
PR_TASK_TYPES = frozenset(("pr_iteration", "pr_review"))


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


def resolve_linear_api_token() -> str:
    """Resolve the Linear personal API token via AgentCore Identity.

    In deployed mode, ``LINEAR_API_KEY_PROVIDER_NAME`` names a credential
    provider in AgentCore Identity (the token vault). The agent runtime
    auto-injects a workload access token into ``BedrockAgentCoreContext``;
    we exchange that for the API key value and cache it in
    ``LINEAR_API_TOKEN`` so downstream consumers (the Linear MCP's
    ``${LINEAR_API_TOKEN}`` placeholder in ``.mcp.json`` and
    ``linear_reactions.py``'s GraphQL Authorization header) keep working
    unchanged.

    For local development, falls back to a pre-set ``LINEAR_API_TOKEN``
    env var so the agent can run outside AgentCore Runtime.

    Returns an empty string if the credential is absent — the agent-side
    MCP config then renders with an unresolved ``${LINEAR_API_TOKEN}`` env
    placeholder, and the Linear MCP will reject the request (fail-closed).
    This function is only called when ``channel_source == 'linear'``.

    Phase 2.0a: replaces the prior Secrets Manager path. Phase 2.0b will
    swap this function entirely for the ``@requires_access_token`` OAuth
    decorator pattern; this imperative shape exists because API keys
    don't need refresh and the MCP config expects a static token.
    """
    cached = os.environ.get("LINEAR_API_TOKEN", "")
    if cached:
        return cached

    provider_name = os.environ.get("LINEAR_API_KEY_PROVIDER_NAME")
    if not provider_name:
        return ""

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if not region:
        log("WARN", "resolve_linear_api_token: AWS_REGION not set; cannot resolve API key")
        return ""

    try:
        import asyncio

        from bedrock_agentcore.runtime import BedrockAgentCoreContext
        from bedrock_agentcore.services.identity import IdentityClient
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:
        # bedrock_agentcore SDK missing from the container image — degrade
        # gracefully rather than hard-crashing the agent. The Linear MCP
        # will fail on first call with a clear auth error.
        log("WARN", f"resolve_linear_api_token: bedrock_agentcore unavailable ({e}); skipping")
        return ""

    try:
        workload_token = BedrockAgentCoreContext.get_workload_access_token()
        if workload_token is None:
            # Outside the AgentCore Runtime container (e.g. local dev). The
            # SDK's `_set_up_local_auth` fallback writes `.agentcore.json`
            # which doesn't fit our flow; bail out and let the caller see
            # an empty token so the MCP config fails closed.
            log(
                "WARN",
                "resolve_linear_api_token: workload access token not in context "
                "(agent must run inside AgentCore Runtime, or set LINEAR_API_TOKEN "
                "directly for local dev)",
            )
            return ""

        client = IdentityClient(region=region)
        token = (
            asyncio.run(
                client.get_api_key(
                    provider_name=provider_name,
                    agent_identity_token=workload_token,
                )
            )
            or ""
        )
        if token:
            os.environ["LINEAR_API_TOKEN"] = token
        return token
    except ClientError as e:
        # Narrowed from a broader `except` per #63 review. AccessDenied is
        # logged at ERROR because it's a persistent IAM misconfig (likely
        # the runtime role missing bedrock-agentcore:GetResourceApiKey or
        # GetWorkloadAccessToken) that should page someone, not a transient
        # blip. ResourceNotFound (provider name unknown) is also persistent
        # — same severity. Other ClientErrors are likely transient (throttle,
        # network blip) and stay at WARN.
        code = e.response.get("Error", {}).get("Code", "")
        severity = (
            "ERROR" if code in ("AccessDeniedException", "ResourceNotFoundException") else "WARN"
        )
        log(severity, f"resolve_linear_api_token failed: {type(e).__name__}: {e}")
        return ""
    except BotoCoreError as e:
        # Never let an Identity outage crash the agent. The Linear MCP will
        # fail on first call with a clear auth error.
        log("WARN", f"resolve_linear_api_token failed: {type(e).__name__}: {e}")
        return ""


def build_config(
    repo_url: str,
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
    task_type: str = "new_task",
    branch_name: str = "",
    pr_number: str = "",
    channel_source: str = "",
    channel_metadata: dict[str, str] | None = None,
    trace: bool = False,
    user_id: str = "",
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

    errors = []
    if not resolved_repo_url:
        errors.append("repo_url is required (e.g., 'owner/repo')")
    if not resolved_github_token:
        errors.append("github_token is required")
    if not resolved_aws_region:
        errors.append("aws_region is required for Bedrock")
    try:
        task = TaskType(task_type)
    except ValueError:
        errors.append(f"Invalid task_type: '{task_type}'")
        task = None
    if task and task.is_pr_task:
        if not pr_number:
            errors.append("pr_number is required for pr_iteration/pr_review task type")
    elif task and not resolved_issue_number and not resolved_task_description:
        errors.append("Either issue_number or task_description is required")

    if errors:
        raise ValueError("; ".join(errors))

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
        task_type=task_type,
        branch_name=branch_name,
        pr_number=pr_number,
        task_id=task_id or uuid.uuid4().hex[:12],
        channel_source=channel_source,
        channel_metadata=channel_metadata or {},
        trace=trace,
        user_id=user_id,
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
