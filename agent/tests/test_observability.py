# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

import observability


@pytest.fixture
def finished_spans(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(observability, "_tracer", provider.get_tracer("test"))
    yield exporter
    provider.shutdown()


class TestTaskSpan:
    def test_exception_is_recorded_once_on_each_span_it_leaves(self, finished_spans):
        with (
            pytest.raises(RuntimeError, match="clone failed"),
            observability.task_span("task.pipeline"),
            observability.task_span("task.repo_setup"),
        ):
            raise RuntimeError("clone failed")

        spans = {span.name: span for span in finished_spans.get_finished_spans()}
        assert set(spans) == {"task.pipeline", "task.repo_setup"}
        for span in spans.values():
            assert span.status.status_code is StatusCode.ERROR
            assert [event.name for event in span.events] == ["exception"]

    def test_phase_that_succeeds_carries_its_attributes_and_no_error(self, finished_spans):
        with observability.task_span("task.repo_setup", {"repo.url": "owner/repo"}) as span:
            span.set_attribute("build.before", True)

        (finished,) = finished_spans.get_finished_spans()
        assert finished.attributes == {"repo.url": "owner/repo", "build.before": True}
        assert finished.status.status_code is StatusCode.UNSET
        assert finished.events == ()


class TestCurrentOtelTraceId:
    def test_returns_32_hex_for_valid_context(self):
        span = MagicMock()
        ctx = MagicMock()
        ctx.is_valid = True
        ctx.trace_id = 0x1A2B3C4D5E6F70819293A4B5C6D7E8F9
        span.get_span_context.return_value = ctx
        with patch.object(observability.trace, "get_current_span", return_value=span):
            tid = observability.current_otel_trace_id()
        assert tid == "1a2b3c4d5e6f70819293a4b5c6d7e8f9"
        assert len(tid) == 32

    def test_zero_padels_short_trace_id(self):
        span = MagicMock()
        ctx = MagicMock()
        ctx.is_valid = True
        ctx.trace_id = 0x1
        span.get_span_context.return_value = ctx
        with patch.object(observability.trace, "get_current_span", return_value=span):
            tid = observability.current_otel_trace_id()
        assert tid == "0" * 31 + "1"

    def test_returns_none_for_invalid_context(self):
        span = MagicMock()
        ctx = MagicMock()
        ctx.is_valid = False
        span.get_span_context.return_value = ctx
        with patch.object(observability.trace, "get_current_span", return_value=span):
            assert observability.current_otel_trace_id() is None

    def test_degrades_to_none_when_tracer_raises(self):
        with patch.object(
            observability.trace, "get_current_span", side_effect=RuntimeError("tracer boom")
        ):
            assert observability.current_otel_trace_id() is None

    def test_logs_the_tracer_fault_rather_than_degrading_silently(self, capfd):
        with patch.object(
            observability.trace, "get_current_span", side_effect=RuntimeError("tracer boom")
        ):
            assert observability.current_otel_trace_id() is None
        out = capfd.readouterr().out
        assert "current_otel_trace_id: tracer fault" in out
        assert "RuntimeError" in out
        assert "tracer boom" in out

    def test_does_not_log_when_there_is_simply_no_recording_span(self, capfd):
        span = MagicMock()
        ctx = MagicMock()
        ctx.is_valid = False
        span.get_span_context.return_value = ctx
        with patch.object(observability.trace, "get_current_span", return_value=span):
            assert observability.current_otel_trace_id() is None
        assert "tracer fault" not in capfd.readouterr().out


class TestPropagateCorrelationContext:
    def test_sets_all_envelope_fields_when_present(self):
        with (
            patch.object(observability, "baggage") as bag,
            patch.object(observability, "context") as ctx,
        ):
            bag.set_baggage.return_value = "CTX"
            observability.propagate_correlation_context("sess-1", user_id="user-1", repo="org/repo")
        keys = {c.args[0] for c in bag.set_baggage.call_args_list}
        assert keys == {"session.id", "user.id", "repo.url"}
        ctx.attach.assert_called_once()

    def test_omits_absent_fields(self):
        with patch.object(observability, "baggage") as bag, patch.object(observability, "context"):
            bag.set_baggage.return_value = "CTX"
            observability.propagate_correlation_context("sess-1")
        keys = {c.args[0] for c in bag.set_baggage.call_args_list}
        assert keys == {"session.id"}

    def test_empty_session_id_is_not_stamped(self):
        with patch.object(observability, "baggage") as bag, patch.object(observability, "context"):
            bag.set_baggage.return_value = "CTX"
            observability.propagate_correlation_context("", user_id="user-1")
        keys = {c.args[0] for c in bag.set_baggage.call_args_list}
        assert keys == {"user.id"}
