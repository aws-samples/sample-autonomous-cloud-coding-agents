"""Tests of ``pipeline.run_task``: the decisions it makes around the agent.

``run_task`` hands the task's fields to the configuration, picks the post-hooks a
workflow gets, and passes what they return on to the verdict, the task record, the
Linear issue and the memory. The functions it calls have tests of their own; each
test here fails when ``run_task`` stops making one of those calls, or makes it with
something else.

The repository setup, the agent and the post-hooks are stubbed, and so is what a
task writes outside its container: the task record, the memory, the Linear issue.
The workflow files, the configuration and the system prompt are the real ones.
"""

import hashlib
import io
import os
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from config import NEEDS_INPUT_MARKER
from models import AgentResult, RepoSetup
from pipeline import run_task
from post_hooks import VerifyOutcome

_CLONE = "/workspace/repo"
_PR_URL = "https://github.com/o/r/pull/1"


def _workflow(workflow_id: str) -> dict:
    """The workflow of a task, as the orchestrator pins it in the payload."""
    return {"id": workflow_id, "version": "1.0.0"}


def _agent_succeeded(**fields) -> AgentResult:
    return AgentResult(status="success", turns=2, num_turns=2, cost_usd=0.01, **fields)


def _run_task(
    agent_result: AgentResult | None = None,
    *,
    setup: RepoSetup | None = None,
    setup_error: Exception | None = None,
    agent_env: dict[str, str] | None = None,
    build: VerifyOutcome | None = None,
    agent_notes: str | None = None,
    **task_fields,
) -> SimpleNamespace:
    """Run task ``t-1`` on repository ``o/r`` with the repository setup, the agent
    and the post-hooks stubbed.

    ``agent_result`` is what the agent returns (a success by default), ``build``
    what the post-agent build returns (passed by default) and ``agent_notes`` the
    "Agent notes" section of the pull request. ``ensure_pr`` answers ``_PR_URL``.
    ``setup_error`` is what the repository setup raises instead of returning.
    ``agent_env`` is what the agent run puts into the environment, as the runner
    does with the token before it starts the agent.
    ``task_fields`` go to ``run_task`` as they are. Returns the result, the stubs
    the tests assert on, and the prompt, system prompt, working directory,
    configuration and environment the agent was started with."""
    run = SimpleNamespace()
    task: dict[str, Any] = {
        "repo_url": "o/r",
        "task_description": "x",
        "github_token": "ghp_test",
        "aws_region": "us-east-1",
        "task_id": "t-1",
        **task_fields,
    }

    async def run_agent(prompt, system_prompt, config, cwd=None, trajectory=None):
        run.prompt, run.system_prompt, run.cwd, run.config = prompt, system_prompt, cwd, config
        os.environ.update(agent_env or {})
        run.environ = dict(os.environ)
        return agent_result or _agent_succeeded()

    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    with (
        patch("runner.run_agent", side_effect=run_agent),
        patch(
            "repo.setup_repo",
            return_value=setup or RepoSetup(repo_dir=_CLONE, branch="bgagent/test/branch"),
            side_effect=setup_error,
        ) as run.setup_repo,
        patch("pipeline.task_span", return_value=span),
        patch("pipeline.task_state") as task_state,
        patch("pipeline.reconcile_agent_branch") as run.reconcile_agent_branch,
        patch("pipeline.ensure_committed", return_value=False) as run.ensure_committed,
        patch(
            "pipeline.verify_build", return_value=build or VerifyOutcome(passed=True)
        ) as run.verify_build,
        patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)) as run.verify_lint,
        patch("pipeline.ensure_pr", return_value=_PR_URL) as run.ensure_pr,
        patch("pipeline._extract_agent_notes", return_value=agent_notes),
        patch(
            "pipeline.agent_memory.write_task_episode", return_value=True
        ) as run.write_task_episode,
        patch(
            "pipeline.agent_memory.write_repo_learnings", return_value=True
        ) as run.write_repo_learnings,
        patch("pipeline.get_disk_usage", return_value=0),
        patch("pipeline.print_metrics"),
        patch("pipeline.resolve_linear_api_token"),
        patch("pipeline.react_task_started", return_value="reaction-42"),
        patch("pipeline.react_task_finished") as run.react_task_finished,
    ):
        task_state.get_task.return_value = None  # the task was not cancelled
        run.result = run_task(**task)
    run.write_terminal = task_state.write_terminal
    return run


class TestTaskFieldsReachWhatUsesThem:
    """The orchestrator sends the blueprint's settings and the task's branches as
    arguments of ``run_task``. One that is dropped on the way is replaced by a
    default, and nothing fails."""

    def test_fields_are_on_the_configuration_of_the_repository_setup_and_the_agent(self):
        fields: dict[str, Any] = {
            "issue_number": "42",
            "anthropic_model": "global.anthropic.claude-sonnet-4-6",
            "max_turns": 7,  # not 10, which the configuration falls back to
            "max_budget_usd": 1.5,
            "build_command": "npm run build",
            "lint_command": "npm run lint",
            "branch_name": "bgagent/t-1/login-page",
            "base_branch": "bgagent/t-0/session-store",
            "merge_branches": ["bgagent/t-00/schema"],
            "approval_timeout_s": 600,
            "initial_approvals": ["tool_type:Read"],
        }

        # With the orchestrator's context, as for every deployed task: the issue
        # is then not fetched from GitHub in the container.
        run = _run_task(hydrated_context={"user_prompt": "Fix the login page"}, **fields)

        assert {name: getattr(run.config, name) for name in fields} == fields
        # The repository setup, which branches the task off its predecessor and
        # runs the baseline build, works from the same configuration.
        assert run.setup_repo.call_args.args[0] is run.config

    def test_instructions_of_the_blueprint_are_in_the_system_prompt(self):
        # They do not travel in the configuration: the pipeline hands them to
        # the builder of the system prompt itself.
        run = _run_task(system_prompt_overrides="Always run the linter.")

        assert "Always run the linter." in run.system_prompt

    def test_build_and_lint_gates_run_the_commands_of_the_blueprint(self):
        run = _run_task(build_command="npm run build", lint_command="npm run lint")

        run.verify_build.assert_called_once_with(_CLONE, "npm run build")
        run.verify_lint.assert_called_once_with(_CLONE, "npm run lint")


class TestAttachmentsOfATaskWithARepository:
    def test_attachment_is_in_the_clone_and_named_in_the_prompt(self, tmp_path):
        image = b"not really a PNG"
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": io.BytesIO(image)}

        with patch("aws_session.tenant_client", return_value=s3):
            run = _run_task(
                setup=RepoSetup(repo_dir=str(tmp_path), branch="bgagent/test/branch"),
                attachments=[
                    {
                        "attachment_id": "att-1",
                        "type": "image",
                        "content_type": "image/png",
                        "filename": "shot.png",
                        "s3_uri": "s3://attachments-bkt/attachments/u-1/t-1/att-1/shot.png",
                        "s3_version_id": "v1",
                        "size_bytes": len(image),
                        "checksum_sha256": hashlib.sha256(image).hexdigest(),
                    }
                ],
            )

        # The agent learns of the file from its prompt alone: the path named there
        # has to be the file, inside the directory the agent works in.
        named = re.search(r"`Read (\S+)`", run.prompt)
        assert named, run.prompt
        path = Path(named.group(1))
        assert path.is_relative_to(run.cwd)
        assert path.read_bytes() == image


class TestWhichRunsAreHeldForInput:
    """Clarify-and-hold: the agent of a new task asks a question instead of guessing.
    Nothing is built and no pull request is opened; the question is the task's
    answer. ``test_pipeline.py`` tests the hold after a ``request_clarification``
    call; these are the older way into it, and the runs that must not be held."""

    def test_marker_that_opens_the_last_message_holds_the_task(self, tmp_path):
        # The older signal, kept for a model that types the marker instead of
        # calling the tool.
        run = _run_task(
            _agent_succeeded(result_text=f"{NEEDS_INPUT_MARKER}\nWhich page is slow?"),
            # Not a repository: nothing was pushed, as after a question.
            setup=RepoSetup(repo_dir=str(tmp_path), branch="bgagent/test/branch"),
        )

        run.verify_build.assert_not_called()
        run.ensure_pr.assert_not_called()
        # What the platform reads as "asked a question": nothing changed, and an
        # answer. The requester is shown the question without the marker.
        assert run.result["code_changed"] is False
        assert run.result["answer_text"] == "Which page is slow?"

    def test_task_whose_agent_asked_nothing_is_not_held(self):
        run = _run_task(_agent_succeeded(result_text="The login page caches its queries now."))

        run.verify_build.assert_called_once()
        run.ensure_pr.assert_called_once()

    def test_iteration_on_a_pull_request_is_not_held(self):
        # An iteration answers a question through its own path (no commit, the
        # last message is the answer), and it may have committed before it asked.
        # A hold skips the push: held, those commits would stay in the container.
        run = _run_task(
            _agent_succeeded(clarification_question="Which page is slow?"),
            resolved_workflow=_workflow("coding/pr-iteration-v1"),
            pr_number="7",
        )

        run.verify_build.assert_called_once()
        run.ensure_pr.assert_called_once()


class TestPostHooksOfAPullRequestTask:
    """A task on an existing pull request ends in the post-hooks its workflow
    declares: an iteration adds commits to the pull request, a review only reads
    it."""

    @pytest.mark.parametrize(
        ("workflow_id", "strategy", "writes"),
        [
            pytest.param("coding/pr-iteration-v1", "push_resolve", True, id="iteration"),
            pytest.param("coding/pr-review-v1", "resolve", False, id="review"),
        ],
    )
    def test_post_hooks_follow_the_workflow(self, workflow_id, strategy, writes):
        run = _run_task(resolved_workflow=_workflow(workflow_id), pr_number="7")

        # What ensure_pr does to the pull request: push and look it up for an
        # iteration, look it up only for a review. Its default, "create", is for a
        # task that opens its own pull request.
        assert run.ensure_pr.call_args.kwargs["strategy"] == strategy
        # A review is read-only: neither the repair of the branch nor the
        # safety-net commit may run on the pull request under review.
        assert run.reconcile_agent_branch.called is writes
        assert run.ensure_committed.called is writes


class TestBuildThatRanIntoItsTimeLimit:
    def test_task_fails_with_the_timeout_marker(self):
        # The build was killed at its time limit, which is not a failed build. The
        # platform tells the two apart by this marker in the task's error.
        run = _run_task(build=VerifyOutcome(passed=False, timed_out=True))

        assert run.result["status"] == "error"
        assert "build_ok=timeout" in run.result["error"]


class TestWhatIsWrittenToMemory:
    """After a task the pipeline files an episode in memory, and the agent's notes
    as learnings about the repository. A later task is given what is stored under
    its repository, or under its user when it has no repository."""

    def test_task_without_a_repository_is_filed_under_its_user(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with patch("aws_session.tenant_client"):  # the upload of the answer
            run = _run_task(
                _agent_succeeded(result_text="Token buckets suit this API."),
                repo_url="",
                resolved_workflow=_workflow("knowledge/web-research-v1"),
                user_id="u-1",
                memory_id="mem-1",
            )

        assert run.result["status"] == "success"
        run.write_task_episode.assert_called_once()
        # The namespace context hydration reads for a task without a repository.
        assert run.write_task_episode.call_args.kwargs["actor"] == "user:u-1"

    def test_notes_of_a_task_with_a_repository_are_filed_under_the_repository(self):
        run = _run_task(memory_id="mem-1", agent_notes="The tests need Node 22.")

        run.write_task_episode.assert_called_once()
        episode = run.write_task_episode.call_args.kwargs
        assert episode["actor"] == "o/r"
        assert episode["self_feedback"] == "The tests need Node 22."
        run.write_repo_learnings.assert_called_once_with(
            memory_id="mem-1", repo="o/r", task_id="t-1", learnings="The tests need Node 22."
        )
        assert run.result["memory_written"] is True


class TestHowAFinishedTaskIsRecorded:
    """The terminal write is the record of the task: the API and the notifications
    read its status from it, the budget roll-up its cost."""

    def test_green_build_with_a_pull_request_is_recorded_as_completed(self):
        run = _run_task()

        run.write_terminal.assert_called_once()
        task_id, status, record = run.write_terminal.call_args.args
        assert (task_id, status) == ("t-1", "COMPLETED")
        expected = {
            "status": "success",
            "pr_url": _PR_URL,
            "build_passed": True,
            "lint_passed": True,
            "cost_usd": 0.01,
            "turns_attempted": 2,
        }
        assert {name: record[name] for name in expected} == expected

    def test_build_that_regressed_is_recorded_as_failed(self):
        # The build passed before the agent ran and fails after it.
        run = _run_task(
            build=VerifyOutcome(passed=False),
            channel_source="linear",
            channel_metadata={"linear_issue_id": "iss-1"},
        )

        _task_id, status, record = run.write_terminal.call_args.args
        assert status == "FAILED"
        assert record["build_passed"] is False
        # The Linear issue gets the failure mark in place of the eyes posted at the
        # start, although a pull request was opened for the red build.
        finished = run.react_task_finished.call_args.kwargs
        assert finished["success"] is False
        assert finished["started_reaction_id"] == "reaction-42"


# The variables of the process environment that tell git, ``gh``, the agent and
# the commit hook who a task is, and which step of its workflow is running.
_TASK_ENV_VARS = (
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "TASK_ID",
    "PROMPT_VERSION",
    "WORKFLOW_ID",
    "WORKFLOW_STEP",
)


def _task_environ(environ=os.environ) -> dict[str, str | None]:
    return {name: environ.get(name) for name in _TASK_ENV_VARS}


class TestWhatATaskLeavesInTheEnvironment:
    """git, ``gh`` and the agent are started with the environment of the process,
    so that is where a task puts its commit identity, its GitHub token, and the
    task id, prompt version, workflow id and workflow step of its commit trailers.
    The process can go on after the task: a server that takes the next one, a
    script, this test run. ``run_task`` leaves these variables as it found them."""

    @pytest.fixture(params=["unset", "set"])
    def before(self, request, monkeypatch) -> dict[str, str | None]:
        """The variables as the task finds them: none of them set, or each one
        set by whoever calls ``run_task``."""
        for name in _TASK_ENV_VARS:
            if request.param == "unset":
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, f"the caller's {name}")
        return _task_environ()

    def test_agent_sees_the_values_of_the_task_and_the_caller_gets_its_own_back(self, before):
        run = _run_task(prompt_version="1c9c10e027a2")

        assert _task_environ(run.environ) == {
            "GIT_AUTHOR_NAME": "bgagent",
            "GIT_AUTHOR_EMAIL": "bgagent@noreply.github.com",
            "GIT_COMMITTER_NAME": "bgagent",
            "GIT_COMMITTER_EMAIL": "bgagent@noreply.github.com",
            "GITHUB_TOKEN": "ghp_test",
            "GH_TOKEN": "ghp_test",
            "TASK_ID": "t-1",
            "PROMPT_VERSION": "1c9c10e027a2",
            "WORKFLOW_ID": "coding/new-task-v1",
            "WORKFLOW_STEP": "implement",
        }
        assert _task_environ() == before

    def test_task_that_fails_leaves_them_as_it_found_them(self, before):
        # The clone fails after the variables were set for it; run_task records
        # the failure and re-raises it.
        with pytest.raises(RuntimeError, match="clone failed"):
            _run_task(setup_error=RuntimeError("clone failed"), prompt_version="1c9c10e027a2")

        assert _task_environ() == before

    def test_task_without_a_repository_leaves_them_as_it_found_them(self, before, monkeypatch):
        # It returns before run_task sets any of the variables: its token is put
        # into the environment by the runner, when the agent is started.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with patch("aws_session.tenant_client"):  # the upload of the answer
            run = _run_task(
                _agent_succeeded(result_text="Token buckets suit this API."),
                repo_url="",
                resolved_workflow=_workflow("knowledge/web-research-v1"),
                agent_env={"GITHUB_TOKEN": "ghp_test", "GH_TOKEN": "ghp_test"},
            )

        assert run.result["status"] == "success"
        run.setup_repo.assert_not_called()
        assert _task_environ() == before

    def test_token_the_configuration_fetched_is_gone_after_the_task(self, monkeypatch):
        # A payload without a token, as on ECS: the configuration reads the token
        # from Secrets Manager and keeps it in GITHUB_TOKEN, before run_task sets
        # any of the variables itself.
        fetched = "ghp_from_secrets_manager"
        secrets_manager = MagicMock()
        secrets_manager.get_secret_value.return_value = {"SecretString": fetched}
        monkeypatch.setenv(
            "GITHUB_TOKEN_SECRET_ARN",
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token",
        )

        with patch("aws_session.platform_client", return_value=secrets_manager):
            run = _run_task(github_token="")

        assert _task_environ(run.environ)["GITHUB_TOKEN"] == fetched
        assert _task_environ()["GITHUB_TOKEN"] is None
