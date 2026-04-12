"""Agent configuration: constants and config-builder."""

import os
import sys
import uuid

from models import TaskType

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
) -> dict:
    """Build and validate configuration from explicit parameters.

    Parameters fall back to environment variables if empty.
    """
    config = {
        "repo_url": repo_url or os.environ.get("REPO_URL", ""),
        "issue_number": issue_number or os.environ.get("ISSUE_NUMBER", ""),
        "task_description": task_description or os.environ.get("TASK_DESCRIPTION", ""),
        "github_token": github_token or resolve_github_token(),
        "aws_region": aws_region or os.environ.get("AWS_REGION", ""),
        "anthropic_model": anthropic_model
        or os.environ.get("ANTHROPIC_MODEL", "us.anthropic.claude-sonnet-4-6"),
        "dry_run": dry_run,
        "max_turns": max_turns,
        "max_budget_usd": max_budget_usd,
        "system_prompt_overrides": system_prompt_overrides,
        "task_type": task_type,
        "branch_name": branch_name,
        "pr_number": pr_number,
    }

    errors = []
    if not config["repo_url"]:
        errors.append("repo_url is required (e.g., 'owner/repo')")
    if not config["github_token"]:
        errors.append("github_token is required")
    if not config["aws_region"]:
        errors.append("aws_region is required for Bedrock")
    try:
        task = TaskType(config["task_type"])
    except ValueError:
        errors.append(f"Invalid task_type: '{config['task_type']}'")
        task = None
    if task and task.is_pr_task:
        if not config["pr_number"]:
            errors.append("pr_number is required for pr_iteration/pr_review task type")
    elif task and not config["issue_number"] and not config["task_description"]:
        errors.append("Either issue_number or task_description is required")

    if errors:
        raise ValueError("; ".join(errors))

    config["task_id"] = task_id or uuid.uuid4().hex[:12]
    return config


def get_config() -> dict:
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
