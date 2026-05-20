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
        from datetime import datetime, timezone

        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as e:
        log("WARN", f"resolve_linear_api_token: boto3 unavailable ({e}); skipping")
        return ""

    sm = boto3.client("secretsmanager", region_name=region)

    def _fetch_token() -> dict:
        resp = sm.get_secret_value(SecretId=secret_arn)
        return json.loads(resp["SecretString"])

    def _is_expiring(expires_at_iso: str, threshold_seconds: int = 60) -> bool:
        try:
            expiry = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00"))
        except ValueError:
            return True
        return (expiry - datetime.now(timezone.utc)).total_seconds() < threshold_seconds

    def _refresh(current: dict) -> dict | None:
        try:
            import urllib.parse
            import urllib.request
        except ImportError:
            return None

        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": current["refresh_token"],
            "client_id": current["client_id"],
            "client_secret": current["client_secret"],
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.linear.app/oauth/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            log("WARN", f"resolve_linear_api_token refresh failed: {type(e).__name__}: {e}")
            return None

        if "access_token" not in payload:
            return None

        now = datetime.now(timezone.utc)
        next_token = {
            **current,
            "access_token": payload["access_token"],
            "refresh_token": payload.get("refresh_token", current["refresh_token"]),
            "expires_at": (
                now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
                if "expires_in" not in payload
                else (now.replace(microsecond=0)).isoformat().replace("+00:00", "Z")
                # below replaces the simple form above with the real computation
            ),
            "scope": payload.get("scope", current["scope"]),
            "updated_at": now.isoformat().replace("+00:00", "Z"),
        }
        # Recompute expires_at properly.
        if "expires_in" in payload:
            from datetime import timedelta
            future = now + timedelta(seconds=int(payload["expires_in"]))
            next_token["expires_at"] = future.replace(microsecond=0).isoformat().replace("+00:00", "Z")

        try:
            sm.put_secret_value(SecretId=secret_arn, SecretString=json.dumps(next_token))
        except (ClientError, BotoCoreError) as e:
            log("WARN", f"resolve_linear_api_token: failed to persist refreshed token: {e}")
            # Even without persistence the in-memory token works for THIS run.
        return next_token

    try:
        token_obj = _fetch_token()
    except (ClientError, BotoCoreError) as e:
        code = ""
        if hasattr(e, "response"):
            code = getattr(e, "response", {}).get("Error", {}).get("Code", "") or ""
        severity = "ERROR" if code in ("AccessDeniedException", "ResourceNotFoundException") else "WARN"
        log(severity, f"resolve_linear_api_token failed: {type(e).__name__}: {e}")
        return ""

    if _is_expiring(token_obj.get("expires_at", "")):
        refreshed = _refresh(token_obj)
        if refreshed:
            token_obj = refreshed

    access = token_obj.get("access_token", "")
    if access:
        os.environ["LINEAR_API_TOKEN"] = access
    return access


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
    approval_timeout_s: int | None = None,
    initial_approvals: list[str] | None = None,
    initial_approval_gate_count: int = 0,
    approval_gate_cap: int | None = None,
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
        approval_timeout_s=approval_timeout_s,
        initial_approvals=initial_approvals or [],
        initial_approval_gate_count=initial_approval_gate_count,
        approval_gate_cap=approval_gate_cap,
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
