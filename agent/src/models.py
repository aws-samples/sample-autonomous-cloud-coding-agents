from __future__ import annotations

from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sanitization import sanitize_external_content


class IssueComment(BaseModel):
    """Single GitHub issue comment — mirrors ``IssueComment`` in context-hydration.ts.

    ``author`` and ``body`` are sanitized at construction. Consumers must not
    sanitize again.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: int
    author: str
    body: str

    @field_validator("author", "body", mode="after")
    @classmethod
    def _sanitize(cls, v: str) -> str:
        return sanitize_external_content(v)


class GitHubIssue(BaseModel):
    """GitHub issue slice — mirrors ``GitHubIssueContext`` in context-hydration.ts.

    ``title``, ``body``, and each comment's ``author``/``body`` are sanitized
    at construction. Consumers must not sanitize again.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    title: str
    body: str = ""
    number: int
    comments: list[IssueComment] = Field(default_factory=list)

    @field_validator("title", "body", mode="after")
    @classmethod
    def _sanitize(cls, v: str) -> str:
        return sanitize_external_content(v)


class MemoryContext(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    repo_knowledge: list[str] = Field(default_factory=list)
    past_episodes: list[str] = Field(default_factory=list)


ContentTrustLevel = Literal["trusted", "untrusted-external", "memory"]

SUPPORTED_HYDRATED_CONTEXT_VERSION = 1

AttachmentType = Literal["image", "file", "url"]

SHA256_HEX_LEN = 64


class AttachmentConfig(BaseModel):
    """Attachment descriptor from the orchestrator — mirrors AgentAttachmentPayload in types.ts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    attachment_id: str
    type: AttachmentType
    content_type: str
    filename: str
    s3_uri: str
    s3_version_id: str
    size_bytes: int
    source_url: str | None = None
    token_estimate: int | None = None
    checksum_sha256: str

    @model_validator(mode="after")
    def _validate_integrity_fields(self) -> Self:
        if not self.s3_version_id:
            raise ValueError("s3_version_id is required for integrity verification")
        if not self.checksum_sha256:
            raise ValueError("checksum_sha256 is required for integrity verification")
        if len(self.checksum_sha256) != SHA256_HEX_LEN or not all(
            c in "0123456789abcdef" for c in self.checksum_sha256
        ):
            raise ValueError("checksum_sha256 must be a 64-character lowercase hex string")
        return self


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

    repo_url: str = ""
    issue_number: str = ""
    task_description: str = ""
    github_token: str = ""
    aws_region: str
    anthropic_model: str = "global.anthropic.claude-opus-5-5"
    # The "small/fast" model Claude Code uses for auxiliary work (e.g. WebFetch
    # page summarization).
    # Bedrock cannot invoke Claude 4.x on demand by a bare foundation-model id:
    # this must be a cross-region inference-profile id (geo prefix).
    haiku_model: str = "global.anthropic.claude-haiku-5-5"
    dry_run: bool = False
    max_turns: int = 10
    max_budget_usd: float | None = None
    system_prompt_overrides: str = ""
    build_command: str = ""
    lint_command: str = ""
    resolved_workflow: dict | None = None
    policy_principal: str = "new_task"
    read_only: bool = False
    allowed_tools: list[str] = Field(default_factory=list)
    requires_repo: bool = True
    is_pr_workflow: bool = False
    branch_name: str = ""
    pr_number: str = ""
    task_id: str = ""
    channel_source: str = ""
    channel_metadata: dict[str, str] = Field(default_factory=dict)
    user_id: str = ""
    trace: bool = False
    cedar_policies: list[str] = []
    resolved_assets: list[dict[str, Any]] = Field(default_factory=list)
    approval_timeout_s: int | None = None
    initial_approvals: list[str] = []
    initial_approval_gate_count: int = 0
    approval_gate_cap: int | None = None
    issue: GitHubIssue | None = None
    base_branch: str | None = None
    merge_branches: list[str] = Field(default_factory=list)
    attachments: list[AttachmentConfig] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_trace_requires_user_id(self) -> Self:
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

    @model_validator(mode="after")
    def _validate_requires_repo_has_repo(self) -> Self:
        if self.requires_repo and not self.repo_url:
            raise ValueError(
                "requires_repo=True requires a non-empty repo_url. A repo-less "
                "workflow must set requires_repo=False (resolved from the "
                "workflow's requires_repo); a repo-bound workflow must supply "
                "repo_url ('owner/repo')."
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
    build_gate_inert: bool = False
    lint_gate_inert: bool = False
    head_sha_before: str = ""


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
    session_id: str = ""
    error: str | None = None
    usage: TokenUsage | None = None
    result_text: str = ""
    clarification_question: str = ""


class TaskResult(BaseModel):
    status: str
    agent_status: str = "unknown"
    pr_url: str | None = None
    build_passed: bool | None = None
    lint_passed: bool | None = None
    cost_usd: float | None = None
    # The Claude Code CLI's `ResultMessage.num_turns` is not the count that
    # `max_turns` limits: it is `max_turns + 1` on a run stopped at the limit,
    # and otherwise grows with each tool result, not with each answer.
    # Undocumented; observed in CLI 2.1.319.
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
    trace_s3_uri: str | None = None
    artifact_uri: str | None = None
    code_changed: bool | None = None
    answer_text: str = ""
    head_sha: str = ""
    otel_trace_id: str | None = None
