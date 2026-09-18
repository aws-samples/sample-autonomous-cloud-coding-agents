# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""A complete checkpoint must recover after losing both process and workspace."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from dataclasses import asdict
from typing import Any
from unittest.mock import MagicMock

import pytest

from continuation_runtime import ContinuationRuntime, restore_for_task
from continuation_storage import ContinuationContext, S3ContinuationStorage
from microvm_lifecycle import ApprovalRecord, LifecycleUnavailable, MicrovmLifecycle
from models import RepoSetup, TaskConfig
from tests.test_continuation_storage import VersionedS3

SESSION = "11111111-1111-4111-8111-aaaaaaaaaaaa"


class Deadline:
    def remaining_s(self) -> float:
        return 5000


def git(workspace, *args):
    return subprocess.run(
        ["git", "-C", str(workspace), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def ready(tmp_path, monkeypatch):
    from continuation_usage import UsageSnapshot

    async def usage(_):
        return UsageSnapshot(0.02, {"input_tokens": 100, "output_tokens": 10})

    monkeypatch.setattr("continuation_runtime.read_usage", usage)
    workspace = tmp_path / "task"
    workspace.mkdir()
    git(workspace, "init", "-b", "main")
    git(workspace, "config", "user.name", "Test")
    git(workspace, "config", "user.email", "test@example.test")
    (workspace / "tracked.txt").write_text("committed\n")
    git(workspace, "add", ".")
    git(workspace, "commit", "-m", "initial")
    original_head = git(workspace, "rev-parse", "HEAD")
    (workspace / "tracked.txt").write_text("staged edit\n")
    git(workspace, "add", ".")
    (workspace / "tracked.txt").write_text("unstaged edit\n")
    (workspace / "untracked.txt").write_text("keep this work\n")
    context = ContinuationContext(
        RepoSetup(
            repo_dir=str(workspace),
            branch="main",
            build_before=False,
            head_sha_before=original_head,
        ),
        "Original user prompt",
        "Original system prompt",
        "coding/new-task-v1",
        "1",
    )
    client = VersionedS3()
    runtime = ContinuationRuntime(context, S3ContinuationStorage("owned-bucket", client=client))
    return workspace, runtime


async def park_runtime(runtime, repo="owner/repo"):
    lifecycle = MicrovmLifecycle("task", "microvm-one")
    await lifecycle.tool_started("toolu_pending")
    park = lifecycle.park_approval(
        "request",
        "toolu_pending",
        Deadline(),
        record=ApprovalRecord("user", repo, "2026-09-17T00:00:00Z", 5000),
    )
    assert park is not None
    tool_input = {"file_path": runtime.context.setup.repo_dir + "/untracked.txt"}
    entries: Any = [
        {
            "type": "assistant",
            "uuid": "entry-one",
            "sessionId": SESSION,
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": park.tool_use_id,
                        "name": "Read",
                        "input": tool_input,
                    }
                ]
            },
        }
    ]
    await runtime.store.append(
        {"project_key": runtime.store.project_key, "session_id": SESSION}, entries
    )
    return lifecycle, park, tool_input


class TestCompleteRecovery:
    def test_restore_preserves_git_baseline_conversation_and_pending_action(self, ready):
        workspace, runtime = ready
        before_status = git(workspace, "status", "--porcelain=v1")
        before_index = git(workspace, "diff", "--cached")

        async def save():
            lifecycle, park, tool_input = await park_runtime(runtime)
            identity, receipt = await runtime.capture(
                lifecycle, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
            )
            assert lifecycle.diagnostic_snapshot()["phase"] == "checkpoint-ready"
            lifecycle.close()
            return identity, receipt

        identity, receipt = asyncio.run(save())
        shutil.rmtree(workspace)
        restored = ContinuationRuntime.restore(
            runtime.storage,
            receipt,
            identity,
            expected_workspace=workspace,
            workflow_id="coding/new-task-v1",
            workflow_version="1",
        )
        assert restored.context == runtime.context
        assert git(workspace, "status", "--porcelain=v1") == before_status
        assert git(workspace, "diff", "--cached") == before_index
        assert (workspace / "untracked.txt").read_text() == "keep this work\n"
        assert restored.restored is not None
        assert restored.restored["session_id"] == SESSION
        prompt = restored.decision_prompt(decision="DENIED", reason="Use another approach")
        assert "DENIED" in prompt and "Use another approach" in prompt
        assert str(workspace / "untracked.txt") in prompt
        assert "normal permission checks" in prompt

    def test_later_parallel_tool_cannot_modify_a_published_workspace(self, ready):
        _, runtime = ready

        async def scenario():
            lifecycle, park, tool_input = await park_runtime(runtime)
            await runtime.capture(
                lifecycle, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
            )
            later = asyncio.create_task(lifecycle.tool_started("toolu_later"))
            await asyncio.sleep(0.03)
            assert not later.done()
            # Reads/feedback remain available while tools are held.
            async with lifecycle.approval_poll():
                pass
            with lifecycle.activity():
                pass
            with pytest.raises(LifecycleUnavailable, match="claim task ownership"):
                await lifecycle.leave_approval(park)
            await lifecycle.release_continuation(park)
            await asyncio.wait_for(later, 1)
            assert lifecycle.diagnostic_snapshot()["phase"] == "active"

        asyncio.run(scenario())

    def test_sleep_and_wake_do_not_release_continuation_tools(self, ready):
        _, runtime = ready

        async def scenario():
            lifecycle, park, tool_input = await park_runtime(runtime)
            await runtime.capture(
                lifecycle, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
            )
            await lifecycle.suspend(lambda _: None, budget_s=1)
            await lifecycle.resume(lambda _: None, budget_s=1)
            assert lifecycle.diagnostic_snapshot()["phase"] == "checkpoint-ready"
            await lifecycle.release_continuation(park)
            assert lifecycle.diagnostic_snapshot()["phase"] == "active"

        asyncio.run(scenario())

    def test_failed_capture_keeps_original_approval_usable(self, ready, monkeypatch):
        _, runtime = ready

        def fail(*_):
            raise RuntimeError("owned storage failure")

        monkeypatch.setattr(runtime, "_save", fail)

        async def scenario():
            lifecycle, park, tool_input = await park_runtime(runtime)
            with pytest.raises(RuntimeError, match="storage failure"):
                await runtime.capture(
                    lifecycle, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
                )
            assert lifecycle.diagnostic_snapshot()["phase"] == "parked"
            await lifecycle.leave_approval(park)

        asyncio.run(scenario())

    def test_cancellation_never_opens_tools_while_capture_thread_may_still_run(self, ready):
        _, runtime = ready

        async def scenario():
            lifecycle, park, _ = await park_runtime(runtime)
            entered = asyncio.Event()

            async def capture():
                async with lifecycle.continuation_checkpoint(park):
                    entered.set()
                    await asyncio.Event().wait()

            task = asyncio.create_task(capture())
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert lifecycle.diagnostic_snapshot()["phase"] == "failed"
            with pytest.raises(LifecycleUnavailable):
                await lifecycle.tool_started("toolu_later")

        asyncio.run(scenario())

    @pytest.mark.parametrize("mismatch", ["workspace", "workflow", "version"])
    def test_wrong_restore_context_is_rejected_before_creating_files(
        self, ready, mismatch, tmp_path
    ):
        workspace, runtime = ready

        async def save():
            lifecycle, park, tool_input = await park_runtime(runtime)
            return await runtime.capture(
                lifecycle, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
            )

        identity, receipt = asyncio.run(save())
        shutil.rmtree(workspace)
        with pytest.raises(RuntimeError, match="workspace or workflow"):
            ContinuationRuntime.restore(
                runtime.storage,
                receipt,
                identity,
                expected_workspace=tmp_path / "another" if mismatch == "workspace" else workspace,
                workflow_id="another" if mismatch == "workflow" else "coding/new-task-v1",
                workflow_version="2" if mismatch == "version" else "1",
            )
        assert not workspace.exists()
        assert not (tmp_path / "another").exists()


@pytest.fixture
def replacement(ready, monkeypatch):
    from continuation_session import decode_checkpoint

    workspace, runtime = ready

    async def save():
        lifecycle, park, tool_input = await park_runtime(runtime)
        result = await runtime.capture(
            lifecycle, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
        )
        lifecycle.close()
        return result

    identity, receipt = asyncio.run(save())
    manifest = runtime.storage.load_manifest(receipt, identity)
    checkpoint = runtime.storage.conversations.load(manifest.conversation, identity)
    action = decode_checkpoint(checkpoint, identity)["action"]
    task = {
        "task_id": "task",
        "user_id": "user",
        "repo": "owner/repo",
        "status": "AWAITING_APPROVAL",
        "session_id": "microvm-new",
        "awaiting_approval_request_id": "request",
        "approval_gate_count": 4,
        "continuation": {
            "version": 1,
            "state": "RESTORING",
            "worker_id": "microvm-new",
            "attempt_id": "attempt-new",
            "identity": asdict(identity),
            "manifest": asdict(receipt),
        },
    }
    approval = {
        "user_id": "user",
        "repo": "owner/repo",
        "status": "APPROVED",
        "tool_input_sha256": action["tool_input_sha256"],
    }
    lifecycle = MicrovmLifecycle("task", "microvm-new")
    monkeypatch.setenv("CONTINUATION_BUCKET_NAME", "owned-bucket")
    monkeypatch.setattr("config.AGENT_WORKSPACE", str(workspace.parent))
    monkeypatch.setattr("microvm_lifecycle.get_context", lambda _: lifecycle)
    monkeypatch.setattr("continuation_runtime.S3ContinuationStorage", lambda _: runtime.storage)
    get_task = MagicMock(return_value=task)
    consume = MagicMock()
    monkeypatch.setattr("task_state.get_task", get_task)
    monkeypatch.setattr("task_state.get_approval_row", lambda *_args, **_kw: approval)
    monkeypatch.setattr("task_state.consume_restored_continuation", consume)
    config = TaskConfig(
        task_id="task",
        user_id="user",
        repo_url="owner/repo",
        github_token="test",
        aws_region="us-west-2",
        resolved_workflow={"id": "coding/new-task-v1", "version": "1"},
    )
    shutil.rmtree(workspace)
    yield config, task, approval, consume, get_task, workspace
    lifecycle.close()


@pytest.mark.parametrize("decision", ["APPROVED", "DENIED", "TIMED_OUT"])
def test_production_restore_loads_saved_files_then_claims_recorded_decision(replacement, decision):
    config, task, approval, consume, get_task, workspace = replacement
    approval["status"] = decision
    approval["deny_reason"] = "Choose another approach"
    runtime = restore_for_task(config)
    assert runtime is not None and runtime.restored is not None
    assert (workspace / "untracked.txt").read_text() == "keep this work\n"
    assert runtime.human_decision == approval
    assert runtime.resume_prompt is not None and decision in runtime.resume_prompt
    assert runtime.prior_cost_usd == pytest.approx(0.02)
    assert config.initial_approval_gate_count == 4
    get_task.assert_called_once_with("task", consistent_read=True)
    consume.assert_called_once_with("task", "microvm-new", task["continuation"])


@pytest.mark.parametrize(
    "field,value",
    [
        ("status", "PENDING"),
        ("status", "CANCELLED"),
        ("user_id", "other"),
        ("repo", "other/repo"),
        ("tool_input_sha256", "different"),
    ],
)
def test_production_restore_never_claims_an_unavailable_or_mismatched_decision(
    replacement, field, value
):
    from continuation_session import ContinuationCheckpointError

    config, _, approval, consume, _, _ = replacement
    approval[field] = value
    with pytest.raises(ContinuationCheckpointError, match="human decision"):
        restore_for_task(config)
    consume.assert_not_called()


def test_production_restore_waits_for_start_registration_without_fresh_clone(
    replacement, monkeypatch
):
    from copy import deepcopy

    config, task, _, consume, get_task, _ = replacement
    starting = deepcopy(task)
    starting["continuation"]["state"] = "STARTING"
    get_task.side_effect = [starting, task]
    monkeypatch.setattr("continuation_runtime.time.sleep", lambda _: None)
    assert restore_for_task(config) is not None
    assert get_task.call_count == 2
    consume.assert_called_once()


def test_production_restore_rejects_a_different_physical_worker_before_writing_files(replacement):
    from continuation_session import ContinuationCheckpointError

    config, task, _, consume, _, workspace = replacement
    task["continuation"]["worker_id"] = "other-worker"
    with pytest.raises(ContinuationCheckpointError, match="does not own"):
        restore_for_task(config)
    assert not workspace.exists()
    consume.assert_not_called()


def test_repository_free_microvm_restores_its_private_scratch_files_without_a_remote(
    ready, tmp_path, monkeypatch
):
    from continuation_runtime import prepare_repoless_runtime
    from continuation_session import decode_checkpoint

    _, reference = ready
    base = tmp_path / "scratch-root"
    monkeypatch.setattr("config.AGENT_WORKSPACE", str(base))
    monkeypatch.setenv("CONTINUATION_BUCKET_NAME", "owned-bucket")
    monkeypatch.setattr("continuation_runtime.S3ContinuationStorage", lambda _: reference.storage)
    lifecycle = MicrovmLifecycle("task", "microvm-one")
    monkeypatch.setattr("microvm_lifecycle.get_context", lambda _: lifecycle)
    task = {"task_id": "task", "user_id": "user", "status": "RUNNING"}
    monkeypatch.setattr("task_state.get_task", lambda *_args, **_kw: task)
    config = TaskConfig(
        task_id="task",
        user_id="user",
        repo_url="",
        github_token="",
        requires_repo=False,
        aws_region="us-west-2",
        resolved_workflow={"id": "default/agent-v1", "version": "1"},
    )
    runtime = prepare_repoless_runtime(
        config,
        user_prompt="Keep these scratch files",
        system_prompt="Saved instructions",
        workflow_id="default/agent-v1",
        workflow_version="1",
    )
    assert runtime is not None
    workspace = base / "task"
    assert runtime.context.setup.repo_dir == str(workspace)
    assert git(workspace, "remote") == ""
    (workspace / "untracked.txt").write_text("private draft\n")

    async def capture():
        active, park, tool_input = await park_runtime(runtime, repo="")
        result = await runtime.capture(
            active, park, session_id=SESSION, tool_name="Read", tool_input=tool_input
        )
        active.close()
        return result

    identity, receipt = asyncio.run(capture())
    manifest = runtime.storage.load_manifest(receipt, identity)
    action = decode_checkpoint(
        runtime.storage.conversations.load(manifest.conversation, identity), identity
    )["action"]
    lifecycle.close()
    lifecycle = MicrovmLifecycle("task", "microvm-new")
    task.update(
        status="AWAITING_APPROVAL",
        session_id="microvm-new",
        awaiting_approval_request_id="request",
        continuation={
            "version": 1,
            "state": "RESTORING",
            "worker_id": "microvm-new",
            "identity": asdict(identity),
            "manifest": asdict(receipt),
        },
    )
    monkeypatch.setattr(
        "task_state.get_approval_row",
        lambda *_args, **_kw: {
            "user_id": "user",
            "repo": "",
            "status": "APPROVED",
            "tool_input_sha256": action["tool_input_sha256"],
        },
    )
    consume = MagicMock()
    monkeypatch.setattr("task_state.consume_restored_continuation", consume)
    shutil.rmtree(workspace)
    try:
        restored = prepare_repoless_runtime(
            config,
            user_prompt="replacement input",
            system_prompt="replacement input",
            workflow_id="default/agent-v1",
            workflow_version="1",
        )
        assert restored is not None and restored.restored is not None
        assert restored.context.system_prompt == "Saved instructions"
        assert (workspace / "untracked.txt").read_text() == "private draft\n"
        assert git(workspace, "remote") == ""
        assert "credential" not in (workspace / ".git/config").read_text()
        consume.assert_called_once()
    finally:
        lifecycle.close()
