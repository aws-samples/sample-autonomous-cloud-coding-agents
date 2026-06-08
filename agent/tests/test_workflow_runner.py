"""Unit tests for the agent-side workflow step runner (#248).

These exercise the orchestration core — step ordering, the ``on_failure``
policies, exception attribution, step-boundary milestones, terminal-outcome
resolution, and checkpoint/resume skipping — with fake handlers, so the loop is
tested independently of the real (SDK/git/boto3-backed) handlers.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from workflow import Step, StepContext, StepOutcome, Workflow, run_workflow
from workflow.runner import WorkflowCheckpoint, _step_key

if TYPE_CHECKING:
    from pathlib import Path


def _workflow(steps: list[dict], *, primary: str = "pr_url", **over) -> Workflow:
    body = {
        "id": "coding/new-task-v1",
        "version": "1.0.0",
        "domain": "coding",
        "requires_repo": True,
        "read_only": False,
        "prompt": {"template": "do the thing"},
        "hydration": {"sources": ["task_description"]},
        "agent_config": {
            "tier": "standard",
            "allowed_tools": ["Bash", "Read"],
            "cedar_policy_modules": ["builtin/hard_deny", "builtin/soft_deny"],
        },
        "steps": steps,
        "terminal_outcomes": {"primary": primary},
        "status": "production",
    }
    body.update(over)
    return Workflow.model_validate(body)


class _RecordingProgress:
    """Captures milestone strings so step-boundary emission can be asserted."""

    def __init__(self) -> None:
        self.milestones: list[str] = []

    def write_agent_milestone(self, milestone: str, details: str = "") -> None:
        self.milestones.append(milestone)


def _ctx(workflow: Workflow, progress=None) -> StepContext:
    # config is unused by fake handlers; a bare object is enough for the core.
    return StepContext(workflow=workflow, config=object(), progress=progress)  # type: ignore[arg-type]


def _ok(data=None):
    def handler(step: Step, ctx: StepContext) -> StepOutcome:
        return StepOutcome(
            kind=step.kind, name=_step_key(step), status="succeeded", data=data or {}
        )

    return handler


def _bad(error="boom"):
    def handler(step: Step, ctx: StepContext) -> StepOutcome:
        return StepOutcome(kind=step.kind, name=_step_key(step), status="failed", error=error)

    return handler


def _raises(exc: Exception | None = None):
    exc = exc or RuntimeError("kaboom")

    def handler(step: Step, ctx: StepContext) -> StepOutcome:
        raise exc

    return handler


def test_runs_all_steps_in_order_and_succeeds():
    seen: list[str] = []

    def track(step, ctx):
        seen.append(step.kind)
        return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

    wf = _workflow(
        [
            {"kind": "clone_repo"},
            {"kind": "hydrate_context"},
            {"kind": "run_agent"},
            {"kind": "ensure_pr", "strategy": "create"},
        ]
    )
    handlers = {k: track for k in ("clone_repo", "hydrate_context", "run_agent", "ensure_pr")}
    result = run_workflow(wf, _ctx(wf), handlers=handlers)
    assert seen == ["clone_repo", "hydrate_context", "run_agent", "ensure_pr"]
    assert result.succeeded
    assert result.terminal_outcome == "pr_url"
    assert len(result.outcomes) == 4


def test_artifacts_collected_from_outcome_data():
    wf = _workflow([{"kind": "run_agent"}, {"kind": "ensure_pr", "strategy": "create"}])
    handlers = {
        "run_agent": _ok({"agent_status": "success"}),
        "ensure_pr": _ok({"pr_url": "https://example/pr/1"}),
    }
    result = run_workflow(wf, _ctx(wf), handlers=handlers)
    assert result.artifacts["pr_url"] == "https://example/pr/1"
    assert result.artifacts["agent_status"] == "success"


def test_on_failure_fail_is_terminal_and_attributed():
    wf = _workflow([{"kind": "run_agent"}, {"kind": "ensure_pr", "strategy": "create"}])
    after_ran = {"hit": False}

    def mark(step, ctx):
        after_ran["hit"] = True
        return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

    handlers = {"run_agent": _bad("agent exploded"), "ensure_pr": mark}
    result = run_workflow(wf, _ctx(wf), handlers=handlers)
    assert not result.succeeded
    assert result.failed_step is not None
    assert result.failed_step.kind == "run_agent"
    assert result.failed_step.error == "agent exploded"
    assert after_ran["hit"] is False  # downstream step never ran


def test_on_failure_continue_proceeds():
    wf = _workflow(
        [
            {"kind": "verify_lint", "on_failure": "continue"},
            {"kind": "run_agent"},
        ]
    )
    handlers = {"verify_lint": _bad("lint failed"), "run_agent": _ok()}
    result = run_workflow(wf, _ctx(wf), handlers=handlers)
    assert result.succeeded  # the advisory failure did not stop the run
    assert [o.status for o in result.outcomes] == ["failed", "succeeded"]


def test_on_failure_skip_remaining_stops_cleanly():
    wf = _workflow(
        [
            {"kind": "run_agent", "on_failure": "skip_remaining"},
            {"kind": "ensure_pr", "strategy": "create"},
        ]
    )
    ran_ensure = {"hit": False}

    def ensure(step, ctx):
        ran_ensure["hit"] = True
        return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

    handlers = {"run_agent": _bad(), "ensure_pr": ensure}
    result = run_workflow(wf, _ctx(wf), handlers=handlers)
    assert result.succeeded  # skip_remaining ends cleanly, not FAILED
    assert ran_ensure["hit"] is False


def test_handler_exception_becomes_attributed_failure():
    wf = _workflow([{"kind": "run_agent"}])
    handlers = {"run_agent": _raises(RuntimeError("kaboom"))}
    result = run_workflow(wf, _ctx(wf), handlers=handlers)
    assert not result.succeeded
    assert result.failed_step is not None
    assert "kaboom" in (result.failed_step.error or "")


def test_missing_handler_is_attributed_failure():
    wf = _workflow([{"kind": "run_agent"}])
    result = run_workflow(wf, _ctx(wf), handlers={})  # no handler for run_agent
    assert not result.succeeded
    assert result.failed_step is not None
    assert "no handler" in (result.failed_step.error or "")


def test_step_boundary_milestones_emitted():
    wf = _workflow([{"kind": "run_agent", "name": "implement"}])
    progress = _RecordingProgress()
    handlers = {"run_agent": _ok()}
    run_workflow(wf, _ctx(wf, progress), handlers=handlers)
    assert "step:implement:start" in progress.milestones
    assert "step:implement:succeeded" in progress.milestones


def test_milestone_uses_kind_when_name_absent():
    wf = _workflow([{"kind": "run_agent"}])
    progress = _RecordingProgress()
    run_workflow(wf, _ctx(wf, progress), handlers={"run_agent": _ok()})
    assert "step:run_agent:start" in progress.milestones


class TestCheckpointResume:
    def test_completed_deterministic_step_skipped_on_resume(self, tmp_path: Path):
        wf = _workflow(
            [
                {"kind": "clone_repo", "name": "setup"},
                {"kind": "run_agent", "name": "implement"},
            ]
        )
        cp = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        calls: list[str] = []

        def clone(step, ctx):
            calls.append("clone")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        def agent(step, ctx):
            calls.append("agent")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        handlers = {"clone_repo": clone, "run_agent": agent}
        run_workflow(wf, _ctx(wf), handlers=handlers, checkpoint=cp)
        assert calls == ["clone", "agent"]

        # Resume: a fresh checkpoint object over the same dir sees the prior run.
        calls.clear()
        cp2 = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        run_workflow(wf, _ctx(wf), handlers=handlers, checkpoint=cp2)
        # clone_repo is deterministic+side-effect-free → skipped; run_agent re-runs.
        assert calls == ["agent"]

    def test_run_agent_not_skipped_on_resume(self, tmp_path: Path):
        # Agentic/side-effecting steps re-run (idempotently) — never skipped by key.
        wf = _workflow([{"kind": "run_agent", "name": "implement"}])
        cp = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        calls: list[str] = []

        def agent(step, ctx):
            calls.append("agent")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        run_workflow(wf, _ctx(wf), handlers={"run_agent": agent}, checkpoint=cp)
        run_workflow(
            wf,
            _ctx(wf),
            handlers={"run_agent": agent},
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        assert calls == ["agent", "agent"]

    def test_stale_checkpoint_from_other_task_ignored(self, tmp_path: Path):
        wf = _workflow([{"kind": "clone_repo", "name": "setup"}])
        WorkflowCheckpoint("task-A", state_dir=tmp_path).save(
            "setup", StepOutcome(kind="clone_repo", name="setup", status="succeeded")
        )
        calls: list[str] = []

        def clone(step, ctx):
            calls.append("clone")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        # Different task id over the same mount must NOT inherit task-A's checkpoint.
        run_workflow(
            wf,
            _ctx(wf),
            handlers={"clone_repo": clone},
            checkpoint=WorkflowCheckpoint("task-B", state_dir=tmp_path),
        )
        assert calls == ["clone"]

    def test_failed_step_not_skipped_on_resume(self, tmp_path: Path):
        wf = _workflow([{"kind": "verify_build", "name": "build", "on_failure": "continue"}])
        cp = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        run_workflow(wf, _ctx(wf), handlers={"verify_build": _bad()}, checkpoint=cp)
        calls: list[str] = []

        def build(step, ctx):
            calls.append("build")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        run_workflow(
            wf,
            _ctx(wf),
            handlers={"verify_build": build},
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        assert calls == ["build"]  # prior outcome was failed → re-run

    def test_checkpoint_file_written_to_state_dir(self, tmp_path: Path):
        wf = _workflow([{"kind": "clone_repo", "name": "setup"}])
        cp = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        run_workflow(wf, _ctx(wf), handlers={"clone_repo": _ok()}, checkpoint=cp)
        state_file = tmp_path / "workflow_state.json"
        assert state_file.is_file()
        payload = json.loads(state_file.read_text())
        assert payload["task_id"] == "task-1"
        assert "setup" in payload["steps"]


def test_default_handlers_cover_every_step_kind():
    """Parity with the validator's handler set — every StepKind has a handler."""
    from workflow import STEP_HANDLERS
    from workflow.validator import _HANDLER_KINDS

    assert set(STEP_HANDLERS) == set(_HANDLER_KINDS)


@pytest.mark.parametrize("unimpl", ["post_review", "deliver_artifact"])
def test_phase_gated_handlers_fail_loud(unimpl):
    """Phase 2b/3 handlers are registered but must raise, not silently no-op."""
    from workflow import STEP_HANDLERS

    wf = _workflow([{"kind": unimpl}], primary="review_posted")
    with pytest.raises(NotImplementedError):
        STEP_HANDLERS[unimpl](wf.steps[0], _ctx(wf))
