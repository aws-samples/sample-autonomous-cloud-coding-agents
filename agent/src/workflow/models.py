from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Domain = Literal["coding", "knowledge", "hybrid"]
Tier = Literal["standard", "elevated", "read-only"]
VcsProvider = Literal["github", "gitlab", "bitbucket", "codecommit", "generic_git"]
RepoIgnore = Literal["claude_md", "rules", "subagents", "settings", "mcp"]
HydrationSource = Literal[
    "issue", "pull_request", "memory", "attachments", "urls", "task_description"
]
StepKind = Literal[
    "clone_repo",
    "hydrate_context",
    "run_agent",
    "verify_build",
    "verify_lint",
    "ensure_pr",
    "post_review",
    "deliver_artifact",
]
OnFailure = Literal["fail", "continue", "skip_remaining"]
EnsurePrStrategy = Literal["create", "push_resolve", "resolve"]
VerifyGate = Literal["strict", "regression_only", "informational"]
DeliverTarget = str
TerminalOutcome = Literal["pr_url", "review_posted", "artifact", "comment"]
ConvergenceMode = Literal["test_gated", "artifact_delivered", "human_approved", "review_submitted"]
ConvergenceSensor = Literal["verify_build", "verify_lint"]
ConvergenceTerminalOutcome = Literal[
    "pr_opened", "review_published", "artifact_delivered", "human_approved"
]
Status = Literal["draft", "validated", "production", "deprecated"]


class Prompt(BaseModel):
    """The system-prompt fragment injected into the base template."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    template: str
    placeholders: list[str] = Field(default_factory=list)


class Hydration(BaseModel):
    """Which context sources the orchestrator assembles for this workflow."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    sources: list[HydrationSource]


class ModelPreference(BaseModel):
    """Optional preferred Bedrock model — a suggestion, bounded by the allow-list."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    allow_task_override: bool = True


class AgentConfig(BaseModel):
    """Everything that shapes the Claude Agent SDK session for this task type.

    ``skills``, ``plugins``, ``subagents`` and ``prompt_fragments`` are declared
    but not read by the runner (#246).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    tier: Tier
    model: ModelPreference | None = None
    allowed_tools: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    cedar_policy_modules: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    plugins: list[str] = Field(default_factory=list)
    subagents: list[str] = Field(default_factory=list)
    prompt_fragments: list[str] = Field(default_factory=list)


class RepoConfig(BaseModel):
    """How the workflow relates to a source-control repository.

    ``provider`` is a VCS abstraction (``github`` is the only implemented
    backend today); ``discover``/``ignore`` gate config discovered from the
    cloned repo (``CLAUDE.md``, ``.claude/``, ``.mcp.json``).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: VcsProvider | None = None
    discover: bool = True
    ignore: list[RepoIgnore] = Field(default_factory=list)


class RequiredInputs(BaseModel):
    """Submit-time validation contract."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    one_of: list[str] | None = None
    all_of: list[str] | None = None


class Step(BaseModel):
    """One ordered pipeline phase the step runner interprets.

    Kind-specific fields beyond the ones below are accepted and kept.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    kind: StepKind
    name: str | None = None
    on_failure: OnFailure = "fail"
    strategy: EnsurePrStrategy | None = None
    gate: VerifyGate | None = None
    target: DeliverTarget | None = None


class TerminalOutcomes(BaseModel):
    """What 'done' produces; drives finalization success inference."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    primary: TerminalOutcome
    secondary: list[TerminalOutcome] = Field(default_factory=list)


class ConvergenceEarlyExit(BaseModel):
    """Explicit exceptions to the workflow's normal convergence path."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    allow_on_policy_deny: bool = False


class Convergence(BaseModel):
    """How a harness decides that this workflow is complete.

    Declarative metadata for conformance tooling: runtime success inference
    does not read it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    mode: ConvergenceMode
    required_sensors: list[ConvergenceSensor] | None = Field(default=None, min_length=1)
    terminal_outcomes: list[ConvergenceTerminalOutcome]
    early_exit: ConvergenceEarlyExit | None = None


class Limits(BaseModel):
    """Workflow-level defaults; per-task / per-repo overrides still win."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    max_turns: int | None = None
    max_budget_usd: float | None = None


class PromotionGate(BaseModel):
    """The check contract a version must pass to reach 'production'."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    requires: list[str] = Field(default_factory=list)


class Workflow(BaseModel):
    """A parsed, shape-validated workflow file.

    Construct via the loader (``load_workflow`` / ``load_workflow_file``), which
    runs JSON-Schema shape validation first. Direct construction is for tests.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    version: str
    domain: Domain
    description: str | None = None
    guidance: str | None = None
    requires_repo: bool | None = None
    read_only: bool = False
    prompt: Prompt
    hydration: Hydration
    agent_config: AgentConfig
    repo_config: RepoConfig | None = None
    required_inputs: RequiredInputs | None = None
    steps: list[Step]
    post_hooks: list[str] = Field(default_factory=list, max_length=0)
    terminal_outcomes: TerminalOutcomes
    convergence: Convergence | None = None
    limits: Limits | None = None
    promotion_gate: PromotionGate | None = None
    status: Status

    @property
    def resolved_requires_repo(self) -> bool:
        """``requires_repo`` with the domain-derived default applied.

        Per WORKFLOWS.md: a ``coding`` workflow defaults to ``True``;
        ``knowledge`` defaults to ``False``. ``hybrid`` defaults to ``False``
        (no clone assumed — a repo, if supplied, is hydrated as context).
        """
        if self.requires_repo is not None:
            return self.requires_repo
        return self.domain == "coding"

    @property
    def ensure_pr_strategy(self) -> EnsurePrStrategy:
        """The strategy of the workflow's ``ensure_pr`` step: ``create`` when it has none."""
        return next(
            (s.strategy for s in self.steps if s.kind == "ensure_pr" and s.strategy),
            "create",
        )

    @property
    def delivers_repo_artifact(self) -> bool:
        """A repository-bound workflow whose terminal outcome is a document, not a PR."""
        return self.terminal_outcomes.primary == "artifact" and self.resolved_requires_repo
