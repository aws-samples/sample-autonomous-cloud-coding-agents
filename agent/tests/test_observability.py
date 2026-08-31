# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for observability helpers (#515 otel_trace_id capture)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import observability


class TestCurrentOtelTraceId:
    """``current_otel_trace_id`` returns a 32-hex id for a valid span context,
    and ``None`` (graceful-missing) when there is no recording span — so the
    replay bundle can treat it as a nullable correlation field."""

    def test_returns_32_hex_for_valid_context(self):
        span = MagicMock()
        ctx = MagicMock()
        ctx.is_valid = True
        ctx.trace_id = 0x1A2B3C4D5E6F70819293A4B5C6D7E8F9
        span.get_span_context.return_value = ctx
        with patch.object(observability.trace, "get_current_span", return_value=span):
            tid = observability.current_otel_trace_id()
        # 128-bit id rendered as zero-padded lowercase 32-char hex.
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
        # A broken/misconfigured tracer must not propagate: callers read this
        # inside DDB-write try-blocks, where a raise would be misclassified as a
        # DDB failure and trip the shared progress circuit breaker (#245 review).
        with patch.object(
            observability.trace, "get_current_span", side_effect=RuntimeError("tracer boom")
        ):
            assert observability.current_otel_trace_id() is None


class TestPropagateCorrelationContext:
    """``propagate_correlation_context`` propagates the correlation envelope
    (#245) via OTEL baggage, setting only the fields that are present."""

    def test_sets_all_envelope_fields_when_present(self):
        with (
            patch.object(observability, "baggage") as bag,
            patch.object(observability, "context") as ctx,
        ):
            bag.set_baggage.return_value = "CTX"
            observability.propagate_correlation_context("sess-1", user_id="user-1", repo="org/repo")
        # Baggage-key ordering is not part of the contract — compare as a set.
        keys = {c.args[0] for c in bag.set_baggage.call_args_list}
        assert keys == {"session.id", "user.id", "repo.url"}
        ctx.attach.assert_called_once()

    def test_omits_absent_fields(self):
        # Empty user_id and None repo → only session.id is set on the baggage.
        with patch.object(observability, "baggage") as bag, patch.object(observability, "context"):
            bag.set_baggage.return_value = "CTX"
            observability.propagate_correlation_context("sess-1")
        keys = {c.args[0] for c in bag.set_baggage.call_args_list}
        assert keys == {"session.id"}

    def test_empty_session_id_is_not_stamped(self):
        # Reachable via server.py's widened trigger (user_id known, no session):
        # an empty session_id must not write an empty-string session.id baggage.
        with patch.object(observability, "baggage") as bag, patch.object(observability, "context"):
            bag.set_baggage.return_value = "CTX"
            observability.propagate_correlation_context("", user_id="user-1")
        keys = {c.args[0] for c in bag.set_baggage.call_args_list}
        assert keys == {"user.id"}
