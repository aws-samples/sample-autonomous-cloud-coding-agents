"""Agent configuration: constants and config-builder."""

import os
import sys
import uuid

from models import TaskConfig, TaskType

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
