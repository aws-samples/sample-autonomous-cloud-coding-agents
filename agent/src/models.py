"""Data models and enumerations for the agent pipeline."""

from __future__ import annotations

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


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

# Attachment types — mirrors AttachmentType in cdk/src/handlers/shared/types.ts.
AttachmentType = Literal["image", "file", "url"]

# A SHA-256 digest rendered as lowercase hex is always 64 characters.
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
        # checksum must be lowercase hex (SHA-256 = 64 hex chars)
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

    # repo_url / github_token default to "" so a repo-less TaskConfig (#248
    # Phase 3) is constructible. The _validate_requires_repo_has_repo validator
    # below enforces that a repo-BOUND config (requires_repo=True, the default)
    # still carries a repo_url — so dropping the field-level requirement does not
    # weaken the coding-path invariant.
    repo_url: str = ""
    issue_number: str = ""
    task_description: str = ""
    github_token: str = ""
    aws_region: str
    anthropic_model: str = "us.anthropic.claude-sonnet-4-6"
    dry_run: bool = False
    max_turns: int = 10
    max_budget_usd: float | None = None
    system_prompt_overrides: str = ""
    # The pinned workflow this task runs ({"id", "version"}), resolved at the
    # create-task boundary and threaded through the payload (#248). None on
    # local/batch runs, where the pipeline defaults to coding/new-task-v1.
    resolved_workflow: dict | None = None
    # The Cedar principal identity derived from the resolved workflow
    # (id→legacy map, else "new_task"). The Agent::TaskAgent::"<id>" principal
    # scheme is unchanged; since #248 Phase 2a, read-only enforcement no longer
    # keys off this principal — it keys off ``read_only`` below.
    policy_principal: str = "new_task"
    # Whether the resolved workflow is read-only (may not mutate the working
    # tree). Threaded into the Cedar request ``context.read_only`` so the
    # hard-deny Write/Edit rules fire for *any* read-only workflow (#248
    # Phase 2a), and drives the runner's allowed_tools tightening.
    read_only: bool = False
    # The SDK tool surface for this task, from the resolved workflow's
    # ``agent_config.allowed_tools`` (#248). This is the second enforcement layer
    # the design promises alongside ``read_only``: ``run_agent`` passes it to
    # ``ClaudeAgentOptions.allowed_tools`` verbatim, and drops ``Write``/``Edit``
    # when ``read_only`` is true. Empty list means "fall back to the built-in
    # full surface" so legacy/batch callers that never resolved a workflow keep
    # working unchanged; a workflow that wants to restrict tools MUST declare a
    # non-empty list (every shipped workflow does).
    allowed_tools: list[str] = Field(default_factory=list)
    # Whether the resolved workflow requires a repo. False for repo-less
    # knowledge workflows (#248 Phase 3): the pipeline skips clone/build/PR and
    # drives the agent + deliver_artifact steps through the workflow runner.
    # Defaults True so coding tasks (and any caller that omits it) keep the
    # repo-bound path.
    requires_repo: bool = True
    # True when the resolved workflow operates on an existing PR (pr_* coding
    # workflows) — gates the "resume existing branch / resolve PR" behavior that
    # the removed task_type used to signal.
    is_pr_workflow: bool = False
    branch_name: str = ""
    pr_number: str = ""
    task_id: str = ""
    # Inbound channel the task was submitted from (mirrors ChannelSource in
    # cdk/src/handlers/shared/types.ts). Gates channel-specific MCP wiring and
    # prompt additions. Empty string means "no channel context" (legacy / local).
    channel_source: str = ""
    channel_metadata: dict[str, str] = Field(default_factory=dict)
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
    # Cedar HITL (§7.3, §10.2). Per-task approval defaults threaded
    # from the orchestrator payload; consumed by PolicyEngine at
    # construction so the engine seeds ApprovalAllowlist and adopts
    # the per-task timeout default.
    approval_timeout_s: int | None = None
    initial_approvals: list[str] = []
    # Chunk 7: TaskTable-persisted ``approval_gate_count`` seeded into
    # the session counter so container restarts (§13.6) resume the
    # cumulative gate budget without resetting to 0. Threaded from the
    # orchestrator payload; zero default preserves legacy callers.
    initial_approval_gate_count: int = 0
    # Chunk 7b (§4 step 5, decision #13): per-task approval-gate cap
    # resolved at task submit-time from ``Blueprint.security.approvalGateCap``
    # (or the platform default of 50). Persisted on the TaskRecord so
    # it survives container restarts and mid-task blueprint edits do
    # not shift the cap beneath a running task. ``None`` when the
    # orchestrator payload did not include the field (legacy tasks);
    # PolicyEngine falls back to its own default of 50 in that case.
    approval_gate_cap: int | None = None
    issue: GitHubIssue | None = None
    base_branch: str | None = None
    # Attachments from the orchestrator payload (Phase 3). Validated as
    # AttachmentConfig models. Empty list for tasks without attachments.
    attachments: list[AttachmentConfig] = Field(default_factory=list)

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

    @model_validator(mode="after")
    def _validate_requires_repo_has_repo(self) -> Self:
        """Fail at construction when a repo-bound config has no repo (#248 Phase 3).

        ``requires_repo`` defaults True, so a config that requires a repo but
        carries an empty ``repo_url`` is an illegal state the repo-bound pipeline
        (clone/build/PR) cannot run. The create-task boundary and ``build_config``
        already enforce this upstream; this validator makes the invariant
        self-enforcing on the type so a directly-constructed ``TaskConfig`` (tests,
        future call sites) cannot represent it silently. Mirrors
        ``_validate_trace_requires_user_id`` above.
        """
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
    # The agent's final result text (ResultMessage.result on success). For a
    # repo-less knowledge task this IS the deliverable that deliver_artifact
    # uploads/posts (#248 Phase 3). Empty for coding tasks (their product is the
    # PR, not the text).
    result_text: str = ""


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
    # S3 URI of a repo-less workflow's delivered artifact (deliver_artifact, #248
    # Phase 3), or ``None`` for coding tasks / when no artifact was delivered.
    # Surfaced on TaskDetail so the user can retrieve the knowledge-task output.
    artifact_uri: str | None = None
