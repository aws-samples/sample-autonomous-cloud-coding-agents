"""Pydantic models for a workflow file.

These mirror ``agent/workflows/schema/workflow.schema.json`` (the canonical
*shape* contract — see WORKFLOWS.md §"Single source of truth and validator
parity"). The JSON Schema validates shape and the schema-expressible
conditionals; these models give the runtime a typed, attribute-access view of
an already-shape-validated file. Cross-field rules that the schema cannot
express (the numbered rules in WORKFLOWS.md §"Validation rules") live in the
single cross-field validator, not here — these models stay deliberately thin so
there is exactly one place those rules are enforced.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# --- enums kept as Literals to mirror the JSON Schema's string enums 1:1 ---

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
# deliver_artifact target: an open string naming a registered deliverer
# (workflow.deliverers / DELIVERERS), not a closed enum — a new delivery method
# is a registered deliverer, not a model/schema change (ADR-014 addendum
# 2026-06-08). First-party names: s3, comment, s3_and_comment.
DeliverTarget = str
TerminalOutcome = Literal["pr_url", "review_posted", "artifact", "comment"]
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

    Asset kinds mirror the #246 registry vocabulary. ``tier`` and
    ``allowed_tools`` are interpreted by the runner in Phases 1-3; the
    registry-resolved kinds (``skills``/``plugins``/``subagents``/
    ``prompt_fragments`` and ``registry://`` refs) are declared now but ignored
    by the runner until #246 lands.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    tier: Tier
    model: ModelPreference | None = None
    allowed_tools: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    cedar_policy_modules: list[str] = Field(default_factory=list)
    # Registry-resolved (Phase 4, #246) — declared, not yet interpreted.
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

    # No default here: "absent" is meaningful (cross-field rule 7 requires
    # provider to be absent when requires_repo:false). The runner applies the
    # github default only when a repo is actually in play.
    provider: VcsProvider | None = None
    discover: bool = True
    ignore: list[RepoIgnore] = Field(default_factory=list)


class RequiredInputs(BaseModel):
    """Submit-time validation contract (replaces scattered required-input checks)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    one_of: list[str] | None = None
    all_of: list[str] | None = None


class Step(BaseModel):
    """One ordered pipeline phase the step runner interprets.

    ``extra='allow'`` mirrors the schema's ``additionalProperties: true`` on
    steps so kind-specific fields beyond the common ones below round-trip.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    kind: StepKind
    name: str | None = None
    on_failure: OnFailure = "fail"
    # kind-specific (validated by enum where present):
    strategy: EnsurePrStrategy | None = None
    gate: VerifyGate | None = None
    target: DeliverTarget | None = None


class TerminalOutcomes(BaseModel):
    """What 'done' produces; drives finalization success inference."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    primary: TerminalOutcome
    secondary: list[TerminalOutcome] = Field(default_factory=list)


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
    # requires_repo defaults from domain when omitted (see resolved_requires_repo).
    requires_repo: bool | None = None
    read_only: bool = False
    prompt: Prompt
    hydration: Hydration
    agent_config: AgentConfig
    repo_config: RepoConfig | None = None
    required_inputs: RequiredInputs | None = None
    steps: list[Step]
    terminal_outcomes: TerminalOutcomes
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
