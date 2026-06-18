"""Coding-lane post-hook gating honors each verify step's declared ``gate`` (#301).

The inline post-hook path in ``pipeline.run_task`` consults the workflow's
``verify_build`` / ``verify_lint`` steps through the runner's ``gate_status`` —
the single place gate semantics live — instead of hardcoding regression-only
gating. These tests pin:

- ``gate: strict`` fails the task on a build regression on the coding lane
  (and ``informational`` never gates) — end-to-end through ``run_task``.
- The three shipped coding workflows keep their exact pre-#301 effective
  gating: inline verdict == runner verdict == legacy verdict for the
  ``regression_only`` and ``read_only`` cases.
"""

from __future__ import annotations

from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest

from models import AgentResult, RepoSetup
from pipeline import _apply_post_hook_gates
from workflow import Workflow, gate_status, load_workflow


def _workflow(steps: list[dict], **over) -> Workflow:
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
        "terminal_outcomes": {"primary": "pr_url"},
        "status": "production",
    }
    body.update(over)
    return Workflow.model_validate(body)


_BASE_STEPS = [
    {"kind": "clone_repo", "name": "setup"},
    {"kind": "run_agent", "name": "implement"},
]


def _wf_with_build_gate(gate: str | None, **over) -> Workflow:
    build_step: dict = {"kind": "verify_build", "name": "build"}
    if gate is not None:
        build_step["gate"] = gate
    steps = [*_BASE_STEPS, build_step, {"kind": "ensure_pr", "strategy": "create"}]
    return _workflow(steps, **over)


class TestApplyPostHookGates:
    """Unit semantics of the inline gate resolution."""

    def test_strict_gates_on_regression(self):
        wf = _wf_with_build_gate("strict")
        assert not _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=True,
            lint_before=True,
        )

    def test_strict_gates_even_preexisting_failure(self):
        # strict means ANY failure gates — including a build that was already
        # red before the agent ran (the case regression_only forgives).
        wf = _wf_with_build_gate("strict")
        assert not _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=False,
            lint_before=True,
        )

    def test_informational_never_gates(self):
        wf = _wf_with_build_gate("informational")
        assert _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=True,
            lint_before=True,
        )

    def test_regression_only_gates_a_regression(self):
        wf = _wf_with_build_gate("regression_only")
        assert not _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=True,
            lint_before=True,
        )

    def test_regression_only_ignores_preexisting_failure(self):
        wf = _wf_with_build_gate("regression_only")
        assert _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=False,
            lint_before=True,
        )

    def test_unset_gate_defaults_to_regression_only(self):
        wf = _wf_with_build_gate(None)
        assert not _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=True,
            lint_before=True,
        )
        assert _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=False,
            lint_before=True,
        )

    def test_read_only_never_gates_even_strict(self):
        wf = _wf_with_build_gate("strict", read_only=True)
        assert _apply_post_hook_gates(
            wf,
            read_only=True,
            build_passed=False,
            lint_passed=True,
            build_before=True,
            lint_before=True,
        )

    def test_undeclared_verify_lint_never_gates(self):
        # Legacy: lint is not used for terminal status unless a workflow
        # declares the step (the shipped coding workflows do not).
        wf = _wf_with_build_gate("regression_only")
        assert _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=True,
            lint_passed=False,
            build_before=True,
            lint_before=True,
        )

    def test_declared_strict_verify_lint_gates(self):
        steps = [
            *_BASE_STEPS,
            {"kind": "verify_build", "name": "build", "gate": "regression_only"},
            {"kind": "verify_lint", "name": "lint", "gate": "strict"},
            {"kind": "ensure_pr", "strategy": "create"},
        ]
        wf = _workflow(steps)
        assert not _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=True,
            lint_passed=False,
            build_before=True,
            lint_before=True,
        )

    def test_advisory_on_failure_continue_does_not_gate(self):
        # on_failure: continue marks the step advisory — the runner records the
        # failure and proceeds, so the inline verdict must not gate either.
        steps = [
            *_BASE_STEPS,
            {"kind": "verify_build", "name": "build", "gate": "regression_only"},
            {
                "kind": "verify_lint",
                "name": "lint",
                "gate": "strict",
                "on_failure": "continue",
            },
            {"kind": "ensure_pr", "strategy": "create"},
        ]
        wf = _workflow(steps)
        assert _apply_post_hook_gates(
            wf,
            read_only=False,
            build_passed=True,
            lint_passed=False,
            build_before=True,
            lint_before=True,
        )

    def test_workflow_none_falls_back_to_legacy(self):
        # Post-hook reload failed: build keeps legacy regression-only gating,
        # lint never gates — a corrupt file cannot strand the agent's work.
        assert not _apply_post_hook_gates(
            None,
            read_only=False,
            build_passed=False,
            lint_passed=True,
            build_before=True,
            lint_before=True,
        )
        assert _apply_post_hook_gates(
            None,
            read_only=False,
            build_passed=False,
            lint_passed=False,
            build_before=False,
            lint_before=True,
        )


class TestShippedWorkflowParity:
    """Lock: no behavior change for the three shipped coding workflows.

    For every (build_passed, build_before) combination, the inline verdict
    (``_apply_post_hook_gates``), the runner verdict (``gate_status`` on the
    declared step), and the legacy pre-#301 inline logic must agree.
    """

    SHIPPED: ClassVar[list[str]] = [
        "coding/new-task-v1",
        "coding/pr-iteration-v1",
        "coding/pr-review-v1",
    ]

    @staticmethod
    def _legacy_build_ok(*, read_only: bool, build_passed: bool, build_before: bool) -> bool:
        # The pre-#301 inline logic, verbatim.
        if read_only:
            return True
        return build_passed or not build_before

    @pytest.mark.parametrize("workflow_id", SHIPPED)
    @pytest.mark.parametrize("build_passed", [True, False])
    @pytest.mark.parametrize("build_before", [True, False])
    def test_inline_runner_and_legacy_verdicts_match(self, workflow_id, build_passed, build_before):
        wf = load_workflow(workflow_id)
        build_step = next(s for s in wf.steps if s.kind == "verify_build")

        inline_ok = _apply_post_hook_gates(
            wf,
            read_only=wf.read_only,
            build_passed=build_passed,
            lint_passed=True,
            build_before=build_before,
            lint_before=True,
        )
        runner_ok = (
            gate_status(
                passed=build_passed,
                gate=build_step.gate,
                read_only=wf.read_only,
                was_passing_before=build_before,
            )
            == "succeeded"
        )
        legacy_ok = self._legacy_build_ok(
            read_only=wf.read_only, build_passed=build_passed, build_before=build_before
        )
        assert inline_ok == runner_ok == legacy_ok

    @pytest.mark.parametrize("workflow_id", SHIPPED)
    def test_lint_failure_never_gates_shipped_workflows(self, workflow_id):
        # None of the shipped coding workflows declare verify_lint, so a lint
        # failure must not gate — exactly the legacy behavior.
        wf = load_workflow(workflow_id)
        assert all(s.kind != "verify_lint" for s in wf.steps)
        assert _apply_post_hook_gates(
            wf,
            read_only=wf.read_only,
            build_passed=True,
            lint_passed=False,
            build_before=True,
            lint_before=True,
        )


class TestRunTaskHonorsGate:
    """End-to-end through run_task: the declared gate decides the task verdict."""

    @staticmethod
    def _span() -> MagicMock:
        span = MagicMock()
        span.__enter__ = MagicMock(return_value=span)
        span.__exit__ = MagicMock(return_value=False)
        return span

    def _run(self, *, gate: str, build_passed: bool, build_before: bool) -> tuple[dict, MagicMock]:
        wf = _wf_with_build_gate(gate)

        async def fake_run_agent(_p, _s, _c, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_ensure_pr = MagicMock(return_value="https://github.com/o/r/pull/1")

        with (
            patch("runner.run_agent", side_effect=fake_run_agent),
            patch("pipeline.build_system_prompt", return_value="sys"),
            patch("pipeline.discover_project_config", return_value=None),
            patch(
                "repo.setup_repo",
                return_value=RepoSetup(
                    repo_dir="/workspace/repo",
                    branch="bgagent/test/branch",
                    build_before=build_before,
                ),
            ),
            patch("pipeline.task_span", return_value=self._span()),
            patch("pipeline.task_state"),
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=build_passed),
            patch("pipeline.verify_lint", return_value=True),
            patch("pipeline.ensure_pr", mock_ensure_pr),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("workflow.load_workflow", return_value=wf),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-gate",
                resolved_workflow={"id": "coding/new-task-v1", "version": "1.0.0"},
            )
        return result, mock_ensure_pr

    def test_strict_gate_fails_task_on_build_regression(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        result, mock_ensure_pr = self._run(gate="strict", build_passed=False, build_before=True)
        assert result["status"] == "error"
        # The inline ordering is preserved: ensure_pr still ran (the PR is the
        # reviewable artifact even when the gate fails the task).
        mock_ensure_pr.assert_called_once()

    def test_strict_gate_fails_task_even_when_broken_before(self, monkeypatch):
        # The case the legacy regression-only inline logic would have passed —
        # strict must gate it (this is exactly what #301 makes effective).
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        result, _ = self._run(gate="strict", build_passed=False, build_before=False)
        assert result["status"] == "error"

    def test_informational_gate_never_fails_task(self, monkeypatch):
        # A build regression that regression_only/strict would gate — the
        # author opted out via gate: informational, so the task succeeds.
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        result, mock_ensure_pr = self._run(
            gate="informational", build_passed=False, build_before=True
        )
        assert result["status"] == "success"
        mock_ensure_pr.assert_called_once()
