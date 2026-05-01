# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for progress_writer._ProgressWriter."""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from progress_writer import _generate_ulid, _ProgressWriter, _truncate_preview

# ---------------------------------------------------------------------------
# _generate_ulid
# ---------------------------------------------------------------------------


class TestGenerateUlid:
    def test_length_is_26(self):
        assert len(_generate_ulid()) == 26

    def test_monotonic_ordering_across_milliseconds(self):
        """ULIDs generated across different milliseconds are lexicographically ordered."""
        import time

        ids = []
        for _ in range(5):
            ids.append(_generate_ulid())
            time.sleep(0.002)  # 2ms gap to ensure different timestamp
        assert ids == sorted(ids)

    def test_uniqueness(self):
        ids = {_generate_ulid() for _ in range(100)}
        assert len(ids) == 100


# ---------------------------------------------------------------------------
# _truncate_preview
# ---------------------------------------------------------------------------


class TestTruncatePreview:
    def test_short_string_unchanged(self):
        assert _truncate_preview("hello") == "hello"

    def test_none_returns_empty(self):
        assert _truncate_preview(None) == ""

    def test_empty_returns_empty(self):
        assert _truncate_preview("") == ""

    def test_long_string_truncated(self):
        long = "x" * 300
        result = _truncate_preview(long)
        assert len(result) <= 203  # 200 + "..."
        assert result.endswith("...")

    def test_custom_max_len(self):
        result = _truncate_preview("abcdef", max_len=3)
        assert result == "abc..."

    def test_exact_length_not_truncated(self):
        s = "a" * 200
        assert _truncate_preview(s) == s


# ---------------------------------------------------------------------------
# _ProgressWriter — init and disable
# ---------------------------------------------------------------------------


class TestProgressWriterInit:
    def test_noop_when_env_var_unset(self, monkeypatch):
        monkeypatch.delenv("TASK_EVENTS_TABLE_NAME", raising=False)
        pw = _ProgressWriter("task-1")
        pw.write_agent_milestone("test", "detail")
        # Should not raise — silently no-ops (table_name is None so _put_event returns early)
        assert pw._table_name is None
        assert pw._table is None

    def test_enabled_when_env_var_set(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "my-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        pw = _ProgressWriter("task-1")
        assert pw._table_name == "my-table"
        assert pw._disabled is False


# ---------------------------------------------------------------------------
# _ProgressWriter — DDB writes
# ---------------------------------------------------------------------------


class TestProgressWriterPutEvent:
    @pytest.fixture()
    def writer(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        return _ProgressWriter("task-42")

    @pytest.fixture()
    def mock_table(self, writer):
        table = MagicMock()
        writer._table = table
        return table

    def test_write_agent_turn(self, writer, mock_table):
        writer.write_agent_turn(
            turn=1,
            model="claude-4",
            thinking="deep thoughts",
            text="hello world",
            tool_calls_count=3,
        )
        mock_table.put_item.assert_called_once()
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["task_id"] == "task-42"
        assert item["event_type"] == "agent_turn"
        assert item["metadata"]["turn"] == 1
        assert item["metadata"]["model"] == "claude-4"
        assert item["metadata"]["thinking_preview"] == "deep thoughts"
        assert item["metadata"]["text_preview"] == "hello world"
        assert item["metadata"]["tool_calls_count"] == 3
        assert "event_id" in item
        assert "timestamp" in item
        assert "ttl" in item

    def test_write_agent_tool_call(self, writer, mock_table):
        writer.write_agent_tool_call(tool_name="Bash", tool_input="ls -la", turn=2)
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["event_type"] == "agent_tool_call"
        assert item["metadata"]["tool_name"] == "Bash"
        assert item["metadata"]["tool_input_preview"] == "ls -la"
        assert item["metadata"]["turn"] == 2

    def test_write_agent_tool_result(self, writer, mock_table):
        writer.write_agent_tool_result(
            tool_name="Bash",
            is_error=True,
            content="command not found",
            turn=2,
        )
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["event_type"] == "agent_tool_result"
        assert item["metadata"]["is_error"] is True
        assert item["metadata"]["content_preview"] == "command not found"

    def test_write_agent_milestone(self, writer, mock_table):
        writer.write_agent_milestone("repo_setup_complete", "branch=main")
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["event_type"] == "agent_milestone"
        assert item["metadata"]["milestone"] == "repo_setup_complete"
        assert item["metadata"]["details"] == "branch=main"

    def test_write_agent_cost_update(self, writer, mock_table):
        writer.write_agent_cost_update(
            cost_usd=0.0512,
            input_tokens=1000,
            output_tokens=500,
            turn=5,
        )
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["event_type"] == "agent_cost_update"
        assert item["metadata"]["cost_usd"] == Decimal("0.0512")
        assert item["metadata"]["input_tokens"] == 1000
        assert item["metadata"]["output_tokens"] == 500

    def test_write_agent_error(self, writer, mock_table):
        writer.write_agent_error(error_type="RuntimeError", message="something broke")
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["event_type"] == "agent_error"
        assert item["metadata"]["error_type"] == "RuntimeError"
        assert item["metadata"]["message_preview"] == "something broke"

    def test_preview_fields_truncated(self, writer, mock_table):
        long_text = "x" * 500
        writer.write_agent_turn(
            turn=1,
            model="claude-4",
            thinking=long_text,
            text=long_text,
            tool_calls_count=0,
        )
        item = mock_table.put_item.call_args[1]["Item"]
        assert len(item["metadata"]["thinking_preview"]) <= 203
        assert len(item["metadata"]["text_preview"]) <= 203

    def test_ttl_is_90_days_from_now(self, writer, mock_table):
        import time

        before = int(time.time())
        writer.write_agent_milestone("test", "")
        item = mock_table.put_item.call_args[1]["Item"]
        after = int(time.time())

        ttl_90_days = 90 * 24 * 60 * 60
        assert before + ttl_90_days <= item["ttl"] <= after + ttl_90_days + 1


# ---------------------------------------------------------------------------
# _ProgressWriter — --trace preview cap (design §10.1)
# ---------------------------------------------------------------------------


class TestProgressWriterTrace:
    """Trace-enabled writers use a 4 KB preview cap instead of 200 chars.

    The cap is per-instance, not a mutable global: two writers in the
    same process (unit tests, local batch mode) can coexist with
    different caps without cross-contamination.
    """

    @pytest.fixture()
    def trace_writer(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        return _ProgressWriter("task-trace", trace=True)

    @pytest.fixture()
    def normal_writer(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        return _ProgressWriter("task-normal")

    def test_trace_raises_preview_cap_to_4kb(self, trace_writer):
        table = MagicMock()
        trace_writer._table = table
        long_text = "x" * 3000
        trace_writer.write_agent_turn(
            turn=1, model="c4", thinking=long_text, text="", tool_calls_count=0
        )
        item = table.put_item.call_args[1]["Item"]
        # 3000 chars fits inside the 4 KB trace cap → returned verbatim,
        # no "..." suffix appended.
        assert item["metadata"]["thinking_preview"] == long_text

    def test_trace_still_caps_at_4096_plus_ellipsis(self, trace_writer):
        table = MagicMock()
        trace_writer._table = table
        long_text = "y" * 5000
        trace_writer.write_agent_turn(
            turn=1, model="c4", thinking=long_text, text="", tool_calls_count=0
        )
        item = table.put_item.call_args[1]["Item"]
        preview = item["metadata"]["thinking_preview"]
        # 4096 content chars + "..." = 4099. Assert the prefix content so
        # a regression that kept the last 4096 (instead of the first)
        # surfaces here instead of passing silently.
        assert len(preview) == 4099
        assert preview[:4096] == "y" * 4096
        assert preview.endswith("...")

    @pytest.mark.parametrize(
        "length,expected_len,has_ellipsis",
        [
            (4095, 4095, False),  # below cap: passes through verbatim
            (4096, 4096, False),  # exactly at cap (``<= max_len`` branch)
            (4097, 4099, True),  # one over: truncated with ellipsis
        ],
    )
    def test_trace_cap_boundary_conditions(self, trace_writer, length, expected_len, has_ellipsis):
        # Lock the ``<=`` vs ``<`` off-by-one at the exact cap boundary.
        table = MagicMock()
        trace_writer._table = table
        trace_writer.write_agent_milestone("m", "x" * length)
        preview = table.put_item.call_args[1]["Item"]["metadata"]["details"]
        assert len(preview) == expected_len
        assert preview.endswith("...") is has_ellipsis

    @pytest.mark.parametrize(
        "length,expected_len,has_ellipsis",
        [
            (199, 199, False),
            (200, 200, False),
            (201, 203, True),
        ],
    )
    def test_normal_cap_boundary_conditions(
        self,
        normal_writer,
        length,
        expected_len,
        has_ellipsis,
    ):
        # Same off-by-one guard on the default 200-char path.
        table = MagicMock()
        normal_writer._table = table
        normal_writer.write_agent_milestone("m", "x" * length)
        preview = table.put_item.call_args[1]["Item"]["metadata"]["details"]
        assert len(preview) == expected_len
        assert preview.endswith("...") is has_ellipsis

    def test_normal_writer_default_200_char_cap_preserved(self, normal_writer):
        # Regression guard: trace=False must keep the 200-char cap.
        table = MagicMock()
        normal_writer._table = table
        long_text = "z" * 500
        normal_writer.write_agent_turn(
            turn=1, model="c4", thinking=long_text, text="", tool_calls_count=0
        )
        item = table.put_item.call_args[1]["Item"]
        preview = item["metadata"]["thinking_preview"]
        assert len(preview) == 203  # 200 + "..."

    def test_trace_flag_applies_to_all_preview_fields(self, trace_writer):
        # Cover every preview site so a future ``write_agent_X`` that
        # forgets ``self._preview(...)`` gets caught.
        table = MagicMock()
        trace_writer._table = table
        long = "L" * 1000

        trace_writer.write_agent_tool_call(tool_name="Bash", tool_input=long, turn=1)
        assert table.put_item.call_args[1]["Item"]["metadata"]["tool_input_preview"] == long

        trace_writer.write_agent_tool_result(tool_name="Bash", is_error=False, content=long, turn=1)
        assert table.put_item.call_args[1]["Item"]["metadata"]["content_preview"] == long

        trace_writer.write_agent_milestone("ms", long)
        assert table.put_item.call_args[1]["Item"]["metadata"]["details"] == long

        trace_writer.write_agent_error("E", long)
        assert table.put_item.call_args[1]["Item"]["metadata"]["message_preview"] == long

    def test_two_writers_in_same_process_have_independent_caps(self, normal_writer, trace_writer):
        # Per-instance cap — not a mutable module global.
        normal_table = MagicMock()
        trace_table = MagicMock()
        normal_writer._table = normal_table
        trace_writer._table = trace_table

        long = "x" * 1000
        normal_writer.write_agent_milestone("n", long)
        trace_writer.write_agent_milestone("t", long)

        n_details = normal_table.put_item.call_args[1]["Item"]["metadata"]["details"]
        t_details = trace_table.put_item.call_args[1]["Item"]["metadata"]["details"]
        assert len(n_details) == 203  # 200 + "..."
        assert t_details == long  # under 4096, full pass-through


# ---------------------------------------------------------------------------
# _ProgressWriter — fail-open behavior
# ---------------------------------------------------------------------------


class TestProgressWriterFailOpen:
    @pytest.fixture()
    def writer(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        return _ProgressWriter("task-fail")

    @pytest.fixture()
    def failing_table(self, writer):
        table = MagicMock()
        table.put_item.side_effect = Exception("DDB unavailable")
        writer._table = table
        return table

    def test_single_failure_does_not_raise(self, writer, failing_table):
        writer.write_agent_milestone("test", "")
        # No exception raised
        assert writer._failure_count == 1
        assert writer._disabled is False

    def test_circuit_breaker_disables_after_max_failures(self, writer, failing_table):
        for _ in range(3):
            writer.write_agent_milestone("test", "")
        assert writer._disabled is True
        assert writer._failure_count == 3

    def test_no_writes_after_circuit_breaker(self, writer, failing_table):
        for _ in range(3):
            writer.write_agent_milestone("test", "")
        assert writer._disabled is True

        # Reset mock to track new calls
        failing_table.put_item.reset_mock()
        writer.write_agent_milestone("test", "")
        failing_table.put_item.assert_not_called()

    def test_success_resets_failure_count(self, writer):
        table = MagicMock()
        # Fail once, then succeed
        table.put_item.side_effect = [Exception("fail"), None]
        writer._table = table

        writer.write_agent_milestone("test1", "")
        assert writer._failure_count == 1

        writer.write_agent_milestone("test2", "")
        assert writer._failure_count == 0


# ---------------------------------------------------------------------------
# _ProgressWriter — lazy boto3 init
# ---------------------------------------------------------------------------


class TestProgressWriterLazyInit:
    def test_boto3_imported_lazily(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        pw = _ProgressWriter("task-lazy")
        # Table should not be initialized until first write
        assert pw._table is None

    def test_boto3_import_error_disables(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        pw = _ProgressWriter("task-no-boto")

        with patch.dict("sys.modules", {"boto3": None}):
            pw.write_agent_milestone("test", "")

        assert pw._disabled is True
