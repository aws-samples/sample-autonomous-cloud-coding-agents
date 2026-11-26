# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import re
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telemetry import upload_trace_to_s3

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSTRUCT_TS = REPO_ROOT / "cdk" / "src" / "handlers" / "shared" / "storage-names.ts"
HANDLER_TS = REPO_ROOT / "cdk" / "src" / "handlers" / "get-trace-url.ts"


def _read_trace_object_key_prefix_from_construct() -> str:
    text = CONSTRUCT_TS.read_text(encoding="utf-8")
    match = re.search(
        r"""export\s+const\s+TRACE_OBJECT_KEY_PREFIX\s*=\s*['"]([^'"]+)['"]""",
        text,
    )
    assert match is not None, f"Could not find TRACE_OBJECT_KEY_PREFIX in {CONSTRUCT_TS}"
    return match.group(1)


def _read_expected_key_prefix_expr_from_handler() -> str:
    text = HANDLER_TS.read_text(encoding="utf-8")
    match = re.search(
        r"""const\s+expectedKeyPrefix\s*=\s*(`[^`]+`)""",
        text,
    )
    assert match is not None, f"Could not find 'const expectedKeyPrefix = `...`' in {HANDLER_TS}"
    return match.group(1)


class TestTraceKeyLayoutContract:
    def test_construct_prefix_is_traces_slash(self):
        prefix = _read_trace_object_key_prefix_from_construct()
        assert prefix == "traces/", (
            f"TRACE_OBJECT_KEY_PREFIX drifted to {prefix!r}; agent uploader still "
            "writes under 'traces/' — update agent/src/telemetry.py in lock-step."
        )

    def test_handler_expected_prefix_uses_construct_constant(self):
        expr = _read_expected_key_prefix_expr_from_handler()
        assert "TRACE_OBJECT_KEY_PREFIX" in expr, (
            f"expectedKeyPrefix expression {expr!r} must reference "
            "TRACE_OBJECT_KEY_PREFIX so storage-names.ts is the single source of truth."
        )
        assert "${userId}" in expr, expr
        assert expr.rstrip("`").endswith("/"), expr

    def test_agent_uploader_writes_key_under_traces_prefix(self, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            uri = upload_trace_to_s3(task_id="TASK-1", user_id="user-abc", body=b"x")

        prefix = _read_trace_object_key_prefix_from_construct()
        _, kwargs = mock_client.put_object.call_args
        key = kwargs["Key"]
        assert key.startswith(prefix), (
            f"Agent wrote key {key!r} but construct declares prefix {prefix!r}"
        )
        assert key == f"{prefix}user-abc/TASK-1.jsonl.gz"
        assert uri == f"s3://b/{prefix}user-abc/TASK-1.jsonl.gz"

    def test_full_key_shape_matches_design_10_1(self, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            upload_trace_to_s3(task_id="t-42", user_id="sub-123", body=b"x")

        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Key"] == "traces/sub-123/t-42.jsonl.gz"
