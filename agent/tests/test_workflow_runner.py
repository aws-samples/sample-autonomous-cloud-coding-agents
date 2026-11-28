"""Unit tests for the agent-side workflow step runner (#248).

These exercise the orchestration core — step ordering, the ``on_failure``
policies, exception attribution, step-boundary milestones and terminal-outcome
resolution — with fake handlers, so the loop is tested independently of the
real (SDK/git/boto3-backed) handlers.
"""

from __future__ import annotations

import os

import pytest

from workflow import Step, StepContext, StepOutcome, Workflow, run_workflow
from workflow.runner import StepHandler, _step_key


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
    handlers: dict[str, StepHandler] = dict.fromkeys(
        ("clone_repo", "hydrate_context", "run_agent", "ensure_pr"), track
    )
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


def test_running_step_is_named_in_the_environment_of_the_commit_hook(monkeypatch):
    # prepare-commit-msg.sh writes WORKFLOW_ID and WORKFLOW_STEP on a commit as its
    # Workflow-Id and Workflow-Step trailers (#560).
    monkeypatch.setenv("WORKFLOW_ID", "default/agent-v1")  # left by an earlier run
    monkeypatch.setenv("WORKFLOW_STEP", "deliver")
    named: list[tuple[str, str]] = []

    def record(step: Step, ctx: StepContext) -> StepOutcome:
        named.append((os.environ["WORKFLOW_ID"], os.environ["WORKFLOW_STEP"]))
        return StepOutcome(kind=step.kind, name=_step_key(step), status="succeeded")

    wf = _workflow(
        [
            {"kind": "clone_repo", "name": "setup"},
            {"kind": "run_agent", "name": "implement"},
            {"kind": "ensure_pr", "strategy": "create"},  # no name: named by its kind
        ]
    )
    handlers: dict[str, StepHandler] = dict.fromkeys(
        ("clone_repo", "run_agent", "ensure_pr"), record
    )
    run_workflow(wf, _ctx(wf), handlers=handlers)

    assert named == [
        ("coding/new-task-v1", "setup"),
        ("coding/new-task-v1", "implement"),
        ("coding/new-task-v1", "ensure_pr"),
    ]


def test_default_handlers_cover_every_kind_a_repo_less_workflow_may_declare():
    """The runner runs every step of a workflow without a repository. On the
    repo-bound path it gets ``run_agent`` only: the repo-only kinds are the pipeline's."""
    from workflow import STEP_HANDLERS
    from workflow.loader import _schema
    from workflow.validator import _REPO_ONLY_KINDS

    kinds = set(_schema()["properties"]["steps"]["items"]["properties"]["kind"]["enum"])
    assert set(STEP_HANDLERS) == kinds - _REPO_ONLY_KINDS


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


class TestHydrateContextHandler:
    @staticmethod
    def _hydrate_user_prompt(**ctx_fields) -> str:
        """The user prompt after the hydrate_context step, whose context was
        hydrated by the orchestrator with the prompt ``HYDRATED``."""
        from models import HydratedContext
        from workflow.runner import _handle_hydrate_context

        wf = _workflow(
            [
                {"kind": "hydrate_context"},
                {"kind": "run_agent"},
                {"kind": "ensure_pr", "strategy": "create"},
            ]
        )
        ctx = _real_ctx(wf, hydrated=HydratedContext(user_prompt="HYDRATED"), **ctx_fields)
        _handle_hydrate_context(wf.steps[0], ctx)
        return ctx.user_prompt

    def test_hydrate_context_takes_the_hydrated_prompt(self):
        assert self._hydrate_user_prompt() == "HYDRATED"

    def test_hydrate_context_keeps_a_prompt_the_caller_built(self):
        # The pipeline hands the step the hydrated prompt with the attachment
        # references appended. The step must not put the bare one back.
        built = "HYDRATED\n\nAttachments: `Read /workspace/.attachments/att-1/report.txt`"

        assert self._hydrate_user_prompt(user_prompt=built) == built


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
