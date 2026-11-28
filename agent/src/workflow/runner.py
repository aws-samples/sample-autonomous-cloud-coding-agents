"""The agent-side workflow step runner.

Per `ADR-014 <../../../docs/decisions/ADR-014-workflow-driven-tasks.md>`_ the
runner lives *in the container* and interprets ``workflow.steps`` — it drives
*what happens inside* the orchestrator's ``RUNNING`` state, not the platform
lifecycle (admission → pre-flight → hydrate → start-session → await → finalize
is unchanged). See WORKFLOWS.md §"The agent-side step runner".

``STEP_HANDLERS`` holds a *step handler* for each kind the runner executes:
``hydrate_context``, ``run_agent`` and ``deliver_artifact``. The clone, the
verify steps and the pull-request step run inline in ``pipeline.run_task``, on
the repo-bound path. ``run_workflow`` executes the steps in order, honours each
step's ``on_failure`` policy and emits a progress milestone at both boundaries
of a step (``step:<name>:start``, then ``step:<name>:succeeded`` or
``:failed``).

This module is intentionally decoupled from ``pipeline.py``: the orchestration
core (the loop, ``on_failure``, terminal-outcome resolution)
is handler-agnostic and unit-tested with fakes; the real handlers are thin
wrappers over the existing helpers. It is wired into ``pipeline.run_task`` via
``_execute_agent_step`` (the agentic step on the repo-bound path) and
``_run_repoless_task`` (the full repo-less step list).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from shell import log

from .models import Step, TerminalOutcomes, Workflow

if TYPE_CHECKING:
    from models import AgentResult, HydratedContext, RepoSetup, TaskConfig
    from progress_writer import _ProgressWriter


# --- result types ------------------------------------------------------------

StepStatus = Literal["succeeded", "failed"]


@dataclass(frozen=True)
class StepOutcome:
    """The result of running one workflow step.

    ``data`` carries kind-specific products the runner threads forward and uses
    for terminal-outcome resolution — e.g. ``{"artifact_uri": ...}`` from
    ``deliver_artifact``.
    """

    kind: str
    name: str
    status: StepStatus
    error: str | None = None
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return self.status == "failed"


@dataclass
class WorkflowResult:
    """The terminal verdict of a workflow run.

    ``status`` reflects whether the *steps* completed; it does NOT itself decide
    task success — per WORKFLOWS.md §"Success inference and terminal outcomes",
    the agent SDK result status stays authoritative in ``pipeline.py``. This
    result layers the declarative *artifact* check on top: ``terminal_outcome``
    is the primary outcome the workflow declared, and ``artifacts`` collects what
    the steps actually produced (``artifact_uri`` / ``comment_posted`` from
    ``deliver_artifact``) so the caller can confirm the declared product exists.
    """

    status: Literal["succeeded", "failed"]
    outcomes: list[StepOutcome]
    terminal_outcome: str | None = None
    failed_step: StepOutcome | None = None
    artifacts: dict[str, Any] = field(default_factory=dict)

    @property
    def succeeded(self) -> bool:
        return self.status == "succeeded"

    @classmethod
    def failed_at(cls, ctx: StepContext, outcome: StepOutcome) -> WorkflowResult:
        return cls(
            status="failed",
            outcomes=list(ctx.outcomes),
            terminal_outcome=ctx.workflow.terminal_outcomes.primary,
            failed_step=outcome,
            artifacts=dict(ctx.artifacts),
        )

    @classmethod
    def from_outcomes(cls, ctx: StepContext, terminal: TerminalOutcomes) -> WorkflowResult:
        return cls(
            status="succeeded",
            outcomes=list(ctx.outcomes),
            terminal_outcome=terminal.primary,
            failed_step=None,
            artifacts=dict(ctx.artifacts),
        )


@dataclass
class StepContext:
    """Mutable state threaded through every step of one workflow run.

    Handlers read the inputs (``workflow``, ``config``, ``hydrated``, and the
    ``setup`` and ``system_prompt`` the caller built) and write the products
    they produce back onto the context (``user_prompt`` from
    ``hydrate_context``, ``agent_result`` from ``run_agent``, and named
    ``artifacts``). Recording an outcome appends to ``outcomes``; the runner
    owns that call so handlers stay focused on doing the work.
    """

    workflow: Workflow
    config: TaskConfig
    hydrated: HydratedContext | None = None
    progress: _ProgressWriter | None = None
    # --trace trajectory accumulator, owned by the caller (pipeline) so it
    # outlives the run_agent step; threaded into run_agent by its handler.
    trajectory: Any = None
    # built by the caller: the clone (repo-bound path only) and the system prompt.
    setup: RepoSetup | None = None
    system_prompt: str = ""
    # products filled in by handlers as the workflow runs:
    user_prompt: str = ""
    agent_result: AgentResult | None = None
    outcomes: list[StepOutcome] = field(default_factory=list)
    artifacts: dict[str, Any] = field(default_factory=dict)

    def record(self, outcome: StepOutcome) -> None:
        self.outcomes.append(outcome)
        if outcome.data:
            self.artifacts.update(outcome.data)


# --- the runner --------------------------------------------------------------

StepHandler = Callable[[Step, StepContext], StepOutcome]


def _step_key(step: Step) -> str:
    """The milestone identity for a step (``name`` falls back to ``kind``)."""
    return step.name or step.kind


def run_workflow(
    workflow: Workflow,
    ctx: StepContext,
    *,
    handlers: dict[str, StepHandler] | None = None,
    only_kinds: frozenset[str] | set[str] | None = None,
) -> WorkflowResult:
    """Execute ``workflow.steps`` in order and return the terminal verdict.

    Each step is dispatched through ``handlers`` (defaults to ``STEP_HANDLERS``).
    A step's ``on_failure`` policy decides the runner's reaction:

    - ``fail`` (default) — terminal ``FAILED`` attributed to the step.
    - ``skip_remaining`` — stop cleanly; resolve terminal outcomes against what
      completed.
    - ``continue`` — record the failure and proceed (the validator forbids this
      on side-effecting steps, so reaching a *succeeded* terminal with a
      half-applied side effect is impossible).

    ``only_kinds`` restricts execution to steps of those kinds (others are passed
    over without running). It is a permanent dual-mode
    mechanism, not a transitional seam: the repo-bound pipeline drives just the
    agentic ``run_agent`` step through the runner (clone / context / post-hooks
    stay on the proven inline path with their hard-won cancel-safety), while the
    repo-less path (``_run_repoless_task``) runs every step, in two calls: the
    delivery after its cancel check, everything else before it.
    """
    handlers = handlers if handlers is not None else STEP_HANDLERS

    for step in workflow.steps:
        key = _step_key(step)

        if only_kinds is not None and step.kind not in only_kinds:
            continue

        # For prepare-commit-msg.sh, which writes them as commit trailers. They stay set after
        # the step: the pipeline's safety-net commit saves the work of that step, and names it.
        os.environ["WORKFLOW_ID"] = workflow.id
        os.environ["WORKFLOW_STEP"] = key
        _milestone(ctx, f"step:{key}:start")
        try:
            handler = handlers[step.kind]
        except KeyError:
            outcome = StepOutcome(
                kind=step.kind,
                name=key,
                status="failed",
                error=f"no handler registered for step kind {step.kind!r}",
            )
        else:
            outcome = _run_handler(handler, step, ctx, key)

        ctx.record(outcome)
        _milestone(ctx, f"step:{key}:{outcome.status}")

        if outcome.failed:
            if step.on_failure == "fail":
                log("WORKFLOW", f"step {key!r} failed (on_failure=fail) — workflow FAILED")
                return WorkflowResult.failed_at(ctx, outcome)
            if step.on_failure == "skip_remaining":
                log("WORKFLOW", f"step {key!r} failed (on_failure=skip_remaining) — stopping")
                break
            # on_failure == "continue": advisory step; record and proceed.
            log("WORKFLOW", f"step {key!r} failed (on_failure=continue) — proceeding")

    return WorkflowResult.from_outcomes(ctx, workflow.terminal_outcomes)


def _run_handler(handler: StepHandler, step: Step, ctx: StepContext, key: str) -> StepOutcome:
    """Invoke a handler, converting any uncaught exception into a failed outcome.

    A handler that raises must not crash the runner mid-workflow — the failure is
    attributed to its step (so terminal ``FAILED`` is traceable) and the
    ``on_failure`` policy still applies.
    """
    try:
        return handler(step, ctx)
    except Exception as e:  # defensive: a handler bug becomes an attributable failure
        log("ERROR", f"step {key!r} handler raised: {type(e).__name__}: {e}")
        return StepOutcome(
            kind=step.kind, name=key, status="failed", error=f"{type(e).__name__}: {e}"
        )


def _milestone(ctx: StepContext, milestone: str) -> None:
    """Emit a step-boundary milestone, best-effort (never fails the workflow)."""
    if ctx.progress is None:
        return
    try:
        ctx.progress.write_agent_milestone(milestone)
    except Exception as e:
        log("WARN", f"milestone {milestone!r} emit failed (non-fatal): {type(e).__name__}: {e}")


# --- step handlers -----------------------------------------------------------
# Thin wrappers over the existing agent helpers. Imports are lazy (mirroring
# pipeline.py) to avoid pulling the SDK / boto3 at module import and to keep the
# orchestration core importable in isolation for tests.


def _handle_hydrate_context(step: Step, ctx: StepContext) -> StepOutcome:
    """Consume the orchestrator-assembled ``HydratedContext`` into the user prompt.

    Hydration is largely orchestrator-side today (WORKFLOWS.md open question #4
    leans "orchestrator hydrates, the agent step only consumes"); this handler is
    that consumer. It sets ``ctx.user_prompt`` to the hydrated ``user_prompt``
    when present, unless the caller already set one: the pipeline's prompt is
    the hydrated one with the attachment references appended, and must not be
    replaced by the bare one. The system prompt is left to the caller.
    """
    if ctx.hydrated is not None and not ctx.user_prompt:
        ctx.user_prompt = ctx.hydrated.user_prompt

    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data={"hydrated": ctx.hydrated is not None},
    )


def _handle_run_agent(step: Step, ctx: StepContext) -> StepOutcome:
    """Run the one Claude Agent SDK loop for this workflow.

    ``run_agent`` is async; the runner is sync (matching ``pipeline.run_task``),
    so the loop is driven via ``asyncio.run`` here exactly as the pipeline does
    today.
    """
    import asyncio

    from config import AGENT_WORKSPACE
    from runner import run_agent

    # Fail loud rather than run an unguided agent: an empty system prompt means
    # no handler/caller built it. The repo-bound path builds it in
    # hydrate_context (from the RepoSetup); the repo-less path builds it in
    # _run_repoless_task (via build_repoless_system_prompt) before run_workflow.
    # An empty prompt here is a wiring bug — better an attributable failed step
    # than a silently context-free SDK loop.
    if not ctx.system_prompt:
        raise ValueError(
            "run_agent reached with an empty system prompt — no clone_repo/"
            "hydrate_context step (or caller) built ctx.system_prompt."
        )

    cwd = ctx.setup.repo_dir if ctx.setup else AGENT_WORKSPACE
    result = asyncio.run(
        run_agent(
            ctx.user_prompt,
            ctx.system_prompt,
            ctx.config,
            cwd=cwd,
            trajectory=ctx.trajectory,
        )
    )
    ctx.agent_result = result
    # The agent loop "failing" is not a step failure here: pipeline's
    # _resolve_overall_task_status owns success inference. The step succeeds if
    # the SDK ran; downstream steps and the terminal-outcome check decide done.
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data={"agent_status": result.status, "session_id": result.session_id},
    )


def gate_status(
    *, passed: bool, gate: str | None, read_only: bool, was_passing_before: bool
) -> StepStatus:
    """Map a verify result + the step's ``gate`` to a step status.

    Single place the verify-gate semantics live, shared by ``verify_build`` and
    ``verify_lint``. It is the implementation behind the coding lane's inline
    post-hook gating (``pipeline._apply_post_hook_gates``), which honors a
    step's declared ``gate`` through this one function:

    - ``informational`` (or a ``read_only`` workflow) — never gates.
    - ``strict`` — any failure gates.
    - ``regression_only`` **and the unset default** — fail only on a *regression*
      (was passing before, fails now); a check that was already red before the
      agent ran is not a regression and does not gate. This matches the legacy
      pipeline behavior of ``build_ok = passed or not build_before`` — which was
      regression-only for *every* task — so an unset gate agrees with the legacy
      path rather than defaulting to the stricter ``strict``.
    """
    if passed:
        return "succeeded"
    if gate == "informational" or read_only:
        return "succeeded"
    if gate == "strict":
        return "failed"
    # regression_only (explicit) and the unset default: gate only a regression.
    return "failed" if was_passing_before else "succeeded"


def _handle_deliver_artifact(step: Step, ctx: StepContext) -> StepOutcome:
    """Deliver a produced artifact (repo-less knowledge work).

    Routes through the named deliverer (``step.target`` → ``workflow.deliverers``):
    an ``s3``-producing target uploads the agent's result text to
    ``artifacts/{task_id}/`` and records the URI; a ``comment``-producing target
    surfaces it as a milestone for the channel fanout. A delivery failure is a
    *failed* step (terminal FAILED) — never a silent skip — since this is the
    workflow's side-effecting terminal step.
    """
    from .deliverers import DEFAULT_DELIVER_TARGET, deliver

    target = step.target or DEFAULT_DELIVER_TARGET
    result = deliver(target, ctx)
    data: dict[str, Any] = {}
    if result.artifact_uri:
        data["artifact_uri"] = result.artifact_uri
    if result.comment_posted:
        data["comment_posted"] = True
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data=data,
    )


STEP_HANDLERS: dict[str, StepHandler] = {
    "hydrate_context": _handle_hydrate_context,
    "run_agent": _handle_run_agent,
    "deliver_artifact": _handle_deliver_artifact,
}
