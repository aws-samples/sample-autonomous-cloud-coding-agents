"""Unit tests for pipeline.py — cedar_policies injection and pure helpers."""

import hashlib
import io
import json
import os
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from pydantic import ValidationError

from models import AgentResult, RepoSetup, TaskConfig, TokenUsage
from pipeline import (
    _branch_has_new_commits,
    _react_linear_task_finished,
    _should_post_start_comment,
)
from post_hooks import VerifyOutcome
from registry.loader import RegistryAssetLoadError

# Minimal Linear channel metadata for the early-ACK ordering tests.
_LINEAR_META = {"issue_id": "ABCA-1", "workspace_id": "ws-1"}

# One attachment as the orchestrator describes it in the payload (AttachmentConfig).
_REPORT_ATTACHMENT = {
    "attachment_id": "att-1",
    "type": "file",
    "content_type": "text/plain",
    "filename": "report.txt",
    "s3_uri": "s3://attachments-bkt/attachments/u-1/t-1/att-1/report.txt",
    "s3_version_id": "v1",
    "size_bytes": 2048,
    "checksum_sha256": "0" * 64,
}


class TestStartCommentPolicy:
    def test_suppresses_only_jira_pr_iteration_comment(self):
        assert not _should_post_start_comment("jira", "coding/pr-iteration-v1")
        assert _should_post_start_comment("jira", "coding/new-task-v1")
        assert _should_post_start_comment("jira", "coding/pr-review-v1")
        assert _should_post_start_comment("linear", "coding/pr-iteration-v1")


class TestCedarPoliciesInjection:
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_cedar_policies_injected_into_config(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """When cedar_policies are passed, they appear in the config."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            policies = [
                'forbid (principal, action, resource) when { resource == Agent::Tool::"Bash" };'
            ]
            run_task(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="test-id",
                cedar_policies=policies,
            )

        assert captured_config is not None
        assert captured_config.cedar_policies == policies

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_cedar_policies_absent_when_not_passed(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """When cedar_policies are not passed, the default empty list is on config."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="test-id",
            )

        assert captured_config is not None
        assert captured_config.cedar_policies == []

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_malformed_registry_asset_fails_the_task_closed(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
        tmp_path,
    ):
        """#246 fail-closed: a resolved mcp_server whose runtime is structurally
        invalid must fail the task (write_terminal FAILED) and re-raise, never run
        the agent with the pinned asset silently missing."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        # A real repo_dir so the loader reaches the transport-validation branch
        # (the failure we want is the invalid payload, not a missing dir).
        mock_setup_repo.return_value = RepoSetup(
            repo_dir=str(tmp_path),
            branch="bgagent/test/branch",
            build_before=True,
        )

        agent_ran = False

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal agent_ran
            agent_ran = True
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span
        mock_task_state.get_task.return_value = None

        with (
            patch("pipeline.configure_channel_mcp"),
            patch("pipeline.strip_linear_mcp_servers", return_value=0),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            # http transport with no url → RegistryAssetLoadError inside the loader.
            bad_asset = {
                "kind": "mcp_server",
                "namespace": "acme",
                "name": "pdf-tools",
                "version": "1.0.0",
                "runtime": {"transport": "http"},
            }
            with pytest.raises(Exception):  # noqa: B017 — re-raised after FAILED write
                run_task(
                    repo_url="owner/repo",
                    task_description="fix bug",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="test-id",
                    resolved_assets=[bad_asset],
                )

        # The task was marked FAILED and the agent never ran with a missing asset.
        assert agent_ran is False
        failed_writes = [
            c for c in mock_task_state.write_terminal.call_args_list if c.args[1] == "FAILED"
        ]
        assert failed_writes, (
            "expected a write_terminal(..., 'FAILED', ...) on the fail-closed path"
        )

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_git_identity_uses_env_vars_not_global_config(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """Git identity is set via GIT_AUTHOR/COMMITTER env vars, never
        `git config --global`, so a developer's ~/.gitconfig is never
        clobbered when the pipeline runs on a workstation (#622)."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        # Ensure a clean slate so the assertion proves the pipeline set them.
        for var in (
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
        ):
            monkeypatch.delenv(var, raising=False)

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        seen: dict[str, str] = {}

        def fake_ensure_committed(_repo_dir):
            # The safety-net commit is the last commit of a task, and git makes
            # it with the environment of the process. Read here, while the task
            # runs: run_task puts the earlier values back when it is left (#635).
            seen.update(os.environ)
            return False

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", side_effect=fake_ensure_committed),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="test-id",
            )

        assert seen["GIT_AUTHOR_NAME"] == "bgagent"
        assert seen["GIT_AUTHOR_EMAIL"] == "bgagent@noreply.github.com"
        assert seen["GIT_COMMITTER_NAME"] == "bgagent"
        assert seen["GIT_COMMITTER_EMAIL"] == "bgagent@noreply.github.com"


class TestRepoLessPipeline:
    """#248 Phase 3: a repo-less workflow runs the agent with no clone/build/PR."""

    @staticmethod
    def _mock_span() -> MagicMock:
        span = MagicMock()
        span.__enter__ = MagicMock(return_value=span)
        span.__exit__ = MagicMock(return_value=False)
        return span

    @patch("runner.run_agent")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_repoless_task_skips_repo_and_runs_agent(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        captured_cwd: dict = {}

        async def fake_run_agent(_prompt, system_prompt, config, cwd=None, trajectory=None):
            captured_cwd["cwd"] = cwd
            captured_cwd["system_prompt"] = system_prompt
            return AgentResult(
                status="success",
                turns=2,
                cost_usd=0.02,
                num_turns=2,
                result_text="## Summary\nThe three papers argue ...",
            )

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = self._mock_span()
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")

        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
            patch("aws_session.tenant_client", return_value=MagicMock()),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Summarise these three papers",
                aws_region="us-east-1",
                task_id="repoless-1",
                resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
            )

        # The repo-less path must never clone a repo or build a PR.
        mock_setup_repo.assert_not_called()
        assert result["pr_url"] is None
        # default/agent-v1 delivers via `s3_and_comment`: the agent's result text
        # is uploaded to artifacts/{task_id}/ (always retrievable) and a comment
        # milestone is recorded. Task succeeds with the artifact URI set.
        assert result["status"] == "success"
        assert result["artifact_uri"] == "s3://artifacts-bkt/artifacts/repoless-1/result.md"
        # What the agent spent is on the result, as it is for a coding task.
        assert result["cost_usd"] == 0.02
        assert result["turns_attempted"] == 2
        # Agent ran from the workspace, not a repo dir, with the repo-less prompt
        # (no Repository: / branch placeholders), and the prompt was substituted.
        assert "Repository:" not in captured_cwd["system_prompt"]
        assert "repoless-1" in captured_cwd["system_prompt"]  # {task_id} substituted
        assert "{task_id}" not in captured_cwd["system_prompt"]

    def _run_with_report(self, workspace: Path, monkeypatch, *, stored: bytes) -> SimpleNamespace:
        """Run a research task without a repository that carries one attachment.

        The attachment is ``report.txt`` as admission stored it; ``stored`` is what
        the bucket hands back for it. The task arrives as the orchestrator sends
        it: a hydrated context whose prompt is the description only, because for a
        task without a repository it leaves the attachments to the agent. The
        agent workspace is ``workspace``, and the stubbed agent reads the file its
        prompt names. Returns what the agent saw, the S3 client, the task-state
        mock, and the result or the message of the error the task raised."""
        report = b"Q3 revenue grew 12 percent.\n"
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        monkeypatch.setattr("pipeline.AGENT_WORKSPACE", str(workspace))
        monkeypatch.setattr("config.AGENT_WORKSPACE", str(workspace))
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": io.BytesIO(stored)}
        run = SimpleNamespace(
            report=report, s3=s3, agent_ran=False, read=None, result=None, raised=None
        )

        async def run_agent(prompt, _system_prompt, _config, cwd, trajectory=None):
            run.agent_ran = True
            run.prompt = prompt
            run.cwd = Path(cwd)
            named = re.search(r"`Read (\S+)`", prompt)
            if named:
                run.named_path = Path(named.group(1))
                run.read = run.named_path.read_bytes()
            return AgentResult(
                status="success", turns=2, cost_usd=0.02, num_turns=2, result_text="Revenue grew."
            )

        with (
            patch("runner.run_agent", side_effect=run_agent),
            patch("pipeline.task_span", return_value=self._mock_span()),
            patch("pipeline.task_state") as run.task_state,
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
            patch("aws_session.tenant_client", return_value=s3),
        ):
            from pipeline import run_task

            try:
                run.result = run_task(
                    task_description="Summarise the attached report",
                    aws_region="us-east-1",
                    task_id="repoless-att",
                    resolved_workflow={"id": "knowledge/web-research-v1", "version": "1.0.0"},
                    hydrated_context={
                        "version": 1,
                        "user_prompt": "Summarise the attached report",
                        "sources": ["task_description"],
                    },
                    attachments=[
                        {
                            **_REPORT_ATTACHMENT,
                            "size_bytes": len(report),
                            "checksum_sha256": hashlib.sha256(report).hexdigest(),
                        }
                    ],
                )
            except RuntimeError as exc:
                run.raised = str(exc)
        return run

    def test_repoless_task_gets_its_attachments(self, tmp_path, monkeypatch):
        run = self._run_with_report(tmp_path, monkeypatch, stored=b"Q3 revenue grew 12 percent.\n")

        # The file is in the directory the agent runs in, and the prompt names it
        # after the task itself, as for a task with a repository.
        assert run.raised is None
        assert run.result["status"] == "success"
        assert run.prompt.startswith("Summarise the attached report")
        assert run.read == run.report
        assert run.named_path.is_relative_to(run.cwd)
        # In a directory of this task alone: clearing up after a failed download
        # removes the whole attachments directory, which no two tasks may share.
        assert run.named_path.is_relative_to(tmp_path / "repoless-att")
        # Read at the object version that admission screened.
        run.s3.get_object.assert_called_once_with(
            Bucket="attachments-bkt", Key="attachments/u-1/t-1/att-1/report.txt", VersionId="v1"
        )

    def test_repoless_task_whose_attachment_was_replaced_fails_before_the_agent_runs(
        self, tmp_path, monkeypatch
    ):
        run = self._run_with_report(tmp_path, monkeypatch, stored=b"not what was screened\n")

        assert run.agent_ran is False
        assert "Attachment download/verification failed" in run.raised
        run.task_state.write_terminal.assert_called_once()
        _task_id, status, payload = run.task_state.write_terminal.call_args.args
        assert status == "FAILED"
        assert "integrity check failed" in payload["error"]

    def _run_with_task_record(
        self, monkeypatch, *, trace_uri: str | None = None, **get_task
    ) -> SimpleNamespace:
        """Run a research task without a repository, with a memory configured.

        ``get_task`` is how the read of the task record behaves once the agent has
        returned (``return_value`` or ``side_effect``). With ``trace_uri`` the task
        was submitted with --trace and its trajectory uploads to that URI. Returns
        the result, the S3 client, the milestones in the order they were written,
        and the mocks of the episode write, the terminal write and the write that
        puts a trace URI on a record that is already terminal."""
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")

        async def run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(
                status="success", turns=2, cost_usd=0.02, num_turns=2, result_text="Findings ..."
            )

        s3 = MagicMock()
        progress = MagicMock()
        with (
            patch("runner.run_agent", side_effect=run_agent),
            patch("pipeline.task_span", return_value=self._mock_span()),
            patch("pipeline._ProgressWriter", return_value=progress),
            patch("pipeline.task_state.get_task", **get_task),
            patch("pipeline.task_state.write_terminal") as write_terminal,
            patch("pipeline.task_state.write_trace_uri_conditional") as write_trace_uri,
            patch("pipeline.agent_memory.write_task_episode", return_value=True) as write_episode,
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=trace_uri),
            patch("aws_session.tenant_client", return_value=s3),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Research approaches to rate limiting",
                aws_region="us-east-1",
                task_id="repoless-rec",
                user_id="u-1",
                memory_id="mem-1",
                trace=trace_uri is not None,
                resolved_workflow={"id": "knowledge/web-research-v1", "version": "1.0.0"},
            )
        return SimpleNamespace(
            result=result,
            s3=s3,
            milestones=[call.args[0] for call in progress.write_agent_milestone.call_args_list],
            write_episode=write_episode,
            write_terminal=write_terminal,
            write_trace_uri=write_trace_uri,
        )

    def test_cancelled_repoless_task_delivers_and_remembers_nothing(self, monkeypatch):
        # The user cancelled while the agent ran: cancel-task has written
        # CANCELLED, and the Stop hook ended the agent after its current turn. As
        # on the repo lane, nothing may follow: no artifact of a half-finished
        # answer, no delivered_comment event, no episode in the user's memory.
        run = self._run_with_task_record(monkeypatch, return_value={"status": "CANCELLED"})

        run.s3.put_object.assert_not_called()
        assert run.milestones == [
            "step:context:start",
            "step:context:succeeded",
            "step:research:start",
            "step:research:succeeded",
            "agent_execution_complete",
            "task_cancelled_acknowledged",
        ]
        run.write_episode.assert_not_called()
        # The record is CANCELLED already; the terminal write would be refused.
        run.write_terminal.assert_not_called()
        assert run.result == {
            "status": "cancelled",
            "task_id": "repoless-rec",
            "turns": 2,
            "turns_attempted": 2,
        }

    def test_cancelled_repoless_task_keeps_its_trace(self, monkeypatch):
        # --trace: what was captured before the cancel is uploaded, and its URI
        # is put on the CANCELLED record, as on the repo lane. Before the cancel
        # check existed the refused terminal write did that on its way out.
        trace_uri = "s3://traces-bkt/traces/u-1/repoless-rec.jsonl.gz"

        run = self._run_with_task_record(
            monkeypatch, trace_uri=trace_uri, return_value={"status": "CANCELLED"}
        )

        assert run.result["status"] == "cancelled"
        run.write_trace_uri.assert_called_once_with("repoless-rec", trace_uri)

    def test_repoless_task_that_was_not_cancelled_is_delivered_and_remembered(self, monkeypatch):
        run = self._run_with_task_record(monkeypatch, return_value={"status": "RUNNING"})

        assert run.result["status"] == "success"
        assert run.result["artifact_uri"] == "s3://artifacts-bkt/artifacts/repoless-rec/result.md"
        run.s3.put_object.assert_called_once()
        assert run.milestones == [
            "step:context:start",
            "step:context:succeeded",
            "step:research:start",
            "step:research:succeeded",
            "step:deliver:start",
            "delivered_comment",
            "step:deliver:succeeded",
            "agent_execution_complete",
        ]
        assert run.write_episode.call_args.kwargs["status"] == "COMPLETED"
        assert run.write_terminal.call_args.args[1] == "COMPLETED"

    def test_task_record_that_cannot_be_read_does_not_hold_back_the_delivery(self, monkeypatch):
        # Fail-open, as on the repo lane: a failed read is not a cancellation.
        import task_state

        run = self._run_with_task_record(
            monkeypatch, side_effect=task_state.TaskFetchError("throttled")
        )

        assert run.result["status"] == "success"
        run.s3.put_object.assert_called_once()

    def test_agent_step_that_skips_the_remaining_steps_is_not_followed_by_the_delivery(
        self, monkeypatch
    ):
        # A workflow may tell the runner to stop without failing when its agent
        # step fails (on_failure: skip_remaining). The delivery is one of the
        # steps that are skipped then: run in a second call, after the cancel
        # check, it must not be started on top of the failed agent step.
        from workflow import load_workflow

        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        shipped = load_workflow("knowledge/web-research-v1")
        workflow = shipped.model_copy(
            update={
                "steps": [
                    step.model_copy(update={"on_failure": "skip_remaining"})
                    if step.kind == "run_agent"
                    else step
                    for step in shipped.steps
                ]
            }
        )

        async def run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            raise RuntimeError("model exploded")

        progress = MagicMock()
        with (
            patch("workflow.load_workflow", return_value=workflow),
            patch("runner.run_agent", side_effect=run_agent),
            patch("pipeline.task_span", return_value=self._mock_span()),
            patch("pipeline._ProgressWriter", return_value=progress),
            patch("pipeline.task_state.get_task", return_value={"status": "RUNNING"}),
            patch("pipeline.task_state.write_terminal"),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Research approaches to rate limiting",
                aws_region="us-east-1",
                task_id="repoless-skip",
                resolved_workflow={"id": "knowledge/web-research-v1", "version": "1.0.0"},
            )

        milestones = [call.args[0] for call in progress.write_agent_milestone.call_args_list]
        assert milestones == [
            "step:context:start",
            "step:context:succeeded",
            "step:research:start",
            "step:research:failed",
            "agent_execution_complete",
        ]
        assert result["status"] == "error"
        assert result["error"] == "repo-less run_agent produced no result"

    @patch("runner.run_agent")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_repoless_task_agent_no_result_is_error(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
    ):
        # The run_agent handler can fail to populate ctx.agent_result (its
        # exception is captured into a failed StepOutcome). The repo-less path
        # synthesizes an error AgentResult → terminal FAILED, not a crash.
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        async def boom(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            raise RuntimeError("model exploded")

        mock_run_agent.side_effect = boom
        mock_task_span.return_value = self._mock_span()

        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Summarise these three papers",
                aws_region="us-east-1",
                task_id="repoless-2",
                resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
            )

        mock_setup_repo.assert_not_called()
        assert result["status"] == "error"
        # The error is the agent step's own: the workflow stops there, and the
        # delivery step that follows it is not attempted on top.
        assert result["error"] == (
            "repo-less run_agent produced no result: RuntimeError: model exploded"
        )
        # Terminal state persisted as FAILED (not left dangling / not COMPLETED).
        terminal_calls = [
            c for c in mock_task_state.write_terminal.call_args_list if c.args[1] == "FAILED"
        ]
        assert terminal_calls, "expected a write_terminal(..., 'FAILED', ...) call"

    @patch("runner.run_agent")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_repoless_agent_success_but_delivery_failure_is_error(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
    ):
        # The delivery gate: the agent succeeds but the side-effecting
        # deliver_artifact step fails (here: ARTIFACTS_BUCKET_NAME unset, so
        # _upload_to_s3 raises). This must surface as a loud terminal FAILED
        # naming the failed step — NOT a silent "succeeded with nothing
        # delivered" (the exact silent-failure the gate exists to prevent).
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.delenv("ARTIFACTS_BUCKET_NAME", raising=False)

        async def fake_run_agent(_prompt, system_prompt, config, cwd=None, trajectory=None):
            return AgentResult(
                status="success",
                turns=2,
                cost_usd=0.02,
                num_turns=2,
                result_text="## Summary\nThe three papers argue ...",
            )

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = self._mock_span()

        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Summarise these three papers",
                aws_region="us-east-1",
                task_id="repoless-3",
                resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
            )

        mock_setup_repo.assert_not_called()
        # Agent succeeded, but delivery failed → overall error, no artifact URI.
        assert result["status"] == "error"
        assert result["artifact_uri"] is None
        # The error names the failed delivery step so the failure is diagnosable.
        assert "deliver" in (result["error"] or "").lower()
        terminal_calls = [
            c for c in mock_task_state.write_terminal.call_args_list if c.args[1] == "FAILED"
        ]
        assert terminal_calls, "expected a write_terminal(..., 'FAILED', ...) call"

    @patch("runner.run_agent")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_repoless_artifact_outcome_without_uri_is_error(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
    ):
        # Code-review MEDIUM #1: WORKFLOWS.md defines primary:artifact success as
        # "agent-success AND an S3 key present". The earlier gate only caught a
        # deliverer that RAISED; a deliverer that returns success WITHOUT writing
        # an artifact_uri would silently pass. Here run_workflow reports succeeded
        # but leaves ctx.artifacts empty — the task must still be a loud FAILED.
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        mock_task_span.return_value = self._mock_span()

        from workflow import WorkflowResult

        def fake_run_workflow(wf, ctx, only_kinds=None):
            # Agent succeeded, but no artifact_uri lands in ctx.artifacts.
            ctx.agent_result = AgentResult(
                status="success", turns=1, cost_usd=0.01, num_turns=1, result_text="done"
            )
            return WorkflowResult.from_outcomes(ctx, wf.terminal_outcomes)

        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
            patch("workflow.run_workflow", side_effect=fake_run_workflow),
        ):
            from pipeline import run_task

            result = run_task(
                task_description="Summarise these three papers",
                aws_region="us-east-1",
                task_id="repoless-4",
                resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
            )

        mock_setup_repo.assert_not_called()
        assert result["status"] == "error"
        assert result["artifact_uri"] is None
        # The error names the artifact/S3 contract so the failure is diagnosable.
        assert "artifact" in (result["error"] or "").lower()
        terminal_calls = [
            c for c in mock_task_state.write_terminal.call_args_list if c.args[1] == "FAILED"
        ]
        assert terminal_calls, "expected a write_terminal(..., 'FAILED', ...) call"

    @patch("runner.run_agent")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_crash_path_persists_otel_trace_id(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        mock_run_agent,
        monkeypatch,
    ):
        # #523: the crash-path TaskResult must carry otel_trace_id — FAILED tasks
        # are the primary post-mortem case the replay bundle (#515) exists for,
        # and the crash `except` is still inside `with task_span()`, so the id is
        # live. Force the pipeline to crash after the span opens and assert the
        # id lands in the FAILED payload rather than persisting null.
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_task_span.return_value = self._mock_span()

        with (
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
            patch(
                "pipeline.current_otel_trace_id",
                return_value="0af7651916cd43dd8448eb211c80319c",
            ),
            patch("workflow.run_workflow", side_effect=RuntimeError("boom")),
        ):
            from pipeline import run_task

            # The crash handler persists FAILED then re-raises, so the exception
            # surfaces — we assert on what it persisted before re-raising.
            with pytest.raises(RuntimeError, match="boom"):
                run_task(
                    task_description="Summarise these three papers",
                    aws_region="us-east-1",
                    task_id="repoless-crash",
                    resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
                )

        failed_calls = [
            c for c in mock_task_state.write_terminal.call_args_list if c.args[1] == "FAILED"
        ]
        assert failed_calls, "expected a write_terminal(..., 'FAILED', ...) call"
        payload = failed_calls[-1].args[2]
        assert payload.get("otel_trace_id") == "0af7651916cd43dd8448eb211c80319c"

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_repo_optional_workflow_with_repo_takes_repo_bound_path(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        # PR review #296 finding #3: requires_repo:false means repo-OPTIONAL, not
        # repo-forbidden. When a repo IS supplied for default/agent-v1, the agent
        # must clone/build/PR (repo-bound path) to match the repo-bound prompt the
        # orchestrator assembled — NOT silently take the repo-less branch and skip
        # the clone. So setup_repo MUST be called here.
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = self._mock_span()

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value="https://github.com/org/repo/pull/1"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="Do it against this repo",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="repo-optional-1",
                resolved_workflow={"id": "default/agent-v1", "version": "1.0.0"},
            )

        # Repo present + repo-optional workflow ⇒ repo-bound path ran.
        mock_setup_repo.assert_called_once()
        assert result["status"] == "success"
        assert result["pr_url"] == "https://github.com/org/repo/pull/1"

    @pytest.mark.parametrize(
        "requires_repo", [True, None], ids=["written-out", "left-to-the-coding-domain"]
    )
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_repoful_artifact_workflow_delivers_artifact_and_skips_pr(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
        requires_repo,
    ):
        # A REPO-FUL artifact workflow clones for context but its terminal outcome
        # is a DOCUMENT, not a PR. It must take the repo-bound path (clone), then
        # deliver the result as an artifact and SKIP the build/PR post-hooks.
        #
        # No such workflow ships today, so this uses a synthetic one: the branch is
        # selected by the workflow CONTRACT (terminal_outcomes.primary == artifact
        # AND requires_repo), not by a workflow id, and without a test the branch
        # could be deleted or inverted silently. Getting it wrong means opening an
        # empty PR for a document task, or running a build that was never wanted.
        #
        # A coding workflow requires a repository whether its file says so or
        # leaves the line out (the domain default, Workflow.resolved_requires_repo):
        # both spellings have to select the branch.
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )
        artifact_text = '{"summary": "two features", "items": []}'

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            return AgentResult(
                status="success", turns=3, cost_usd=0.05, num_turns=3, result_text=artifact_text
            )

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = self._mock_span()

        # Synthesize the workflow by copying the real coding workflow and flipping
        # ONLY the two fields that select this branch, so the test cannot drift from
        # the production contract the way a hand-built stub would.
        from workflow import load_workflow as real_load_workflow

        base_wf = real_load_workflow("coding/new-task-v1")
        artifact_wf = base_wf.model_copy(
            update={
                "id": "synthetic/artifact-repoful-v1",
                "requires_repo": requires_repo,
                "terminal_outcomes": base_wf.terminal_outcomes.model_copy(
                    update={"primary": "artifact"}
                ),
            }
        )

        with (
            patch("workflow.load_workflow", return_value=artifact_wf),
            patch(
                "pipeline._deliver_plan_artifact",
                return_value="s3://artifacts-bkt/artifacts/artifact-1/result.md",
            ) as mock_deliver,
            # Stubbed with what the real hooks return, so that a run that takes
            # the build and pull-request hooks after all fails in the assertions
            # below, not on a stub's return value or on a real lint command.
            patch("pipeline.ensure_pr", return_value=None) as mock_ensure_pr,
            patch(
                "pipeline.verify_build", return_value=VerifyOutcome(passed=True)
            ) as mock_verify_build,
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_committed", return_value=False) as mock_ensure_committed,
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline._maybe_upload_trace", return_value=None),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="Add auth + billing + admin",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="artifact-1",
                resolved_workflow={"id": "synthetic/artifact-repoful-v1", "version": "1.0.0"},
            )

        # Repo-bound path ran (clone), plan delivered as artifact, PR/build skipped.
        mock_setup_repo.assert_called_once()
        mock_deliver.assert_called_once()
        mock_ensure_pr.assert_not_called()
        mock_verify_build.assert_not_called()
        mock_ensure_committed.assert_not_called()
        assert result["status"] == "success"
        assert result["pr_url"] is None
        assert result["artifact_uri"] == "s3://artifacts-bkt/artifacts/artifact-1/result.md"


class TestCancelSkipsPostHooks:
    """Cancel short-circuit: if task is CANCELLED when run_agent returns, the
    pipeline must skip post-hooks so no PR is pushed on a cancelled task.
    """

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancelled_task_skips_post_hooks(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        # Simulate cancel-task.ts having already flipped the status.
        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        mock_ensure_pr = MagicMock()
        mock_ensure_committed = MagicMock()

        with (
            patch("pipeline.ensure_committed", mock_ensure_committed),
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr", mock_ensure_pr),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            # Route get_task through the mock; keep TaskFetchError importable.
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception

            from pipeline import run_task

            result = run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled",
            )

        # CRITICAL: no PR push, no commit safety-net on cancelled task.
        mock_ensure_pr.assert_not_called()
        mock_ensure_committed.assert_not_called()
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled"

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_running_task_runs_post_hooks_normally(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """Regression guard: a task that is NOT cancelled still runs post-hooks."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_ensure_pr = MagicMock(return_value="https://github.com/o/r/pull/1")

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", mock_ensure_pr),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            # Task is RUNNING (not cancelled) — normal path must execute.
            mock_task_state_mod.get_task = MagicMock(return_value={"status": "RUNNING"})
            mock_task_state_mod.TaskFetchError = Exception

            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-running",
            )

        mock_ensure_pr.assert_called_once()

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_jira_card_not_moved_to_in_review_on_build_failure(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """review blocker #9a: ensure_pr opens a PR even on a FAILED build (so the
        human sees the broken diff), so the Jira In Progress → In Review transition
        must gate on build_passed — not merely on pr_url — or the board lies that
        the work is ready for review. Mirrors the Linear success-only twin."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_transition = MagicMock()
        with (
            patch("pipeline.ensure_committed", return_value=False),
            # FAILED build — ensure_pr still opens the PR below.
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=False)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/9"),
            patch("pipeline.transition_pr_opened", mock_transition),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = MagicMock(return_value={"status": "RUNNING"})
            mock_task_state_mod.TaskFetchError = Exception
            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-jira-failbuild",
                channel_source="jira",
                channel_metadata={"jira_issue_key": "ABC-1"},
            )
        # PR opened, but the Jira card was NOT advanced to In Review on the red build.
        mock_transition.assert_not_called()

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_jira_card_moved_to_in_review_on_build_success(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """The positive twin: a PASSING build DOES move the Jira card to In Review."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_transition = MagicMock()
        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/9"),
            patch("pipeline.transition_pr_opened", mock_transition),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = MagicMock(return_value={"status": "RUNNING"})
            mock_task_state_mod.TaskFetchError = Exception
            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-jira-okbuild",
                channel_source="jira",
                channel_metadata={"jira_issue_key": "ABC-1"},
            )
        mock_transition.assert_called_once()

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_post_hook_workflow_reload_failure_still_opens_pr(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        # PR review #296 finding #5: the post-hook reload runs AFTER run_agent has
        # mutated/committed the tree. If load_workflow raises there (e.g. the
        # file build_config already fell back on), the task must NOT be stranded
        # FAILED with no PR — it falls back to the default "create" strategy and
        # still calls ensure_pr, mirroring build_config's fail-soft handling.
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        # Phase marker: the post-hook reload is the only load_workflow call that
        # happens AFTER the agent runs. Loads before the agent (build_config, the
        # run_agent step dispatch) must succeed so the task actually starts; the
        # post-hook reload is the one we force to fail — regardless of how many
        # pre-agent loads happen (the reviewers noted it's parsed 3-4x/task).
        agent_ran = {"done": False}

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            agent_ran["done"] = True
            return AgentResult(status="success", turns=2, cost_usd=0.01, num_turns=2)

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = self._running_span()

        mock_ensure_pr = MagicMock(return_value="https://github.com/o/r/pull/1")

        from workflow import WorkflowValidationError
        from workflow import load_workflow as real_load

        def flaky_load(workflow_id):
            if agent_ran["done"]:
                raise WorkflowValidationError("simulated post-hook reload failure")
            return real_load(workflow_id)

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", mock_ensure_pr),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("workflow.load_workflow", side_effect=flaky_load),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-posthook-fallback",
                resolved_workflow={"id": "coding/new-task-v1", "version": "1.0.0"},
            )

        # The reload failed but the work was still finalized into a PR.
        mock_ensure_pr.assert_called_once()
        assert mock_ensure_pr.call_args.kwargs["strategy"] == "create"
        assert result["pr_url"] == "https://github.com/o/r/pull/1"

    @staticmethod
    def _running_span() -> MagicMock:
        span = MagicMock()
        span.__enter__ = MagicMock(return_value=span)
        span.__exit__ = MagicMock(return_value=False)
        return span


# ---------------------------------------------------------------------------
# Trace threading into TaskConfig (design §10.1)
# ---------------------------------------------------------------------------


class TestTraceThreading:
    """run_task(trace=...) must land on ``TaskConfig.trace`` so the
    runner.py _ProgressWriter picks it up. This is the exact junction a
    reviewer caught as silently dropping the flag in review; lock it
    with a dedicated test.
    """

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_trace_true_sets_config_trace_true(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="deep debug",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-trace",
                trace=True,
                user_id="cognito-sub-trace-user",
            )

        assert captured_config is not None
        # The config reaching run_agent carries trace=True so runner.py's
        # _ProgressWriter(config.task_id, trace=config.trace) picks it up.
        assert captured_config.trace is True
        assert captured_config.user_id == "cognito-sub-trace-user"

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_trace_default_is_false(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="normal task",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-notrace",
            )

        assert captured_config is not None
        assert captured_config.trace is False

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_initial_approval_gate_count_lands_on_config(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """Chunk 7 (§13.6): ``initial_approval_gate_count`` must reach
        ``TaskConfig`` so runner.py can seed ``PolicyEngine._approval_gate_count``
        on a restarted container. Verifies the server → pipeline → config
        → runner hand-off without spinning up PolicyEngine."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="restarted task",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-resume",
                initial_approval_gate_count=17,
            )

        assert captured_config is not None
        assert captured_config.initial_approval_gate_count == 17

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_run_task_approval_gate_cap_lands_on_config(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        """Chunk 7b (§4 step 5, decision #13): approval_gate_cap from the
        orchestrator payload must reach TaskConfig so runner.py hands it
        to PolicyEngine. Verifies the server → pipeline → config →
        runner hand-off without spinning up PolicyEngine."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        captured_config: TaskConfig | None = None

        async def fake_run_agent(_prompt, _system_prompt, config, cwd=None, trajectory=None):
            nonlocal captured_config
            captured_config = config
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch(
                "pipeline.ensure_pr",
                return_value="https://github.com/org/repo/pull/1",
            ),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            run_task(
                repo_url="owner/repo",
                task_description="capped task",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cap",
                approval_gate_cap=200,
            )

        assert captured_config is not None
        assert captured_config.approval_gate_cap == 200


class TestTraceS3Upload:
    """Pipeline triggers the S3 trace upload only when
    ``trace=True`` AND ``user_id`` is non-empty; threads the resulting
    ``trace_s3_uri`` into ``task_state.write_terminal`` so the
    TaskRecord update is atomic with terminal-status."""

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_happens_when_trace_and_user_id(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            # Simulate the runner accumulating one event so dump returns bytes.
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://b/traces/u-1/t-up.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="debug it",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-up",
                trace=True,
                user_id="u-1",
            )

        # Upload was called with the expected identifiers.
        assert mock_upload.called
        call_kwargs = mock_upload.call_args.kwargs
        assert call_kwargs["task_id"] == "t-up"
        assert call_kwargs["user_id"] == "u-1"
        assert isinstance(call_kwargs["body"], bytes)

        # trace_s3_uri was threaded into the terminal write.
        assert result["trace_s3_uri"] == "s3://b/traces/u-1/t-up.jsonl.gz"
        mock_task_state.write_terminal.assert_called()
        terminal_result = mock_task_state.write_terminal.call_args.args[2]
        assert terminal_result["trace_s3_uri"] == "s3://b/traces/u-1/t-up.jsonl.gz"

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_skipped_when_trace_false(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="normal",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-nt",
                trace=False,
                user_id="u-1",
            )

        assert not mock_upload.called
        assert result["trace_s3_uri"] is None

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_skipped_when_user_id_empty_and_trace_true(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """trace=True with empty user_id now
        fails at ``TaskConfig`` construction time (pre-flight validation)
        rather than silently skipping the upload and returning
        ``trace_s3_uri=None``.

        Previously (rev-5) this was a best-effort defensive skip inside
        ``pipeline.run_task``'s trace-upload block; shifting the check to
        the Pydantic model means misconfigured callers surface the error
        immediately, before any agent work runs. The upload mock is never
        exercised because we never reach the upload path.
        """
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            with pytest.raises(ValidationError, match="trace=True requires a non-empty user_id"):
                run_task(
                    repo_url="owner/repo",
                    task_description="trace without user",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="t-no-uid",
                    trace=True,
                    user_id="",  # empty — now rejected at TaskConfig construction
                )

        assert not mock_upload.called

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_upload_fail_open_does_not_fail_task(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """A failed S3 upload (fail-open returns None) must NOT flip
        the task to FAILED — the trajectory is a debug artifact."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = None  # simulate S3 failure

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            # A DELIVERED task (a PR was opened) — this test is about trace-upload
            # fail-open, not the no-deliverable delivery gate. Returning a PR keeps
            # the delivery gate out of the picture so the assertion isolates the
            # trace behavior (a real no-PR task is covered in TestDeliveryGate).
            patch("pipeline.ensure_pr", return_value="https://github.com/owner/repo/pull/1"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="trace fail",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-fail",
                trace=True,
                user_id="u-1",
            )

        assert mock_upload.called
        # Fail-open: task is still success, trace_s3_uri just absent.
        assert result["status"] == "success"
        assert result["trace_s3_uri"] is None

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancel_path_does_not_upload_trace_when_trace_false(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """Cancel path must NOT attempt an S3 upload when ``trace=False``.

        L4 flipped the previous blanket "no upload on cancel" rule: the
        cancel path now best-effort uploads and self-heals when
        ``config.trace=True`` (so users can debug cancelled-mid-run
        tasks). This test pins the negative side — without ``--trace``,
        there is still no upload on the cancel path. Post-hooks must
        still be skipped in both cases."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        with (
            patch("pipeline.ensure_committed") as mock_ensure_committed,
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr") as mock_ensure_pr,
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception

            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="mid-run cancel no trace",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled-no-trace",
                trace=False,  # no --trace → no upload even on cancel
                user_id="u-1",
            )

        mock_upload.assert_not_called()
        mock_ensure_committed.assert_not_called()
        mock_ensure_pr.assert_not_called()
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled-no-trace"
        assert "trace_s3_uri" not in result

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancel_path_uploads_and_self_heals_when_trace(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """L4 item 1c — cancel path with ``trace=True`` best-effort
        uploads to S3 and calls ``write_trace_uri_conditional`` so the
        trajectory captured before cancel stays recoverable.

        ``write_terminal`` cannot persist ``trace_s3_uri`` atomically on
        this path because its ConditionExpression rejects CANCELLED —
        the conditional-self-heal helper (scoped to
        ``attribute_not_exists(trace_s3_uri) AND status IN (...)``)
        handles the persistence instead."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            # Seed the accumulator so dump_gzipped_jsonl returns bytes.
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://bucket/traces/u-1/t-cancelled-trace.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        with (
            patch("pipeline.ensure_committed") as mock_ensure_committed,
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr") as mock_ensure_pr,
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception
            mock_task_state_mod.write_trace_uri_conditional = MagicMock(return_value=True)

            from pipeline import run_task

            result = run_task(
                repo_url="owner/repo",
                task_description="mid-run cancel with trace",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled-trace",
                trace=True,
                user_id="u-1",
            )

            # Upload was attempted.
            mock_upload.assert_called_once()
            # Self-heal was invoked with the resulting URI.
            mock_task_state_mod.write_trace_uri_conditional.assert_called_once_with(
                "t-cancelled-trace",
                "s3://bucket/traces/u-1/t-cancelled-trace.jsonl.gz",
            )
            # write_terminal is NOT called on the cancel path (its
            # ConditionExpression would reject CANCELLED).
            mock_task_state_mod.write_terminal.assert_not_called()

        # Post-hooks still skipped (cancel short-circuit).
        mock_ensure_committed.assert_not_called()
        mock_ensure_pr.assert_not_called()
        # Cancel-shaped return payload.
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled-trace"

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_cancel_path_heal_failure_is_fail_open(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """L4 item 1c — when the self-heal helper raises on the cancel
        path, the cancel fast-path must still return cleanly; an
        upload/persist error must not propagate and turn a valid cancel
        into a pipeline crash."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://bucket/traces/u-1/t-cancelled-crash.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        mock_get_task = MagicMock(return_value={"status": "CANCELLED"})

        with (
            patch("pipeline.ensure_committed"),
            patch("pipeline.verify_build"),
            patch("pipeline.verify_lint"),
            patch("pipeline.ensure_pr"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state") as mock_task_state_mod,
        ):
            mock_task_state_mod.get_task = mock_get_task
            mock_task_state_mod.TaskFetchError = Exception
            # Self-heal raises — cancel path must swallow it.
            mock_task_state_mod.write_trace_uri_conditional = MagicMock(
                side_effect=RuntimeError("ddb boom")
            )

            from pipeline import run_task

            # No exception should escape — fail-open contract.
            result = run_task(
                repo_url="owner/repo",
                task_description="cancel with heal failure",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-cancelled-crash",
                trace=True,
                user_id="u-1",
            )

        # Upload was attempted; heal raised but was swallowed.
        mock_upload.assert_called_once()
        assert result["status"] == "cancelled"
        assert result["task_id"] == "t-cancelled-crash"


class TestTraceCrashPath:
    """K2 review Finding #1 — a pipeline crash (exception after the
    agent loop) must still attempt the trace upload so the user can
    debug the failure. The upload is fully fail-open under the crash
    path too: an S3 error must not mask or replace the underlying
    pipeline exception."""

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_crash_path_uploads_trace_and_threads_uri(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            # Accumulate something so dump has bytes, then later cause
            # the pipeline to crash post-hooks.
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.return_value = "s3://b/traces/u-1/t-crash.jsonl.gz"

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        # Force a crash after agent completes but before terminal write:
        # ``verify_build`` raises, which escapes to the outer except.
        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", side_effect=RuntimeError("build verify boom")),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            import contextlib

            from pipeline import run_task

            with contextlib.suppress(RuntimeError):
                run_task(
                    repo_url="owner/repo",
                    task_description="crash case",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="t-crash",
                    trace=True,
                    user_id="u-1",
                )  # pipeline re-raises after writing FAILED

        # Upload was invoked on the crash path.
        assert mock_upload.called
        call_kwargs = mock_upload.call_args.kwargs
        assert call_kwargs["task_id"] == "t-crash"
        assert call_kwargs["user_id"] == "u-1"

        # Terminal was written as FAILED WITH trace_s3_uri threaded in.
        mock_task_state.write_terminal.assert_called()
        args, _ = mock_task_state.write_terminal.call_args
        assert args[1] == "FAILED"
        crash_result = args[2]
        assert crash_result["trace_s3_uri"] == "s3://b/traces/u-1/t-crash.jsonl.gz"

    @patch("pipeline.upload_trace_to_s3")
    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_crash_path_upload_exception_does_not_mask_original_error(
        self,
        mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        mock_upload,
        monkeypatch,
    ):
        """If the crash-path upload itself raises, the original
        pipeline exception must still be the one that propagates."""
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            if trajectory is not None:
                trajectory._put_event({"event": "TURN", "turn": 1})
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_upload.side_effect = RuntimeError("upload explode")

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)
        mock_task_span.return_value = mock_span

        with (
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", side_effect=ValueError("original pipeline error")),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value=None),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            import pytest

            from pipeline import run_task

            with pytest.raises(ValueError, match="original pipeline error"):
                run_task(
                    repo_url="owner/repo",
                    task_description="mask test",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="t-mask",
                    trace=True,
                    user_id="u-1",
                )

        # Terminal still written despite the upload failure.
        mock_task_state.write_terminal.assert_called()


class TestJiraCredentialIsolation:
    @pytest.mark.parametrize("channel_source", ["", "linear", "jira"])
    def test_run_task_scrubs_prior_jira_credentials_before_building_config(
        self,
        monkeypatch,
        channel_source,
    ):
        """A warm Jira task cannot expose credentials to the next task."""
        credential_names = (
            "JIRA_API_TOKEN",
            "JIRA_APP_ACTOR_CONFIGURED",
            "JIRA_APP_ACTOR_PROXY_URL",
            "JIRA_APP_ACTOR_SHARED_SECRET",
        )
        for name in credential_names:
            monkeypatch.setenv(name, "tenant-x-secret")

        def stop_after_scrub(**_kwargs):
            assert all(name not in os.environ for name in credential_names)
            raise RuntimeError("stop after credential scrub")

        with patch("pipeline.build_config", side_effect=stop_after_scrub):
            from pipeline import run_task

            with pytest.raises(RuntimeError, match="stop after credential scrub"):
                run_task(channel_source=channel_source)


class TestSessionTagsAroundTheConfiguration:
    """A task whose configuration cannot be built never reaches the pipeline's own
    FAILED write: ``run_task`` raises and the caller records the error (the backup
    write of ``server._run_task_background``). That write assumes the per-task
    SessionRole, whose DynamoDB grant covers only the item named by the ``task_id``
    session tag, so the tags have to be set before the configuration is built."""

    @staticmethod
    def _session_tags() -> dict[str, str]:
        import aws_session

        return {tag["Key"]: tag["Value"] for tag in aws_session._session_tags()}

    def test_task_whose_configuration_is_rejected_is_already_tagged(self):
        from pipeline import run_task

        # A descriptor field this agent image does not know (an orchestrator
        # deployed ahead of the runtime image): AttachmentConfig forbids extras.
        attachment = {**_REPORT_ATTACHMENT, "scan_verdict": "clean"}

        with pytest.raises(ValueError, match=r"Attachment\[0\] validation failed"):
            run_task(
                repo_url="owner/repo",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-1",
                user_id="u-1",
                attachments=[attachment],
            )

        assert self._session_tags() == {"user_id": "u-1", "repo": "owner/repo", "task_id": "t-1"}

    def test_started_task_is_tagged_from_its_resolved_configuration(self):
        from pipeline import run_task

        # Local batch mode passes no task id: one is generated while the
        # configuration is built, and that is the id the session has to carry.
        with (
            patch("pipeline.task_span", side_effect=RuntimeError("stop before the pipeline")),
            pytest.raises(RuntimeError, match="stop before the pipeline"),
        ):
            run_task(
                repo_url="owner/repo",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                user_id="u-1",
            )

        tags = self._session_tags()
        assert re.fullmatch(r"[0-9a-f]{12}", tags.pop("task_id"))
        assert tags == {"user_id": "u-1", "repo": "owner/repo"}


class TestEarlyAckOrdering:
    """#616 review N4 — the early-ACK reorder must hold under future edits.

    The fix moved the channel ACK (token resolve → 👀 react_task_started →
    "starting" comment) to BEFORE the multi-minute ``setup_repo`` baseline so a
    picked-up task doesn't look dead during the pre-agent build, and so a
    setup-phase failure has a 👀 to swap to ❌. These tests pin both halves:
    (1) the ACK fires before ``setup_repo``, and (2) a ``setup_repo`` crash still
    swaps the 👀 to ❌ via ``react_task_finished(success=False,
    started_reaction_id=<the id from the early react>)``.
    """

    @staticmethod
    def _mock_span() -> MagicMock:
        span = MagicMock()
        span.__enter__ = MagicMock(return_value=span)
        span.__exit__ = MagicMock(return_value=False)
        return span

    @patch("runner.run_agent")
    @patch("pipeline.build_system_prompt")
    @patch("pipeline.discover_project_config")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    def test_channel_ack_fires_before_setup_repo(
        self,
        mock_task_span,
        mock_setup_repo,
        _mock_discover,
        _mock_build_prompt,
        mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_setup_repo.return_value = RepoSetup(
            repo_dir="/workspace/repo",
            branch="bgagent/test/branch",
            build_before=True,
        )

        async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1)

        mock_run_agent.side_effect = fake_run_agent
        mock_task_span.return_value = self._mock_span()

        # Shared parent records the interleaving of the ACK calls vs setup_repo.
        manager = MagicMock()
        manager.attach_mock(mock_setup_repo, "setup_repo")

        with (
            patch("pipeline.resolve_linear_api_token") as m_resolve,
            patch("pipeline.react_task_started", return_value="reaction-42") as m_react,
            patch("pipeline.comment_task_started") as m_comment,
            patch("pipeline.transition_task_started") as m_transition,
            patch("pipeline.configure_channel_mcp"),
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/1"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
            patch("pipeline.task_state"),
        ):
            manager.attach_mock(m_resolve, "resolve")
            manager.attach_mock(m_react, "react")
            manager.attach_mock(m_comment, "comment")
            manager.attach_mock(m_transition, "transition")

            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-ack-order",
                channel_source="linear",
                channel_metadata=_LINEAR_META,
            )

        order = [name for name, _args, _kw in manager.mock_calls]
        # The 👀 react and the token resolve it depends on both precede the
        # (potentially minutes-long) setup_repo baseline — as does the Jira
        # board move (issue #572), all part of the early ACK.
        assert "react" in order and "setup_repo" in order
        assert order.index("resolve") < order.index("react")
        assert order.index("react") < order.index("setup_repo"), (
            f"👀 react_task_started must fire before setup_repo; order was {order}"
        )
        assert order.index("comment") < order.index("setup_repo")
        assert order.index("transition") < order.index("setup_repo")

    @patch("runner.run_agent")
    @patch("repo.setup_repo")
    @patch("pipeline.task_span")
    @patch("pipeline.task_state")
    def test_setup_failure_swaps_eyes_to_cross(
        self,
        _mock_task_state,
        mock_task_span,
        mock_setup_repo,
        _mock_run_agent,
        monkeypatch,
    ):
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        # setup_repo raises (e.g. the pre-agent baseline build OOM/timeout) —
        # the outer handler must still fire the ❌ swap with the early 👀 id.
        mock_setup_repo.side_effect = RuntimeError("baseline build blew up")
        mock_task_span.return_value = self._mock_span()

        with (
            patch("pipeline.resolve_linear_api_token") as m_resolve,
            patch("pipeline.react_task_started", return_value="reaction-42"),
            patch("pipeline.comment_task_started"),
            patch("pipeline.transition_task_started"),
            patch("pipeline.react_task_finished") as m_finished,
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            import pytest

            from pipeline import run_task

            with pytest.raises(RuntimeError, match="baseline build blew up"):
                run_task(
                    repo_url="o/r",
                    task_description="x",
                    github_token="ghp_test",
                    aws_region="us-east-1",
                    task_id="t-setup-fail",
                    channel_source="linear",
                    channel_metadata=_LINEAR_META,
                )

        # The 👀 posted before setup_repo is swapped to ❌: react_task_finished is
        # called with success=False and the reaction id captured pre-setup.
        m_finished.assert_called_once()
        _args, kwargs = m_finished.call_args
        assert kwargs.get("success") is False
        assert kwargs.get("started_reaction_id") == "reaction-42"
        # The token is resolved again for that swap: a crash can come hours after
        # the start, when the token cached there has expired.
        assert m_resolve.call_args_list == [call(_LINEAR_META), call(_LINEAR_META, force=True)]


# ---------------------------------------------------------------------------
# What a finished run reports: task record, pull request, Linear issue
# ---------------------------------------------------------------------------


def _run_pipeline(
    agent_result: AgentResult,
    *,
    build: VerifyOutcome | None = None,
    pr_url: str | None = "https://github.com/o/r/pull/1",
    setup: RepoSetup | None = None,
    task_record: dict | None = None,
    **task_kwargs,
) -> SimpleNamespace:
    """Run ``run_task`` with the agent, the repository setup and the post-hooks stubbed.

    ``build`` is what the post-agent build returns (passed by default), ``pr_url``
    what ``ensure_pr`` returns, ``task_record`` what the cancel check reads. Returns
    the result dict, the three mocks these tests assert on, and the calls to the
    Linear token and reactions in the order they were made."""

    async def fake_run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
        return agent_result

    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    with (
        patch("runner.run_agent", side_effect=fake_run_agent),
        patch("pipeline.build_system_prompt", return_value="sys"),
        patch("pipeline.discover_project_config", return_value=None),
        patch(
            "repo.setup_repo",
            return_value=setup
            or RepoSetup(repo_dir="/workspace/repo", branch="bgagent/test/branch"),
        ),
        patch("pipeline.task_span", return_value=span),
        patch("pipeline.task_state") as task_state,
        patch("pipeline.ensure_committed", return_value=False),
        patch(
            "pipeline.verify_build", return_value=build or VerifyOutcome(passed=True)
        ) as verify_build,
        patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
        patch("pipeline.ensure_pr", return_value=pr_url) as ensure_pr,
        patch("pipeline.get_disk_usage", return_value=0),
        patch("pipeline.print_metrics"),
        patch("pipeline.resolve_linear_api_token") as resolve_linear_api_token,
        patch("pipeline.react_task_started", return_value="reaction-42") as react_task_started,
        patch("pipeline.react_task_finished") as react_task_finished,
    ):
        # One parent for the three Linear calls, so that their order can be read.
        linear = MagicMock()
        linear.attach_mock(resolve_linear_api_token, "resolve_linear_api_token")
        linear.attach_mock(react_task_started, "react_task_started")
        linear.attach_mock(react_task_finished, "react_task_finished")
        task_state.get_task.return_value = task_record
        from pipeline import run_task

        result = run_task(
            repo_url="o/r",
            task_description="x",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_id="t-report",
            **task_kwargs,
        )
    return SimpleNamespace(
        result=result,
        verify_build=verify_build,
        ensure_pr=ensure_pr,
        react_task_finished=react_task_finished,
        linear_calls=linear.mock_calls,
    )


def _agent_succeeded(**fields) -> AgentResult:
    return AgentResult(status="success", turns=1, cost_usd=0.01, num_turns=1, **fields)


class TestInertBuildIsNotReportedAsPassed:
    """A post-agent build whose command could not run (exit 127, no such task) does
    not gate the task, but nothing was built: neither the pull request nor the task
    record may call that a pass."""

    def test_task_succeeds_and_the_build_is_reported_as_not_run(self):
        run = _run_pipeline(
            _agent_succeeded(),
            build=VerifyOutcome(passed=False, inert=True),
            build_command="yarn install && yarn build",
        )

        # The gate stays inert: a command that cannot run is a configuration
        # problem, not the agent's code.
        assert run.result["status"] == "success"
        # None is "the gate did not run" (models.TaskResult): write_terminal then
        # stores no build_passed at all, instead of a true for a build that never
        # started.
        assert run.result["build_passed"] is None
        # The pull request body is written from the same value (third argument).
        assert run.ensure_pr.call_args.args[2] is None

    def test_build_that_ran_and_passed_is_still_reported_as_passed(self):
        run = _run_pipeline(_agent_succeeded())

        assert run.result["build_passed"] is True
        assert run.ensure_pr.call_args.args[2] is True


class TestTurnsCompletedAtTheCap:
    def test_max_turns_stop_is_clamped_to_the_cap(self):
        # The runner's own count can pass the cap: the CLI may ask the model
        # again without counting a turn, and that answer is one more for the
        # runner. The CLI marks the max-turns result ``is_error``, so the runner
        # reports status "error" (not "error_max_turns").
        run = _run_pipeline(
            AgentResult(
                status="error",
                error="Agent session error (subtype='error_max_turns')",
                turns=11,
                num_turns=11,
            ),
            max_turns=10,
        )

        assert run.result["turns_attempted"] == 11
        assert run.result["turns_completed"] == 10


class TestTurnsCompletedCountsTheAnswers:
    """``turns_completed`` is the number of answers of the model, which is what
    ``max_turns`` limits: the runner's count. The CLI's ``num_turns`` is kept as
    ``turns_attempted``: it grows with every tool result, so it can pass the cap
    on a task that never reached it."""

    def test_completed_task_records_its_answers_not_the_cli_count(self):
        # 62 answers under a cap of 80; several of them called more than one tool.
        run = _run_pipeline(
            AgentResult(status="success", turns=62, num_turns=90, cost_usd=0.01),
            max_turns=80,
        )

        assert run.result["turns_completed"] == 62
        assert run.result["turns_attempted"] == 90
        assert run.result["turns"] == 90

    def test_stop_at_the_cap_records_the_cap_and_the_aborted_attempt(self):
        # What the runner hands over when the cap fires: ten answers, and a CLI
        # count that includes the attempt it aborted.
        run = _run_pipeline(
            AgentResult(
                status="error",
                error="Agent session error (subtype='error_max_turns')",
                turns=10,
                num_turns=11,
            ),
            max_turns=10,
        )

        assert run.result["turns_completed"] == 10
        assert run.result["turns_attempted"] == 11

    def test_cli_count_stands_in_when_the_runner_saw_no_answer(self):
        # No answer reached the runner, but the CLI reported a count: it is
        # used, clamped to the cap.
        run = _run_pipeline(
            AgentResult(
                status="error",
                error="Agent session error (subtype='error_max_turns')",
                num_turns=11,
            ),
            max_turns=10,
        )

        assert run.result["turns_completed"] == 10


class TestEpisodeRecordsHowTheTaskEnded:
    """The episode written to the repository's memory is handed to later tasks on
    that repository as a past episode. It has to carry the verdict the task record
    carries, not the result of the post-agent build."""

    @staticmethod
    def _run(agent_result: AgentResult, **run_kwargs) -> tuple[str, str]:
        """The status of the task's result, and the status its episode was written with."""
        with (
            patch("pipeline._extract_agent_notes", return_value=None),
            patch("pipeline.agent_memory.write_task_episode", return_value=True) as write_episode,
        ):
            run = _run_pipeline(agent_result, memory_id="mem-1", **run_kwargs)
        write_episode.assert_called_once()
        return run.result["status"], write_episode.call_args.kwargs["status"]

    def test_agent_stopped_at_its_turn_limit_over_a_green_build_is_remembered_as_failed(self):
        stopped = AgentResult(
            status="error",
            error="Agent session error (subtype='error_max_turns')",
            turns=11,
            num_turns=11,
        )

        assert self._run(stopped, max_turns=10) == ("error", "FAILED")

    def test_task_completed_over_a_build_that_was_already_red_is_remembered_as_completed(self):
        # The regression-only gate: the build failed before the agent ran and
        # still fails, so it does not fail the task.
        red_before = RepoSetup(
            repo_dir="/workspace/repo", branch="bgagent/test/branch", build_before=False
        )

        outcome = self._run(_agent_succeeded(), setup=red_before, build=VerifyOutcome(passed=False))

        assert outcome == ("success", "COMPLETED")

    def test_task_that_delivered_nothing_is_remembered_as_failed(self, tmp_path):
        # The delivery gate: the agent and the build are fine, but there is no
        # pull request and no commit on the branch (tmp_path is not a repository).
        nothing_pushed = RepoSetup(repo_dir=str(tmp_path), branch="bgagent/test/branch")

        outcome = self._run(_agent_succeeded(), setup=nothing_pushed, pr_url=None)

        assert outcome == ("error", "FAILED")

    def test_hold_for_input_is_remembered_as_completed(self):
        # Clarify-and-hold ends COMPLETED without a build or a pull request.
        outcome = self._run(_agent_succeeded(clarification_question="Which page?"))

        assert outcome == ("success", "COMPLETED")


class TestHoldForInput:
    """Clarify-and-hold: the agent called ``request_clarification`` instead of doing
    the work. The task ends COMPLETED with the question as its answer; nothing is
    built and no pull request is opened."""

    @pytest.mark.parametrize(
        ("recorded_question", "answer"),
        [
            pytest.param("Which page is slow?", "Which page is slow?", id="question"),
            # What the runner records for a call whose ``question`` was empty. The
            # agent's last message is then the best text there is; without one the
            # platform's comment falls back to a wording of its own.
            pytest.param(" ", "Tell me which page you mean.", id="empty question"),
        ],
    )
    def test_task_is_held_whatever_the_question_says(self, tmp_path, recorded_question, answer):
        # No pull request and nothing pushed (tmp_path is not a repository): a run
        # that is not held ends as "no change was delivered" (deliverable=lost).
        run = _run_pipeline(
            _agent_succeeded(
                clarification_question=recorded_question,
                result_text="Tell me which page you mean.",
            ),
            setup=RepoSetup(repo_dir=str(tmp_path), branch="bgagent/test/branch"),
            pr_url=None,
        )

        run.verify_build.assert_not_called()
        run.ensure_pr.assert_not_called()
        assert run.result["status"] == "success"
        assert run.result["error"] is None
        assert run.result["code_changed"] is False
        assert run.result["answer_text"] == answer


class TestStepMilestonesOfThePostHooks:
    """The workflow runner announces each step it runs (``step:<name>:start``, then
    the step's status), but on the repo lane it runs the agent step only: the build
    and the pull request are inline post-hooks. The pipeline announces those two
    itself, under the names the workflow gives them. The console takes its
    "Checking" and "Pull request" stages, and its build lines, from these events."""

    @staticmethod
    def _milestones(agent_result: AgentResult, **run_kwargs) -> list[str]:
        """The milestones of one run, in the order they were written."""
        progress = MagicMock()
        with patch("pipeline._ProgressWriter", return_value=progress):
            _run_pipeline(agent_result, **run_kwargs)
        return [call.args[0] for call in progress.write_agent_milestone.call_args_list]

    def test_build_and_pull_request_are_announced_between_the_agent_and_the_pr(self):
        assert self._milestones(_agent_succeeded()) == [
            "repo_setup_complete",
            "step:implement:start",
            "step:implement:succeeded",
            "agent_execution_complete",
            "step:build:start",
            "step:build:succeeded",
            "step:open_pr:start",
            "pr_created",
        ]

    def test_steps_carry_the_names_their_workflow_declares(self):
        # coding/pr-iteration-v1 calls its steps iterate, build and resolve_pr.
        milestones = self._milestones(
            _agent_succeeded(),
            resolved_workflow={"id": "coding/pr-iteration-v1", "version": "1.0.0"},
            pr_number="7",
        )

        assert milestones[-4:] == [
            "step:build:start",
            "step:build:succeeded",
            "step:resolve_pr:start",
            "pr_created",
        ]

    def test_build_that_failed_is_announced_as_failed(self):
        # The pull request is opened all the same, so that the diff can be seen.
        milestones = self._milestones(_agent_succeeded(), build=VerifyOutcome(passed=False))

        assert milestones[-4:] == [
            "step:build:start",
            "step:build:failed",
            "step:open_pr:start",
            "pr_created",
        ]

    def test_build_whose_command_could_not_run_gets_no_verdict(self):
        # Nothing was built: neither "succeeded" nor "failed" is true of it, as on
        # the task record and in the pull request.
        milestones = self._milestones(
            _agent_succeeded(), build=VerifyOutcome(passed=False, inert=True)
        )

        assert milestones[-3:] == ["step:build:start", "step:open_pr:start", "pr_created"]

    def test_hold_for_input_announces_no_post_hook_step(self):
        # Clarify-and-hold runs neither the build nor the pull request.
        milestones = self._milestones(_agent_succeeded(clarification_question="Which page?"))

        assert milestones[-1] == "agent_execution_complete"


class TestLinearIssueAtTerminal:
    """What the pipeline tells the Linear issue when a run ends: the reaction that
    replaces the eyes, and whether the issue moves to In Review."""

    @staticmethod
    def _finished(run: SimpleNamespace) -> dict:
        run.react_task_finished.assert_called_once()
        return run.react_task_finished.call_args.kwargs

    def test_opened_pull_request_moves_the_issue_to_in_review(self):
        run = _run_pipeline(
            _agent_succeeded(), channel_source="linear", channel_metadata=_LINEAR_META
        )

        finished = self._finished(run)
        assert finished["success"] is True
        assert finished["transition_state"] is True

    def test_hold_for_input_does_not_move_the_issue_to_in_review(self):
        # Clarify-and-hold: the agent asked a question, there is no pull request.
        # In Review means "work done, awaiting human merge"; the platform's own
        # comment for this run says the task has not started.
        run = _run_pipeline(
            _agent_succeeded(clarification_question="Which page?"),
            channel_source="linear",
            channel_metadata=_LINEAR_META,
        )

        run.ensure_pr.assert_not_called()
        assert run.result["status"] == "success"
        finished = self._finished(run)
        assert finished["success"] is True
        assert finished["transition_state"] is False

    def test_cancelled_task_swaps_the_eyes_reaction(self):
        # The user cancelled during the run. No post-hook runs, but the eyes the
        # agent posted at the start must not stay on the issue: nothing else
        # removes that reaction until another task starts on the same issue.
        run = _run_pipeline(
            _agent_succeeded(),
            task_record={"status": "CANCELLED"},
            channel_source="linear",
            channel_metadata=_LINEAR_META,
        )

        assert run.result["status"] == "cancelled"
        run.ensure_pr.assert_not_called()
        finished = self._finished(run)
        assert finished["success"] is False
        assert finished["started_reaction_id"] == "reaction-42"

    @pytest.mark.parametrize(
        "task_record",
        [pytest.param(None, id="finished"), pytest.param({"status": "CANCELLED"}, id="cancelled")],
    )
    def test_final_reaction_is_sent_with_a_token_resolved_at_the_end(self, task_record):
        # A Linear access token lasts 24 hours and the one cached when the task
        # started can be near its end. After a long run Linear refuses it, and the
        # eyes stay on the issue, which never moves to In Review.
        run = _run_pipeline(
            _agent_succeeded(),
            task_record=task_record,
            channel_source="linear",
            channel_metadata=_LINEAR_META,
        )

        assert [name for name, _args, _kwargs in run.linear_calls] == [
            "resolve_linear_api_token",
            "react_task_started",
            "resolve_linear_api_token",
            "react_task_finished",
        ]
        assert run.linear_calls[2] == call.resolve_linear_api_token(_LINEAR_META, force=True)

    def test_task_of_another_channel_resolves_no_linear_token(self):
        run = _run_pipeline(_agent_succeeded())

        assert [name for name, _args, _kwargs in run.linear_calls] == [
            "react_task_started",
            "react_task_finished",
        ]

    def test_token_lookup_that_raises_does_not_stop_the_final_reaction(self):
        # The lookup at the end runs inside the crash handler too, between the
        # FAILED write and the metrics report: it must not raise out of there.
        # A secret that holds a JSON list is one input the resolver raises on.
        config = TaskConfig(
            repo_url="o/r",
            aws_region="us-east-1",
            task_id="t-report",
            channel_source="linear",
            channel_metadata=_LINEAR_META,
        )
        lookup_error = AttributeError("'list' object has no attribute 'get'")
        with (
            patch("pipeline.resolve_linear_api_token", side_effect=lookup_error),
            patch("pipeline.react_task_finished") as react_task_finished,
        ):
            _react_linear_task_finished(config, success=False, started_reaction_id="reaction-42")

        react_task_finished.assert_called_once_with(
            "linear",
            _LINEAR_META,
            success=False,
            started_reaction_id="reaction-42",
            transition_state=False,
        )


class TestDeliveryGateReadsThePushedBranch:
    """Without a pull request the delivery gate reports either "the commit is on the
    branch, only the pull request is missing" or "nothing was delivered". It must
    decide that from what was PUSHED: after a failed push the commits exist only in
    the container, and the platform would tell the user that the work is safe on a
    branch GitHub has never seen.

    Real git under ``tmp_path``, with a bare repository as origin."""

    BRANCH = "bgagent/t-report/fix"

    @staticmethod
    def _git(cwd, *args):
        subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)

    def _clone_with_unpushed_commit(self, tmp_path) -> RepoSetup:
        origin = tmp_path / "origin.git"
        repo = tmp_path / "repo"
        self._git(tmp_path, "init", "-q", "--bare", str(origin))
        self._git(tmp_path, "clone", "-q", str(origin), str(repo))
        self._git(repo, "config", "--local", "user.email", "abca-test@example.invalid")
        self._git(repo, "config", "--local", "user.name", "ABCA Test")
        (repo / "f.txt").write_text("base\n")
        self._git(repo, "add", "-A")
        self._git(repo, "commit", "-qm", "base")
        self._git(repo, "branch", "-M", "main")
        self._git(repo, "push", "-q", "origin", "main")
        # The task branch, with the agent's commit on it. Not pushed.
        self._git(repo, "checkout", "-qb", self.BRANCH)
        (repo / "f.txt").write_text("base\nagent change\n")
        self._git(repo, "commit", "-qam", "agent work")
        return RepoSetup(repo_dir=str(repo), branch=self.BRANCH, default_branch="main")

    def test_commit_that_was_never_pushed_is_reported_as_lost(self, tmp_path):
        setup = self._clone_with_unpushed_commit(tmp_path)

        # ensure_pr returned None: the push failed, and so did `gh pr create`.
        run = _run_pipeline(_agent_succeeded(), pr_url=None, setup=setup)

        assert run.result["status"] == "error"
        assert "deliverable=lost" in run.result["error"]

    def test_pushed_commit_without_pull_request_is_reported_as_no_pr(self, tmp_path):
        setup = self._clone_with_unpushed_commit(tmp_path)
        self._git(setup.repo_dir, "push", "-q", "-u", "origin", self.BRANCH)

        run = _run_pipeline(_agent_succeeded(), pr_url=None, setup=setup)

        assert run.result["status"] == "error"
        assert "deliverable=no_pr" in run.result["error"]

    def test_pushed_commit_whose_subject_is_not_utf8_is_counted(self, tmp_path):
        # The check runs for every task that ends without a pull request, so it
        # must not be able to raise. `git commit` converts a subject that is not
        # UTF-8 itself; a commit object written by another tool keeps its bytes
        # and `git log` prints them as they are.
        setup = self._clone_with_unpushed_commit(tmp_path)
        head = subprocess.run(
            ["git", "cat-file", "commit", "HEAD"],
            cwd=setup.repo_dir,
            check=True,
            capture_output=True,
        )
        written = subprocess.run(
            ["git", "hash-object", "-t", "commit", "-w", "--stdin"],
            cwd=setup.repo_dir,
            input=head.stdout.replace(b"agent work", b"caf\xe9"),
            check=True,
            capture_output=True,
        )
        sha = written.stdout.decode().strip()
        self._git(setup.repo_dir, "push", "-q", "origin", f"{sha}:refs/heads/{self.BRANCH}")

        assert _branch_has_new_commits(setup.repo_dir, "main", self.BRANCH) is True


class TestIterationHeadCheck:
    """After an iteration on a pull request the pipeline compares HEAD with the
    commit the task started from, so that the reply can say "updated" or
    "answered, nothing changed". The comparison only words the reply: it must not
    be able to fail a task whose pull request is already updated.

    Real git under ``tmp_path``."""

    @staticmethod
    def _git(cwd, *args) -> str:
        done = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
        return done.stdout.strip()

    def _checkout(self, tmp_path) -> RepoSetup:
        """The branch of the pull request, checked out at its one commit."""
        repo = tmp_path / "repo"
        repo.mkdir()
        self._git(repo, "init", "-q")
        self._git(repo, "config", "--local", "user.email", "abca-test@example.invalid")
        self._git(repo, "config", "--local", "user.name", "ABCA Test")
        self._git(repo, "commit", "-q", "--allow-empty", "-m", "the pull request as it was")
        self._git(repo, "branch", "-M", "feature/x")
        return RepoSetup(
            repo_dir=str(repo),
            branch="feature/x",
            head_sha_before=self._git(repo, "rev-parse", "HEAD"),
        )

    @staticmethod
    def _iterate(setup: RepoSetup, answer: str = "") -> dict:
        """What the task records after an iteration on pull request 7."""
        run = _run_pipeline(
            _agent_succeeded(result_text=answer),
            setup=setup,
            resolved_workflow={"id": "coding/pr-iteration-v1", "version": "1.0.0"},
            pr_number="7",
        )
        return run.result

    def test_iteration_that_committed_reports_a_change(self, tmp_path):
        setup = self._checkout(tmp_path)
        self._git(setup.repo_dir, "commit", "-q", "--allow-empty", "-m", "address the review")

        result = self._iterate(setup, answer="Done.")

        assert result["code_changed"] is True
        assert result["head_sha"] == self._git(setup.repo_dir, "rev-parse", "HEAD")
        assert result["answer_text"] == ""

    def test_iteration_without_a_commit_reports_the_answer(self, tmp_path):
        setup = self._checkout(tmp_path)

        result = self._iterate(setup, answer="It is on purpose.")

        assert result["code_changed"] is False
        assert result["head_sha"] == setup.head_sha_before
        assert result["answer_text"] == "It is on purpose."

    @pytest.mark.parametrize(
        "checkout", ["gone", "."], ids=["no such directory", "not a repository"]
    )
    def test_task_keeps_its_verdict_when_git_cannot_say(self, tmp_path, checkout):
        # git cannot even be started in a directory that is gone, and it exits
        # non-zero in one that is not a repository.
        setup = RepoSetup(
            repo_dir=str(tmp_path / checkout), branch="feature/x", head_sha_before="a" * 40
        )

        result = self._iterate(setup)

        assert result["status"] == "success"
        assert result["code_changed"] is None
        assert result["head_sha"] == ""


class TestCrashedTaskIsReported:
    """A task whose pipeline raises is recorded FAILED by the handler at the bottom of
    ``run_task``. That record is all the platform shows of the task afterwards: it
    has to say what the agent spent and how long the task ran."""

    @staticmethod
    def _crash(
        *, setup_error: Exception | None = None, agent_result: AgentResult | None = None
    ) -> SimpleNamespace:
        """Run a task that raises in the repository setup (``setup_error``) or, once
        the agent has returned ``agent_result``, in ``ensure_pr``.

        The pipeline's clock is stubbed: the repository setup takes 5 minutes and
        the agent 40. Returns the FAILED payload and the ``print_metrics`` mock."""
        clock = SimpleNamespace(now=1_000_000.0)

        def setup_repo(_config, progress=None):
            clock.now += 300
            if setup_error:
                raise setup_error
            return RepoSetup(repo_dir="/workspace/repo", branch="bgagent/test/branch")

        async def run_agent(_prompt, _system_prompt, _config, cwd=None, trajectory=None):
            clock.now += 2400
            return agent_result

        span = MagicMock()
        span.__enter__ = MagicMock(return_value=span)
        span.__exit__ = MagicMock(return_value=False)
        with (
            patch("runner.run_agent", side_effect=run_agent),
            patch("pipeline.build_system_prompt", return_value="sys"),
            patch("pipeline.discover_project_config", return_value=None),
            patch("repo.setup_repo", side_effect=setup_repo),
            patch("pipeline.task_span", return_value=span),
            patch("pipeline.task_state") as task_state,
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", side_effect=RuntimeError("gh pr create timed out")),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics") as print_metrics,
            patch("pipeline.time") as pipeline_time,
            pytest.raises(RuntimeError),
        ):
            pipeline_time.time.side_effect = lambda: clock.now
            task_state.get_task.return_value = None
            from pipeline import run_task

            run_task(
                repo_url="o/r",
                task_description="x",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_id="t-crash",
            )
        task_state.write_terminal.assert_called_once()
        _task_id, status, payload = task_state.write_terminal.call_args.args
        assert status == "FAILED"
        return SimpleNamespace(failed=payload, print_metrics=print_metrics)

    def test_crash_after_the_agent_keeps_what_the_agent_reported(self):
        # The agent finished, then opening the pull request raised. What the agent
        # spent is known and has to be on the FAILED record like on every other
        # terminal record: the monthly budgets are rolled up from its cost_usd.
        crashed = self._crash(
            agent_result=AgentResult(
                status="success",
                turns=7,
                num_turns=7,
                cost_usd=1.25,
                session_id="sess-1",
                usage=TokenUsage(
                    input_tokens=1200,
                    output_tokens=340,
                    cache_read_input_tokens=5000,
                    cache_creation_input_tokens=60,
                ),
            )
        )

        assert crashed.failed["error"] == "RuntimeError: gh pr create timed out"
        from_the_agent = {
            "agent_status": "success",
            "cost_usd": 1.25,
            "turns": 7,
            "turns_attempted": 7,
            "turns_completed": 7,
            "session_id": "sess-1",
            "input_tokens": 1200,
            "output_tokens": 340,
            "cache_read_input_tokens": 5000,
            "cache_creation_input_tokens": 60,
        }
        assert {key: crashed.failed[key] for key in from_the_agent} == from_the_agent

    def test_setup_failure_records_how_long_the_task_ran(self):
        # The clone failed after five minutes. No agent ran, so the agent's fields
        # stay at their defaults, but the task did run for five minutes.
        crashed = self._crash(setup_error=RuntimeError("clone failed"))

        assert crashed.failed["status"] == "error"
        assert crashed.failed["agent_status"] == "unknown"
        assert crashed.failed["cost_usd"] is None
        assert crashed.failed["duration_s"] == 300.0

    def test_crash_after_the_agent_is_timed_like_a_finished_run(self):
        # A finished run reports the time since the agent started (40 minutes
        # here), without the repository setup before it (5 minutes). A run that
        # crashes in a post-hook is on the same clock.
        crashed = self._crash(agent_result=_agent_succeeded())

        assert crashed.failed["duration_s"] == 2400.0

    def test_crashed_task_emits_the_event_the_dashboard_counts(self):
        # The dashboard computes its success rate and task counts from the
        # METRICS_REPORT event, which only print_metrics emits: without it a
        # crashed task is not counted as a failure, it is not counted at all.
        crashed = self._crash(setup_error=RuntimeError("clone failed"))

        crashed.print_metrics.assert_called_once_with(crashed.failed)


# ---------------------------------------------------------------------------
# What the agent step is given: the prompt, the system prompt, .mcp.json
# ---------------------------------------------------------------------------


class TestWhatTheAgentStepIsGiven:
    """What ``run_task`` hands to the agent step. The prompt building and the
    ``.mcp.json`` handling run for real: only the repository setup, the agent
    itself and the post-hooks are stubbed."""

    @pytest.fixture
    def agent_step(self, tmp_path):
        """The stubbed agent step of a task whose clone is ``tmp_path``. It records
        its prompt, system prompt and config, and the servers that ``.mcp.json``
        names at the moment the agent starts."""
        step = SimpleNamespace(ran=False)
        # A clone is a repository: the registry loader has git keep .mcp.json out of commits.
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)

        def servers_in_mcp_json(repo_dir: str) -> list[str]:
            mcp_json = Path(repo_dir, ".mcp.json")
            if not mcp_json.exists():
                return []
            return sorted(json.loads(mcp_json.read_text())["mcpServers"])

        async def run_agent(prompt, system_prompt, config, cwd, trajectory=None):
            step.ran = True
            step.prompt, step.system_prompt, step.config = prompt, system_prompt, config
            step.mcp_servers = servers_in_mcp_json(cwd)
            return _agent_succeeded()

        span = MagicMock()
        span.__enter__ = MagicMock(return_value=span)
        span.__exit__ = MagicMock(return_value=False)
        with (
            patch("runner.run_agent", side_effect=run_agent),
            patch(
                "repo.setup_repo",
                return_value=RepoSetup(repo_dir=str(tmp_path), branch="bgagent/test/branch"),
            ),
            patch("pipeline.task_span", return_value=span),
            patch("pipeline.task_state") as task_state,
            patch("pipeline.ensure_committed", return_value=False),
            patch("pipeline.verify_build", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.verify_lint", return_value=VerifyOutcome(passed=True)),
            patch("pipeline.ensure_pr", return_value="https://github.com/o/r/pull/1"),
            patch("pipeline.get_disk_usage", return_value=0),
            patch("pipeline.print_metrics"),
        ):
            task_state.get_task.return_value = None
            step.task_state = task_state
            yield step

    @staticmethod
    def _run_task(**task_kwargs) -> dict:
        from pipeline import run_task

        return run_task(
            repo_url="o/r",
            task_description="x",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_id="t-given",
            **task_kwargs,
        )

    @staticmethod
    def _mcp_server(name: str, url: str) -> dict:
        """The resolved registry asset ``acme/<name>``, as the orchestrator sends it."""
        return {
            "kind": "mcp_server",
            "namespace": "acme",
            "name": name,
            "version": "1.0.0",
            "runtime": {"transport": "http", "url": url},
        }

    def test_linear_server_committed_to_the_repository_is_removed(self, agent_step, tmp_path):
        # ADR-016: the agent must have no Linear tools. The CLI loads the
        # repository's .mcp.json, a Linear task has the Linear token in its
        # environment and the permission mode is bypassPermissions, so the entry
        # has to be gone from the file before the agent starts.
        (tmp_path / ".mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "linear-server": {"type": "sse", "url": "https://mcp.linear.app/sse"},
                        "docs": {"command": "docs-mcp"},
                    }
                }
            )
        )

        self._run_task()

        assert agent_step.mcp_servers == ["docs"]

    def test_registry_server_is_in_mcp_json_when_the_agent_starts(self, agent_step):
        self._run_task(resolved_assets=[self._mcp_server("pdf", "https://pdf.example.com/mcp")])

        assert agent_step.mcp_servers == ["acme__pdf"]

    @pytest.mark.parametrize(
        ("name", "url"),
        [
            # A server that has nothing to do with Linear: its key contains the word.
            pytest.param("linear-regression", "https://ml.example.com/mcp", id="linear-in-name"),
            # The name says nothing; the URL is Linear's.
            pytest.param("tracker", "https://mcp.linear.app/sse", id="linear-server"),
        ],
    )
    def test_registry_server_that_the_linear_scrub_removes_fails_the_task(
        self, agent_step, name, url
    ):
        # The registry merge writes its servers into .mcp.json after that first
        # scrub, so the pipeline scrubs once more behind the merge. What this scrub
        # removes is a server the Blueprint pins, and the task record already names
        # it as loaded: the task fails, like for every other pinned asset that
        # could not be loaded (#246), instead of running without the server.
        with pytest.raises(RegistryAssetLoadError, match="Linear MCP scrub"):
            self._run_task(
                resolved_assets=[
                    self._mcp_server(name, url),
                    self._mcp_server("pdf", "https://pdf.example.com/mcp"),
                ]
            )

        assert agent_step.ran is False
        agent_step.task_state.write_terminal.assert_called_once()
        _task_id, status, payload = agent_step.task_state.write_terminal.call_args.args
        assert status == "FAILED"
        # The error is what the operator reads: it names the rule and the pinned servers.
        assert "Linear MCP scrub" in payload["error"]
        assert f"acme__{name}" in payload["error"]

    def test_orchestrator_context_is_what_the_agent_runs_on(self, agent_step):
        # Every deployed task arrives with a hydrated context. Its prompt was
        # assembled, screened and budgeted by the orchestrator: the agent must run
        # on that text, not on a prompt rebuilt in the container from the task
        # description, and on the issue, branches and memory that came with it.
        self._run_task(
            hydrated_context={
                "version": 1,
                "user_prompt": "HYDRATED PROMPT",
                "issue": {"number": 42, "title": "Login page is slow", "body": "Takes 9 s."},
                "memory_context": {"repo_knowledge": ["Uses Jest"]},
                "sources": ["issue", "memory"],
                "token_estimate": 12,
                "truncated": False,
                "resolved_branch_name": "bgagent/t-given/login-page-is-slow",
                "resolved_base_branch": "bgagent/t-parent/session-store",
            }
        )

        assert agent_step.prompt == "HYDRATED PROMPT"
        assert "Uses Jest" in agent_step.system_prompt
        assert agent_step.config.issue.title == "Login page is slow"
        assert agent_step.config.branch_name == "bgagent/t-given/login-page-is-slow"
        assert agent_step.config.base_branch == "bgagent/t-parent/session-store"

    def test_context_of_a_newer_schema_fails_the_task_with_the_contract_error(self, agent_step):
        # An orchestrator that is ahead of the agent image sends a context this
        # agent cannot parse. The task must fail with the validation error that
        # names the mismatch, before anything else runs.
        with pytest.raises(ValidationError, match="schema version 99 is not supported"):
            self._run_task(hydrated_context={"user_prompt": "x", "version": 99})

        assert agent_step.ran is False
        agent_step.task_state.write_terminal.assert_called_once()
        _task_id, status, payload = agent_step.task_state.write_terminal.call_args.args
        assert status == "FAILED"
        assert "schema version 99 is not supported" in payload["error"]


class TestBatchEntryPoint:
    """``main()``, the local batch entry point (``agent/run.sh``)."""

    @staticmethod
    def _main(capsys, **config_fields) -> tuple[str, MagicMock]:
        config = TaskConfig(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_id="t-main",
            **config_fields,
        )
        with (
            patch("pipeline.get_config", return_value=config),
            patch("pipeline.run_task", return_value={"status": "success"}) as run_task,
        ):
            from pipeline import main

            main()
        return capsys.readouterr().out, run_task

    def test_real_run_does_not_announce_a_dry_run(self, capsys):
        out, run_task = self._main(capsys)

        run_task.assert_called_once()
        assert "Dry run" not in out

    def test_dry_run_prints_the_length_and_hash_of_each_prompt(self, capsys):
        out, run_task = self._main(capsys, dry_run=True)

        run_task.assert_not_called()
        assert "Dry run mode detected." in out
        # One line for the system prompt and one for the user prompt, each ending
        # at the hash: no switch prints the text itself.
        prompt_lines = [line for line in out.splitlines() if line.startswith("length=")]
        assert len(prompt_lines) == 2
        assert all(
            re.fullmatch(r"length=\d+ chars sha256=[0-9a-f]{12}", line) for line in prompt_lines
        ), prompt_lines
        assert "--- DRY RUN COMPLETE ---" in out
