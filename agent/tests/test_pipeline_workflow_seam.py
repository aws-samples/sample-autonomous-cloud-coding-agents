"""Tests for the workflow-runner seam in pipeline._execute_agent_step (#248).

Post-cutover (task 8) the workflow runner is the sole agentic path: the single
``run_agent`` step is dispatched through ``workflow.run_workflow`` (driven by the
resolved workflow id), while clone/context/post-hooks stay inline. These tests
pin that path without standing up the full pipeline.
"""

from __future__ import annotations

import subprocess
from unittest.mock import patch

import pytest

from models import AgentResult, RepoSetup, TaskConfig
from pipeline import _execute_agent_step
from post_hooks import ensure_committed
from repo import _install_commit_hook


def _config(workflow_id: str = "coding/new-task-v1") -> TaskConfig:
    return TaskConfig(
        repo_url="owner/repo",
        github_token="ghp_test",
        aws_region="us-east-1",
        task_id="task-1",
        resolved_workflow={"id": workflow_id, "version": "1.0.0"},
        max_turns=10,
    )


def _setup() -> RepoSetup:
    return RepoSetup(repo_dir="/workspace/repo", branch="bgagent/task-1", default_branch="main")


class TestExecuteAgentStep:
    def test_routes_through_runner_and_threads_result(self):
        # The run_agent step runs through the workflow runner; the agent result
        # threads back via ctx.agent_result. run_agent is lazily imported inside
        # the handler from the top-level `runner` module, so patch it there.
        expected = AgentResult(status="success", session_id="wf-session")

        async def fake(_p, _s, _c, cwd=None, trajectory=None):
            return expected

        with patch("runner.run_agent", side_effect=fake):
            out = _execute_agent_step(
                "the-user-prompt", "the-system-prompt", _config(), _setup(), None, None, None
            )
        assert out is expected

    def test_only_runs_agent_step_not_post_hooks(self):
        # The seam restricts the runner to the run_agent step: deterministic
        # post-hook handlers (ensure_pr/verify_build) must NOT fire here — the
        # inline path owns them.
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

    def test_run_agent_failure_reraises_to_preserve_error_contract(self):
        # When the run_agent step's handler raises, run_workflow captures it into
        # a failed StepOutcome (does not propagate). _execute_agent_step must
        # RE-RAISE so run_task's `except` block restores full error fidelity
        # (log_error_cw mirror + real text) — not silently downgrade to a generic
        # AgentResult. The original error text must be carried in the raise.
        async def boom(_p, _s, _c, cwd=None, trajectory=None):
            raise RuntimeError("SDK session expired")

        with (
            patch("runner.run_agent", side_effect=boom),
            pytest.raises(RuntimeError, match="SDK session expired"),
        ):
            _execute_agent_step("p", "s", _config(), _setup(), None, None, None)


def _git(repo, *args) -> str:
    """Run git for real in *repo*, a directory under ``tmp_path``."""
    done = subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)
    return done.stdout.strip()


class TestCommitTrailersOfAWorkflowRun:
    """The commits of a task name the workflow and the step they were made in (#560).

    The runner, the workflow file, the commit hook and git are the real ones. Only
    the agent is replaced: by one that commits a change and leaves another one
    uncommitted, for the safety-net commit ``run_task`` makes after the step."""

    @pytest.fixture
    def repo(self, tmp_path, monkeypatch):
        """A repository with the hook installed, and the environment ``run_task``
        has prepared when it reaches the agent step: the committer identity, the
        task and the prompt version. The two workflow variables hold what an
        earlier run in this process left in them."""
        repo = tmp_path / "repo"
        repo.mkdir()
        # Not the ignore file of the host: git would refuse to add a file it names.
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
        for role in ("AUTHOR", "COMMITTER"):
            monkeypatch.setenv(f"GIT_{role}_NAME", "bgagent")
            monkeypatch.setenv(f"GIT_{role}_EMAIL", "bgagent@noreply.github.com")
        monkeypatch.setenv("TASK_ID", "task-1")
        monkeypatch.setenv("PROMPT_VERSION", "1c9c10e027a2")
        monkeypatch.setenv("WORKFLOW_ID", "default/agent-v1")
        monkeypatch.setenv("WORKFLOW_STEP", "deliver")
        _git(repo, "init", "-q")
        _install_commit_hook(str(repo))
        return repo

    def test_agent_commit_and_safety_net_commit_name_the_workflow_and_the_agent_step(self, repo):
        def work_of_the_agent() -> None:
            (repo / "a.txt").write_text("committed by the agent\n")
            _git(repo, "add", "a.txt")
            _git(repo, "commit", "-qm", "feat: add a")
            (repo / "a.txt").write_text("committed by the agent\nleft uncommitted\n")

        async def agent(_p, _s, _c, cwd=None, trajectory=None):
            work_of_the_agent()
            return AgentResult(status="success")

        setup = RepoSetup(repo_dir=str(repo), branch="bgagent/task-1", default_branch="main")
        with patch("runner.run_agent", side_effect=agent):
            _execute_agent_step("p", "s", _config(), setup, None, None, None)
        of_the_agent_commit = _git(repo, "log", "-1", "--format=%(trailers)").splitlines()
        # What run_task does next for a task that may write: it commits the work
        # the agent step left uncommitted. The build and the pull request, which
        # the workflow declares after the agent step, have not started.
        assert ensure_committed(str(repo)) is True

        trailers = [
            "Task-Id: task-1",
            "Prompt-Version: 1c9c10e027a2",
            "Workflow-Id: coding/new-task-v1",
            "Workflow-Step: implement",
        ]
        assert of_the_agent_commit == trailers
        assert _git(repo, "log", "--format=%s") == (
            "chore(agent): save uncommitted work from session end\nfeat: add a"
        )
        assert _git(repo, "log", "-1", "--format=%(trailers)").splitlines() == trailers
