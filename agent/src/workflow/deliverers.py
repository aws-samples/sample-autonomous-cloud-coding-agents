"""Registry of ``deliver_artifact`` deliverers (#248, ADR-014 addendum 2026-06-08).

A workflow's ``deliver_artifact`` step names a *deliverer* in its ``target``
field; that name resolves here. This mirrors the step-handler registry pattern
(``STEP_HANDLERS`` in ``runner.py``): a new delivery method is a registered
deliverer, **not** a schema change — ``target`` is an open string, and the
closed set of valid names lives in ``DELIVERERS`` rather than a JSON-Schema enum.

Each deliverer declares the terminal outcomes it ``produces`` so the cross-field
validator (rule 11) can check a workflow's declared ``terminal_outcomes.primary``
is actually produced by some step — the single source of truth for the old
``_DELIVER_TARGET_OUTCOMES`` map, now registry-driven.

The shared *plumbing* contract every deliverer builds on is frozen in the
ADR-014 addendum: artifacts upload to a task-scoped key ``artifacts/{task_id}/``
in the platform artifacts bucket (``ARTIFACTS_BUCKET_NAME``), the agent
SessionRole carries a prefix-scoped IAM grant, a per-artifact size limit
applies, and the delivered URL surfaces on ``TaskDetail`` (``artifact_uri``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from shell import log

if TYPE_CHECKING:
    from .runner import StepContext

# Per-artifact size cap. A repo-less knowledge task's deliverable is text (the
# agent's final message); 5 MiB is generous for that and bounds a runaway upload.
MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
ARTIFACT_KEY_PREFIX = "artifacts"


@dataclass(frozen=True)
class DeliveryResult:
    """What a deliverer produced: an artifact S3 URI and/or a posted comment."""

    artifact_uri: str | None = None
    comment_posted: bool = False


@dataclass(frozen=True)
class Deliverer:
    """A named ``deliver_artifact`` target and the terminal outcomes it yields.

    ``produces`` is the set of ``terminal_outcomes`` values this deliverer can
    satisfy (e.g. an S3 upload produces ``artifact``; a comment post produces
    ``comment``). Used by validator rule 11 and by the runtime ``deliver``
    dispatcher.
    """

    name: str
    produces: frozenset[str] = field(default_factory=frozenset)


# First-party deliverers. The three names preserve the exact produced-outcome
# sets of the pre-addendum ``_DELIVER_TARGET_OUTCOMES`` enum, so no existing
# workflow / fixture / golden vector changes behavior — the closed enum is
# widened to an open string + this registry, not redefined.
DELIVERERS: dict[str, Deliverer] = {
    "s3": Deliverer("s3", frozenset({"artifact"})),
    "comment": Deliverer("comment", frozenset({"comment"})),
    "s3_and_comment": Deliverer("s3_and_comment", frozenset({"artifact", "comment"})),
}

# The target a ``deliver_artifact`` step uses when it omits ``target``. This is
# the SINGLE source of truth for that default — both the runtime (runner.py's
# ``_handle_deliver_artifact``) and the validator (``produced_outcomes(None)``)
# key off it, so the two can never disagree about what an unset target delivers
# (PR review #296 finding #7).
DEFAULT_DELIVER_TARGET = "s3"


def _artifact_body(ctx: StepContext) -> bytes:
    """The deliverable bytes: the agent's final result text (#248 Phase 3)."""
    text = ctx.agent_result.result_text if ctx.agent_result else ""
    if not text:
        raise ValueError("deliver_artifact: agent produced no result text to deliver")
    # Bound memory BEFORE encoding. UTF-8 uses ≥1 byte per character, so a string
    # whose character count already exceeds the byte cap cannot possibly fit —
    # reject it without materializing a second full copy as bytes. This is what
    # makes the cap actually cap memory on the constrained MicroVM: previously the
    # bytes were encoded first and the check ran after, so a multi-hundred-MB
    # result had both the str and its bytes resident before the cap fired
    # (PR review #296 finding #9).
    if len(text) > MAX_ARTIFACT_BYTES:
        raise ValueError(
            f"deliver_artifact: artifact text is {len(text)} characters, exceeds the "
            f"{MAX_ARTIFACT_BYTES}-byte limit"
        )
    body = text.encode("utf-8")
    # Precise byte check for the borderline case (multibyte chars can push a
    # within-character-budget string just over the byte cap).
    if len(body) > MAX_ARTIFACT_BYTES:
        raise ValueError(
            f"deliver_artifact: artifact is {len(body)} bytes, exceeds the "
            f"{MAX_ARTIFACT_BYTES}-byte limit"
        )
    return body


def _upload_to_s3(ctx: StepContext) -> str:
    """Upload the deliverable to ``artifacts/{task_id}/result.md``; return its URI.

    Mirrors the trace-upload pattern (``telemetry.py``): tenant-scoped S3 client,
    task_id-scoped key matching the SessionRole grant. Raises on misconfiguration
    or upload failure — deliver_artifact is a side-effecting terminal step, so a
    failure must surface as a failed step, not a silent skip.
    """
    bucket = os.environ.get("ARTIFACTS_BUCKET_NAME")
    if not bucket:
        raise ValueError("deliver_artifact: ARTIFACTS_BUCKET_NAME is not configured")
    task_id = ctx.config.task_id
    if not task_id:
        raise ValueError("deliver_artifact: empty task_id (cannot scope the artifact key)")

    body = _artifact_body(ctx)
    key = f"{ARTIFACT_KEY_PREFIX}/{task_id}/result.md"
    from aws_session import tenant_client

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    client = tenant_client("s3", region_name=region)
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="text/markdown")
    uri = f"s3://{bucket}/{key}"
    log("WORKFLOW", f"deliver_artifact: uploaded {len(body)} bytes to {uri}")
    return uri


def _post_comment(ctx: StepContext) -> bool:
    """Record the deliverable as a ``delivered_comment`` progress milestone.

    The agent has no direct comment channel for a repo-less task (no GitHub repo;
    Linear MCP is channel-gated). This records the result text as a
    ``delivered_comment`` milestone on TaskEventsTable — visible in the live event
    stream (``bgagent watch``) and to any consumer of the task's events.

    NOTE: rendering this milestone to an external channel (Slack/email/GitHub) is
    NOT yet wired — ``delivered_comment`` is not in the fan-out's
    ``ROUTABLE_MILESTONES``, so a downstream channel post does not happen today.
    Returns True only when the milestone was actually recorded (progress writer
    present), so the caller does not over-report a comment that wasn't emitted.
    """
    if ctx.progress is None:
        return False
    body = _artifact_body(ctx).decode("utf-8")
    ctx.progress.write_agent_milestone("delivered_comment", body)
    return True


def deliver(target: str, ctx: StepContext) -> DeliveryResult:
    """Run the named deliverer against the step context.

    Raises ``ValueError`` for an unknown target (the validator's rule-8 should
    prevent this reaching runtime, but fail loud rather than silently no-op).
    """
    if target not in DELIVERERS:
        raise ValueError(
            f"deliver_artifact: unknown target {target!r} (known: {sorted(DELIVERERS)})"
        )
    artifact_uri: str | None = None
    comment_posted = False
    if "artifact" in DELIVERERS[target].produces:
        artifact_uri = _upload_to_s3(ctx)
    if "comment" in DELIVERERS[target].produces:
        comment_posted = _post_comment(ctx)
    return DeliveryResult(artifact_uri=artifact_uri, comment_posted=comment_posted)


# Terminal outcomes that any deliver_artifact deliverer can produce (union over
# the registry) — the set rule 11 treats as "deliver_artifact-backed".
DELIVER_OUTCOMES: frozenset[str] = frozenset().union(*(d.produces for d in DELIVERERS.values()))


def produced_outcomes(target: str | None) -> frozenset[str]:
    """Terminal outcomes a deliver_artifact ``target`` produces.

    An unset target resolves to {@link DEFAULT_DELIVER_TARGET} — the SAME default
    the runtime applies — so the validator models exactly what will run. (It was
    previously lenient, returning the full set, which let a ``primary: comment``
    workflow with no ``target`` pass validation while the runtime silently
    delivered only to ``s3`` and never posted the comment — PR review #296
    finding #7.) An unknown name returns the empty set (it produces nothing the
    validator can vouch for).
    """
    resolved = DEFAULT_DELIVER_TARGET if target is None else target
    deliverer = DELIVERERS.get(resolved)
    return deliverer.produces if deliverer is not None else frozenset()
