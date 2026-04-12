"""Data models and enumerations for the agent pipeline."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class TaskType(StrEnum):
    """Supported task types."""

    new_task = "new_task"
    pr_iteration = "pr_iteration"
    pr_review = "pr_review"

    @property
    def is_pr_task(self) -> bool:
        return self in (TaskType.pr_iteration, TaskType.pr_review)

    @property
    def is_read_only(self) -> bool:
        return self == TaskType.pr_review


class IssueComment(BaseModel):
    model_config = ConfigDict(frozen=True)

    author: str
    body: str


class GitHubIssue(BaseModel):
    model_config = ConfigDict(frozen=True)

    title: str
    body: str = ""
    number: int
    comments: list[IssueComment] = []


class MemoryContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    repo_knowledge: list[str] = []
    past_episodes: list[str] = []


class HydratedContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_prompt: str
    issue: GitHubIssue | None = None
    resolved_base_branch: str | None = None
    truncated: bool = False
    memory_context: MemoryContext | None = None


class TaskConfig(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    repo_url: str
    issue_number: str = ""
    task_description: str = ""
    github_token: str
    aws_region: str
    anthropic_model: str = "us.anthropic.claude-sonnet-4-6"
    dry_run: bool = False
    max_turns: int = 10
    max_budget_usd: float | None = None
    system_prompt_overrides: str = ""
    task_type: str = "new_task"
    branch_name: str = ""
    pr_number: str = ""
    task_id: str = ""
    # Enriched mid-flight by pipeline.py:
    cedar_policies: list[str] = []
    issue: GitHubIssue | None = None
    base_branch: str | None = None


class RepoSetup(BaseModel):
    model_config = ConfigDict(frozen=True)

    repo_dir: str
    branch: str
    notes: list[str] = []
    build_before: bool = True
    lint_before: bool = True
    default_branch: str = "main"


class TokenUsage(BaseModel):
    model_config = ConfigDict(frozen=True)

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class AgentResult(BaseModel):
    status: str = "unknown"
    turns: int = 0
    num_turns: int = 0
    cost_usd: float | None = None
    duration_ms: int = 0
    duration_api_ms: int = 0
    session_id: str = ""
    error: str | None = None
    usage: TokenUsage | None = None


class TaskResult(BaseModel):
    status: str
    agent_status: str = "unknown"
    pr_url: str | None = None
    build_passed: bool = False
    lint_passed: bool = False
    cost_usd: float | None = None
    turns: int | None = None
    duration_s: float = 0.0
    task_id: str = ""
    disk_before: str = ""
    disk_after: str = ""
    disk_delta: str = ""
    prompt_version: str | None = None
    memory_written: bool = False
    error: str | None = None
    session_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None
