# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Tests for the K2 Stage 4 --trace upload path (design §10.1).

Covers:
  * ``_TrajectoryWriter`` accumulator behavior (enabled/disabled,
    bounded, JSONL header shape)
  * ``upload_trace_to_s3`` fail-open semantics and contract enforcement
    from the K2 Stage 3 review (empty user_id -> skip + warn, never
    write ``traces//`` keys)
"""

from __future__ import annotations

import gzip
import io
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telemetry import _TrajectoryWriter, upload_trace_to_s3


class TestTrajectoryAccumulator:
    """``_TrajectoryWriter`` with ``accumulate=True`` retains events
    in memory for the terminal-state S3 dump. With ``accumulate=False``
    (default) nothing is kept — the writer stays CW-only and zero-cost
    for non-trace tasks."""

    def test_accumulator_disabled_by_default(self):
        w = _TrajectoryWriter("t-1")
        w._put_event({"event": "X", "n": 1})
        assert w._events == []
        assert w._accumulated_bytes == 0
        assert w.dump_gzipped_jsonl() is None

    def test_accumulator_retains_events_when_enabled(self):
        w = _TrajectoryWriter("t-1", accumulate=True)
        w._put_event({"event": "A", "n": 1})
        w._put_event({"event": "B", "n": 2})
        assert len(w._events) == 2
        assert w._accumulated_bytes > 0

    def test_dump_gzipped_jsonl_produces_well_formed_output(self):
        w = _TrajectoryWriter("task-42", accumulate=True)
        w._put_event({"event": "TURN", "turn": 1})
        w._put_event({"event": "TURN", "turn": 2})

        body = w.dump_gzipped_jsonl()
        assert body is not None
        # Decompress and parse every line as JSON
        lines = gzip.decompress(body).decode("utf-8").splitlines()
        assert len(lines) == 3  # header + 2 events
        header = json.loads(lines[0])
        assert header["event"] == "TRAJECTORY_ARTIFACT_HEADER"
        assert header["task_id"] == "task-42"
        assert header["accumulated_events"] == 2
        assert header["dropped"] == 0
        assert header["max_bytes"] == _TrajectoryWriter._ACCUMULATOR_MAX_BYTES
        # Events are in insertion order
        events = [json.loads(line) for line in lines[1:]]
        assert events[0] == {"event": "TURN", "turn": 1}
        assert events[1] == {"event": "TURN", "turn": 2}

    def test_accumulator_is_bounded(self):
        # Force a low cap so the test runs fast without allocating 50 MB.
        # Instance-level attribute override — does NOT leak across tests
        # (each test constructs a fresh writer). A future refactor that
        # converts this to a class-level assignment would silently leak;
        # keep the assignment on ``w`` (the instance), never on the class.
        w = _TrajectoryWriter("t-1", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 100  # tiny budget
        # Each event serializes to ~30+ bytes; a few will fit, the
        # rest should bounce off the cap.
        for i in range(10):
            w._put_event({"event": "X", "i": i})
        # At least one event must have been captured before the cap
        # tripped — otherwise this test would pass trivially against a
        # buggy ``_put_event`` that rejects everything (pr-test-analyzer
        # Finding S1).
        assert len(w._events) >= 1
        assert w._accumulator_dropped > 0
        assert w._accumulated_bytes <= 100
        # Header must report the drop so a consumer can tell a
        # truncated trace from a complete one.
        body = w.dump_gzipped_jsonl()
        assert body is not None
        header = json.loads(gzip.decompress(body).decode("utf-8").splitlines()[0])
        assert header["dropped"] > 0
        assert header["accumulated_events"] < 10

    def test_dump_returns_none_when_no_events(self):
        w = _TrajectoryWriter("t-1", accumulate=True)
        # No events appended
        assert w.dump_gzipped_jsonl() is None

    def test_accumulator_cap_uses_inclusive_upper_bound(self):
        """Pin ``<=`` boundary on ``_put_event``.

        An event whose serialized size is EXACTLY the cap must be
        accepted (``<=``). A subsequent 1-byte-added event must be
        rejected. This test guards against a future ``<`` off-by-one
        refactor that would silently drop events sitting right at the
        cap.

        The exact serialized JSON length is measured below so the test
        is deterministic under default ``json.dumps`` spacing; the
        padding length (75) is chosen to land the event on 100 bytes
        on the nose.
        """
        import json as _json

        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 100

        # Craft an event whose JSON byte length is exactly 100.
        exact_event = {"event": "X", "pad": "A" * 75}
        assert len(_json.dumps(exact_event).encode("utf-8")) == 100, (
            "Padding recipe drifted; recompute the 'pad' length so the "
            "serialized event is 100 bytes."
        )

        w._put_event(exact_event)
        # Accepted at the boundary (<=).
        assert len(w._events) == 1
        assert w._accumulated_bytes == 100
        assert w._accumulator_dropped == 0

        # Any further event (even 1 byte over the remaining budget) is
        # dropped — remaining budget is 0.
        w._put_event({"event": "X"})
        assert len(w._events) == 1  # unchanged
        assert w._accumulator_dropped == 1

    def test_accumulator_handles_non_serializable_gracefully(self, capsys):
        w = _TrajectoryWriter("t-1", accumulate=True)

        class Unserializable:
            def __repr__(self):
                # Make repr clean so the default=str fallback produces
                # deterministic output rather than a random address.
                return "Unserializable()"

        # json.dumps with default=str will stringify most objects, but
        # we still pin the fail-open branch in case a future refactor
        # removes the fallback.
        w._put_event({"event": "OK"})
        # Force a TypeError by sneaking in something json actually can't
        # serialize even with default=str — use a circular dict.
        bad: dict = {}
        bad["self"] = bad
        w._put_event(bad)
        # First event still captured.
        assert len(w._events) >= 1


class TestUploadTraceToS3:
    """``upload_trace_to_s3`` is the agent's S3 write path. It is
    fail-open and enforces the Stage 3 review contract (empty user_id
    -> skip, never write ``traces//...``)."""

    def test_skip_when_user_id_empty(self, capsys, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "bucket")
        result = upload_trace_to_s3(task_id="t-1", user_id="", body=b"payload")
        assert result is None
        captured = capsys.readouterr()
        assert "skip" in captured.out
        assert "unreachable key" in captured.out
        assert "t-1" in captured.out

    def test_skip_when_task_id_empty(self, capsys, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "bucket")
        result = upload_trace_to_s3(task_id="", user_id="u-1", body=b"x")
        assert result is None
        assert "empty task_id" in capsys.readouterr().out

    def test_skip_when_bucket_env_unset(self, capsys, monkeypatch):
        monkeypatch.delenv("TRACE_ARTIFACTS_BUCKET_NAME", raising=False)
        result = upload_trace_to_s3(task_id="t-1", user_id="u-1", body=b"x")
        assert result is None
        assert "TRACE_ARTIFACTS_BUCKET_NAME unset" in capsys.readouterr().out

    def test_happy_path_returns_s3_uri(self, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "my-bucket")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            result = upload_trace_to_s3(task_id="t-9", user_id="u-1", body=b"gz-payload")

        assert result == "s3://my-bucket/traces/u-1/t-9.jsonl.gz"
        # ContentEncoding=gzip intentionally omitted — it triggers Node's
        # fetch (undici) auto-decompression, which breaks the CLI's trace
        # download paths. See telemetry.upload_trace_to_s3 comment.
        mock_client.put_object.assert_called_once_with(
            Bucket="my-bucket",
            Key="traces/u-1/t-9.jsonl.gz",
            Body=b"gz-payload",
            ContentType="application/gzip",
        )
        _, kwargs = mock_client.put_object.call_args
        assert "ContentEncoding" not in kwargs

    def test_fail_open_on_s3_error(self, capsys, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "my-bucket")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_client.put_object.side_effect = RuntimeError("boom")
        with patch("boto3.client", return_value=mock_client):
            result = upload_trace_to_s3(task_id="t-9", user_id="u-1", body=b"x")

        # Fail-open: returns None but does NOT raise.
        assert result is None
        captured = capsys.readouterr()
        assert "S3 put_object failed" in captured.out
        assert "boom" in captured.out

    def test_flags_iam_misconfiguration_in_error_path(self, capsys, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "my-bucket")

        mock_client = MagicMock()
        mock_client.put_object.side_effect = PermissionError(
            "AccessDenied: agent role lacks s3:PutObject",
        )
        with patch("boto3.client", return_value=mock_client):
            upload_trace_to_s3(task_id="t-9", user_id="u-1", body=b"x")

        captured = capsys.readouterr()
        assert "IAM misconfiguration likely" in captured.out

    def test_object_key_uses_design_layout(self, monkeypatch):
        # Pin the key layout from design §10.1:
        # ``traces/<user_id>/<task_id>.jsonl.gz``
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            upload_trace_to_s3(task_id="TASK-XYZ", user_id="sub-123", body=b"x")

        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Key"] == "traces/sub-123/TASK-XYZ.jsonl.gz"

    def test_region_env_unset_passes_none_to_boto_client(self, monkeypatch):
        """Both ``AWS_REGION`` and ``AWS_DEFAULT_REGION`` unset — the
        uploader must still proceed and delegate region resolution to
        boto3's default credential/region provider chain by passing
        ``region_name=None``."""
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "bucket")
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)

        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client) as mock_factory:
            result = upload_trace_to_s3(task_id="t-1", user_id="u-1", body=b"x")

        # Upload proceeded (did not short-circuit on missing region).
        assert result == "s3://bucket/traces/u-1/t-1.jsonl.gz"
        # boto3.client was invoked with region_name=None so boto's default
        # chain (IMDS, config file, env var precedence) resolves it.
        args, kwargs = mock_factory.call_args
        assert args[0] == "s3"
        assert kwargs.get("region_name") is None

    def test_empty_body_still_calls_put_object(self, monkeypatch):
        """Empty ``body=b""`` must be passed to ``put_object`` without
        short-circuiting. Boto3 accepts empty Body; we pin that behavior
        so a future refactor can't silently skip zero-byte uploads."""
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "my-bucket")
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            result = upload_trace_to_s3(task_id="t-empty", user_id="u-1", body=b"")

        assert result == "s3://my-bucket/traces/u-1/t-empty.jsonl.gz"
        mock_client.put_object.assert_called_once()
        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Body"] == b""
        assert kwargs["Key"] == "traces/u-1/t-empty.jsonl.gz"

    def test_none_body_raises_when_put_object_rejects(self, monkeypatch):
        """``body=None`` is a contract violation from the caller's side.

        The current implementation passes ``None`` straight through to
        ``put_object`` and relies on boto3's ``ParamValidationError``
        (or TypeError in the mocked case) to fail visibly. Pin whatever
        the current behavior is — if L3 wants to harden this with an
        early ``if body is None: skip``, it can.

        We use ``side_effect=TypeError`` to simulate boto3's rejection
        of ``Body=None`` in a way that's deterministic without requiring
        the real SDK.
        """
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "my-bucket")
        mock_client = MagicMock()
        mock_client.put_object.side_effect = TypeError(
            "put_object() Body expected bytes-like, got NoneType"
        )
        from typing import cast

        # ``cast`` launders ``None`` through the ``bytes``-typed parameter
        # so the static type checker accepts the contract violation this
        # test is deliberately exercising.
        bad_body: bytes = cast("bytes", None)
        with patch("boto3.client", return_value=mock_client):
            # Fail-open on the generic except path — returns None, does
            # not raise. This pins the CURRENT behavior: None body is
            # swallowed as an upload failure rather than rejected up
            # front. Flagged for L3 in the report.
            result = upload_trace_to_s3(task_id="t-none", user_id="u-1", body=bad_body)
        assert result is None
        mock_client.put_object.assert_called_once()
        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Body"] is None


class TestEndToEndAccumulatorRoundTrip:
    """A small end-to-end test: accumulate events, dump, upload —
    covers the shape the pipeline will actually produce."""

    def test_accumulated_payload_is_uploadable(self, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")

        w = _TrajectoryWriter("task-rt", accumulate=True)
        w._put_event({"event": "TRAJECTORY_TURN", "turn": 1, "text": "hi"})
        w._put_event({"event": "TRAJECTORY_RESULT", "num_turns": 1})

        body = w.dump_gzipped_jsonl()
        assert body is not None
        # gzip roundtrip produces parseable JSONL
        lines = gzip.decompress(body).decode("utf-8").splitlines()
        assert len(lines) == 3  # header + 2
        for line in lines:
            json.loads(line)  # raises if invalid

        # Upload path accepts the dumped payload.
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            uri = upload_trace_to_s3(task_id="task-rt", user_id="u-1", body=body)

        assert uri == "s3://b/traces/u-1/task-rt.jsonl.gz"
        put_kwargs = mock_client.put_object.call_args.kwargs
        # Uploaded bytes exactly match what dump_gzipped_jsonl produced.
        assert put_kwargs["Body"] == body


def _decompress_jsonl(body: bytes) -> list[dict]:
    return [json.loads(line) for line in gzip.decompress(body).decode("utf-8").splitlines()]


class TestDumpEmptyVsNonEmpty:
    """Regression pin: the accumulator must emit the header only when
    there are events to describe. An empty accumulator -> ``None`` so
    callers do not upload a zero-event artifact."""

    def test_empty_accumulator_returns_none(self):
        w = _TrajectoryWriter("t", accumulate=True)
        assert w.dump_gzipped_jsonl() is None

    def test_single_event_produces_header_plus_event(self):
        w = _TrajectoryWriter("t", accumulate=True)
        w._put_event({"event": "ONLY"})
        body = w.dump_gzipped_jsonl()
        assert body is not None
        assert len(_decompress_jsonl(body)) == 2


class TestWriterByteTracking:
    """``_accumulated_bytes`` must track the uncompressed JSON size —
    not the Python object size — because that's what the bound guards."""

    def test_bytes_counter_advances_on_each_event(self):
        w = _TrajectoryWriter("t", accumulate=True)
        size0 = w._accumulated_bytes
        w._put_event({"event": "X"})
        size1 = w._accumulated_bytes
        w._put_event({"event": "Y"})
        size2 = w._accumulated_bytes
        assert size0 < size1 < size2

    def test_bytes_counter_matches_serialized_length(self):
        w = _TrajectoryWriter("t", accumulate=True)
        payload = {"event": "X", "content": "hello"}
        w._put_event(payload)
        expected = len(io.BytesIO(json.dumps(payload).encode("utf-8")).getvalue())
        assert w._accumulated_bytes == expected


class TestAccumulatorFlagsAreIndependent:
    """The ``accumulate`` flag must not affect the existing CW-write
    path for non-trace tasks. Explicitly assert that disabling the
    accumulator leaves the writer at zero memory cost."""

    def test_non_accumulating_writer_retains_no_state(self):
        w = _TrajectoryWriter("t", accumulate=False)
        # Even after many events, accumulator state stays at zero.
        for i in range(100):
            w._put_event({"event": "X", "i": i})
        assert w._events == []
        assert w._accumulated_bytes == 0
        assert w._accumulator_dropped == 0


class TestAccumulatorWhenCloudWatchDisabled:
    """K2 review Finding #9: accumulator must capture events even when
    the CloudWatch path is disabled (no log group env, or circuit
    breaker open). The S3 artifact is independent of CW health by
    design."""

    def test_captures_when_log_group_unset(self, monkeypatch):
        monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
        w = _TrajectoryWriter("t", accumulate=True)
        w._put_event({"event": "X"})
        assert len(w._events) == 1

    def test_captures_when_circuit_breaker_open(self):
        w = _TrajectoryWriter("t", accumulate=True)
        w._disabled = True  # simulate circuit breaker open
        w._put_event({"event": "X"})
        assert len(w._events) == 1


class TestTruncationCallback:
    """K2 review Finding #3: accumulator cap trips fire a one-shot
    callback so the pipeline can surface ``trace_truncated`` in
    ``bgagent watch``."""

    def test_callback_fires_on_first_drop_only(self):
        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 50
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))

        # First N events fit; later ones trip the cap repeatedly.
        for i in range(20):
            w._put_event({"event": "X", "i": i})

        # Fire-once: callback called exactly one time even though
        # many events dropped.
        assert len(calls) == 1
        assert calls[0][0] == 50  # max_bytes arg
        assert calls[0][1] >= 1  # at least one drop at the moment of first announcement

    def test_callback_not_fired_when_cap_never_trips(self):
        w = _TrajectoryWriter("t", accumulate=True)
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))

        for i in range(5):
            w._put_event({"event": "X", "i": i})
        assert calls == []

    def test_callback_errors_are_swallowed(self, capsys):
        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 50

        def broken_cb(_maxb, _dropped):
            raise RuntimeError("cb boom")

        w.set_truncation_callback(broken_cb)
        # Should not raise even though the callback raises.
        for i in range(20):
            w._put_event({"event": "X", "i": i})
        assert w._accumulator_dropped > 0
        assert "truncation callback raised" in capsys.readouterr().out

    def test_accumulator_dropped_continues_past_announcement(self):
        """Debounce semantics: the callback fires once, but
        ``_accumulator_dropped`` must keep incrementing for every
        subsequent rejected event so the header reports the true final
        drop count (not just the count at the moment of announcement)."""
        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 50
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))

        # Many events past the cap — force multiple drops.
        for i in range(50):
            w._put_event({"event": "X", "i": i})

        # Fire-once: the callback was called exactly one time.
        assert len(calls) == 1
        announced_drops = calls[0][1]
        # Counter kept climbing after the one-shot announcement.
        assert w._accumulator_dropped > announced_drops, (
            f"dropped counter stuck at announcement value "
            f"{announced_drops}; final={w._accumulator_dropped}"
        )

    def test_callback_not_fired_when_accumulator_disabled(self):
        w = _TrajectoryWriter("t", accumulate=False)
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))
        # Even with huge event volume, non-accumulating writer skips
        # the bookkeeping branch entirely.
        for i in range(1000):
            w._put_event({"event": "X", "i": i})
        assert calls == []
