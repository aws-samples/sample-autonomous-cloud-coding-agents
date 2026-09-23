# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Version-checked access to exact CLI spending at a paused approval hook."""

from __future__ import annotations

import asyncio
import importlib.metadata
import math
from dataclasses import dataclass
from typing import Any

from continuation_session import ContinuationCheckpointError
from shared_constants import SHARED_CONSTANTS

TOKEN_FIELDS = {
    "input_tokens": "inputTokens",
    "output_tokens": "outputTokens",
    "cache_read_input_tokens": "cacheReadInputTokens",
    "cache_creation_input_tokens": "cacheCreationInputTokens",
}


@dataclass(frozen=True)
class UsageSnapshot:
    cost_usd: float
    tokens: dict[str, int]


def valid_cost(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def valid_tokens(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and set(value) <= set(TOKEN_FIELDS)
        and all(type(count) is int and count >= 0 for count in value.values())
    )


async def read_usage(client: Any) -> UsageSnapshot:
    """Read cumulative spending without interrupting or issuing another query.

    SDK 0.2.110 bundles CLI 2.1.191, whose experimental ``get_usage`` control
    request exposes exact session dollars and per-model token counters. Python
    has no public wrapper yet. Keep this dependency isolated and covered by the
    real SDK probe in CI; an upgrade must verify it before publishing checkpoints.
    """
    if (
        importlib.metadata.version("claude-agent-sdk")
        != SHARED_CONSTANTS["microvm_continuation"]["verified_sdk_version"]
    ):
        raise ContinuationCheckpointError(
            "Continuation accounting requires the verified SDK version",
            code="checkpoint_sdk_unverified",
        )
    query = getattr(client, "_query", None)
    send = getattr(query, "_send_control_request", None)
    if not callable(send):
        raise ContinuationCheckpointError(
            "Continuation accounting client is unavailable", code="checkpoint_sdk_unverified"
        )
    try:
        response = await asyncio.wait_for(send({"subtype": "get_usage"}), timeout=5)
    except TimeoutError as exc:
        raise ContinuationCheckpointError(
            "Continuation accounting request timed out", code="checkpoint_sdk_timeout"
        ) from exc
    session = response.get("session") if isinstance(response, dict) else None
    if not isinstance(session, dict) or not valid_cost(session.get("total_cost_usd")):
        raise ContinuationCheckpointError("Continuation accounting response has no valid cost")
    models = session.get("model_usage")
    if not isinstance(models, dict):
        raise ContinuationCheckpointError("Continuation accounting response has no model usage")
    tokens = dict.fromkeys(TOKEN_FIELDS, 0)
    model_cost = 0.0
    for usage in models.values():
        if (
            not isinstance(usage, dict)
            or not valid_cost(usage.get("costUSD"))
            or any(
                type(usage.get(key)) is not int or usage[key] < 0 for key in TOKEN_FIELDS.values()
            )
        ):
            raise ContinuationCheckpointError("Continuation model usage is invalid")
        model_cost += usage["costUSD"]
        for target, source in TOKEN_FIELDS.items():
            tokens[target] += usage[source]
    cost = float(session["total_cost_usd"])
    if not math.isclose(model_cost, cost, rel_tol=1e-9, abs_tol=1e-12):
        raise ContinuationCheckpointError("Continuation model costs do not match session spending")
    return UsageSnapshot(cost, tokens)
