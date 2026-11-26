from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from shell import log

if TYPE_CHECKING:
    from .runner import StepContext

MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
ARTIFACT_KEY_PREFIX = "artifacts"

# Observed: a model that started a background ``Workflow`` (Claude CLI tool) ended its
# final message with "Use /workflows to watch live progress."
_DEFERRAL_MARKERS = (
    "watch live progress",
    "the workflow is now running in the background",
)

_CODE_AND_URL_RE = re.compile(
    r"```.*?```|`[^`]*`|https?://\S+",
    re.DOTALL,
)


def _strip_code_and_urls(text: str) -> str:
    return _CODE_AND_URL_RE.sub(" ", text)


def _reject_if_deferral(text: str) -> None:
    lowered = _strip_code_and_urls(text).lower()
    hit = next((m for m in _DEFERRAL_MARKERS if m in lowered), None)
    if hit is not None:
        raise ValueError(
            "deliver_artifact: final message defers the work rather than "
            f"delivering it (matched {hit!r}); refusing to upload a placeholder "
            "artifact. The deliverable must be complete in-session."
        )


@dataclass(frozen=True)
class DeliveryResult:
    artifact_uri: str | None = None
    comment_posted: bool = False


@dataclass(frozen=True)
class Deliverer:
    """A named ``deliver_artifact`` target and the terminal outcomes it yields.

    ``produces`` is the set of ``terminal_outcomes`` values this deliverer can
    satisfy.
    """

    name: str
    produces: frozenset[str] = field(default_factory=frozenset)


DELIVERERS: dict[str, Deliverer] = {
    "s3": Deliverer("s3", frozenset({"artifact"})),
    "comment": Deliverer("comment", frozenset({"comment"})),
    "s3_and_comment": Deliverer("s3_and_comment", frozenset({"artifact", "comment"})),
}

DEFAULT_DELIVER_TARGET = "s3"


def _artifact_body(ctx: StepContext) -> bytes:
    text = ctx.agent_result.result_text if ctx.agent_result else ""
    if not text:
        raise ValueError("deliver_artifact: agent produced no result text to deliver")
    if len(text) > MAX_ARTIFACT_BYTES:
        raise ValueError(
            f"deliver_artifact: artifact text is {len(text)} characters, exceeds the "
            f"{MAX_ARTIFACT_BYTES}-byte limit"
        )
    _reject_if_deferral(text)
    body = text.encode("utf-8")
    if len(body) > MAX_ARTIFACT_BYTES:
        raise ValueError(
            f"deliver_artifact: artifact is {len(body)} bytes, exceeds the "
            f"{MAX_ARTIFACT_BYTES}-byte limit"
        )
    return body


def _upload_to_s3(ctx: StepContext) -> str:
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
    if ctx.progress is None:
        return False
    body = _artifact_body(ctx).decode("utf-8")
    ctx.progress.write_agent_milestone("delivered_comment", body)
    return True


def deliver(target: str, ctx: StepContext) -> DeliveryResult:
    """Run the named deliverer against the step context.

    Raises ``ValueError`` for an unknown target.
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


DELIVER_OUTCOMES: frozenset[str] = frozenset().union(*(d.produces for d in DELIVERERS.values()))


def produced_outcomes(target: str | None) -> frozenset[str]:
    """Terminal outcomes a deliver_artifact ``target`` produces.

    An unset target resolves to ``DEFAULT_DELIVER_TARGET``. An unknown name
    returns the empty set.
    """
    resolved = DEFAULT_DELIVER_TARGET if target is None else target
    deliverer = DELIVERERS.get(resolved)
    return deliverer.produces if deliverer is not None else frozenset()
