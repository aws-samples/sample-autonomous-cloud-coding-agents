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
