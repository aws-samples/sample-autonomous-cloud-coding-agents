"""The agent-side workflow step runner (#248).

Per `ADR-014 <../../../docs/decisions/ADR-014-workflow-driven-tasks.md>`_ the
runner lives *in the container* and interprets ``workflow.steps`` — it drives
*what happens inside* the orchestrator's ``RUNNING`` state, not the platform
lifecycle (admission → pre-flight → hydrate → start-session → await → finalize
is unchanged). See WORKFLOWS.md §"The agent-side step runner".

The runner is the structural replacement for the hardcoded ``task_type``
branches that were scattered through ``pipeline.py``: each existing helper
(``setup_repo``, ``run_agent``, ``verify_build``, ``ensure_pr``, …) becomes a
*step handler* keyed by ``StepKind`` in ``STEP_HANDLERS``. ``run_workflow``
executes the steps in order, honours each step's ``on_failure`` policy, emits a
``step:<name>:start`` / ``:complete`` progress milestone per boundary, and
checkpoints completed steps so a resumed session skips work already done
(WORKFLOWS.md §"Step execution semantics").

This module is intentionally decoupled from ``pipeline.py``: the orchestration
core (the loop, ``on_failure``, checkpoint/resume, terminal-outcome resolution)
is handler-agnostic and unit-tested with fakes; the real handlers are thin
wrappers over the existing helpers. It is wired into ``pipeline.run_task`` via
``_execute_agent_step`` (the agentic step on the repo-bound path) and
``_run_repoless_task`` (the full repo-less step list).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from shell import log

from .models import Step, TerminalOutcomes, Workflow

if TYPE_CHECKING:
    from models import AgentResult, HydratedContext, RepoSetup, TaskConfig
    from progress_writer import _ProgressWriter


# --- result types ------------------------------------------------------------

StepStatus = Literal["succeeded", "failed", "skipped"]


@dataclass(frozen=True)
class StepOutcome:
    """The result of running (or skipping) one workflow step.

    ``data`` carries kind-specific products the runner threads forward and uses
    for terminal-outcome resolution — e.g. ``{"pr_url": ...}`` from ``ensure_pr``
    or ``{"artifact_uri": ...}`` from ``deliver_artifact``.
    """

    kind: str
    name: str
    status: StepStatus
    error: str | None = None
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return self.status == "failed"

    @property
    def succeeded(self) -> bool:
        return self.status == "succeeded"

    def to_checkpoint(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "name": self.name,
            "status": self.status,
            "error": self.error,
            "data": self.data,
        }

    @classmethod
    def from_checkpoint(cls, raw: dict[str, Any]) -> StepOutcome:
        return cls(
            kind=raw["kind"],
            name=raw["name"],
            status=raw["status"],
            error=raw.get("error"),
            data=raw.get("data", {}),
        )


@dataclass
class WorkflowResult:
    """The terminal verdict of a workflow run.

    ``status`` reflects whether the *steps* completed; it does NOT itself decide
    task success — per WORKFLOWS.md §"Success inference and terminal outcomes",
    the agent SDK result status stays authoritative in ``pipeline.py``. This
    result layers the declarative *artifact* check on top: ``terminal_outcome``
    is the primary outcome the workflow declared, and ``artifacts`` collects what
    the steps actually produced (``pr_url`` from ``ensure_pr``; ``artifact_uri`` /
    ``comment_posted`` from ``deliver_artifact``) so the caller can confirm the
    declared product exists.
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

    Handlers read the inputs (``workflow``, ``config``, ``hydrated``) and write
    the products they produce back onto the context (``setup`` from
    ``clone_repo``, ``user_prompt`` from ``hydrate_context``, ``agent_result``
    from ``run_agent``, and named ``artifacts``). Recording an outcome appends to
    ``outcomes``; the runner owns that call so handlers stay focused on doing the
    work.
    """

    workflow: Workflow
    config: TaskConfig
    hydrated: HydratedContext | None = None
    progress: _ProgressWriter | None = None
    # --trace trajectory accumulator, owned by the caller (pipeline) so it
    # outlives the run_agent step; threaded into run_agent by its handler.
    trajectory: Any = None
    # products filled in by handlers as the workflow runs:
    setup: RepoSetup | None = None
    system_prompt: str = ""
    user_prompt: str = ""
    agent_result: AgentResult | None = None
    outcomes: list[StepOutcome] = field(default_factory=list)
    artifacts: dict[str, Any] = field(default_factory=dict)

    def record(self, outcome: StepOutcome) -> None:
        self.outcomes.append(outcome)
        if outcome.data:
            self.artifacts.update(outcome.data)


# --- checkpoint / resume -----------------------------------------------------

# Persistent session storage survives stop/resume (COMPUTE.md); the checkpoint
# lives here so a resumed session skips work already done. Overridable for tests
# and local runs where /mnt/workspace does not exist.
_WORKFLOW_STATE_DIR = os.environ.get("WORKFLOW_STATE_DIR", "/mnt/workspace")
_WORKFLOW_STATE_FILE = "workflow_state.json"

# Steps a resumed run may skip wholesale. The bar is deliberately narrow: a step
# is only skippable if its *entire* product is captured in the checkpoint
# ``data`` and re-applied to the context by ``ctx.record`` (which merges ``data``
# into ``ctx.artifacts``). ``verify_build``/``verify_lint`` qualify — their whole
# product is the ``build_passed``/``lint_passed`` boolean that ``ensure_pr`` later
# reads from ``ctx.artifacts``.
#
# ``clone_repo`` and ``hydrate_context`` are deliberately NOT here even though
# they are deterministic: they populate in-memory products (``ctx.setup``,
# ``ctx.user_prompt``) that later steps read directly and that cannot be
# reconstructed from the JSON checkpoint. Skipping them would leave ``ctx.setup``
# None (breaking ``ensure_pr``) and ``ctx.user_prompt`` empty (an unguided agent
# loop). They re-run on resume instead, relying on handler-level idempotency
# (``setup_repo`` tolerating an already-populated workspace — WORKFLOWS.md §"Step
# execution semantics"). Side-effecting / agentic steps (``run_agent``,
# ``ensure_pr``, ``post_review``, ``deliver_artifact``) also always re-run: they
# carry their own idempotency keys (PR branch, review id, artifact S3 key) and
# the agent loop resumes via its persisted SDK session UUID, not from turn 0.
_RESUMABLE_SKIP_KINDS = frozenset({"verify_build", "verify_lint"})


class WorkflowCheckpoint:
    """Records completed step outcomes so a resumed run can skip them.

    The default implementation persists to ``workflow_state.json`` on the
    persistent session mount. ``load`` returns the map of already-completed step
    keys → outcomes; ``save`` appends one. Resume is best-effort: a missing or
    unreadable checkpoint just means "start from step 0" (the side-effecting
    steps are independently idempotent, so re-running them reconciles rather
    than duplicates — WORKFLOWS.md §"Step execution semantics").
    """

    def __init__(self, task_id: str, state_dir: str | os.PathLike[str] | None = None) -> None:
        self._path = Path(state_dir or _WORKFLOW_STATE_DIR) / _WORKFLOW_STATE_FILE
        self._task_id = task_id

    def load(self) -> dict[str, StepOutcome]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        # Guard against a stale checkpoint from a different task on a reused mount.
        if raw.get("task_id") != self._task_id:
            return {}
        return {key: StepOutcome.from_checkpoint(oc) for key, oc in raw.get("steps", {}).items()}

    def save(self, key: str, outcome: StepOutcome) -> None:
        existing = self.load()
        existing[key] = outcome
        payload = {
            "task_id": self._task_id,
            "steps": {k: oc.to_checkpoint() for k, oc in existing.items()},
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(payload), encoding="utf-8")
        except OSError as e:
            # Checkpoint loss only costs us resume granularity, never correctness
            # (side effects are idempotent). Never let it fail the workflow.
            log("WARN", f"workflow checkpoint write failed (non-fatal): {type(e).__name__}: {e}")


class _NullCheckpoint(WorkflowCheckpoint):
    """No-op checkpoint — the default when resume is not wired up (e.g. tests)."""

    def __init__(self) -> None:
        # Intentionally skips the base file setup — this checkpoint never reads
        # or writes; load() / save() are overridden to no-op.
        self._path = Path(os.devnull)
        self._task_id = ""

    def load(self) -> dict[str, StepOutcome]:
        return {}

    def save(self, key: str, outcome: StepOutcome) -> None:
        return None


# --- the runner --------------------------------------------------------------

StepHandler = Callable[[Step, StepContext], StepOutcome]


def _step_key(step: Step) -> str:
    """The checkpoint / milestone identity for a step (``name`` falls back to ``kind``)."""
    return step.name or step.kind


def run_workflow(
    workflow: Workflow,
    ctx: StepContext,
    *,
    handlers: dict[str, StepHandler] | None = None,
    checkpoint: WorkflowCheckpoint | None = None,
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
    over without running or checkpointing). It is a permanent dual-mode
    mechanism, not a transitional seam: the repo-bound pipeline drives just the
    agentic ``run_agent`` step through the runner (clone / context / post-hooks
    stay on the proven inline path with their hard-won cancel-safety), while the
    repo-less path (``_run_repoless_task``) passes ``None`` so every step runs.

    On resume, deterministic side-effect-free steps already recorded in the
    checkpoint are skipped; everything else re-runs (idempotently).
    """
    handlers = handlers if handlers is not None else STEP_HANDLERS
    checkpoint = checkpoint if checkpoint is not None else _NullCheckpoint()
    completed = checkpoint.load()

    for step in workflow.steps:
        key = _step_key(step)

        if only_kinds is not None and step.kind not in only_kinds:
            continue

        if step.kind in _RESUMABLE_SKIP_KINDS and key in completed:
            prior = completed[key]
            if prior.succeeded:
                log("WORKFLOW", f"step {key!r} already completed — skipping (resume)")
                # Emit the boundary milestones even when skipping so a watcher
                # ('bgagent watch') sees the step accounted for rather than a gap.
                _milestone(ctx, f"step:{key}:start")
                ctx.record(prior)
                _milestone(ctx, f"step:{key}:skipped")
                continue

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
        checkpoint.save(key, outcome)
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


def _handle_clone_repo(step: Step, ctx: StepContext) -> StepOutcome:
    """Clone + prepare the repo (replaces the inline ``setup_repo`` call).

    Idempotent: if ``ctx.setup`` is already populated (the caller pre-cloned, or
    a resumed run reuses an existing setup) the clone is reused rather than
    redone — matching WORKFLOWS.md §"Step execution semantics" ("clone_repo need
    not re-clone a populated /workspace").
    """
    from repo import setup_repo

    reused = ctx.setup is not None
    if not reused:
        ctx.setup = setup_repo(ctx.config)
    setup = ctx.setup
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data={"branch": setup.branch, "build_before": setup.build_before, "reused": reused},
    )


def _handle_hydrate_context(step: Step, ctx: StepContext) -> StepOutcome:
    """Consume the orchestrator-assembled ``HydratedContext`` into the prompts.

    Hydration is largely orchestrator-side today (WORKFLOWS.md open question #4
    leans "orchestrator hydrates, the agent step only consumes"); this handler is
    that consumer. It sets BOTH prompts the ``run_agent`` step needs:

    - ``ctx.user_prompt`` — the hydrated ``user_prompt`` when present.
    - ``ctx.system_prompt`` — built via the existing ``build_system_prompt`` so
      the workflow path produces the same system prompt as ``pipeline.run_task``
      (repo_url/branch/workspace/max_turns/setup_notes/memory_context + overrides
      + channel guidance). Without this the agent loop would run with an empty
      system prompt (code-review finding). Requires a prior ``clone_repo`` for
      the ``RepoSetup``; when absent (repo-less workflows) the system prompt is
      left to the caller, since ``build_system_prompt`` is repo-shaped today.
    """
    if ctx.hydrated is not None:
        ctx.user_prompt = ctx.hydrated.user_prompt

    built_system_prompt = False
    if ctx.setup is not None and not ctx.system_prompt:
        from prompt_builder import build_system_prompt

        ctx.system_prompt = build_system_prompt(
            ctx.config, ctx.setup, ctx.hydrated, ctx.config.system_prompt_overrides
        )
        built_system_prompt = True

    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data={
            "hydrated": ctx.hydrated is not None,
            "system_prompt_built": built_system_prompt,
        },
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
    ``verify_lint`` (the two were near-identical twins that drifted on the
    ``read_only`` rule — see the code-review finding). Since #301 it is also the
    implementation behind the coding lane's inline post-hook gating
    (``pipeline._apply_post_hook_gates``), so both lanes honor a step's
    declared ``gate`` through this one function:

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


def _handle_verify_build(step: Step, ctx: StepContext) -> StepOutcome:
    """Run ``mise run build``. Gating vs informational is the step's ``gate``."""
    from post_hooks import verify_build

    repo_dir = ctx.setup.repo_dir if ctx.setup else ""
    passed = verify_build(repo_dir)
    # was_passing_before defaults True (assume green-before, so a post-agent
    # failure IS a regression) — the same conservative default pipeline.py uses.
    was_passing_before = ctx.setup.build_before if ctx.setup else True
    status = gate_status(
        passed=passed,
        gate=step.gate,
        read_only=ctx.workflow.read_only,
        was_passing_before=was_passing_before,
    )
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status=status,
        error=None if status == "succeeded" else "post-agent build failed (regression)",
        data={"build_passed": passed},
    )


def _handle_verify_lint(step: Step, ctx: StepContext) -> StepOutcome:
    """Run ``mise run lint`` (typically an advisory ``on_failure: continue`` gate)."""
    from post_hooks import verify_lint

    repo_dir = ctx.setup.repo_dir if ctx.setup else ""
    passed = verify_lint(repo_dir)
    was_passing_before = ctx.setup.lint_before if ctx.setup else True
    status = gate_status(
        passed=passed,
        gate=step.gate,
        read_only=ctx.workflow.read_only,
        was_passing_before=was_passing_before,
    )
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status=status,
        error=None if status == "succeeded" else "post-agent lint failed (regression)",
        data={"lint_passed": passed},
    )


def _handle_ensure_pr(step: Step, ctx: StepContext) -> StepOutcome:
    """Create / push+resolve / resolve a PR per the step's ``strategy``.

    The provider-neutral intent dispatches through the existing GitHub
    realization. ``ensure_pr`` now takes the strategy explicitly (``create`` |
    ``push_resolve`` | ``resolve``) instead of self-inspecting the removed
    ``task_type`` (#248 task 8), so the workflow's declared strategy drives the
    behavior.
    """
    from post_hooks import ensure_pr

    if ctx.setup is None:
        return StepOutcome(
            kind=step.kind,
            name=_step_key(step),
            status="failed",
            error="ensure_pr requires a cloned repo (no clone_repo step ran)",
        )
    build_passed = bool(ctx.artifacts.get("build_passed", True))
    lint_passed = bool(ctx.artifacts.get("lint_passed", True))
    strategy = step.strategy or "create"
    pr_url = ensure_pr(
        ctx.config,
        ctx.setup,
        build_passed,
        lint_passed,
        agent_result=ctx.agent_result,
        strategy=strategy,
    )
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data={"pr_url": pr_url, "strategy": strategy},
    )


def _handle_post_review(step: Step, ctx: StepContext) -> StepOutcome:
    """Post a structured review via a VCS review API (no shipped workflow yet).

    No first-party workflow declares a ``post_review`` step — ``coding/pr-review-v1``
    resolves its PR via ``ensure_pr(strategy: resolve)`` instead. The handler is
    registered so the handler-coverage check (validator rule 8) stays honest and
    fails loudly rather than silently no-opping; it is implemented when a workflow
    that posts a GitHub Reviews-API review (vs an issue comment) ships.
    """
    raise NotImplementedError(
        "post_review has no shipped workflow yet — coding/pr-review-v1 uses "
        "ensure_pr(strategy: resolve); this handler lands with a future review workflow"
    )


def _handle_deliver_artifact(step: Step, ctx: StepContext) -> StepOutcome:
    """Deliver a produced artifact (repo-less knowledge work, #248 Phase 3).

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
    "clone_repo": _handle_clone_repo,
    "hydrate_context": _handle_hydrate_context,
    "run_agent": _handle_run_agent,
    "verify_build": _handle_verify_build,
    "verify_lint": _handle_verify_lint,
    "ensure_pr": _handle_ensure_pr,
    "post_review": _handle_post_review,
    "deliver_artifact": _handle_deliver_artifact,
}
