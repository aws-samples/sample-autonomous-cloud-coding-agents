"""Data models and enumerations for the agent pipeline."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    """Single GitHub issue comment — mirrors ``IssueComment`` in context-hydration.ts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: int
    author: str
    body: str


class GitHubIssue(BaseModel):
    """GitHub issue slice — mirrors ``GitHubIssueContext`` in context-hydration.ts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    title: str
    body: str = ""
    number: int
    comments: list[IssueComment] = Field(default_factory=list)


class MemoryContext(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    repo_knowledge: list[str] = Field(default_factory=list)
    past_episodes: list[str] = Field(default_factory=list)


# Trust classification for content sources — mirrors ContentTrustLevel in context-hydration.ts.
# 'trusted': user-supplied input, 'untrusted-external': GitHub-sourced content,
# 'memory': memory records.
ContentTrustLevel = Literal["trusted", "untrusted-external", "memory"]

# Bump when this agent supports a new orchestrator HydratedContext shape
# (see cdk/src/handlers/shared/context-hydration.ts).
SUPPORTED_HYDRATED_CONTEXT_VERSION = 1


class HydratedContext(BaseModel):
    """Orchestrator context JSON — keep in sync with HydratedContext in context-hydration.ts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    version: int = 1
    user_prompt: str
    issue: GitHubIssue | None = None
    memory_context: MemoryContext | None = None
    sources: list[str] = Field(default_factory=list)
    token_estimate: int = 0
    truncated: bool = False
    fallback_error: str | None = None
    guardrail_blocked: str | None = None
    resolved_branch_name: str | None = None
    resolved_base_branch: str | None = None
    content_trust: dict[str, ContentTrustLevel] | None = None

    @model_validator(mode="after")
    def version_supported(self) -> Self:
        if self.version > SUPPORTED_HYDRATED_CONTEXT_VERSION:
            raise ValueError(
                f"HydratedContext schema version {self.version} is not supported by this agent "
                f"(max supported: {SUPPORTED_HYDRATED_CONTEXT_VERSION}). "
                "Deploy an updated agent container image."
            )
        return self


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
    screenshot_urls: list[str] = Field(default_factory=list)
