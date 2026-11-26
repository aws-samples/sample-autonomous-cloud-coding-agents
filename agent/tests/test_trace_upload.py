# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

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
        lines = gzip.decompress(body).decode("utf-8").splitlines()
        assert len(lines) == 3
        header = json.loads(lines[0])
        assert header["event"] == "TRAJECTORY_ARTIFACT_HEADER"
        assert header["task_id"] == "task-42"
        assert header["accumulated_events"] == 2
        assert header["dropped"] == 0
        assert header["max_bytes"] == _TrajectoryWriter._ACCUMULATOR_MAX_BYTES
        events = [json.loads(line) for line in lines[1:]]
        assert events[0] == {"event": "TURN", "turn": 1}
        assert events[1] == {"event": "TURN", "turn": 2}

    def test_accumulator_is_bounded(self):
        w = _TrajectoryWriter("t-1", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 100
        for i in range(10):
            w._put_event({"event": "X", "i": i})
        assert len(w._events) >= 1
        assert w._accumulator_dropped > 0
        assert w._accumulated_bytes <= 100
        body = w.dump_gzipped_jsonl()
        assert body is not None
        header = json.loads(gzip.decompress(body).decode("utf-8").splitlines()[0])
        assert header["dropped"] > 0
        assert header["accumulated_events"] < 10

    def test_dump_returns_none_when_no_events(self):
        w = _TrajectoryWriter("t-1", accumulate=True)
        assert w.dump_gzipped_jsonl() is None

    def test_accumulator_cap_uses_inclusive_upper_bound(self):
        import json as _json

        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 100

        exact_event = {"event": "X", "pad": "A" * 75}
        assert len(_json.dumps(exact_event).encode("utf-8")) == 100, (
            "Padding recipe drifted; recompute the 'pad' length so the "
            "serialized event is 100 bytes."
        )

        w._put_event(exact_event)
        assert len(w._events) == 1
        assert w._accumulated_bytes == 100
        assert w._accumulator_dropped == 0

        w._put_event({"event": "X"})
        assert len(w._events) == 1
        assert w._accumulator_dropped == 1

    def test_accumulator_handles_non_serializable_gracefully(self, capsys):
        w = _TrajectoryWriter("t-1", accumulate=True)

        class Unserializable:
            def __repr__(self):
                return "Unserializable()"

        w._put_event({"event": "OK"})
        bad: dict = {}
        bad["self"] = bad
        w._put_event(bad)
        assert len(w._events) >= 1


class TestUploadTraceToS3:
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
        # download paths.
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
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")
        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            upload_trace_to_s3(task_id="TASK-XYZ", user_id="sub-123", body=b"x")

        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Key"] == "traces/sub-123/TASK-XYZ.jsonl.gz"

    def test_region_env_unset_passes_none_to_boto_client(self, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "bucket")
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)

        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client) as mock_factory:
            result = upload_trace_to_s3(task_id="t-1", user_id="u-1", body=b"x")

        assert result == "s3://bucket/traces/u-1/t-1.jsonl.gz"
        args, kwargs = mock_factory.call_args
        assert args[0] == "s3"
        assert kwargs.get("region_name") is None

    def test_empty_body_still_calls_put_object(self, monkeypatch):
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
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "my-bucket")
        mock_client = MagicMock()
        mock_client.put_object.side_effect = TypeError(
            "put_object() Body expected bytes-like, got NoneType"
        )
        from typing import cast

        bad_body: bytes = cast("bytes", None)
        with patch("boto3.client", return_value=mock_client):
            result = upload_trace_to_s3(task_id="t-none", user_id="u-1", body=bad_body)
        assert result is None
        mock_client.put_object.assert_called_once()
        _, kwargs = mock_client.put_object.call_args
        assert kwargs["Body"] is None


class TestEndToEndAccumulatorRoundTrip:
    def test_accumulated_payload_is_uploadable(self, monkeypatch):
        monkeypatch.setenv("TRACE_ARTIFACTS_BUCKET_NAME", "b")

        w = _TrajectoryWriter("task-rt", accumulate=True)
        w._put_event({"event": "TRAJECTORY_TURN", "turn": 1, "text": "hi"})
        w._put_event({"event": "TRAJECTORY_RESULT", "num_turns": 1})

        body = w.dump_gzipped_jsonl()
        assert body is not None
        lines = gzip.decompress(body).decode("utf-8").splitlines()
        assert len(lines) == 3
        for line in lines:
            json.loads(line)

        mock_client = MagicMock()
        with patch("boto3.client", return_value=mock_client):
            uri = upload_trace_to_s3(task_id="task-rt", user_id="u-1", body=body)

        assert uri == "s3://b/traces/u-1/task-rt.jsonl.gz"
        put_kwargs = mock_client.put_object.call_args.kwargs
        assert put_kwargs["Body"] == body


def _decompress_jsonl(body: bytes) -> list[dict]:
    return [json.loads(line) for line in gzip.decompress(body).decode("utf-8").splitlines()]


class TestDumpEmptyVsNonEmpty:
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
    def test_non_accumulating_writer_retains_no_state(self):
        w = _TrajectoryWriter("t", accumulate=False)
        for i in range(100):
            w._put_event({"event": "X", "i": i})
        assert w._events == []
        assert w._accumulated_bytes == 0
        assert w._accumulator_dropped == 0


class TestAccumulatorWhenCloudWatchDisabled:
    def test_captures_when_log_group_unset(self, monkeypatch):
        monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
        w = _TrajectoryWriter("t", accumulate=True)
        w._put_event({"event": "X"})
        assert len(w._events) == 1

    def test_captures_when_circuit_breaker_open(self):
        w = _TrajectoryWriter("t", accumulate=True)
        w._disabled = True
        w._put_event({"event": "X"})
        assert len(w._events) == 1


class TestTrajectoryStreamCreation:
    def test_failed_stream_creation_is_retried_on_the_next_write(self, monkeypatch):
        monkeypatch.setenv("LOG_GROUP_NAME", "/abca/application")
        client = MagicMock()
        # contextlib.suppress needs a real exception class here.
        client.exceptions.ResourceAlreadyExistsException = type(
            "ResourceAlreadyExistsException", (Exception,), {}
        )
        client.create_log_stream.side_effect = [
            RuntimeError("still throttled after the SDK's own retries"),
            None,
        ]

        with patch("boto3.client", return_value=client):
            w = _TrajectoryWriter("t-1")
            w._put_event({"event": "A"})
            w._put_event({"event": "B"})

        assert client.create_log_stream.call_count == 2
        assert client.put_log_events.call_count == 1
        assert (w._failure_count, w._disabled) == (1, False)


class TestTruncationCallback:
    def test_callback_fires_on_first_drop_only(self):
        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 50
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))

        for i in range(20):
            w._put_event({"event": "X", "i": i})

        assert len(calls) == 1
        assert calls[0][0] == 50
        assert calls[0][1] >= 1

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
        for i in range(20):
            w._put_event({"event": "X", "i": i})
        assert w._accumulator_dropped > 0
        assert "truncation callback raised" in capsys.readouterr().out

    def test_accumulator_dropped_continues_past_announcement(self):
        w = _TrajectoryWriter("t", accumulate=True)
        w._ACCUMULATOR_MAX_BYTES = 50
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))

        for i in range(50):
            w._put_event({"event": "X", "i": i})

        assert len(calls) == 1
        announced_drops = calls[0][1]
        assert w._accumulator_dropped > announced_drops, (
            f"dropped counter stuck at announcement value "
            f"{announced_drops}; final={w._accumulator_dropped}"
        )

    def test_callback_not_fired_when_accumulator_disabled(self):
        w = _TrajectoryWriter("t", accumulate=False)
        calls: list[tuple[int, int]] = []
        w.set_truncation_callback(lambda maxb, dropped: calls.append((maxb, dropped)))
        for i in range(1000):
            w._put_event({"event": "X", "i": i})
        assert calls == []
