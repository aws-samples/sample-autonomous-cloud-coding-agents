"""Shared fixtures for agent unit tests."""

import pytest

# Env vars that agent code reads — clean them to avoid leaking host state.
_AGENT_ENV_VARS = [
    "TASK_TABLE_NAME",
    "TASK_EVENTS_TABLE_NAME",
    "USER_CONCURRENCY_TABLE_NAME",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN_SECRET_ARN",
    "REPO_URL",
    "ISSUE_NUMBER",
    "TASK_DESCRIPTION",
    "ANTHROPIC_MODEL",
    "MAX_TURNS",
    "MAX_BUDGET_USD",
    "DRY_RUN",
    "LOG_GROUP_NAME",
    "MEMORY_ID",
    "ENABLE_CLI_TELEMETRY",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Remove agent-related env vars before every test."""
    for var in _AGENT_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
