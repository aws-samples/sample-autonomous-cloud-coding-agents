"""Tests for the deliver_artifact deliverer registry (ADR-014 addendum)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from models import AgentResult, TaskConfig
from workflow.deliverers import (
    DEFAULT_DELIVER_TARGET,
    DELIVER_OUTCOMES,
    DELIVERERS,
    MAX_ARTIFACT_BYTES,
    deliver,
    produced_outcomes,
)


def test_first_party_deliverers_present():
    assert set(DELIVERERS) == {"s3", "comment", "s3_and_comment"}


def test_produced_outcomes_match_first_party_contract():
    # These sets must equal the pre-addendum enum behavior so no existing
    # workflow / fixture changes verdict.
    assert produced_outcomes("s3") == frozenset({"artifact"})
    assert produced_outcomes("comment") == frozenset({"comment"})
    assert produced_outcomes("s3_and_comment") == frozenset({"artifact", "comment"})


def test_unset_target_models_the_runtime_default():
    # PR review #296 finding #7: an unset target must resolve to the SAME default
    # the runtime applies (DEFAULT_DELIVER_TARGET), not a lenient full set — so
    # the validator models exactly what runs. With the default 's3', that is
    # {'artifact'} only; a primary:comment workflow with no target is correctly
    # flagged by rule 11 rather than silently never posting the comment.
    assert DEFAULT_DELIVER_TARGET == "s3"
    assert produced_outcomes(None) == produced_outcomes(DEFAULT_DELIVER_TARGET)
    assert produced_outcomes(None) == frozenset({"artifact"})
    # The full union still exists for rule 11's "is this a deliver-backed
    # outcome at all" membership check.
    assert frozenset({"artifact", "comment"}) == DELIVER_OUTCOMES


def test_unknown_target_produces_nothing():
    assert produced_outcomes("nope") == frozenset()


def _ctx(result_text="some output", task_id="task-1", progress=None):
    """A minimal StepContext stand-in for the deliver() dispatcher."""
    return SimpleNamespace(
        agent_result=AgentResult(status="success", result_text=result_text),
        config=TaskConfig(aws_region="us-east-1", requires_repo=False, task_id=task_id),
        progress=progress,
    )


class TestDeliver:
    def test_unknown_target_raises(self):
        with pytest.raises(ValueError, match="unknown target"):
            deliver("nope", _ctx())

    def test_s3_uploads_and_returns_uri(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        mock_client = MagicMock()
        with patch("aws_session.tenant_client", return_value=mock_client):
            result = deliver("s3", _ctx(result_text="hello", task_id="task-9"))

        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-9/result.md"
        assert result.comment_posted is False
        # Uploaded to the task_id-scoped key the SessionRole grant allows.
        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Key"] == "artifacts/task-9/result.md"
        assert kwargs["Body"] == b"hello"

    def test_s3_missing_bucket_raises(self, monkeypatch):
        monkeypatch.delenv("ARTIFACTS_BUCKET_NAME", raising=False)
        with pytest.raises(ValueError, match="ARTIFACTS_BUCKET_NAME is not configured"):
            deliver("s3", _ctx())

    def test_empty_result_text_raises(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with pytest.raises(ValueError, match="no result text"):
            deliver("s3", _ctx(result_text=""))

    def test_oversize_artifact_raises(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        big = "x" * (MAX_ARTIFACT_BYTES + 1)
        with pytest.raises(ValueError, match="exceeds the"):
            deliver("s3", _ctx(result_text=big))

    def test_oversize_artifact_rejected_before_encoding(self, monkeypatch):
        # PR review #296 finding #9: the cap must bound memory by rejecting on the
        # character count BEFORE encoding to UTF-8 bytes (which would materialize a
        # second full copy). Patch str.encode to prove it is never called on the
        # oversize path — the up-front character check fires first.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        from workflow.deliverers import _artifact_body

        big = "x" * (MAX_ARTIFACT_BYTES + 1)

        class _NoEncode(str):
            def encode(self, *a, **k):
                raise AssertionError("encode() called before the size cap fired")

        ctx = _ctx(result_text=_NoEncode(big))
        with pytest.raises(ValueError, match="characters, exceeds the"):
            _artifact_body(ctx)

    def test_comment_writes_milestone_no_s3(self):
        progress = MagicMock()
        result = deliver("comment", _ctx(result_text="findings", progress=progress))
        assert result.artifact_uri is None
        assert result.comment_posted is True
        progress.write_agent_milestone.assert_called_once()
        assert progress.write_agent_milestone.call_args.args[0] == "delivered_comment"

    def test_s3_and_comment_does_both(self, monkeypatch):
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        progress = MagicMock()
        with patch("aws_session.tenant_client", return_value=MagicMock()):
            result = deliver("s3_and_comment", _ctx(result_text="r", progress=progress))
        assert result.artifact_uri is not None
        assert result.comment_posted is True
