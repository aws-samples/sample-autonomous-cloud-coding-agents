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
    # Platform user_id (Cognito ``sub``) threaded from the orchestrator
    # payload. Required ONLY when ``trace`` is true — the agent writes
    # the trajectory dump to ``traces/<user_id>/<task_id>.jsonl.gz``
    # (design §10.1), and the ``get-trace-url`` handler's per-caller-
    # prefix guard refuses to presign keys outside the caller's own
    # ``traces/<user_id>/`` prefix. Empty-string default for local
    # batch runs (no orchestrator in the loop; no trace upload).
    user_id: str = ""
    # Opt-in debug preview cap (design §10.1). Threaded to BOTH the
    # pipeline.py milestone writer AND the runner.py turn/tool writer —
    # the runner's writer is where thinking/tool_input/tool_result
    # previews live, so dropping ``trace`` here silently no-ops the
    # feature for the fields that matter.
    trace: bool = False
    # Enriched mid-flight by pipeline.py:
    cedar_policies: list[str] = []
    issue: GitHubIssue | None = None
    base_branch: str | None = None

    @model_validator(mode="after")
    def _validate_trace_requires_user_id(self) -> Self:
        """Fail at construction when trace=True without a user_id.

        The trace trajectory is uploaded to
        ``traces/<user_id>/<task_id>.jsonl.gz`` (design §10.1). An empty
        ``user_id`` produces ``traces//<task_id>.jsonl.gz``, which the
        ``get-trace-url`` handler's per-caller-prefix guard refuses.
        Catching this at construction time surfaces the misconfiguration
        locally / in CI instead of deferring to runtime S3 upload.
        """
        if self.trace and not self.user_id:
            raise ValueError(
                "trace=True requires a non-empty user_id. Local/batch runs "
                "without an orchestrator must either set trace=False (the "
                "default) or supply user_id explicitly. The trace trajectory "
                "is uploaded to traces/<user_id>/<task_id>.jsonl.gz (design "
                "§10.1), and the get-trace-url handler refuses keys outside "
                "the caller's traces/<user_id>/ prefix."
            )
        return self


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
    # Rev-5 DATA-1: historically the `turns` field was set to the SDK's
    # `ResultMessage.num_turns`, which INCLUDES the attempted turn that
    # tripped a cap (so `max_turns=6` yields `turns=7` under
    # `agent_status='error_max_turns'`). That confused operators. We
    # now expose both fields explicitly:
    #   * `turns_attempted` — the SDK's authoritative counter (ex-`turns`).
    #   * `turns_completed` — clamped to max_turns when we know the cap
    #     fired; otherwise equals `turns_attempted`.
    # The legacy `turns` field is retained (= `turns_attempted`) so
    # existing DDB consumers keep working during the transition.
    turns: int | None = None
    turns_attempted: int | None = None
    turns_completed: int | None = None
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
    # S3 URI of the uploaded --trace trajectory dump, or ``None`` when
    # the task did not run with ``--trace`` / the upload was skipped or
    # failed. Threaded into ``task_state.write_terminal`` so the
    # TaskRecord's ``trace_s3_uri`` field is set atomically with the
    # terminal-status transition (design §10.1).
    trace_s3_uri: str | None = None
