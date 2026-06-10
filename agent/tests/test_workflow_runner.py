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
from workflow.runner import StepHandler, WorkflowCheckpoint, _step_key

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
    return StepContext(workflow=workflow, config=object(), progress=progress)  # ty: ignore[invalid-argument-type]


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

    def track(step: Step, ctx: StepContext) -> StepOutcome:
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
    handlers: dict[str, StepHandler] = {
        k: track for k in ("clone_repo", "hydrate_context", "run_agent", "ensure_pr")
    }
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

    def mark(step: Step, ctx: StepContext) -> StepOutcome:
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

    def ensure(step: Step, ctx: StepContext) -> StepOutcome:
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
    def test_completed_verify_step_skipped_on_resume(self, tmp_path: Path):
        # Only steps whose ENTIRE product is in the checkpoint data (and re-applied
        # via ctx.artifacts) are skippable — verify_build/verify_lint qualify.
        wf = _workflow(
            [
                {"kind": "verify_build", "name": "build"},
                {"kind": "run_agent", "name": "implement"},
            ]
        )
        cp = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        calls: list[str] = []

        def build(step: Step, ctx: StepContext) -> StepOutcome:
            calls.append("build")
            return StepOutcome(
                kind=step.kind,
                name=_step_key(step),
                status="succeeded",
                data={"build_passed": True},
            )

        def agent(step: Step, ctx: StepContext) -> StepOutcome:
            calls.append("agent")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        handlers: dict[str, StepHandler] = {"verify_build": build, "run_agent": agent}
        run_workflow(wf, _ctx(wf), handlers=handlers, checkpoint=cp)
        assert calls == ["build", "agent"]

        # Resume: a fresh checkpoint object over the same dir sees the prior run.
        calls.clear()
        cp2 = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        result = run_workflow(wf, _ctx(wf), handlers=handlers, checkpoint=cp2)
        # verify_build is skipped; run_agent re-runs. The skipped step's product
        # (build_passed) is still re-applied to artifacts via ctx.record(prior).
        assert calls == ["agent"]
        assert result.artifacts["build_passed"] is True

    def test_clone_repo_not_skipped_on_resume(self, tmp_path: Path):
        # clone_repo populates an in-memory product (ctx.setup) that can't be
        # rebuilt from the JSON checkpoint, so it must re-run (handler-level
        # idempotency), never be skipped — else ctx.setup would stay None and
        # break downstream steps.
        wf = _workflow(
            [
                {"kind": "clone_repo", "name": "setup"},
                {"kind": "run_agent", "name": "implement"},
            ]
        )
        calls: list[str] = []

        def clone(step: Step, ctx: StepContext) -> StepOutcome:
            calls.append("clone")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        def agent(step: Step, ctx: StepContext) -> StepOutcome:
            calls.append("agent")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        handlers: dict[str, StepHandler] = {"clone_repo": clone, "run_agent": agent}
        run_workflow(
            wf,
            _ctx(wf),
            handlers=handlers,
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        calls.clear()
        run_workflow(
            wf,
            _ctx(wf),
            handlers=handlers,
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        assert calls == ["clone", "agent"]  # clone re-runs, not skipped

    def test_run_agent_not_skipped_on_resume(self, tmp_path: Path):
        # Agentic/side-effecting steps re-run (idempotently) — never skipped by key.
        wf = _workflow([{"kind": "run_agent", "name": "implement"}])
        cp = WorkflowCheckpoint("task-1", state_dir=tmp_path)
        calls: list[str] = []

        def agent(step: Step, ctx: StepContext) -> StepOutcome:
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

        def clone(step: Step, ctx: StepContext) -> StepOutcome:
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

        def build(step: Step, ctx: StepContext) -> StepOutcome:
            calls.append("build")
            return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

        run_workflow(
            wf,
            _ctx(wf),
            handlers={"verify_build": build},
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        assert calls == ["build"]  # prior outcome was failed → re-run

    def test_skipped_step_emits_boundary_milestones(self, tmp_path: Path):
        # A resumed run must still account for the skipped step in milestones, so
        # a watcher sees it rather than a gap.
        wf = _workflow(
            [
                {"kind": "verify_build", "name": "build"},
                {"kind": "run_agent", "name": "implement"},
            ]
        )
        handlers = {
            "verify_build": _ok({"build_passed": True}),
            "run_agent": _ok(),
        }
        run_workflow(
            wf,
            _ctx(wf),
            handlers=handlers,
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        progress = _RecordingProgress()
        run_workflow(
            wf,
            _ctx(wf, progress),
            handlers=handlers,
            checkpoint=WorkflowCheckpoint("task-1", state_dir=tmp_path),
        )
        assert "step:build:start" in progress.milestones
        assert "step:build:skipped" in progress.milestones

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


@pytest.mark.parametrize("unimpl", ["post_review"])
def test_phase_gated_handlers_fail_loud(unimpl):
    """Still-stubbed handlers are registered but must raise, not silently no-op.

    deliver_artifact graduated from this list in #248 Phase 3 (now implemented);
    post_review remains a stub until its phase.
    """
    from workflow import STEP_HANDLERS

    wf = _workflow([{"kind": unimpl}], primary="review_posted")
    with pytest.raises(NotImplementedError):
        STEP_HANDLERS[unimpl](wf.steps[0], _ctx(wf))


class TestGateStatus:
    """The shared verify-gate semantics (verify_build / verify_lint)."""

    def test_passing_always_succeeds(self):
        from workflow.runner import gate_status

        assert (
            gate_status(passed=True, gate="strict", read_only=False, was_passing_before=True)
            == "succeeded"
        )

    def test_strict_failure_gates(self):
        from workflow.runner import gate_status

        assert (
            gate_status(passed=False, gate="strict", read_only=False, was_passing_before=True)
            == "failed"
        )

    def test_informational_never_gates(self):
        from workflow.runner import gate_status

        assert (
            gate_status(
                passed=False, gate="informational", read_only=False, was_passing_before=True
            )
            == "succeeded"
        )

    def test_read_only_never_gates(self):
        from workflow.runner import gate_status

        # read_only workflows treat verify results as informational (matches
        # pipeline.py: pr_review build status is informational only).
        assert (
            gate_status(passed=False, gate="strict", read_only=True, was_passing_before=True)
            == "succeeded"
        )

    def test_regression_only_gates_a_regression(self):
        from workflow.runner import gate_status

        # was passing before, fails now → regression → gates.
        assert (
            gate_status(
                passed=False, gate="regression_only", read_only=False, was_passing_before=True
            )
            == "failed"
        )

    def test_regression_only_ignores_preexisting_failure(self):
        from workflow.runner import gate_status

        # already broken before the agent ran → not a regression → does NOT gate
        # (mirrors pipeline.py build_ok = passed or not build_before).
        assert (
            gate_status(
                passed=False, gate="regression_only", read_only=False, was_passing_before=False
            )
            == "succeeded"
        )

    def test_unset_gate_defaults_to_regression_only(self):
        from workflow.runner import gate_status

        # An unset gate must mirror pipeline.py (which is always regression-only),
        # NOT default to strict: a regression gates, a pre-existing failure does not.
        assert (
            gate_status(passed=False, gate=None, read_only=False, was_passing_before=True)
            == "failed"
        )
        assert (
            gate_status(passed=False, gate=None, read_only=False, was_passing_before=False)
            == "succeeded"
        )


def _real_ctx(workflow: Workflow, **kw):
    """A StepContext with a real (minimal) TaskConfig for handler tests."""
    from models import TaskConfig

    config = TaskConfig(
        repo_url="owner/repo",
        github_token="ghp_test",
        aws_region="us-east-1",
        task_id="task-1",
        max_turns=10,
    )
    return StepContext(workflow=workflow, config=config, **kw)


class TestVerifyHandlers:
    def test_verify_build_regression_only_passes_when_broken_before(self, monkeypatch):
        from models import RepoSetup
        from workflow.runner import _handle_verify_build

        # build red after, but it was already red before → not a regression.
        monkeypatch.setattr("post_hooks.verify_build", lambda _d: False)
        wf = _workflow(
            [
                {"kind": "verify_build", "name": "build", "gate": "regression_only"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        ctx = _real_ctx(wf, setup=RepoSetup(repo_dir="/r", branch="b", build_before=False))
        outcome = _handle_verify_build(wf.steps[0], ctx)
        assert outcome.succeeded
        assert outcome.data["build_passed"] is False

    def test_verify_build_regression_only_fails_on_regression(self, monkeypatch):
        from models import RepoSetup
        from workflow.runner import _handle_verify_build

        monkeypatch.setattr("post_hooks.verify_build", lambda _d: False)
        wf = _workflow(
            [
                {"kind": "verify_build", "name": "build", "gate": "regression_only"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        ctx = _real_ctx(wf, setup=RepoSetup(repo_dir="/r", branch="b", build_before=True))
        assert _handle_verify_build(wf.steps[0], ctx).failed

    def test_verify_lint_read_only_is_informational(self, monkeypatch):
        from models import RepoSetup
        from workflow.runner import _handle_verify_lint

        # read_only workflow: a lint failure must not gate (symmetry with build).
        monkeypatch.setattr("post_hooks.verify_lint", lambda _d: False)
        wf = _workflow(
            [
                {"kind": "clone_repo"},
                {"kind": "verify_lint", "name": "lint"},
                {"kind": "run_agent"},
                {"kind": "post_review"},
            ],
            primary="review_posted",
            read_only=True,
        )
        ctx = _real_ctx(wf, setup=RepoSetup(repo_dir="/r", branch="b", lint_before=True))
        assert _handle_verify_lint(wf.steps[1], ctx).succeeded


class TestCloneAndHydrateHandlers:
    def test_clone_repo_reuses_prepopulated_setup(self, monkeypatch):
        from models import RepoSetup
        from workflow.runner import _handle_clone_repo

        called = {"n": 0}

        def fake_setup_repo(_config):
            called["n"] += 1
            return RepoSetup(repo_dir="/fresh", branch="fresh")

        monkeypatch.setattr("repo.setup_repo", fake_setup_repo)
        wf = _workflow(
            [
                {"kind": "clone_repo"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        pre = RepoSetup(repo_dir="/pre", branch="pre")
        ctx = _real_ctx(wf, setup=pre)
        outcome = _handle_clone_repo(wf.steps[0], ctx)
        assert called["n"] == 0  # setup_repo NOT called — reused
        assert ctx.setup is pre
        assert outcome.data["reused"] is True

    def test_clone_repo_clones_when_absent(self, monkeypatch):
        from models import RepoSetup
        from workflow.runner import _handle_clone_repo

        monkeypatch.setattr(
            "repo.setup_repo", lambda _c: RepoSetup(repo_dir="/fresh", branch="fresh")
        )
        wf = _workflow(
            [
                {"kind": "clone_repo"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        ctx = _real_ctx(wf)
        outcome = _handle_clone_repo(wf.steps[0], ctx)
        assert ctx.setup is not None and ctx.setup.repo_dir == "/fresh"
        assert outcome.data["reused"] is False

    def test_hydrate_context_builds_system_prompt(self, monkeypatch):
        from models import RepoSetup
        from workflow.runner import _handle_hydrate_context

        monkeypatch.setattr(
            "prompt_builder.build_system_prompt",
            lambda _c, _s, _h, _o: "BUILT-SYSTEM-PROMPT",
        )
        wf = _workflow(
            [
                {"kind": "clone_repo"},
                {"kind": "hydrate_context"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        ctx = _real_ctx(wf, setup=RepoSetup(repo_dir="/r", branch="b"))
        outcome = _handle_hydrate_context(wf.steps[1], ctx)
        assert ctx.system_prompt == "BUILT-SYSTEM-PROMPT"
        assert outcome.data["system_prompt_built"] is True

    def test_hydrate_context_skips_build_without_setup(self):
        from workflow.runner import _handle_hydrate_context

        # repo-less: no setup → system prompt left to the caller, not built here.
        wf = _workflow(
            [
                {"kind": "hydrate_context"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        ctx = _real_ctx(wf)
        outcome = _handle_hydrate_context(wf.steps[0], ctx)
        assert ctx.system_prompt == ""
        assert outcome.data["system_prompt_built"] is False


class TestRunAgentHandler:
    def test_empty_system_prompt_fails_loud(self):
        # run_agent must not run an unguided (empty system prompt) agent loop —
        # it raises so the step is an attributable failure, not a silent no-op.
        from workflow.runner import _handle_run_agent

        wf = _workflow([{"kind": "run_agent"}])
        ctx = _real_ctx(wf)  # system_prompt defaults to ""
        with pytest.raises(ValueError, match="empty system prompt"):
            _handle_run_agent(wf.steps[0], ctx)

    def test_empty_system_prompt_surfaces_as_failed_step(self):
        # Through run_workflow, the raise becomes a failed StepOutcome (the runner
        # never crashes mid-workflow) attributed to the run_agent step.
        wf = _workflow([{"kind": "run_agent", "name": "implement"}])
        result = run_workflow(wf, _real_ctx(wf))
        assert not result.succeeded
        assert result.failed_step is not None
        assert result.failed_step.name == "implement"
        assert "empty system prompt" in (result.failed_step.error or "")
