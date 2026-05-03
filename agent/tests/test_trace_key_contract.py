# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Cross-language contract test: trace S3 key layout (design §10.1).

The trace artifact key ``traces/<user_id>/<task_id>.jsonl.gz`` is
asserted by three independent codepaths that MUST agree:

1. Agent ``upload_trace_to_s3`` in ``agent/src/telemetry.py`` — constructs
   the key it writes to S3.
2. CDK handler ``expectedKeyPrefix`` in
   ``cdk/src/handlers/get-trace-url.ts`` — refuses to presign keys
   outside the caller's user prefix.
3. CDK construct ``TRACE_OBJECT_KEY_PREFIX`` in
   ``cdk/src/constructs/trace-artifacts-bucket.ts`` — exports the
   canonical prefix that the handler imports.

This test is a drift detector: if anyone renames ``traces/`` to
``trajectories/`` on one side, it fails immediately. The agent side is
exercised end-to-end (mocked boto3); the TypeScript sides are parsed as
source text so no TS runtime is needed.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telemetry import upload_trace_to_s3

# Repository root relative to this test file:
#   agent/tests/test_trace_key_contract.py -> parents[2]
REPO_ROOT = Path(__file__).resolve().parents[2]
CONSTRUCT_TS = REPO_ROOT / "cdk" / "src" / "constructs" / "trace-artifacts-bucket.ts"
HANDLER_TS = REPO_ROOT / "cdk" / "src" / "handlers" / "get-trace-url.ts"


def _read_trace_object_key_prefix_from_construct() -> str:
    """Parse ``export const TRACE_OBJECT_KEY_PREFIX = 'traces/';`` from
    the CDK construct file without importing TypeScript."""
    text = CONSTRUCT_TS.read_text(encoding="utf-8")
    match = re.search(
        r"""export\s+const\s+TRACE_OBJECT_KEY_PREFIX\s*=\s*['"]([^'"]+)['"]""",
        text,
    )
    assert match is not None, f"Could not find TRACE_OBJECT_KEY_PREFIX in {CONSTRUCT_TS}"
    return match.group(1)


def _read_expected_key_prefix_expr_from_handler() -> str:
    """Parse the ``expectedKeyPrefix = ...`` assignment from the handler.

    Returns the raw right-hand-side expression as a string. We only
    care that it interpolates ``TRACE_OBJECT_KEY_PREFIX`` and builds a
    ``<prefix>${userId}/`` shape — that's what binds the three sides
    together.
    """
    text = HANDLER_TS.read_text(encoding="utf-8")
    match = re.search(
        r"""const\s+expectedKeyPrefix\s*=\s*(`[^`]+`)""",
        text,
    )
    assert match is not None, f"Could not find 'const expectedKeyPrefix = `...`' in {HANDLER_TS}"
    return match.group(1)


class TestTraceKeyLayoutContract:
    """All three codepaths must agree on ``traces/<user_id>/<task_id>.jsonl.gz``."""

    def test_construct_prefix_is_traces_slash(self):
        prefix = _read_trace_object_key_prefix_from_construct()
        assert prefix == "traces/", (
            f"TRACE_OBJECT_KEY_PREFIX drifted to {prefix!r}; agent uploader still "
            "writes under 'traces/' — update agent/src/telemetry.py in lock-step."
        )

    def test_handler_expected_prefix_uses_construct_constant(self):
        """The handler must compose its expected prefix from the shared
        constant (not a hardcoded string), and append the caller's user
        id with a trailing slash."""
        expr = _read_expected_key_prefix_expr_from_handler()
        # Template literal must reference TRACE_OBJECT_KEY_PREFIX — if
        # someone inlines the string, the drift detector in
        # test_construct_prefix_is_traces_slash stops catching renames.
        assert "TRACE_OBJECT_KEY_PREFIX" in expr, (
            f"expectedKeyPrefix expression {expr!r} must reference "
            "TRACE_OBJECT_KEY_PREFIX so the construct is the single source of truth."
        )
        # Must interpolate the user id and end with a trailing slash.
        assert "${userId}" in expr, expr
        assert expr.rstrip("`").endswith("/"), expr

    def test_agent_uploader_writes_key_under_traces_prefix(self, monkeypatch):
        """Round-trip: the agent's actual put_object call uses the same
        prefix the construct exports."""
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
        """Pin the full shape ``traces/<user_id>/<task_id>.jsonl.gz``."""
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            upload_trace_to_s3(task_id="t-42", user_id="sub-123", body=b"x")

        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Key"] == "traces/sub-123/t-42.jsonl.gz"
