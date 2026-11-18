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

    def test_oversize_artifact_rejected_before_the_deferral_scan(self, monkeypatch):
        # The scan copies the text twice (code stripped, then lower-cased), so the
        # cap fires before it, as it does before encoding: a text over the cap is
        # reported as too large, whatever it says.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        big = "Use /workflows to watch live progress. " + "x" * MAX_ARTIFACT_BYTES
        with pytest.raises(ValueError, match="characters, exceeds the"):
            deliver("s3", _ctx(result_text=big))

    def test_deferral_message_rejected_not_uploaded(self, monkeypatch):
        # #515 exit-path guard: a final message that defers the work ("running…
        # watch /workflows") must fail the deliver step, not upload as the
        # artifact. This is the exact placeholder observed on task 01KWDEFQH6.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        deferral = (
            "The deep-research workflow is running in the background. I'll deliver "
            "the full cited report here as soon as it completes. Use /workflows to "
            "watch live progress."
        )
        with pytest.raises(ValueError, match="defers the work"):
            deliver("s3", _ctx(result_text=deferral))

    def test_deferral_guard_applies_to_comment_target_too(self):
        # Both deliverers route through _artifact_body, so the comment path is
        # guarded as well — a deferral is never presented as a delivered comment.
        # (progress must be present, else _post_comment short-circuits before
        # building the body.)
        ctx = _ctx(
            result_text="The workflow is now running in the background.", progress=MagicMock()
        )
        with pytest.raises(ValueError, match="defers the work"):
            deliver("comment", ctx)

    def test_genuine_answer_mentioning_background_is_not_rejected(self, monkeypatch):
        # Guard against false positives: an answer that legitimately discusses
        # "background" as a topic (not a deferral) must still deliver.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        answer = (
            "# DynamoDB capacity modes\n\nOn-demand suits bursty traffic; provisioned "
            "with auto-scaling suits steady load. Background compaction is handled by "
            "the service. Sources: docs.aws.amazon.com/..."
        )
        with patch("aws_session.tenant_client", return_value=MagicMock()):
            result = deliver("s3", _ctx(result_text=answer))
        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-1/result.md"

    @pytest.mark.parametrize(
        "answer",
        [
            # PR #523 review: a cited CI URL matched the old "/workflows" marker.
            (
                "Our CI is defined in `.github/workflows/ci.yml`. See "
                "https://github.com/o/r/actions/workflows/ci.yml for the runs."
            ),
            # "running in the background" as genuine topic prose.
            "Log compaction runs in the background, so writes are never blocked.",
            # "watch progress" / "check back" as legitimate instructions in an answer.
            (
                "To watch progress of a deployment, run `bgagent watch <id>`; check back "
                "in the console once it reports COMPLETED."
            ),
            # A fenced code block quoting a marker must not trip it.
            (
                "Here is the guard's marker list:\n```\nwatch live progress\n```\nThat is "
                "the full answer."
            ),
            # A finished answer announces what comes next in the same message.
            (
                "I compared the three libraries. I'll share the results by criterion.\n\n"
                "## Speed\nA is twice as fast as B.\n\n## Licence\nAll three are MIT."
            ),
            # The answer is itself a message or a notice: a promise in it is the
            # deliverable, not the agent putting the work off.
            "Dear Ms Lee, the analysis is still running. I will share the results on Friday.",
            "We are down for maintenance tonight. Please check back later.",
            "Service is restored. A full incident report will follow within five days.",
            "The load test is done in two of three regions. Detailed results will follow shortly.",
            "Thank you for the invitation. I will deliver the keynote on Thursday at 9:00.",
        ],
    )
    def test_genuine_answer_with_colliding_tokens_not_rejected(self, monkeypatch, answer):
        # #523: the guard matches full phrases and strips code/URLs first, so
        # answers that merely quote a token in a link, code, or topic prose still
        # deliver. Only the S3 client is a stub: the text meets the real guard.
        monkeypatch.setenv("ARTIFACTS_BUCKET_NAME", "artifacts-bkt")
        with patch("aws_session.tenant_client", return_value=MagicMock()):
            result = deliver("s3", _ctx(result_text=answer))
        assert result.artifact_uri == "s3://artifacts-bkt/artifacts/task-1/result.md"

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
