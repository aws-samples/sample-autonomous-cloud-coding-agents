"""Tests for the gated workflow-runner seam in pipeline.run_task (#248 task 5).

The seam ("build it, gate it off") routes the agentic ``run_agent`` step through
``workflow.run_workflow`` when ``WORKFLOW_RUNNER_ENABLED`` is set AND the task's
``task_type`` maps to a shipped workflow; otherwise it is the legacy inline
``run_agent`` call. These tests pin both branches of ``_execute_agent_step`` and
the task_type→workflow bridge, without standing up the full pipeline.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from models import AgentResult, RepoSetup, TaskConfig
from pipeline import _execute_agent_step, _workflow_id_for_task_type


def _config(task_type: str = "new_task") -> TaskConfig:
    return TaskConfig(
        repo_url="owner/repo",
        github_token="ghp_test",
        aws_region="us-east-1",
        task_id="task-1",
        task_type=task_type,
        max_turns=10,
    )


def _setup() -> RepoSetup:
    return RepoSetup(repo_dir="/workspace/repo", branch="bgagent/task-1", default_branch="main")


class TestWorkflowIdBridge:
    def test_new_task_maps_to_coding_workflow(self):
        assert _workflow_id_for_task_type("new_task") == "coding/new-task-v1"

    @pytest.mark.parametrize("tt", ["pr_iteration", "pr_review", "unknown"])
    def test_unmigrated_task_types_have_no_workflow_yet(self, tt):
        assert _workflow_id_for_task_type(tt) is None


class TestExecuteAgentStep:
    def _fake_run_agent(self, result: AgentResult):
        async def fake(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return result

        return fake

    def test_gate_off_uses_inline_run_agent(self, monkeypatch):
        # Default (flag unset): legacy inline path. run_workflow is lazily
        # imported from the workflow package, so patch it there and assert the
        # gate-off branch never reaches it.
        monkeypatch.delenv("WORKFLOW_RUNNER_ENABLED", raising=False)
        expected = AgentResult(status="success", session_id="s1")
        with (
            patch("pipeline.run_agent", side_effect=self._fake_run_agent(expected)),
            patch("workflow.run_workflow") as mock_wf,
        ):
            out = _execute_agent_step(
                "prompt", "sysprompt", _config(), _setup(), None, None, None
            )
        assert out is expected
        mock_wf.assert_not_called()

    def test_gate_on_but_unmigrated_task_type_uses_inline(self, monkeypatch):
        # Flag on, but pr_review has no workflow yet → still the inline path.
        monkeypatch.setenv("WORKFLOW_RUNNER_ENABLED", "1")
        expected = AgentResult(status="success")
        with (
            patch("pipeline.run_agent", side_effect=self._fake_run_agent(expected)),
            patch("workflow.run_workflow") as mock_wf,
        ):
            out = _execute_agent_step(
                "prompt", "sys", _config("pr_review"), _setup(), None, None, None
            )
        assert out is expected
        mock_wf.assert_not_called()

    def test_gate_on_new_task_routes_through_runner(self, monkeypatch):
        # Flag on + new_task → the run_agent step runs through the workflow
        # runner, and the agent result is threaded back via ctx.agent_result.
        # run_agent is lazily imported inside the handler from the top-level
        # `runner` module, so patch it there.
        monkeypatch.setenv("WORKFLOW_RUNNER_ENABLED", "true")
        expected = AgentResult(status="success", session_id="wf-session")

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with patch("runner.run_agent", side_effect=fake):
            out = _execute_agent_step(
                "the-user-prompt", "the-system-prompt", _config(), _setup(), None, None, None
            )
        assert out is expected

    def test_gate_on_only_runs_agent_step_not_post_hooks(self, monkeypatch):
        # The seam restricts the runner to the run_agent step: deterministic
        # post-hook handlers (ensure_pr/verify_build) must NOT fire here — the
        # inline path owns them. We assert ensure_pr's handler is never invoked.
        monkeypatch.setenv("WORKFLOW_RUNNER_ENABLED", "1")
        expected = AgentResult(status="success")

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with (
            patch("runner.run_agent", side_effect=fake),
            patch("post_hooks.ensure_pr") as mock_ensure_pr,
            patch("post_hooks.verify_build") as mock_build,
        ):
            out = _execute_agent_step("p", "s", _config(), _setup(), None, None, None)
        assert out is expected
        mock_ensure_pr.assert_not_called()
        mock_build.assert_not_called()
