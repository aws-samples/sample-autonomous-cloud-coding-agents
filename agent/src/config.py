"""Agent configuration: constants and config-builder."""

import os
import sys
import uuid

from models import TaskConfig, TaskType

AGENT_WORKSPACE = os.environ.get("AGENT_WORKSPACE", "/workspace")

# Task types that operate on an existing pull request.
PR_TASK_TYPES = frozenset(("pr_iteration", "pr_review"))


def _resolve_github_token_via_token_vault(
    workload_identity_name: str,
    credential_provider_name: str,
) -> str:
    """Resolve GitHub token via AgentCore Token Vault (M2M OAuth2 flow)."""
    import boto3

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    client = boto3.client("bedrock-agentcore", region_name=region)

    # Step 1: obtain a workload access token (represents the agent's identity)
    try:
        wat_response = client.get_workload_access_token(
            workloadName=workload_identity_name,
        )
    except Exception as exc:
        raise RuntimeError(
            f"Token Vault: failed to get workload access token "
            f"for '{workload_identity_name}': {exc}"
        ) from exc

    workload_access_token = wat_response.get("workloadAccessToken")
    if not workload_access_token:
        raise RuntimeError("Token Vault returned empty workload access token")

    # Step 2: exchange for a GitHub OAuth token via M2M flow
    try:
        token_response = client.get_resource_oauth2_token(
            workloadIdentityToken=workload_access_token,
            resourceCredentialProviderName=credential_provider_name,
            scopes=["repo"],
            oauth2Flow="M2M",
        )
    except Exception as exc:
        raise RuntimeError(
            f"Token Vault: failed to exchange for GitHub OAuth token via provider "
            f"'{credential_provider_name}': {exc}"
        ) from exc

    access_token = token_response.get("accessToken")
    if not access_token:
        raise RuntimeError("Token Vault returned empty GitHub access token")

    return access_token


def resolve_github_token() -> str:
    """Resolve GitHub token from Token Vault, Secrets Manager, or environment variable.

    Resolution order (first match wins):
    1. GITHUB_TOKEN env var (set externally or cached from a prior resolution)
    2. AgentCore Token Vault (preferred) — when WORKLOAD_IDENTITY_NAME and
       GITHUB_OAUTH2_PROVIDER_NAME are set
    3. Secrets Manager PAT — when GITHUB_TOKEN_SECRET_ARN is set
    4. Empty string (no credential configured)
    """
    # Return cached value if already resolved
    cached = os.environ.get("GITHUB_TOKEN", "")
    if cached:
        return cached

    # Prefer Token Vault if configured
    workload_name = os.environ.get("WORKLOAD_IDENTITY_NAME")
    provider_name = os.environ.get("GITHUB_OAUTH2_PROVIDER_NAME")
    if workload_name and provider_name:
        token = _resolve_github_token_via_token_vault(workload_name, provider_name)
        os.environ["GITHUB_TOKEN"] = token
        return token

    # Fall back to Secrets Manager PAT
    secret_arn = os.environ.get("GITHUB_TOKEN_SECRET_ARN")
    if secret_arn:
        import boto3

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_arn)
        token = resp.get("SecretString")
        if not token:
            raise RuntimeError(
                f"GitHub token secret '{secret_arn}' is empty or stored as binary "
                "— ensure the secret contains a plaintext PAT string"
            )
        # Cache in env so downstream tools (git, gh CLI) work unchanged
        os.environ["GITHUB_TOKEN"] = token
        return token
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
        )
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
