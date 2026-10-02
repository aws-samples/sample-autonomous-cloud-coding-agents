# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Compose conversation, workflow and workspace recovery at an approval barrier."""

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from claude_agent_sdk import project_key_for_directory

from continuation_session import (
    CheckpointIdentity,
    CheckpointSessionStore,
    ContinuationCheckpointError,
    decode_checkpoint,
)
from continuation_storage import (
    ContinuationContext,
    ContinuationManifest,
    FileReceipt,
    S3ContinuationStorage,
)
from continuation_usage import TOKEN_FIELDS, read_usage
from continuation_workspace import WorkspaceLimits, capture_workspace, restore_workspace

if TYPE_CHECKING:
    from microvm_lifecycle import ApprovalPark, MicrovmLifecycle
    from models import TaskConfig
    from policy import PolicyEngine


_current: ContextVar[ContinuationRuntime | None] = ContextVar("continuation_runtime", default=None)


def current_runtime() -> ContinuationRuntime | None:
    return _current.get()


@contextmanager
def bind_runtime(runtime: ContinuationRuntime | None):
    token = _current.set(runtime)
    try:
        yield
    finally:
        _current.reset(token)


def create_runtime(context: ContinuationContext, task_id: str) -> ContinuationRuntime | None:
    from microvm_lifecycle import get_context

    bucket = os.environ.get("CONTINUATION_BUCKET_NAME", "")
    if not bucket or get_context(task_id) is None:
        return None
    return ContinuationRuntime(context, S3ContinuationStorage(bucket))


def restore_for_task(config: TaskConfig) -> ContinuationRuntime | None:
    """Read a coordinator-owned replacement assignment; payloads do not choose S3 keys."""
    import task_state
    from config import AGENT_WORKSPACE
    from microvm_lifecycle import get_context

    bucket = os.environ.get("CONTINUATION_BUCKET_NAME", "")
    lifecycle = get_context(config.task_id)
    if not bucket or lifecycle is None:
        return None
    registration_deadline = time.monotonic() + 30
    while True:
        task = task_state.get_task(config.task_id, consistent_read=True)
        record = task.get("continuation") if task else None
        if not isinstance(record, dict) or record.get("state") != "STARTING":
            break
        # /run can start the pipeline before RunMicrovm returns its handle to
        # the coordinator. Never turn that registration race into a fresh clone.
        if time.monotonic() >= registration_deadline:
            raise ContinuationCheckpointError(
                "Replacement worker registration was not acknowledged"
            )
        time.sleep(0.2)
    if (
        task is None
        or task.get("user_id") != config.user_id
        or (task.get("repo") or "") != config.repo_url
    ):
        raise ContinuationCheckpointError("Continuation task identity is unavailable")
    record = task.get("continuation")
    if record is None:
        return None
    if not isinstance(record, dict) or record.get("state") != "RESTORING":
        raise ContinuationCheckpointError("Existing continuation cannot start as a fresh task")
    identity = CheckpointIdentity(**record["identity"])
    if (
        record.get("version") != 1
        or record.get("worker_id") != lifecycle.microvm_id
        or task.get("session_id") != lifecycle.microvm_id
        or task.get("status") != "AWAITING_APPROVAL"
        or task.get("awaiting_approval_request_id") != identity.request_id
        or (identity.task_id, identity.user_id, identity.repo)
        != (config.task_id, config.user_id, config.repo_url)
    ):
        raise ContinuationCheckpointError("Replacement worker does not own this continuation")
    workflow = config.resolved_workflow or {}
    runtime = ContinuationRuntime.restore(
        S3ContinuationStorage(bucket),
        FileReceipt.from_record(record["manifest"], identity),
        identity,
        expected_workspace=Path(AGENT_WORKSPACE).resolve() / config.task_id,
        workflow_id=workflow.get("id", ""),
        workflow_version=workflow.get("version", ""),
    )
    approval = task_state.get_approval_row(
        config.task_id, identity.request_id, consistent_read=True
    )
    if (
        approval is None
        or approval.get("user_id") != config.user_id
        or (approval.get("repo") or "") != config.repo_url
        or runtime.restored is None
        or approval.get("tool_input_sha256") != runtime.restored["action"]["tool_input_sha256"]
        or approval.get("status") not in {"APPROVED", "DENIED", "TIMED_OUT"}
    ):
        raise ContinuationCheckpointError("Continuation human decision is unavailable")
    # No SDK process exists yet. Only after restoration and this conditional
    # claim may its freshly gated tools start.
    task_state.consume_restored_continuation(config.task_id, lifecycle.microvm_id, record)
    runtime.resume_prompt = runtime.decision_prompt(
        decision=approval["status"], reason=approval.get("deny_reason") or ""
    )
    runtime.human_decision = approval
    config.initial_approval_gate_count = max(
        int(task.get("approval_gate_count", 0)), runtime.context.approval_gate_count
    )
    return runtime


def prepare_repoless_runtime(
    config: TaskConfig,
    *,
    user_prompt: str,
    system_prompt: str,
    workflow_id: str,
    workflow_version: str,
) -> ContinuationRuntime | None:
    """Give a MicroVM task a private scratch workspace with a local-only Git baseline."""
    from config import AGENT_WORKSPACE
    from microvm_lifecycle import get_context
    from models import RepoSetup

    if not os.environ.get("CONTINUATION_BUCKET_NAME") or get_context(config.task_id) is None:
        return None
    if config.repo_url:
        raise ContinuationCheckpointError(
            "Scratch recovery is only for a task without a repository"
        )
    restored = restore_for_task(config)
    if restored is not None:
        return restored
    # Validate the task component before joining it to a filesystem path.
    CheckpointIdentity(config.task_id, "initial", "initial", config.user_id, "")
    workspace = Path(AGENT_WORKSPACE).resolve() / config.task_id
    workspace.parent.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(mode=0o700, exist_ok=False)
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")

    def git(*args: str) -> str:
        return subprocess.run(
            [
                "git",
                "-C",
                str(workspace),
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=ABCA",
                "-c",
                "user.email=workspace@invalid",
                *args,
            ],
            env=env,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout.strip()

    git("init", "-b", "scratch")
    git("commit", "--allow-empty", "--no-gpg-sign", "-m", "Private task workspace")
    return create_runtime(
        ContinuationContext(
            RepoSetup(
                repo_dir=str(workspace), branch="scratch", head_sha_before=git("rev-parse", "HEAD")
            ),
            user_prompt,
            system_prompt,
            workflow_id,
            workflow_version,
        ),
        config.task_id,
    )


class ContinuationRuntime:
    """A single runner's state; SDK append/checkpoint calls share its event loop."""

    def __init__(
        self,
        context: ContinuationContext,
        storage: S3ContinuationStorage,
        *,
        store: CheckpointSessionStore | None = None,
        restored: dict | None = None,
    ) -> None:
        self.context = context
        self.storage = storage
        self.store = store or CheckpointSessionStore(
            project_key_for_directory(context.setup.repo_dir)
        )
        self.restored = restored
        self.resume_prompt: str | None = None
        self.human_decision: dict | None = None
        self._approval_consumed = False
        self.client: Any = None
        # These remain fixed for this SDK process. Repeated captures must not
        # add its cumulative counters to an earlier capture of the same process.
        self.prior_cost_usd = context.cost_usd if restored is not None else 0.0
        self.prior_token_usage = dict(context.token_usage) if restored is not None else {}

    def seed_policy(self, engine: PolicyEngine) -> None:
        """Carry session grants and the recorded denial across worker replacement."""
        for scope in self.context.approval_scopes:
            engine.allowlist.add(scope)
        decision = self.human_decision
        if self.restored is None or decision is None:
            return
        action = self.restored["action"]
        status = decision["status"]
        if status == "APPROVED":
            scope = decision.get("scope") or "this_call"
            if scope != "this_call":
                engine.allowlist.add(scope)
        elif status in {"DENIED", "TIMED_OUT"}:
            reason = decision.get("deny_reason") or ""
            engine.recent_decisions.record(
                action["tool_name"],
                action["tool_input_sha256"],
                decision=status,
                reason=reason,
                original_decision_ts=decision.get("decided_at"),
            )
            if status == "DENIED":
                for rule_id in decision.get("matching_rule_ids", []):
                    engine.recent_decisions.record_rule_decision(
                        action["tool_name"],
                        rule_id,
                        decision="DENIED",
                        reason=reason,
                        original_decision_ts=decision.get("decided_at"),
                    )

    def consume_approved_action(self, tool_name: str, tool_input_sha256: str) -> dict | None:
        """Consume one exact saved proposal, only after the normal policy check."""
        decision = self.human_decision
        if (
            self.restored is None
            or decision is None
            or decision.get("status") != "APPROVED"
            or self._approval_consumed
            or self.restored["action"]["tool_name"] != tool_name
            or self.restored["action"]["tool_input_sha256"] != tool_input_sha256
        ):
            return None
        self._approval_consumed = True
        return decision

    async def capture(
        self,
        lifecycle: MicrovmLifecycle,
        park: ApprovalPark,
        *,
        session_id: str,
        tool_name: str,
        tool_input: dict,
        approval_scopes: tuple[str, ...] = (),
        approval_gate_count: int = 0,
    ) -> tuple[CheckpointIdentity, FileReceipt]:
        if park.record is None:
            raise ContinuationCheckpointError("Approval identity is unavailable for continuation")
        identity = CheckpointIdentity(
            park.task_id,
            park.microvm_id,
            park.request_id,
            park.record.user_id,
            park.record.repo,
        )
        async with lifecycle.continuation_checkpoint(park):
            body = await self.store.checkpoint_pending(
                identity,
                session_id=session_id,
                tool_use_id=park.tool_use_id,
                tool_name=tool_name,
                tool_input=tool_input,
                timeout_s=10,
            )
            entries = decode_checkpoint(body, identity)["entries"]
            usage = await read_usage(self.client)
            turns = set()
            for index, entry in enumerate(entries):
                message = entry.get("message")
                if entry.get("type") != "assistant" or not isinstance(message, dict):
                    continue
                message_id = message.get("id")
                turns.add(
                    message_id
                    if isinstance(message_id, str) and message_id
                    else entry.get("uuid") or f"entry-{index}"
                )
            self.context = replace(
                self.context,
                approval_scopes=approval_scopes,
                approval_gate_count=max(self.context.approval_gate_count, approval_gate_count),
                turns_used=max(self.context.turns_used, len(turns)),
                cost_usd=self.prior_cost_usd + usage.cost_usd,
                token_usage={
                    key: self.prior_token_usage.get(key, 0) + usage.tokens.get(key, 0)
                    for key in TOKEN_FIELDS
                },
            )
            receipt = await asyncio.to_thread(self._save, body, identity)
        return identity, receipt

    def _save(self, body: bytes, identity: CheckpointIdentity) -> FileReceipt:
        # Staging is outside the workspace so it cannot recursively archive
        # itself. TemporaryDirectory is private and is removed on every exit.
        with tempfile.TemporaryDirectory(prefix="abca-continuation-") as directory:
            archive = Path(directory).resolve() / "workspace.tar"
            capture_workspace(
                Path(self.context.setup.repo_dir),
                archive,
                identity,
                limits=WorkspaceLimits(max_bytes=self.storage.limits.max_workspace_bytes),
            )
            workspace = self.storage.save_workspace(archive, identity)
            conversation = self.storage.conversations.save(body, identity)
            return self.storage.save_manifest(
                ContinuationManifest(identity, conversation, workspace, self.context)
            )

    @classmethod
    def restore(
        cls,
        storage: S3ContinuationStorage,
        receipt: FileReceipt,
        identity: CheckpointIdentity,
        *,
        expected_workspace: Path,
        workflow_id: str,
        workflow_version: str,
    ) -> ContinuationRuntime:
        manifest = storage.load_manifest(receipt, identity)
        context = manifest.context
        if (
            context.setup.repo_dir != str(expected_workspace)
            or context.workflow_id != workflow_id
            or context.workflow_version != workflow_version
        ):
            raise ContinuationCheckpointError("Continuation workspace or workflow changed")
        body = storage.conversations.load(manifest.conversation, identity)
        restored = decode_checkpoint(body, identity)
        if restored["project_key"] != project_key_for_directory(str(expected_workspace)):
            raise ContinuationCheckpointError(
                "Continuation SDK project does not match the workspace"
            )
        with tempfile.TemporaryDirectory(prefix="abca-restore-") as directory:
            archive = Path(directory).resolve() / "workspace.tar"
            storage.download_workspace(manifest.workspace, identity, archive)
            restore_workspace(
                archive,
                expected_workspace,
                identity,
                expected_sha256=manifest.workspace.sha256,
                limits=WorkspaceLimits(max_bytes=storage.limits.max_workspace_bytes),
            )
        return cls(
            context,
            storage,
            store=CheckpointSessionStore.restore(body, identity),
            restored=restored,
        )

    def decision_prompt(self, *, decision: str, reason: str = "") -> str:
        """Supply the saved action as context; every newly proposed tool is gated."""
        import json

        if self.restored is None or decision not in {"APPROVED", "DENIED", "TIMED_OUT"}:
            raise ContinuationCheckpointError("A resolved continuation decision is required")
        action = self.restored["action"]
        return (
            "Continue the saved task from the restored workspace and conversation. "
            "The previous worker stopped while waiting for a human decision; its pending "
            "tool call was not executed. The recorded decision for that request is "
            + decision
            + ". Human feedback: "
            + json.dumps(reason)
            + ". Saved tool proposal: "
            + json.dumps({"tool_name": action["tool_name"], "tool_input": action["tool_input"]})
            + (
                ". If you perform this approved proposal, use exactly the saved tool name "
                "and every saved input field and value, including descriptions and timeouts. "
                "Do not paraphrase the description or add optional arguments: any input change "
                "is a new proposal and requires its own permission check"
                if decision == "APPROVED"
                else ""
            )
            + ". Decide how to continue using this context. A denial must not be worked around. "
            "Any new tool proposal still goes through the normal permission checks."
        )
