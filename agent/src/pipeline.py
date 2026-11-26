from __future__ import annotations

import hashlib
import inspect
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING

from pydantic import ValidationError

import memory as agent_memory
import task_state
from channel_mcp import configure_channel_mcp, strip_linear_mcp_servers
from config import (
    AGENT_WORKSPACE,
    DEFAULT_WORKFLOW_ID,
    NEEDS_INPUT_MARKER,
    REPO_LESS_DEFAULT_WORKFLOW_ID,
    build_config,
    clear_jira_task_credentials,
    get_config,
    resolve_jira_oauth_token,
    resolve_linear_api_token,
)
from context import assemble_prompt, fetch_github_issue
from jira_reactions import (
    comment_task_started,
    transition_pr_opened,
    transition_task_started,
)
from linear_reactions import react_task_finished, react_task_started
from models import AgentResult, HydratedContext, RepoSetup, TaskConfig, TaskResult
from observability import current_otel_trace_id, task_span
from post_hooks import (
    _extract_agent_notes,
    ensure_committed,
    ensure_pr,
    reconcile_agent_branch,
    verify_build,
    verify_lint,
)
from progress_writer import _ProgressWriter
from prompt_builder import build_system_prompt, discover_project_config
from shell import log, log_error_cw
from telemetry import (
    _TrajectoryWriter,
    format_bytes,
    get_disk_usage,
    print_metrics,
    upload_trace_to_s3,
)

if TYPE_CHECKING:
    from collections.abc import Generator

    from workflow import Workflow

_SDK_NO_RESULT_MESSAGE = (
    "Agent SDK stream ended without a ResultMessage (agent_status=unknown). "
    "Treat as failure: possible SDK bug, network interruption, or protocol mismatch."
)


def _chain_prior_agent_error(agent_result: AgentResult | None, exc: BaseException) -> str:
    tail = f"{type(exc).__name__}: {exc}"
    if agent_result is None:
        return tail
    if agent_result.error:
        return f"{agent_result.error}; subsequent failure: {tail}"
    if agent_result.status == "error":
        return f"Agent reported status=error; subsequent failure: {tail}"
    return tail


def _inject_attachment_context(prompt: str, prepared_attachments: list) -> str:
    lines = ["\n\n---\n\n**Attachments provided with this task:**\n"]
    for att in prepared_attachments:
        size_kb = att.size_bytes / 1024
        if att.type == "image":
            lines.append(
                f"- **Image:** `{att.filename}` ({size_kb:.1f} KB, {att.content_type}) "
                f"— View with: `Read {att.local_path}`"
            )
        else:
            lines.append(
                f"- **File:** `{att.filename}` ({size_kb:.1f} KB, {att.content_type}) "
                f"— Read with: `Read {att.local_path}`"
            )
    lines.append(
        "\nUse the Read tool to view these files. Image files will be displayed visually when read."
    )
    return prompt + "\n".join(lines)


def _download_task_attachments(config: TaskConfig, workspace: str, progress) -> list:
    if not config.attachments:
        return []
    from attachments import download_attachments

    try:
        with task_span("task.attachment_download"):
            prepared = download_attachments(config.attachments, workspace)
        progress.write_agent_milestone("attachments_downloaded", f"count={len(prepared)}")
    except RuntimeError as e:
        log("ERROR", f"Attachment integrity check failed: {e}")
        raise RuntimeError(
            f"Attachment download/verification failed: {e}. "
            "The task cannot proceed without valid attachments."
        ) from e
    except Exception as e:
        err_type = type(e).__name__
        log("ERROR", f"Attachment download failed: {err_type}: {e}")
        raise RuntimeError(f"Failed to download task attachments from S3: {err_type}: {e}") from e
    return prepared


def _maybe_upload_trace(
    config: TaskConfig,
    trajectory,
    progress,
) -> str | None:
    if not config.trace:
        return None
    if not config.user_id:
        log(
            "WARN",
            "Trace was enabled but user_id is empty — skipping S3 "
            "upload to avoid writing an unreachable artifact key. "
            f"task_id={config.task_id}",
        )
        return None
    try:
        artifact = trajectory.dump_gzipped_jsonl()
    except Exception as e:
        log("WARN", f"Trace dump_gzipped_jsonl failed: {type(e).__name__}: {e}")
        # nosemgrep: py-silent-success-masking -- trace upload best-effort; missing artifact ok
        return None
    if not artifact:
        log(
            "INFO",
            "Trace accumulator is empty (no trajectory events captured). Skipping S3 upload.",
        )
        return None
    trace_s3_uri = upload_trace_to_s3(
        task_id=config.task_id,
        user_id=config.user_id,
        body=artifact,
    )
    if trace_s3_uri:
        try:
            progress.write_agent_milestone("trajectory_uploaded", trace_s3_uri)
        except Exception as e:
            log("WARN", f"trajectory_uploaded milestone emit failed: {type(e).__name__}: {e}")
        log("TASK", f"Trace artifact uploaded: {trace_s3_uri}")
    else:
        log(
            "WARN",
            "Trace upload returned no URI — see [trace/upload] logs "
            "above for the reason (skipped or failed). Task proceeds "
            "to terminal without trace_s3_uri.",
        )
    return trace_s3_uri


def _task_is_cancelled(task_id: str) -> bool:
    try:
        record = task_state.get_task(task_id)
    except task_state.TaskFetchError:
        return False
    return bool(record and record.get("status") == "CANCELLED")


def _acknowledge_cancel(
    config: TaskConfig,
    agent_result: AgentResult,
    trajectory,
    progress,
    skipped: str,
) -> dict:
    log("TASK", f"Task {config.task_id} cancelled; skipping {skipped.lower()}")
    progress.write_agent_milestone(
        "task_cancelled_acknowledged",
        f"{skipped} skipped; terminal state already CANCELLED.",
    )
    if config.trace:
        log(
            "TASK",
            "Task cancelled mid-run; attempting best-effort "
            "--trace upload + conditional persist so the "
            "trajectory captured before cancel is still "
            "recoverable.",
        )
        try:
            trace_s3_uri = _maybe_upload_trace(config, trajectory, progress)
            if trace_s3_uri:
                task_state.write_trace_uri_conditional(config.task_id, trace_s3_uri)
        except Exception as e:
            log(
                "WARN",
                f"Cancel-path trace upload/persist failed (fail-open): {type(e).__name__}: {e}",
            )
    return {
        "status": "cancelled",
        "task_id": config.task_id,
        "turns": agent_result.turns,
        "turns_attempted": agent_result.num_turns or agent_result.turns,
    }


def _deliver_plan_artifact(
    workflow,
    config,
    hydrated,
    progress,
    trajectory,
    setup,
    prompt: str,
    agent_result,
) -> str | None:
    from workflow import StepContext
    from workflow.deliverers import deliver as deliver_artifact

    deliver_ctx = StepContext(
        workflow=workflow,
        config=config,
        hydrated=hydrated,
        progress=progress,
        trajectory=trajectory,
        setup=setup,
        system_prompt="",
        user_prompt=prompt,
    )
    deliver_ctx.agent_result = agent_result
    result = deliver_artifact("s3", deliver_ctx)
    artifact_uri = result.artifact_uri
    log("POST", f"artifact delivered: {artifact_uri}")
    if artifact_uri:
        progress.write_agent_milestone("artifact_delivered", artifact_uri)
    return artifact_uri


def _execute_agent_step(
    prompt: str,
    system_prompt: str,
    config,
    setup,
    hydrated,
    trajectory,
    progress,
):
    from workflow import StepContext, load_workflow, run_workflow

    workflow_id = (config.resolved_workflow or {}).get("id", DEFAULT_WORKFLOW_ID)
    wf = load_workflow(workflow_id)
    ctx = StepContext(
        workflow=wf,
        config=config,
        hydrated=hydrated,
        progress=progress,
        trajectory=trajectory,
        setup=setup,
        system_prompt=system_prompt,
        user_prompt=prompt,
    )
    result = run_workflow(wf, ctx, only_kinds={"run_agent"})

    if ctx.agent_result is None:
        detail = (
            result.failed_step.error
            if result.failed_step and result.failed_step.error
            else "run_agent step produced no result"
        )
        raise RuntimeError(f"Workflow run_agent step failed: {detail}")
    return ctx.agent_result


def _should_post_start_comment(channel_source: str | None, workflow_id: str) -> bool:
    return channel_source != "jira" or workflow_id != "coding/pr-iteration-v1"


def _react_linear_task_finished(
    config: TaskConfig,
    *,
    success: bool,
    started_reaction_id: str | None,
    transition_state: bool = False,
) -> None:
    """A Linear access token lasts 24 hours: the one cached at task start may
    have expired after a long run, so it is resolved again first."""
    if config.channel_source == "linear":
        try:
            resolve_linear_api_token(config.channel_metadata, force=True)
        except Exception as e:
            log("WARN", f"Linear token was not resolved again: {type(e).__name__}: {e}")
    react_task_finished(
        config.channel_source,
        config.channel_metadata,
        success=success,
        started_reaction_id=started_reaction_id,
        transition_state=transition_state,
    )


def _run_repoless_task(
    *,
    config,
    prompt: str,
    hc,
    progress,
    trajectory,
    root_span,
    start_time: float,
    memory_id: str,
    system_prompt_overrides: str,
) -> dict:
    from prompt_builder import build_repoless_system_prompt
    from workflow import StepContext, load_workflow, run_workflow

    workflow_id = (config.resolved_workflow or {}).get("id", REPO_LESS_DEFAULT_WORKFLOW_ID)
    wf = load_workflow(workflow_id)
    system_prompt = build_repoless_system_prompt(config, hc, system_prompt_overrides)

    prepared_attachments = _download_task_attachments(
        config, f"{AGENT_WORKSPACE}/{config.task_id}", progress
    )
    if prepared_attachments:
        prompt = _inject_attachment_context(prompt, prepared_attachments)

    ctx = StepContext(
        workflow=wf,
        config=config,
        hydrated=hc,
        progress=progress,
        trajectory=trajectory,
        setup=None,
        system_prompt=system_prompt,
        user_prompt=prompt,
    )
    delivery = {"deliver_artifact"}
    before_delivery = [s for s in wf.steps if s.kind not in delivery]
    with task_span("task.agent_execution"):
        wf_result = run_workflow(wf, ctx, only_kinds={s.kind for s in before_delivery})
        cancelled = _task_is_cancelled(config.task_id)
        skipped = any(
            outcome.failed and step.on_failure == "skip_remaining"
            for step, outcome in zip(before_delivery, wf_result.outcomes, strict=False)
        )
        if wf_result.succeeded and not skipped and not cancelled:
            wf_result = run_workflow(wf, ctx, only_kinds=delivery)

    agent_result = ctx.agent_result
    if agent_result is None:
        failed = wf_result.failed_step
        underlying = failed.error if failed and failed.error else None
        agent_result = AgentResult(
            status="error",
            error=(
                f"repo-less run_agent produced no result: {underlying}"
                if underlying
                else "repo-less run_agent produced no result"
            ),
        )
    progress.write_agent_milestone(
        "agent_execution_complete",
        f"status={agent_result.status} turns={agent_result.turns}",
    )

    if cancelled:
        return _acknowledge_cancel(config, agent_result, trajectory, progress, "Delivery")

    duration = time.time() - start_time
    overall_status, result_error = _resolve_overall_task_status(
        agent_result, build_ok=True, pr_url=None
    )

    artifact_uri = ctx.artifacts.get("artifact_uri")
    primary_outcome = wf.terminal_outcomes.primary
    if overall_status == "success" and not wf_result.succeeded:
        overall_status = "error"
        failed = wf_result.failed_step
        result_error = (
            f"Agent completed but delivery failed at step "
            f"{(failed.name if failed else 'deliver_artifact')!r}: "
            f"{(failed.error if failed and failed.error else 'unknown delivery error')}"
        )
        log("WARN", result_error)
    elif overall_status == "success" and primary_outcome == "artifact" and not artifact_uri:
        overall_status = "error"
        result_error = (
            "Agent completed and delivery reported success, but no artifact_uri "
            "was produced — the workflow's primary outcome is 'artifact', which "
            "requires a retrievable S3 key (WORKFLOWS.md success contract)."
        )
        log("WARN", result_error)

    trace_s3_uri = _maybe_upload_trace(config, trajectory, progress)

    memory_written = False
    effective_memory_id = memory_id or os.environ.get("MEMORY_ID", "")
    if effective_memory_id and config.user_id:
        memory_written = agent_memory.write_task_episode(
            memory_id=effective_memory_id,
            actor=f"user:{config.user_id}",
            task_id=config.task_id,
            status="COMPLETED" if overall_status == "success" else "FAILED",
            cost_usd=agent_result.cost_usd,
            duration_s=round(duration, 1),
        )

    result = TaskResult(
        status=overall_status,
        **_agent_result_fields(agent_result, config.max_turns),
        pr_url=None,
        artifact_uri=artifact_uri,
        duration_s=round(duration, 1),
        task_id=config.task_id,
        memory_written=memory_written,
        error=result_error,
        trace_s3_uri=trace_s3_uri,
        otel_trace_id=current_otel_trace_id(),
    )
    result_dict = result.model_dump()

    root_span.set_attribute("task.status", result.status)
    root_span.set_attribute("task.repo_less", True)
    if result.cost_usd is not None:
        root_span.set_attribute("agent.cost_usd", float(result.cost_usd))

    print_metrics(result_dict)
    terminal_status = "COMPLETED" if overall_status == "success" else "FAILED"
    task_state.write_terminal(config.task_id, terminal_status, result_dict)
    return result_dict


def _apply_post_hook_gates(
    workflow: Workflow | None,
    *,
    read_only: bool,
    build_passed: bool,
    lint_passed: bool,
    build_before: bool,
    lint_before: bool,
) -> bool:
    from workflow import gate_status

    steps = list(workflow.steps) if workflow is not None else []
    gates_ok = True
    for kind, passed, was_passing_before in (
        ("verify_build", build_passed, build_before),
        ("verify_lint", lint_passed, lint_before),
    ):
        step = next((s for s in steps if s.kind == kind), None)
        if step is None:
            if kind == "verify_lint":
                continue
            gate, gating, on_failure = None, True, "fail"
        else:
            gate, gating, on_failure = step.gate, step.on_failure == "fail", step.on_failure
        status = gate_status(
            passed=passed,
            gate=gate,
            read_only=read_only,
            was_passing_before=was_passing_before,
        )
        if passed:
            continue
        label = gate or "regression_only"
        if status == "succeeded":
            if read_only:
                log("INFO", f"read-only workflow: {kind} failed — informational only, not gating")
            elif gate == "informational":
                log("INFO", f"{kind} failed — gate=informational, not gating")
            else:
                log(
                    "WARN",
                    f"Post-agent {kind} failed, but it was already failing before "
                    "agent changes — not counting as regression",
                )
        elif gating:
            log("WARN", f"{kind} failed — gate={label} gates the task")
            gates_ok = False
        else:
            log("INFO", f"{kind} failed — gate={label} but on_failure={on_failure}, not gating")
    return gates_ok


def _step_milestone(workflow: Workflow | None, kind: str, phase: str, progress) -> None:
    step = next((s for s in workflow.steps if s.kind == kind), None) if workflow else None
    if step is not None:
        progress.write_agent_milestone(f"step:{step.name or step.kind}:{phase}")


def _starts_with_needs_input_marker(result_text: str | None) -> bool:
    return bool(result_text) and result_text.lstrip().startswith(NEEDS_INPUT_MARKER)


def _strip_needs_input_marker(result_text: str) -> str:
    text = result_text.strip()
    text = text.removeprefix(NEEDS_INPUT_MARKER)
    return text.strip()


def _resolve_overall_task_status(
    agent_result: AgentResult,
    *,
    build_ok: bool,
    pr_url: str | None,
    build_timed_out: bool = False,
    build_infra_failed: bool = False,
) -> tuple[str, str | None]:
    agent_status = agent_result.status
    err = agent_result.error

    if err and "error_max_turns" in err:
        from hooks import last_stuck_summary

        stuck = last_stuck_summary()
        if stuck and stuck not in err:
            err = f"{err} — {stuck}"

    if build_infra_failed and agent_status in ("success", "end_turn"):
        return "error", (f"Task did not succeed (agent_status={agent_status!r}, build_ok=infra)")

    if agent_status in ("success", "end_turn") and build_ok:
        return "success", err

    from hooks import last_blocker_reason

    blocker = last_blocker_reason()

    if agent_status == "unknown":
        if pr_url:
            log(
                "INFO",
                f"No ResultMessage from SDK (agent_status=unknown); pr_url present: {pr_url}",
            )
        if build_ok:
            log(
                "INFO",
                "No ResultMessage from SDK; build_ok=True (informational; task still failed)",
            )
        if blocker and not err:
            return "error", blocker
        merged = f"{err}; {_SDK_NO_RESULT_MESSAGE}" if err else _SDK_NO_RESULT_MESSAGE
        return "error", merged

    if not err:
        if blocker:
            return "error", blocker
        build_marker = "timeout" if build_timed_out else build_ok
        err = f"Task did not succeed (agent_status={agent_status!r}, build_ok={build_marker})"
    return "error", err


def _branch_has_new_commits(repo_dir: str, default_branch: str, branch: str) -> bool:
    # The output stays bytes: a git commit subject need not be UTF-8, and
    # decoding one that is not would raise.
    try:
        res = subprocess.run(
            ["git", "log", f"origin/{default_branch}..origin/{branch}", "--oneline"],
            cwd=repo_dir,
            check=False,
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return res.returncode == 0 and bool(res.stdout.strip())


def _head_sha(repo_dir: str) -> str:
    sha = ""
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_dir,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if res.returncode == 0:
            sha = res.stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        log("WARN", f"Could not read HEAD after the run ({type(exc).__name__}: {exc})")
    return sha


def _apply_delivery_gate(
    overall_status: str,
    result_error: str | None,
    *,
    workflow_read_only: bool,
    artifact_workflow: bool,
    needs_input: bool,
    ensure_pr_strategy: str,
    pr_url: str | None,
    commit_landed: bool,
) -> tuple[str, str | None]:
    delivery_expected = (
        not workflow_read_only
        and not artifact_workflow
        and not needs_input
        and ensure_pr_strategy == "create"
    )
    if not (overall_status == "success" and delivery_expected and not pr_url):
        return overall_status, result_error
    if commit_landed:
        reason = (
            "Task did not succeed (agent_status=success, deliverable=no_pr): a "
            "commit reached the branch but no PR was opened — the change is on the "
            "branch but was not delivered."
        )
    else:
        reason = (
            "Task did not succeed (agent_status=success, deliverable=lost): the "
            "coding task reported success but no commit reached the branch and no "
            "PR was opened — either the agent made no change, or its changes did "
            "not land in the task's repository."
        )
    log("WARN", f"Delivery gate: {reason}")
    return "error", reason


def _compute_turns_completed(
    turns: int | None,
    max_turns: int,
) -> int | None:
    """A ``max_turns`` of 0 is no cap: the SDK hands the CLI a turn limit only
    for a truthy value."""
    if not turns or max_turns <= 0:
        return turns
    # The CLI can ask the model again without counting a turn (in CLI 2.1.319, after an
    # answer that was refused, cut off or empty), so `turns` can pass the cap.
    return min(turns, max_turns)


def _agent_result_fields(agent_result: AgentResult | None, max_turns: int) -> dict:
    if agent_result is None:
        return {}
    usage = agent_result.usage
    turns_attempted = agent_result.num_turns or agent_result.turns
    return {
        "agent_status": agent_result.status,
        "cost_usd": agent_result.cost_usd,
        "turns": turns_attempted,
        "turns_attempted": turns_attempted,
        "turns_completed": _compute_turns_completed(
            agent_result.turns or turns_attempted, max_turns
        ),
        "session_id": agent_result.session_id or None,
        "input_tokens": usage.input_tokens if usage else None,
        "output_tokens": usage.output_tokens if usage else None,
        "cache_read_input_tokens": usage.cache_read_input_tokens if usage else None,
        "cache_creation_input_tokens": usage.cache_creation_input_tokens if usage else None,
    }


def _write_memory(
    config: TaskConfig,
    setup: RepoSetup,
    agent_result: AgentResult,
    start_time: float,
    succeeded: bool,
    pr_url: str | None,
    memory_id: str,
) -> bool:
    self_feedback = None
    try:
        self_feedback = _extract_agent_notes(setup.repo_dir, setup.branch, config)
    except Exception as e:
        log(
            "WARN",
            f"Agent notes extraction failed (non-fatal): {type(e).__name__}: {e}",
        )

    episode_cost = agent_result.cost_usd

    episode_ok = agent_memory.write_task_episode(
        memory_id=memory_id,
        actor=config.repo_url,
        task_id=config.task_id,
        status="COMPLETED" if succeeded else "FAILED",
        pr_url=pr_url,
        cost_usd=episode_cost,
        duration_s=round(time.time() - start_time, 1),
        self_feedback=self_feedback,
    )

    learnings_ok = False
    if self_feedback:
        learnings_ok = agent_memory.write_repo_learnings(
            memory_id=memory_id,
            repo=config.repo_url,
            task_id=config.task_id,
            learnings=self_feedback,
        )

    log("MEMORY", f"Memory write: episode={episode_ok}, learnings={learnings_ok}")
    return episode_ok or learnings_ok


@contextmanager
def _task_environ_restored() -> Generator[None]:
    before = dict(os.environ)
    try:
        yield
    finally:
        for name in os.environ.keys() - before.keys():
            os.environ.pop(name, None)
        os.environ.update(before)


@_task_environ_restored()
def run_task(  # noqa: C901 -- 53 when the ceiling of 15 was set; must not grow
    repo_url: str = "",
    task_description: str = "",
    issue_number: str = "",
    github_token: str = "",
    anthropic_model: str = "",
    max_turns: int = 100,
    max_budget_usd: float | None = None,
    aws_region: str = "",
    task_id: str = "",
    hydrated_context: dict | None = None,
    system_prompt_overrides: str = "",
    build_command: str = "",
    lint_command: str = "",
    prompt_version: str = "",
    memory_id: str = "",
    resolved_workflow: dict | None = None,
    branch_name: str = "",
    pr_number: str = "",
    base_branch: str | None = None,
    merge_branches: list[str] | None = None,
    cedar_policies: list[str] | None = None,
    approval_timeout_s: int | None = None,
    initial_approvals: list[str] | None = None,
    initial_approval_gate_count: int = 0,
    approval_gate_cap: int | None = None,
    channel_source: str = "",
    channel_metadata: dict[str, str] | None = None,
    trace: bool = False,
    user_id: str = "",
    attachments: list[dict] | None = None,
    resolved_assets: list[dict] | None = None,
) -> dict:
    """Run the full agent pipeline and return ``TaskResult.model_dump()``."""
    from opentelemetry.trace import StatusCode

    from aws_session import configure_session, is_scoped
    from repo import setup_repo

    clear_jira_task_credentials()

    configure_session(user_id=user_id, repo=repo_url, task_id=task_id)

    config = build_config(
        repo_url=repo_url,
        task_description=task_description,
        issue_number=issue_number,
        github_token=github_token,
        anthropic_model=anthropic_model,
        max_turns=max_turns,
        max_budget_usd=max_budget_usd,
        aws_region=aws_region,
        task_id=task_id,
        system_prompt_overrides=system_prompt_overrides,
        build_command=build_command,
        lint_command=lint_command,
        resolved_workflow=resolved_workflow,
        branch_name=branch_name,
        pr_number=pr_number,
        base_branch=base_branch,
        merge_branches=merge_branches,
        channel_source=channel_source,
        channel_metadata=channel_metadata,
        trace=trace,
        user_id=user_id,
        approval_timeout_s=approval_timeout_s,
        initial_approvals=initial_approvals,
        initial_approval_gate_count=initial_approval_gate_count,
        approval_gate_cap=approval_gate_cap,
        attachments=attachments,
    )

    if cedar_policies:
        config.cedar_policies = cedar_policies

    if resolved_assets:
        config.resolved_assets = resolved_assets

    configure_session(
        user_id=config.user_id,
        repo=config.repo_url,
        task_id=config.task_id,
    )
    log("TASK", f"Tenant-data credential scoping: {'SCOPED' if is_scoped() else 'UNSCOPED'}")

    log("TASK", f"Task ID: {config.task_id}")
    log("TASK", f"Repository: {config.repo_url}")
    log("TASK", f"Issue: {config.issue_number or '(none)'}")
    log("TASK", f"Model: {config.anthropic_model}")

    with task_span(
        "task.pipeline",
        attributes={
            "task.id": config.task_id,
            "repo.url": config.repo_url,
            "issue.number": config.issue_number,
            "agent.model": config.anthropic_model,
            **({"user.id": config.user_id} if config.user_id else {}),
        },
    ) as root_span:
        task_state.write_running(config.task_id)
        task_state.write_heartbeat(config.task_id)

        agent_result: AgentResult | None = None
        progress = _ProgressWriter(
            config.task_id, trace=trace, user_id=config.user_id, repo=config.repo_url
        )
        from hooks import reset_blocker_reason, reset_stuck_summary

        reset_blocker_reason()
        reset_stuck_summary()
        trajectory = _TrajectoryWriter(config.task_id, accumulate=trace)
        if trace:

            def _on_trace_truncated(max_bytes: int, first_dropped: int) -> None:
                progress.write_agent_milestone(
                    "trace_truncated",
                    f"Trace accumulator hit its {max_bytes}-byte cap after "
                    f"{first_dropped} event drop(s); the downloaded "
                    f"artifact will be truncated. See the "
                    f"TRAJECTORY_ARTIFACT_HEADER row for the final "
                    f"drop count.",
                )

            trajectory.set_truncation_callback(_on_trace_truncated)
        linear_eyes_reaction_id: str | None = None
        start_time = time.time()
        try:
            with task_span("task.context_hydration"):
                if hydrated_context:
                    log("TASK", "Using hydrated context from orchestrator")
                    try:
                        hc = HydratedContext.model_validate(hydrated_context)
                    except ValidationError as err:
                        parts = [
                            f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}"
                            for e in err.errors()
                        ]
                        log(
                            "ERROR",
                            "HydratedContext validation failed (orchestrator vs agent contract): "
                            + "; ".join(parts),
                        )
                        raise
                    prompt = hc.user_prompt
                    if hc.issue:
                        config.issue = hc.issue
                    if hc.resolved_branch_name:
                        config.branch_name = hc.resolved_branch_name
                    if hc.resolved_base_branch:
                        config.base_branch = hc.resolved_base_branch
                    if hc.truncated:
                        log("WARN", "Context was truncated by orchestrator token budget")
                    if hc.fallback_error:
                        log("WARN", f"Orchestrator context fallback: {hc.fallback_error}")
                    if hc.guardrail_blocked:
                        log(
                            "WARN",
                            f"Orchestrator guardrail blocked content: {hc.guardrail_blocked}",
                        )
                else:
                    hc = None
                    if config.issue_number:
                        log("TASK", f"Fetching issue #{config.issue_number}...")
                        config.issue = fetch_github_issue(
                            config.repo_url, config.issue_number, config.github_token
                        )
                        log("TASK", f"  Title: {config.issue.title}")

                    prompt = assemble_prompt(config)

            if not config.requires_repo and not config.repo_url:
                return _run_repoless_task(
                    config=config,
                    prompt=prompt,
                    hc=hc,
                    progress=progress,
                    trajectory=trajectory,
                    root_span=root_span,
                    start_time=time.time(),
                    memory_id=memory_id,
                    system_prompt_overrides=system_prompt_overrides,
                )

            # Not `git config --global`: it would overwrite the real ~/.gitconfig
            # when this pipeline runs on a developer workstation (#622).
            os.environ["GIT_AUTHOR_NAME"] = "bgagent"
            os.environ["GIT_AUTHOR_EMAIL"] = "bgagent@noreply.github.com"
            os.environ["GIT_COMMITTER_NAME"] = "bgagent"
            os.environ["GIT_COMMITTER_EMAIL"] = "bgagent@noreply.github.com"
            os.environ["GITHUB_TOKEN"] = config.github_token
            os.environ["GH_TOKEN"] = config.github_token

            os.environ["TASK_ID"] = config.task_id
            if prompt_version:
                os.environ["PROMPT_VERSION"] = prompt_version

            if config.channel_source == "linear":
                resolve_linear_api_token(config.channel_metadata)
            elif config.channel_source == "jira":
                resolve_jira_oauth_token(config.channel_metadata)

            linear_transition_state = not config.read_only
            linear_eyes_reaction_id = react_task_started(
                config.channel_source,
                config.channel_metadata,
                transition_state=linear_transition_state,
            )

            workflow_id = (config.resolved_workflow or {}).get("id", DEFAULT_WORKFLOW_ID)
            if _should_post_start_comment(config.channel_source, workflow_id):
                comment_task_started(
                    config.channel_source,
                    config.channel_metadata,
                )

            transition_task_started(
                config.channel_source,
                config.channel_metadata,
            )

            with task_span("task.repo_setup") as setup_span:
                setup = setup_repo(config, progress=progress)
                setup_span.set_attribute("build.before", setup.build_before)
            progress.write_agent_milestone(
                "repo_setup_complete",
                f"branch={setup.branch} build_before={setup.build_before}",
            )

            system_prompt = build_system_prompt(config, setup, hc, system_prompt_overrides)

            configure_channel_mcp(setup.repo_dir, config.channel_source)
            strip_linear_mcp_servers(setup.repo_dir)

            if config.resolved_assets:
                from registry.loader import RegistryAssetLoadError, apply_resolved_assets

                loaded_mcp_keys = apply_resolved_assets(setup.repo_dir, config.resolved_assets)
                log("TASK", f"Registry: applied {len(loaded_mcp_keys)} mcp_server asset(s)")
                removed = strip_linear_mcp_servers(setup.repo_dir)
                if removed:
                    raise RegistryAssetLoadError(
                        f"the Linear MCP scrub removed {removed} of the pinned mcp_server "
                        "assets: it drops every server whose key or config contains 'linear' "
                        "(ADR-016: the agent must have no Linear tools). Remove the pin, or "
                        "publish the server without that word in its name and config. "
                        f"Pinned: {', '.join(loaded_mcp_keys)}"
                    )

            prepared_attachments = _download_task_attachments(config, setup.repo_dir, progress)

            repo_dir = setup.repo_dir
            project_config = discover_project_config(repo_dir)
            if project_config:
                log("TASK", f"Repo project configuration: {project_config}")
            else:
                log("TASK", "No repo-level project configuration found")

            if prepared_attachments:
                prompt = _inject_attachment_context(prompt, prepared_attachments)

            disk_before = get_disk_usage(AGENT_WORKSPACE)
            start_time = time.time()

            log("TASK", "Starting agent...")
            if config.max_budget_usd:
                log("TASK", f"Budget limit: ${config.max_budget_usd:.2f}")
            with task_span("task.agent_execution") as agent_span:
                try:
                    agent_result = _execute_agent_step(
                        prompt,
                        system_prompt,
                        config,
                        setup,
                        hc,
                        trajectory,
                        progress,
                    )
                except Exception as e:
                    log_error_cw(f"Agent failed: {e}", task_id=config.task_id or None)
                    agent_span.set_status(StatusCode.ERROR, str(e))
                    agent_span.record_exception(e)
                    agent_result = AgentResult(status="error", error=str(e))
            progress.write_agent_milestone(
                "agent_execution_complete",
                f"status={agent_result.status} turns={agent_result.turns}",
            )

            if _task_is_cancelled(config.task_id):
                cancelled = _acknowledge_cancel(
                    config, agent_result, trajectory, progress, "Post-hooks"
                )
                _react_linear_task_finished(
                    config, success=False, started_reaction_id=linear_eyes_reaction_id
                )
                return cancelled

            from workflow import WorkflowValidationError, load_workflow

            workflow_read_only = config.read_only
            _workflow = None
            try:
                _workflow = load_workflow(
                    (config.resolved_workflow or {}).get("id", DEFAULT_WORKFLOW_ID)
                )
                ensure_pr_strategy = _workflow.ensure_pr_strategy
            except WorkflowValidationError as exc:
                log(
                    "WARN",
                    f"post-hook workflow reload failed ({exc}); defaulting ensure_pr "
                    "strategy to 'create' so the agent's work is not stranded",
                )
                ensure_pr_strategy = "create"

            artifact_workflow = bool(_workflow and _workflow.delivers_repo_artifact)
            artifact_uri: str | None = None

            clarification_q = agent_result.clarification_question or ""
            needs_input = bool(
                not artifact_workflow
                and not config.is_pr_workflow
                and (clarification_q or _starts_with_needs_input_marker(agent_result.result_text))
            )

            with task_span("task.post_hooks") as post_span:
                if needs_input:
                    build_passed = True
                    lint_passed = True
                    build_timed_out = False
                    build_inert = False
                    build_infra_failed = False
                    safety_committed = False
                    pr_url = None
                    log("POST", "Clarify-before-spend: agent asked for input — holding (no PR)")
                elif artifact_workflow:
                    build_passed = True
                    lint_passed = True
                    build_timed_out = False
                    build_inert = False
                    build_infra_failed = False
                    safety_committed = False
                    pr_url = None
                    artifact_uri = _deliver_plan_artifact(
                        _workflow, config, hc, progress, trajectory, setup, prompt, agent_result
                    )
                    post_span.set_attribute("artifact.uri", artifact_uri or "")
                else:
                    if not workflow_read_only:
                        reconcile_agent_branch(setup.repo_dir, setup.branch)
                    safety_committed = (
                        False if workflow_read_only else ensure_committed(setup.repo_dir)
                    )
                    post_span.set_attribute("safety_net.committed", safety_committed)

                    _step_milestone(_workflow, "verify_build", "start", progress)
                    build_outcome = verify_build(setup.repo_dir, config.build_command)
                    build_passed = build_outcome.passed
                    build_timed_out = build_outcome.timed_out
                    build_infra_failed = build_outcome.infra_failed
                    build_inert = build_outcome.inert
                    if build_inert:
                        log(
                            "POST",
                            "Post-agent build gate is INERT (command couldn't run) "
                            "— not gating on it; surfacing as inert, not a failure",
                        )
                        build_passed = True
                    else:
                        _step_milestone(
                            _workflow,
                            "verify_build",
                            "succeeded" if build_passed else "failed",
                            progress,
                        )
                    if getattr(setup, "lint_gate_inert", False):
                        log(
                            "POST",
                            "Skipping post-agent lint verification "
                            "(lint gating is INERT for this repo)",
                        )
                        lint_passed = True
                    else:
                        lint_passed = verify_lint(setup.repo_dir, config.lint_command).passed
                    _step_milestone(_workflow, "ensure_pr", "start", progress)
                    pr_url = ensure_pr(
                        config,
                        setup,
                        None if build_inert else build_passed,
                        lint_passed,
                        agent_result=agent_result,
                        strategy=ensure_pr_strategy,
                    )
                    post_span.set_attribute("build.passed", build_passed)
                    post_span.set_attribute("lint.passed", lint_passed)
                    post_span.set_attribute("pr.url", pr_url or "")
            if pr_url:
                progress.write_agent_milestone("pr_created", pr_url)
                if build_passed:
                    transition_pr_opened(
                        config.channel_source,
                        config.channel_metadata,
                    )
                else:
                    log(
                        "TASK",
                        "Jira card NOT moved to In Review — PR opened with a FAILED build "
                        "(build_ok=False); leaving it In Progress with the failure comment (#9a).",
                    )

            build_ok = _apply_post_hook_gates(
                _workflow,
                read_only=workflow_read_only,
                build_passed=build_passed,
                lint_passed=lint_passed,
                build_before=setup.build_before,
                lint_before=setup.lint_before,
            )
            overall_status, result_error = _resolve_overall_task_status(
                agent_result,
                build_ok=build_ok,
                pr_url=pr_url,
                build_timed_out=build_timed_out,
                build_infra_failed=build_infra_failed and not workflow_read_only,
            )
            commit_landed = not pr_url and _branch_has_new_commits(
                setup.repo_dir, setup.default_branch, setup.branch
            )
            overall_status, result_error = _apply_delivery_gate(
                overall_status,
                result_error,
                workflow_read_only=workflow_read_only,
                artifact_workflow=artifact_workflow,
                needs_input=needs_input,
                ensure_pr_strategy=ensure_pr_strategy,
                pr_url=pr_url,
                commit_landed=commit_landed,
            )
            if needs_input:
                overall_status = "success"
                result_error = None

            memory_written = False
            effective_memory_id = memory_id or os.environ.get("MEMORY_ID", "")
            if effective_memory_id:
                memory_written = _write_memory(
                    config,
                    setup,
                    agent_result,
                    start_time,
                    overall_status == "success",
                    pr_url,
                    effective_memory_id,
                )

            duration = time.time() - start_time
            disk_after = get_disk_usage(AGENT_WORKSPACE)

            _react_linear_task_finished(
                config,
                success=(overall_status == "success"),
                started_reaction_id=linear_eyes_reaction_id,
                transition_state=linear_transition_state and bool(pr_url),
            )

            # No Jira terminal comment here: the fan-out plane's
            # ``dispatchToJira`` posts it (#573).

            trace_s3_uri = _maybe_upload_trace(config, trajectory, progress)

            code_changed: bool | None = None
            head_sha_after = ""
            if config.is_pr_workflow and setup.head_sha_before:
                head_sha_after = _head_sha(setup.repo_dir)
                if head_sha_after:
                    code_changed = head_sha_after != setup.head_sha_before
            answer_text = (agent_result.result_text or "").strip()
            if needs_input:
                code_changed = False
                answer_text = clarification_q.strip() or _strip_needs_input_marker(answer_text)

            result = TaskResult(
                status=overall_status,
                **_agent_result_fields(agent_result, config.max_turns),
                pr_url=pr_url,
                build_passed=None if build_inert else build_passed,
                lint_passed=lint_passed,
                duration_s=round(duration, 1),
                task_id=config.task_id,
                disk_before=format_bytes(disk_before),
                disk_after=format_bytes(disk_after),
                disk_delta=format_bytes(disk_after - disk_before),
                prompt_version=prompt_version or None,
                memory_written=memory_written,
                error=result_error,
                trace_s3_uri=trace_s3_uri,
                artifact_uri=artifact_uri,
                code_changed=code_changed,
                answer_text=answer_text if code_changed is False else "",
                head_sha=head_sha_after,
                otel_trace_id=current_otel_trace_id(),
            )

            result_dict = result.model_dump()

            root_span.set_attribute("task.status", result.status)
            if result.cost_usd is not None:
                root_span.set_attribute("agent.cost_usd", float(result.cost_usd))
            if result.turns:
                root_span.set_attribute("agent.turns", int(result.turns))
            root_span.set_attribute("build.passed", bool(result.build_passed))
            root_span.set_attribute("lint.passed", bool(result.lint_passed))
            root_span.set_attribute("pr.url", result.pr_url or "")
            root_span.set_attribute("task.duration_s", result.duration_s)
            usage = agent_result.usage
            if usage:
                root_span.set_attribute("agent.input_tokens", usage.input_tokens)
                root_span.set_attribute("agent.output_tokens", usage.output_tokens)
                root_span.set_attribute(
                    "agent.cache_read_input_tokens",
                    usage.cache_read_input_tokens,
                )
                root_span.set_attribute(
                    "agent.cache_creation_input_tokens",
                    usage.cache_creation_input_tokens,
                )
            if result.status != "success":
                root_span.set_status(StatusCode.ERROR, str(result.error or "task did not succeed"))

            print_metrics(result_dict)

            terminal_status = "COMPLETED" if overall_status == "success" else "FAILED"
            task_state.write_terminal(config.task_id, terminal_status, result_dict)

            return result_dict

        except Exception as e:
            crash_trace_s3_uri: str | None = None
            try:
                crash_trace_s3_uri = _maybe_upload_trace(config, trajectory, progress)
            except Exception as upload_exc:
                log(
                    "WARN",
                    f"Crash-path trace upload failed: {type(upload_exc).__name__}: {upload_exc}",
                )

            agent_for_chain = agent_result
            combined = _chain_prior_agent_error(agent_for_chain, e)
            crash_result = TaskResult(
                status="error",
                error=combined,
                task_id=config.task_id,
                **_agent_result_fields(agent_for_chain, config.max_turns),
                duration_s=round(time.time() - start_time, 1),
                trace_s3_uri=crash_trace_s3_uri,
                otel_trace_id=current_otel_trace_id(),
            )
            crash_dict = crash_result.model_dump()
            task_state.write_terminal(config.task_id, "FAILED", crash_dict)
            _react_linear_task_finished(
                config, success=False, started_reaction_id=linear_eyes_reaction_id
            )
            # No Jira failure comment here: the fan-out plane's
            # ``dispatchToJira`` posts it (#573).
            print_metrics(crash_dict)
            raise


_PAYLOAD_KEY_ALIASES = {
    "prompt": "task_description",
    "model_id": "anthropic_model",
}

_PAYLOAD_STR_KEYS = frozenset({"issue_number", "pr_number"})

_RUN_TASK_PARAMS = frozenset(inspect.signature(run_task).parameters)

_KNOWN_ORCHESTRATOR_KEYS = frozenset(
    {
        "task_started_at",
    }
)


def run_task_from_payload(payload: dict) -> dict:
    """Invoke :func:`run_task` from a full orchestrator payload dict.

    Renames the aliased keys, ignores keys that are not ``run_task``
    parameters and keys whose value is ``None``, and coerces the str/int
    fields the orchestrator may emit as numbers; a ``max_turns`` that is not
    an integer is ignored. ``aws_region`` falls back to the ``AWS_REGION``
    env var when the payload omits it.
    """
    kwargs: dict = {}
    for key, value in (payload or {}).items():
        target = _PAYLOAD_KEY_ALIASES.get(key, key)
        if target not in _RUN_TASK_PARAMS:
            if key in _KNOWN_ORCHESTRATOR_KEYS and value is not None:
                log(
                    "WARN",
                    f"run_task_from_payload: dropping known orchestrator key '{key}' "
                    f"(not a run_task parameter) — consumed elsewhere or not yet wired",
                )
            continue
        if value is None:
            continue
        if target in _PAYLOAD_STR_KEYS:
            value = str(value)
        elif target == "max_turns":
            if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                log("WARN", f"run_task_from_payload: ignoring non-integer max_turns {value!r}")
                continue
            try:
                coerced = int(value)
            except (TypeError, ValueError):
                log("WARN", f"run_task_from_payload: ignoring non-integer max_turns {value!r}")
                continue
            if isinstance(value, float) and coerced != value:
                log("WARN", f"run_task_from_payload: ignoring non-integral max_turns {value!r}")
                continue
            value = coerced
        kwargs[target] = value

    kwargs.setdefault("aws_region", os.environ.get("AWS_REGION", ""))
    return run_task(**kwargs)


def main():
    config = get_config()

    print("Task configuration loaded.", flush=True)
    print()

    if config.dry_run:
        print("Dry run mode detected.", flush=True)
        if config.issue_number:
            config.issue = fetch_github_issue(
                config.repo_url, config.issue_number, config.github_token
            )
        prompt = assemble_prompt(config)
        dry_setup = RepoSetup(
            repo_dir=f"{AGENT_WORKSPACE}/{config.task_id}",
            branch=f"bgagent/{config.task_id}/dry-run",
            default_branch="main",
            notes=["(dry run — setup not executed)"],
        )
        system_prompt = build_system_prompt(config, dry_setup, None, config.system_prompt_overrides)
        system_prompt_hash = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:12]
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        print("\n--- SYSTEM PROMPT (REDACTED) ---")
        print(f"length={len(system_prompt)} chars sha256={system_prompt_hash}", flush=True)
        print("\n--- USER PROMPT (REDACTED) ---")
        print(f"length={len(prompt)} chars sha256={prompt_hash}", flush=True)
        print("\n--- DRY RUN COMPLETE ---")
        return

    result = run_task(
        repo_url=config.repo_url,
        task_description=config.task_description,
        issue_number=config.issue_number,
        github_token=config.github_token,
        anthropic_model=config.anthropic_model,
        max_turns=config.max_turns,
        max_budget_usd=config.max_budget_usd,
        aws_region=config.aws_region,
        system_prompt_overrides=config.system_prompt_overrides,
        trace=config.trace,
        user_id=config.user_id,
    )

    if result["status"] != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
