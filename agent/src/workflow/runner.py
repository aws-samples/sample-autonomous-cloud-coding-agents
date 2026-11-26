from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, override

from shell import log

from .models import Step, TerminalOutcomes, Workflow

if TYPE_CHECKING:
    from models import AgentResult, HydratedContext, RepoSetup, TaskConfig
    from progress_writer import _ProgressWriter


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
    task success. ``terminal_outcome`` is the primary outcome the workflow
    declared, and ``artifacts`` collects what the steps actually produced
    (``pr_url`` from ``ensure_pr``; ``artifact_uri`` / ``comment_posted`` from
    ``deliver_artifact``).
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
    from ``run_agent``, and named ``artifacts``). ``record`` appends to
    ``outcomes``; the runner calls it, not the handlers.
    """

    workflow: Workflow
    config: TaskConfig
    hydrated: HydratedContext | None = None
    progress: _ProgressWriter | None = None
    trajectory: Any = None
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


_WORKFLOW_STATE_DIR = os.environ.get("WORKFLOW_STATE_DIR", "/mnt/workspace")
_WORKFLOW_STATE_FILE = "workflow_state.json"

_RESUMABLE_SKIP_KINDS = frozenset({"verify_build", "verify_lint"})


class WorkflowCheckpoint:
    """Records completed step outcomes so a resumed run can skip them.

    The default implementation persists to ``workflow_state.json`` on the
    persistent session mount. ``load`` returns the map of already-completed step
    keys → outcomes; ``save`` appends one. A missing or unreadable checkpoint,
    or one written by another task, loads as empty.
    """

    def __init__(self, task_id: str, state_dir: str | os.PathLike[str] | None = None) -> None:
        self._path = Path(state_dir or _WORKFLOW_STATE_DIR) / _WORKFLOW_STATE_FILE
        self._task_id = task_id

    def load(self) -> dict[str, StepOutcome]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # nosemgrep: py-silent-success-masking -- no checkpoint: run_workflow skips no step
            return {}
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
            log("WARN", f"workflow checkpoint write failed (non-fatal): {type(e).__name__}: {e}")


class _NullCheckpoint(WorkflowCheckpoint):
    def __init__(self) -> None:
        self._path = Path(os.devnull)
        self._task_id = ""

    @override
    def load(self) -> dict[str, StepOutcome]:
        return {}

    @override
    def save(self, key: str, outcome: StepOutcome) -> None:
        return None


StepHandler = Callable[[Step, StepContext], StepOutcome]


def _step_key(step: Step) -> str:
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
    - ``continue`` — record the failure and proceed.

    ``only_kinds`` restricts execution to steps of those kinds (others are passed
    over without running or checkpointing).

    On resume, a ``verify_build`` or ``verify_lint`` step that the checkpoint
    records as succeeded is skipped; every other step re-runs.
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
                _milestone(ctx, f"step:{key}:start")
                ctx.record(prior)
                _milestone(ctx, f"step:{key}:skipped")
                continue

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
        checkpoint.save(key, outcome)
        _milestone(ctx, f"step:{key}:{outcome.status}")

        if outcome.failed:
            if step.on_failure == "fail":
                log("WORKFLOW", f"step {key!r} failed (on_failure=fail) — workflow FAILED")
                return WorkflowResult.failed_at(ctx, outcome)
            if step.on_failure == "skip_remaining":
                log("WORKFLOW", f"step {key!r} failed (on_failure=skip_remaining) — stopping")
                break
            log("WORKFLOW", f"step {key!r} failed (on_failure=continue) — proceeding")

    return WorkflowResult.from_outcomes(ctx, workflow.terminal_outcomes)


def _run_handler(handler: StepHandler, step: Step, ctx: StepContext, key: str) -> StepOutcome:
    try:
        return handler(step, ctx)
    except Exception as e:
        log("ERROR", f"step {key!r} handler raised: {type(e).__name__}: {e}")
        return StepOutcome(
            kind=step.kind, name=key, status="failed", error=f"{type(e).__name__}: {e}"
        )


def _milestone(ctx: StepContext, milestone: str) -> None:
    if ctx.progress is None:
        return
    try:
        ctx.progress.write_agent_milestone(milestone)
    except Exception as e:
        log("WARN", f"milestone {milestone!r} emit failed (non-fatal): {type(e).__name__}: {e}")


def _handle_clone_repo(step: Step, ctx: StepContext) -> StepOutcome:
    from repo import setup_repo

    reused = ctx.setup is not None
    if not reused:
        ctx.setup = setup_repo(ctx.config, progress=ctx.progress)
    setup = ctx.setup
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status="succeeded",
        data={"branch": setup.branch, "build_before": setup.build_before, "reused": reused},
    )


def _handle_hydrate_context(step: Step, ctx: StepContext) -> StepOutcome:
    if ctx.hydrated is not None and not ctx.user_prompt:
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
    import asyncio

    from config import AGENT_WORKSPACE
    from runner import run_agent

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

    - ``informational`` (or a ``read_only`` workflow) — never gates.
    - ``strict`` — any failure gates.
    - ``regression_only`` **and the unset default** — fail only on a *regression*
      (was passing before, fails now).
    """
    if passed:
        return "succeeded"
    if gate == "informational" or read_only:
        return "succeeded"
    if gate == "strict":
        return "failed"
    return "failed" if was_passing_before else "succeeded"


def _handle_verify_build(step: Step, ctx: StepContext) -> StepOutcome:
    from post_hooks import verify_build

    repo_dir = ctx.setup.repo_dir if ctx.setup else ""
    outcome = verify_build(repo_dir, ctx.config.build_command)
    passed = outcome.passed
    was_passing_before = ctx.setup.build_before if ctx.setup else True
    status = gate_status(
        passed=passed,
        gate=step.gate,
        read_only=ctx.workflow.read_only,
        was_passing_before=was_passing_before,
    )
    fail_reason = (
        "post-agent build timed out"
        if outcome.timed_out
        else "post-agent build failed (regression)"
    )
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status=status,
        error=None if status == "succeeded" else fail_reason,
        data={"build_passed": passed},
    )


def _handle_verify_lint(step: Step, ctx: StepContext) -> StepOutcome:
    from post_hooks import verify_lint

    repo_dir = ctx.setup.repo_dir if ctx.setup else ""
    outcome = verify_lint(repo_dir, ctx.config.lint_command)
    passed = outcome.passed
    was_passing_before = ctx.setup.lint_before if ctx.setup else True
    status = gate_status(
        passed=passed,
        gate=step.gate,
        read_only=ctx.workflow.read_only,
        was_passing_before=was_passing_before,
    )
    fail_reason = (
        "post-agent lint timed out" if outcome.timed_out else "post-agent lint failed (regression)"
    )
    return StepOutcome(
        kind=step.kind,
        name=_step_key(step),
        status=status,
        error=None if status == "succeeded" else fail_reason,
        data={"lint_passed": passed},
    )


def _handle_ensure_pr(step: Step, ctx: StepContext) -> StepOutcome:
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
    raise NotImplementedError(
        "post_review has no shipped workflow yet — coding/pr-review-v1 uses "
        "ensure_pr(strategy: resolve); this handler lands with a future review workflow"
    )


def _handle_deliver_artifact(step: Step, ctx: StepContext) -> StepOutcome:
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
