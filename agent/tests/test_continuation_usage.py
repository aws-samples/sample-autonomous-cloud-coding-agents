# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Accounting cannot silently reset or estimate spend after replacement."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from continuation_session import ContinuationCheckpointError
from continuation_usage import read_usage

RESPONSE: dict[str, Any] = {
    "session": {
        "total_cost_usd": 0.03,
        "model_usage": {
            "sonnet": {
                "costUSD": 0.01,
                "inputTokens": 100,
                "outputTokens": 20,
                "cacheReadInputTokens": 30,
                "cacheCreationInputTokens": 40,
            },
            "haiku": {
                "costUSD": 0.02,
                "inputTokens": 5,
                "outputTokens": 6,
                "cacheReadInputTokens": 7,
                "cacheCreationInputTokens": 8,
            },
        },
    }
}


def test_reads_exact_current_process_spending_across_models():
    send = AsyncMock(return_value=RESPONSE)
    snapshot = asyncio.run(
        read_usage(SimpleNamespace(_query=SimpleNamespace(_send_control_request=send)))
    )
    assert snapshot.cost_usd == 0.03
    assert snapshot.tokens == {
        "input_tokens": 105,
        "output_tokens": 26,
        "cache_read_input_tokens": 37,
        "cache_creation_input_tokens": 48,
    }
    send.assert_awaited_once_with({"subtype": "get_usage"})


@pytest.mark.parametrize(
    "mutation", ["negative", "nan", "missing", "empty_models", "bad_tokens", "different_cost"]
)
def test_incomplete_or_invalid_accounting_cannot_publish_a_checkpoint(mutation):
    response = deepcopy(RESPONSE)
    if mutation in {"negative", "nan"}:
        response["session"]["total_cost_usd"] = -1 if mutation == "negative" else float("nan")
    elif mutation == "missing":
        response = {}
    elif mutation == "empty_models":
        response["session"]["model_usage"] = {}
    elif mutation == "bad_tokens":
        response["session"]["model_usage"]["haiku"]["inputTokens"] = "5"
    else:
        response["session"]["model_usage"]["haiku"]["costUSD"] = 0.5
    client = SimpleNamespace(
        _query=SimpleNamespace(_send_control_request=AsyncMock(return_value=response))
    )
    with pytest.raises(ContinuationCheckpointError):
        asyncio.run(read_usage(client))


def test_unverified_sdk_upgrade_requires_explicit_accounting_validation(monkeypatch):
    monkeypatch.setattr("continuation_usage.importlib.metadata.version", lambda _: "0.3.0")
    with pytest.raises(ContinuationCheckpointError, match="verified SDK"):
        asyncio.run(read_usage(None))
