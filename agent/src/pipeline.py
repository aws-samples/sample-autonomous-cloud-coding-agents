"""Task pipeline: the main orchestrator that wires all modules together."""

from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import sys
import time

from pydantic import ValidationError

import memory as agent_memory
import task_state
from config import AGENT_WORKSPACE, build_config, get_config
from context import assemble_prompt, fetch_github_issue
from models import AgentResult, HydratedContext, RepoSetup, TaskConfig, TaskResult
from observability import task_span
from post_hooks import (
    _extract_agent_notes,
    ensure_committed,
    ensure_pr,
    verify_build,
    verify_lint,
)
from progress_writer import _ProgressWriter
from prompt_builder import build_system_prompt, discover_project_config
from runner import run_agent
from shell import log
from system_prompt import SYSTEM_PROMPT
from telemetry import (
    _TrajectoryWriter,
    format_bytes,
    get_disk_usage,
    print_metrics,
    upload_trace_to_s3,
)

_SDK_NO_RESULT_MESSAGE = (
    "Agent SDK stream ended without a ResultMessage (agent_status=unknown). "
    "Treat as failure: possible SDK bug, network interruption, or protocol mismatch."
)


def _chain_prior_agent_error(agent_result: AgentResult | None, exc: BaseException) -> str:
    """Preserve agent-layer failures when a later pipeline stage raises."""
    tail = f"{type(exc).__name__}: {exc}"
    if agent_result is None:
        return tail
    if agent_result.error:
        return f"{agent_result.error}; subsequent failure: {tail}"
    if agent_result.status == "error":
        return f"Agent reported status=error; subsequent failure: {tail}"
    return tail


def _maybe_upload_trace(
    config: TaskConfig,
    trajectory,
    progress,
) -> str | None:
    """Run the --trace S3 upload if the task opted in and user_id is set.

    Returns the resulting ``s3://`` URI (or ``None`` on any skip/fail).
    Fully fail-open: an exception here does NOT propagate. Called from
    both the happy path (post-hooks complete) and the crash path
    (top-level ``except``) so a crashing task still produces a
    debuggable artifact — which is exactly when ``--trace`` is most
    useful (K2 review Finding #1).

    Gates (K2 Stage 3 review Finding #1):
      - ``config.trace`` must be true.
      - ``config.user_id`` must be non-empty, else we would write to
        ``traces//<task_id>.jsonl.gz`` — an unreachable key that no
        Cognito caller can download through ``bgagent trace download``.
    """
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
            # Milestone write is best-effort; don't mask the upload.
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


def _resolve_overall_task_status(
    agent_result: AgentResult,
    *,
    build_ok: bool,
    pr_url: str | None,
) -> tuple[str, str | None]:
    """Map agent outcome + build gate to (overall_status, error_for_task_result)."""
    agent_status = agent_result.status
    err = agent_result.error

    if agent_status in ("success", "end_turn") and build_ok:
        return "success", err

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
        merged = f"{err}; {_SDK_NO_RESULT_MESSAGE}" if err else _SDK_NO_RESULT_MESSAGE
        return "error", merged

    if not err:
        err = f"Task did not succeed (agent_status={agent_status!r}, build_ok={build_ok})"
    return "error", err


def _compute_turns_completed(
    agent_status: str,
    turns_attempted: int | None,
    max_turns: int,
) -> int | None:
    """Clamp ``turns_completed`` to ``max_turns`` when the SDK hit the limit.

    Rev-5 DATA-1 — the Claude Agent SDK reports ``num_turns = max_turns + 1``
    on ``error_max_turns`` because the aborted attempt is counted.  Clamping
    at the final write keeps ``turns_completed`` truthful ("how many turns
    actually executed") while ``turns_attempted`` keeps the raw SDK value
    for debugging.

    Returns ``None`` if ``turns_attempted`` is ``None``/falsy so callers can
    round-trip a missing SDK count without inventing a fake zero.
    """
    if not turns_attempted:
        return turns_attempted
    if agent_status == "error_max_turns":
        return min(turns_attempted, max_turns)
    return turns_attempted


def _write_memory(
    config: TaskConfig,
    setup: RepoSetup,
    agent_result: AgentResult,
    start_time: float,
    build_passed: bool,
    pr_url: str | None,
    memory_id: str,
) -> bool:
    """Write task episode and repo learnings to AgentCore Memory.

    Returns True if any memory was successfully written.
    """
    # Parse self-feedback from PR body — separate try-catch so extraction
    # failures don't mask memory write errors (and vice versa).
    self_feedback = None
    try:
        self_feedback = _extract_agent_notes(setup.repo_dir, setup.branch, config)
    except Exception as e:
        log(
            "WARN",
            f"Agent notes extraction failed (non-fatal): {type(e).__name__}: {e}",
        )

    episode_cost = agent_result.cost_usd

    # Memory writes are individually fail-open (return False on error)
    episode_ok = agent_memory.write_task_episode(
        memory_id=memory_id,
        repo=config.repo_url,
        task_id=config.task_id,
        status="COMPLETED" if build_passed else "FAILED",
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


def run_task(
    repo_url: str,
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
    prompt_version: str = "",
    memory_id: str = "",
    task_type: str = "new_task",
    branch_name: str = "",
    pr_number: str = "",
    cedar_policies: list[str] | None = None,
    trace: bool = False,
    user_id: str = "",
) -> dict:
    """Run the full agent pipeline and return a serialized result dict.

    This is the main entry point for both:
      - AgentCore server mode (called by server.py /invocations)
      - Local batch mode (called by main())

    Builds a ``TaskResult`` Pydantic model internally, then returns
    ``TaskResult.model_dump()`` for downstream consumers (DynamoDB,
    metrics, server response).
    """
    from opentelemetry.trace import StatusCode

    from repo import setup_repo

    # Build config
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
        task_type=task_type,
        branch_name=branch_name,
        pr_number=pr_number,
        trace=trace,
        user_id=user_id,
    )

    # Inject Cedar policies into config for the PolicyEngine in runner.py
    if cedar_policies:
        config.cedar_policies = cedar_policies

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
        },
    ) as root_span:
        task_state.write_running(config.task_id)
        task_state.write_heartbeat(config.task_id)

        agent_result: AgentResult | None = None
        progress = _ProgressWriter(config.task_id, trace=trace)
        # --trace accumulator (design §10.1): when the task opted into
        # trace, ``_TrajectoryWriter`` keeps an in-memory copy of each
        # event so the pipeline can gzip+upload the full trajectory to
        # S3 on terminal. Owned by the pipeline rather than the runner
        # so the accumulator outlives ``run_agent``'s scope.
        trajectory = _TrajectoryWriter(config.task_id, accumulate=trace)
        # K2 review Finding #3 — surface accumulator truncation to the
        # user via a ``trace_truncated`` milestone on TaskEventsTable
        # (visible in ``bgagent watch``). Fire-once by design: the
        # downloaded artifact's header reports the final drop count.
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
        try:
            # Context hydration
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
                    # Local batch mode — fetch issue and assemble prompt in-container
                    if config.issue_number:
                        log("TASK", f"Fetching issue #{config.issue_number}...")
                        config.issue = fetch_github_issue(
                            config.repo_url, config.issue_number, config.github_token
                        )
                        log("TASK", f"  Title: {config.issue.title}")

                    prompt = assemble_prompt(config)

            # Configure git and gh auth before setup_repo() uses them
            subprocess.run(
                ["git", "config", "--global", "user.name", "bgagent"],
                check=True,
                capture_output=True,
                timeout=60,
            )
            subprocess.run(
                ["git", "config", "--global", "user.email", "bgagent@noreply.github.com"],
                check=True,
                capture_output=True,
                timeout=60,
            )
            os.environ["GITHUB_TOKEN"] = config.github_token
            os.environ["GH_TOKEN"] = config.github_token

            # Set env vars for the prepare-commit-msg hook BEFORE setup_repo()
            # so the hook has access to TASK_ID/PROMPT_VERSION from the start.
            os.environ["TASK_ID"] = config.task_id
            if prompt_version:
                os.environ["PROMPT_VERSION"] = prompt_version

            # Setup repo (deterministic pre-hooks)
            with task_span("task.repo_setup") as setup_span:
                setup = setup_repo(config)
                setup_span.set_attribute("build.before", setup.build_before)
            progress.write_agent_milestone(
                "repo_setup_complete",
                f"branch={setup.branch} build_before={setup.build_before}",
            )

            system_prompt = build_system_prompt(config, setup, hc, system_prompt_overrides)

            # Log discovered repo-level project configuration
            # (all files loaded by setting_sources=["project"])
            repo_dir = setup.repo_dir
            project_config = discover_project_config(repo_dir)
            if project_config:
                log("TASK", f"Repo project configuration: {project_config}")
            else:
                log("TASK", "No repo-level project configuration found")

            # Run agent
            disk_before = get_disk_usage(AGENT_WORKSPACE)
            start_time = time.time()

            log("TASK", "Starting agent...")
            if config.max_budget_usd:
                log("TASK", f"Budget limit: ${config.max_budget_usd:.2f}")
            # Warn if uvloop is the active policy — subprocess SIGCHLD conflicts.
            policy = asyncio.get_event_loop_policy()
            policy_name = type(policy).__name__
            if "uvloop" in policy_name.lower():
                log(
                    "WARN",
                    f"uvloop detected ({policy_name}) — this may cause subprocess "
                    f"SIGCHLD conflicts with the Claude Agent SDK",
                )
            with task_span("task.agent_execution") as agent_span:
                try:
                    agent_result = asyncio.run(
                        run_agent(
                            prompt,
                            system_prompt,
                            config,
                            cwd=setup.repo_dir,
                            trajectory=trajectory,
                        )
                    )
                except Exception as e:
                    log("ERROR", f"Agent failed: {e}")
                    agent_span.set_status(StatusCode.ERROR, str(e))
                    agent_span.record_exception(e)
                    agent_result = AgentResult(status="error", error=str(e))
            progress.write_agent_milestone(
                "agent_execution_complete",
                f"status={agent_result.status} turns={agent_result.turns}",
            )

            # Cancel short-circuit: the Stop hook signalled cancel by stopping
            # the SDK early, but that only stops the agent loop — post-hooks
            # (ensure_committed, ensure_pr) would still run and push/open a PR
            # on a cancelled task.  Re-check the task status here and exit the
            # pipeline before any side-effect-producing post-hook runs.  The
            # terminal state is already CANCELLED (written by cancel-task.ts),
            # so we do NOT call write_terminal — its ConditionExpression only
            # allows RUNNING/HYDRATING/FINALIZING, which would fail silently,
            # but leaving the cancel record intact makes the intent explicit.
            try:
                _current_record = task_state.get_task(config.task_id)
            except task_state.TaskFetchError:
                _current_record = None  # fail-open: let normal path proceed
            if _current_record and _current_record.get("status") == "CANCELLED":
                log("TASK", f"Task {config.task_id} cancelled; skipping post-hooks")
                progress.write_agent_milestone(
                    "task_cancelled_acknowledged",
                    "Post-hooks skipped; terminal state already CANCELLED.",
                )
                # K2 review Finding #2: we intentionally do NOT upload the
                # trace on the cancel path right now — the record is
                # already in terminal state CANCELLED and we have no
                # atomic hook to persist ``trace_s3_uri`` alongside it
                # (``write_terminal``'s ConditionExpression rejects
                # CANCELLED). A follow-up can add a conditional update
                # scoped to CANCELLED + trace_s3_uri. Until then, surface
                # the skip loudly so users running ``--trace`` against a
                # cancelled task know the trajectory was captured in
                # CloudWatch Logs but is not in S3.
                if config.trace:
                    log(
                        "WARN",
                        "Task was cancelled mid-run; --trace S3 upload is "
                        "skipped (terminal state already CANCELLED; see "
                        "CloudWatch Logs stream `trajectory/"
                        f"{config.task_id}` for captured events).",
                    )
                return {
                    "status": "cancelled",
                    "task_id": config.task_id,
                    "turns": agent_result.turns,
                    "turns_attempted": agent_result.num_turns or agent_result.turns,
                }

            # Post-hooks (agent_result is guaranteed set by the try/except above)
            with task_span("task.post_hooks") as post_span:
                # Safety net: commit any uncommitted tracked changes (skip for read-only tasks)
                if config.task_type == "pr_review":
                    safety_committed = False
                else:
                    safety_committed = ensure_committed(setup.repo_dir)
                post_span.set_attribute("safety_net.committed", safety_committed)

                build_passed = verify_build(setup.repo_dir)
                lint_passed = verify_lint(setup.repo_dir)
                pr_url = ensure_pr(
                    config, setup, build_passed, lint_passed, agent_result=agent_result
                )
                post_span.set_attribute("build.passed", build_passed)
                post_span.set_attribute("lint.passed", lint_passed)
                post_span.set_attribute("pr.url", pr_url or "")
            if pr_url:
                progress.write_agent_milestone("pr_created", pr_url)

            # Memory write — capture task episode and repo learnings
            memory_written = False
            effective_memory_id = memory_id or os.environ.get("MEMORY_ID", "")
            if effective_memory_id:
                memory_written = _write_memory(
                    config,
                    setup,
                    agent_result,
                    start_time,
                    build_passed,
                    pr_url,
                    effective_memory_id,
                )

            # Metrics
            duration = time.time() - start_time
            disk_after = get_disk_usage(AGENT_WORKSPACE)

            # Overall status: do not infer success from PR/build when the SDK never
            # emitted ResultMessage (agent_status=unknown) — that masks protocol gaps.
            # NOTE: lint_passed is intentionally NOT used for terminal status.
            agent_status = agent_result.status
            # Default True = assume build was green before, so a post-agent
            # failure IS counted as a regression (conservative).
            build_before = setup.build_before
            if config.task_type == "pr_review":
                build_ok = True  # Review task — build status is informational only
                if not build_passed:
                    log("INFO", "pr_review: build failed — informational only, not gating")
            else:
                build_ok = build_passed or not build_before
            if not build_passed and not build_before and config.task_type != "pr_review":
                log(
                    "WARN",
                    "Post-agent build failed, but build was already failing before "
                    "agent changes — not counting as regression",
                )
            overall_status, result_error = _resolve_overall_task_status(
                agent_result,
                build_ok=build_ok,
                pr_url=pr_url,
            )

            # --trace trajectory S3 upload (design §10.1). Runs AFTER
            # post-hooks but BEFORE ``write_terminal`` so the resulting
            # ``trace_s3_uri`` can be persisted atomically with the
            # terminal-status transition. Fail-open: an S3 error does
            # NOT flip the task to FAILED — the trajectory is a debug
            # artifact, not a correctness gate. The same helper is also
            # invoked from the crash path below so a pipeline exception
            # still produces a usable debug artifact.
            trace_s3_uri = _maybe_upload_trace(config, trajectory, progress)

            # Build TaskResult
            usage = agent_result.usage
            turns_attempted = agent_result.num_turns or agent_result.turns
            turns_completed = _compute_turns_completed(
                agent_status=agent_status,
                turns_attempted=turns_attempted,
                max_turns=config.max_turns,
            )
            result = TaskResult(
                status=overall_status,
                agent_status=agent_status,
                pr_url=pr_url,
                build_passed=build_passed,
                lint_passed=lint_passed,
                cost_usd=agent_result.cost_usd,
                # Legacy field (= turns_attempted) kept for back-compat.
                turns=turns_attempted,
                turns_attempted=turns_attempted,
                turns_completed=turns_completed,
                duration_s=round(duration, 1),
                task_id=config.task_id,
                disk_before=format_bytes(disk_before),
                disk_after=format_bytes(disk_after),
                disk_delta=format_bytes(disk_after - disk_before),
                prompt_version=prompt_version or None,
                memory_written=memory_written,
                error=result_error,
                session_id=agent_result.session_id or None,
                input_tokens=usage.input_tokens if usage else None,
                output_tokens=usage.output_tokens if usage else None,
                cache_read_input_tokens=usage.cache_read_input_tokens if usage else None,
                cache_creation_input_tokens=usage.cache_creation_input_tokens if usage else None,
                trace_s3_uri=trace_s3_uri,
            )

            result_dict = result.model_dump()

            # Record terminal attributes on the root span for CloudWatch querying
            root_span.set_attribute("task.status", result.status)
            if result.cost_usd is not None:
                root_span.set_attribute("agent.cost_usd", float(result.cost_usd))
            if result.turns:
                root_span.set_attribute("agent.turns", int(result.turns))
            root_span.set_attribute("build.passed", result.build_passed)
            root_span.set_attribute("lint.passed", result.lint_passed)
            root_span.set_attribute("pr.url", result.pr_url or "")
            root_span.set_attribute("task.duration_s", result.duration_s)
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

            # Emit metrics to CloudWatch Logs and print summary to stdout
            print_metrics(result_dict)

            # Persist terminal state to DynamoDB
            terminal_status = "COMPLETED" if overall_status == "success" else "FAILED"
            task_state.write_terminal(config.task_id, terminal_status, result_dict)

            return result_dict

        except Exception as e:
            # Ensure the task is marked FAILED in DynamoDB even if the pipeline
            # crashes before reaching the normal terminal-state write.
            #
            # K2 review Finding #1 — crash-path trace upload. The
            # trajectory accumulator is exactly the artifact the user
            # enabled ``--trace`` to capture the failure with; dropping
            # it on the crash path is a silent regression against the
            # design intent. Fully wrapped in its own try/except so a
            # trace upload failure cannot mask or replace the real
            # exception (we re-raise ``e`` at the end).
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
                agent_status=agent_for_chain.status if agent_for_chain else "unknown",
                trace_s3_uri=crash_trace_s3_uri,
            )
            task_state.write_terminal(config.task_id, "FAILED", crash_result.model_dump())
            raise


def main():
    config = get_config()

    print("Task configuration loaded.", flush=True)
    print("Dry run mode detected.", flush=True)
    print()

    if config.dry_run:
        # Context hydration for dry run
        if config.issue_number:
            config.issue = fetch_github_issue(
                config.repo_url, config.issue_number, config.github_token
            )
        prompt = assemble_prompt(config)
        system_prompt = SYSTEM_PROMPT.replace("{repo_url}", config.repo_url)
        system_prompt = system_prompt.replace("{task_id}", config.task_id)
        system_prompt = system_prompt.replace("{workspace}", AGENT_WORKSPACE)
        system_prompt = system_prompt.replace("{branch_name}", "bgagent/{task_id}/dry-run")
        system_prompt = system_prompt.replace("{default_branch}", "main")
        system_prompt = system_prompt.replace("{max_turns}", str(config.max_turns))
        system_prompt = system_prompt.replace("{setup_notes}", "(dry run — setup not executed)")
        system_prompt = system_prompt.replace("{memory_context}", "(dry run — memory not loaded)")
        overrides = config.system_prompt_overrides
        if overrides:
            system_prompt += f"\n\n## Additional instructions\n\n{overrides}"
        system_prompt_hash = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:12]
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        print("\n--- SYSTEM PROMPT (REDACTED) ---")
        print(
            f"length={len(system_prompt)} chars sha256={system_prompt_hash} "
            "(set DEBUG_DRY_RUN_PROMPTS=1 to print full text)",
            flush=True,
        )
        print("\n--- USER PROMPT (REDACTED) ---")
        print(
            f"length={len(prompt)} chars sha256={prompt_hash} "
            "(set DEBUG_DRY_RUN_PROMPTS=1 to print full text)",
            flush=True,
        )
        if os.environ.get("DEBUG_DRY_RUN_PROMPTS") == "1":
            print(
                "\nDEBUG_DRY_RUN_PROMPTS=1 is set, but full prompt printing is disabled "
                "for secure logging compliance.",
                flush=True,
            )
        print("\n--- DRY RUN COMPLETE ---")
        return

    # Run the full pipeline.  run_task() is sync and calls asyncio.run()
    # internally, so main() must NOT be async (nested asyncio.run() is illegal).
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

    # Exit with error if agent failed
    if result["status"] != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
