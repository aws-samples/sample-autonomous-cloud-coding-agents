# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from __future__ import annotations

import asyncio
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from hooks import pre_tool_use_hook
from policy import PolicyEngine
from progress_writer import (
    BLOCKER_KINDS,
    _classify_ddb_error,
    _generate_ulid,
    _ProgressWriter,
    _reset_circuit_breakers,
    _truncate_preview,
    format_blocker_reason,
)


@pytest.fixture(autouse=True)
def _reset_shared_circuit_breaker_state():
    _reset_circuit_breakers()
    yield
    _reset_circuit_breakers()


class TestGenerateUlid:
    def test_length_is_26(self):
        assert len(_generate_ulid()) == 26

    def test_monotonic_ordering_across_milliseconds(self):
        import time

        ids = []
        for _ in range(5):
            ids.append(_generate_ulid())
            time.sleep(0.002)
        assert ids == sorted(ids)

    def test_uniqueness(self):
        ids = {_generate_ulid() for _ in range(100)}
        assert len(ids) == 100


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
        assert len(result) <= 203
        assert result.endswith("...")

    def test_custom_max_len(self):
        result = _truncate_preview("abcdef", max_len=3)
        assert result == "abc..."

    def test_exact_length_not_truncated(self):
        s = "a" * 200
        assert _truncate_preview(s) == s


class TestProgressWriterInit:
    def test_noop_when_env_var_unset(self, monkeypatch):
        monkeypatch.delenv("TASK_EVENTS_TABLE_NAME", raising=False)
        pw = _ProgressWriter("task-1")
        pw.write_agent_milestone("test", "detail")
        assert pw._table_name is None
        assert pw._table is None

    def test_enabled_when_env_var_set(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "my-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        pw = _ProgressWriter("task-1")
        assert pw._table_name == "my-table"
        assert pw._disabled is False


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

    def test_write_agent_blocked_event_shape(self, writer, mock_table):
        writer.write_agent_blocked(
            kind="egress_denied",
            detail="connection to registry.npmjs.org refused",
            remediation_hint="allowlist registry.npmjs.org in DNS Firewall",
            retryable=False,
            resource="registry.npmjs.org",
        )
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["event_type"] == "agent_blocked"
        meta = item["metadata"]
        assert meta["kind"] == "egress_denied"
        assert meta["detail"] == "connection to registry.npmjs.org refused"
        assert meta["remediation_hint"] == "allowlist registry.npmjs.org in DNS Firewall"
        assert meta["retryable"] is False
        assert meta["resource"] == "registry.npmjs.org"

    def test_write_agent_blocked_omits_resource_when_absent(self, writer, mock_table):
        writer.write_agent_blocked(
            kind="policy_fail_closed",
            detail="Cedar engine unavailable",
            remediation_hint="check policy engine health",
            retryable=False,
        )
        meta = mock_table.put_item.call_args[1]["Item"]["metadata"]
        assert "resource" not in meta

    def test_write_agent_blocked_normalises_unknown_kind(self, writer, mock_table):
        writer.write_agent_blocked(
            kind="not_a_real_kind",
            detail="something odd",
            remediation_hint="investigate",
            retryable=False,
        )
        meta = mock_table.put_item.call_args[1]["Item"]["metadata"]
        assert meta["kind"] == "unknown_environmental"

    def test_write_agent_blocked_truncates_detail(self, writer, mock_table):
        writer.write_agent_blocked(
            kind="dependency_unreachable",
            detail="x" * 500,
            remediation_hint="y" * 500,
            retryable=True,
        )
        meta = mock_table.put_item.call_args[1]["Item"]["metadata"]
        assert len(meta["detail"]) <= 203
        assert len(meta["remediation_hint"]) <= 203

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


class TestCorrelationEnvelope:
    def _writer(self, monkeypatch, **kwargs):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        writer = _ProgressWriter("task-42", **kwargs)
        writer._table = MagicMock()
        return writer

    def test_stamps_user_repo_trace_when_present(self, monkeypatch):
        writer = self._writer(monkeypatch, user_id="user-1", repo="org/repo")
        with patch("progress_writer.current_otel_trace_id", return_value="a" * 32):
            writer.write_agent_milestone("m", "")
        item = writer._table.put_item.call_args[1]["Item"]
        assert item["user_id"] == "user-1"
        assert item["repo"] == "org/repo"
        assert item["trace_id"] == "a" * 32

    def test_repo_less_omits_repo(self, monkeypatch):
        writer = self._writer(monkeypatch, user_id="user-1", repo=None)
        with patch("progress_writer.current_otel_trace_id", return_value="b" * 32):
            writer.write_agent_milestone("m", "")
        item = writer._table.put_item.call_args[1]["Item"]
        assert item["user_id"] == "user-1"
        assert "repo" not in item

    def test_missing_trace_id_omits_key(self, monkeypatch):
        writer = self._writer(monkeypatch, user_id="user-1", repo="org/repo")
        with patch("progress_writer.current_otel_trace_id", return_value=None):
            writer.write_agent_milestone("m", "")
        item = writer._table.put_item.call_args[1]["Item"]
        assert "trace_id" not in item

    def test_defaults_omit_all_correlation_keys(self, monkeypatch):
        writer = self._writer(monkeypatch)
        with patch("progress_writer.current_otel_trace_id", return_value=None):
            writer.write_agent_milestone("m", "")
        item = writer._table.put_item.call_args[1]["Item"]
        assert "user_id" not in item
        assert "repo" not in item
        assert "trace_id" not in item


class TestProgressWriterTrace:
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
        assert len(preview) == 4099
        assert preview[:4096] == "y" * 4096
        assert preview.endswith("...")

    @pytest.mark.parametrize(
        "length,expected_len,has_ellipsis",
        [
            (4095, 4095, False),
            (4096, 4096, False),
            (4097, 4099, True),
        ],
    )
    def test_trace_cap_boundary_conditions(self, trace_writer, length, expected_len, has_ellipsis):
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
        table = MagicMock()
        normal_writer._table = table
        normal_writer.write_agent_milestone("m", "x" * length)
        preview = table.put_item.call_args[1]["Item"]["metadata"]["details"]
        assert len(preview) == expected_len
        assert preview.endswith("...") is has_ellipsis

    def test_normal_writer_default_200_char_cap_preserved(self, normal_writer):
        table = MagicMock()
        normal_writer._table = table
        long_text = "z" * 500
        normal_writer.write_agent_turn(
            turn=1, model="c4", thinking=long_text, text="", tool_calls_count=0
        )
        item = table.put_item.call_args[1]["Item"]
        preview = item["metadata"]["thinking_preview"]
        assert len(preview) == 203

    def test_trace_flag_applies_to_all_preview_fields(self, trace_writer):
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
        normal_table = MagicMock()
        trace_table = MagicMock()
        normal_writer._table = normal_table
        trace_writer._table = trace_table

        long = "x" * 1000
        normal_writer.write_agent_milestone("n", long)
        trace_writer.write_agent_milestone("t", long)

        n_details = normal_table.put_item.call_args[1]["Item"]["metadata"]["details"]
        t_details = trace_table.put_item.call_args[1]["Item"]["metadata"]["details"]
        assert len(n_details) == 203
        assert t_details == long


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

        failing_table.put_item.reset_mock()
        writer.write_agent_milestone("test", "")
        failing_table.put_item.assert_not_called()

    def test_success_resets_failure_count(self, writer):
        table = MagicMock()
        table.put_item.side_effect = [Exception("fail"), None]
        writer._table = table

        writer.write_agent_milestone("test1", "")
        assert writer._failure_count == 1

        writer.write_agent_milestone("test2", "")
        assert writer._failure_count == 0


class TestProgressWriterLazyInit:
    def test_boto3_imported_lazily(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        pw = _ProgressWriter("task-lazy")
        assert pw._table is None

    def test_boto3_import_error_disables(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        pw = _ProgressWriter("task-no-boto")

        with patch.dict("sys.modules", {"boto3": None}):
            pw.write_agent_milestone("test", "")

        assert pw._disabled is True


def _make_client_error(code: str, message: str = "boom") -> Exception:
    err = Exception(message)
    setattr(  # noqa: B010 — intentional dynamic attr to duck-type ClientError
        err,
        "response",
        {
            "Error": {"Code": code, "Message": message},
            "ResponseMetadata": {"HTTPStatusCode": 400},
        },
    )
    return err


class TestClassifyDdbError:
    @pytest.mark.parametrize(
        "code",
        [
            "ValidationException",
            "ItemCollectionSizeLimitExceededException",
            "ResourceNotFoundException",
            "AccessDeniedException",
            "UnauthorizedOperation",
        ],
    )
    def test_permanent_aws_codes(self, code):
        assert _classify_ddb_error(_make_client_error(code)) == "permanent"

    @pytest.mark.parametrize(
        "code",
        [
            "ProvisionedThroughputExceededException",
            "RequestLimitExceeded",
            "ThrottlingException",
            "ServiceUnavailable",
            "InternalServerError",
        ],
    )
    def test_transient_aws_codes(self, code):
        assert _classify_ddb_error(_make_client_error(code)) == "transient"

    def test_unknown_aws_code_falls_through_to_unknown(self):
        assert _classify_ddb_error(_make_client_error("SomeNewException")) == "unknown"

    def test_network_class_name_treated_as_transient(self):
        class EndpointConnectionError(Exception):
            pass

        assert _classify_ddb_error(EndpointConnectionError("no route to host")) == "transient"

    def test_arbitrary_exception_is_unknown(self):
        assert _classify_ddb_error(RuntimeError("wat")) == "unknown"


class TestProgressWriterFailOpenClassified:
    @pytest.fixture()
    def writer(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        return _ProgressWriter("task-finding6")

    def test_permanent_error_does_not_trip_breaker(self, writer):
        table = MagicMock()
        table.put_item.side_effect = _make_client_error("ValidationException")
        writer._table = table

        for _ in range(10):
            writer.write_agent_milestone("test", "")

        assert writer._failure_count == 0, "Permanent errors must not increment the shared counter"
        assert writer._disabled is False, (
            "ValidationException must keep the stream alive for smaller events"
        )

    def test_transient_error_trips_breaker_as_before(self, writer):
        table = MagicMock()
        table.put_item.side_effect = _make_client_error("ProvisionedThroughputExceededException")
        writer._table = table

        for _ in range(_ProgressWriter._MAX_FAILURES):
            writer.write_agent_milestone("test", "")

        assert writer._disabled is True
        assert writer._failure_count == _ProgressWriter._MAX_FAILURES

    def test_access_denied_disables_writer_immediately_with_loud_log(self, writer, capsys):
        table = MagicMock()
        table.put_item.side_effect = _make_client_error("AccessDeniedException")
        writer._table = table

        writer.write_agent_milestone("test", "")

        assert writer._disabled is True, (
            "AccessDeniedException must flip the breaker on first occurrence"
        )
        captured = capsys.readouterr()
        assert "permanent error" in captured.out.lower()
        assert "AccessDeniedException" in captured.out
        assert "disabling" in captured.out.lower()

    def test_resource_not_found_disables_writer_immediately(self, writer):
        table = MagicMock()
        table.put_item.side_effect = _make_client_error("ResourceNotFoundException")
        writer._table = table

        writer.write_agent_milestone("test", "")

        assert writer._disabled is True

    def test_unknown_exception_treated_as_transient_with_error_log(self, writer, capsys):
        table = MagicMock()
        table.put_item.side_effect = RuntimeError("mystery")
        writer._table = table

        writer.write_agent_milestone("test", "")

        assert writer._failure_count == 1
        assert writer._disabled is False
        captured = capsys.readouterr()
        assert "ERROR" in captured.out
        assert "UNKNOWN" in captured.out


class TestSharedCircuitBreaker:
    @pytest.fixture()
    def env(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

    def test_shared_circuit_breaker_across_writers_same_task_id(self, env):
        w1 = _ProgressWriter("task-shared")
        w2 = _ProgressWriter("task-shared")

        t1 = MagicMock()
        t1.put_item.side_effect = _make_client_error("ProvisionedThroughputExceededException")
        w1._table = t1

        for _ in range(_ProgressWriter._MAX_FAILURES):
            w1.write_agent_milestone("turn", "")

        assert w1._disabled is True
        assert w2._disabled is True, "Shared breaker must also disable the sibling writer"

        t2 = MagicMock()
        w2._table = t2
        w2.write_agent_milestone("milestone", "")
        t2.put_item.assert_not_called()

    def test_separate_tasks_have_independent_breakers(self, env):
        w_a = _ProgressWriter("task-a")
        w_b = _ProgressWriter("task-b")

        t_a = MagicMock()
        t_a.put_item.side_effect = _make_client_error("ProvisionedThroughputExceededException")
        w_a._table = t_a

        for _ in range(_ProgressWriter._MAX_FAILURES):
            w_a.write_agent_milestone("x", "")
        assert w_a._disabled is True

        assert w_b._disabled is False
        assert w_b._failure_count == 0

        t_b = MagicMock()
        w_b._table = t_b
        w_b.write_agent_milestone("y", "")
        t_b.put_item.assert_called_once()

    def test_unknown_sentinel_task_id_is_isolated(self, env):
        w_real = _ProgressWriter("task-real")
        w_unknown = _ProgressWriter("unknown")

        t = MagicMock()
        t.put_item.side_effect = _make_client_error("ProvisionedThroughputExceededException")
        w_unknown._table = t

        for _ in range(_ProgressWriter._MAX_FAILURES):
            w_unknown.write_agent_milestone("x", "")
        assert w_unknown._disabled is True

        assert w_real._disabled is False

    def test_reset_helper_clears_shared_state_between_tests(self, env):
        w = _ProgressWriter("task-reset")
        t = MagicMock()
        t.put_item.side_effect = _make_client_error("ProvisionedThroughputExceededException")
        w._table = t
        for _ in range(_ProgressWriter._MAX_FAILURES):
            w.write_agent_milestone("x", "")
        assert w._disabled is True

        _reset_circuit_breakers()
        w2 = _ProgressWriter("task-reset")
        assert w2._disabled is False
        assert w2._failure_count == 0

    def test_success_on_one_writer_resets_shared_counter(self, env):
        w1 = _ProgressWriter("task-share-success")
        w2 = _ProgressWriter("task-share-success")

        t1 = MagicMock()
        t1.put_item.side_effect = _make_client_error("ProvisionedThroughputExceededException")
        w1._table = t1
        w1.write_agent_milestone("turn", "")
        assert w1._failure_count == 1

        t2 = MagicMock()
        w2._table = t2
        w2.write_agent_milestone("milestone", "")
        assert w1._failure_count == 0
        assert w2._failure_count == 0

    def test_permanent_error_on_one_writer_does_not_affect_sibling_breaker(self, env):
        w1 = _ProgressWriter("task-perm-cross")
        w2 = _ProgressWriter("task-perm-cross")

        t1 = MagicMock()
        t1.put_item.side_effect = _make_client_error("ValidationException")
        w1._table = t1
        for _ in range(10):
            w1.write_agent_milestone("oversized", "x" * 10)
        assert w1._disabled is False

        t2 = MagicMock()
        w2._table = t2
        w2.write_agent_milestone("normal", "y")
        t2.put_item.assert_called_once()


class TestApprovalMilestoneHelpers:
    @pytest.fixture()
    def writer(self, monkeypatch):
        monkeypatch.setenv("TASK_EVENTS_TABLE_NAME", "events-table")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        w = _ProgressWriter("task-approval")
        w._table = MagicMock()
        return w

    def _last_event(self, writer) -> tuple[str, dict]:
        call = writer._table.put_item.call_args
        assert call is not None, "put_item not called"
        item = call.kwargs.get("Item") or call.args[0]
        return item["event_type"], item["metadata"]

    def test_pre_approvals_loaded(self, writer):
        writer.write_approval_pre_approvals_loaded(count=2, scopes=["tool_type:Read", "rule:foo"])
        event_type, metadata = self._last_event(writer)
        assert event_type == "agent_milestone"
        assert metadata["milestone"] == "pre_approvals_loaded"
        assert metadata["count"] == 2
        assert metadata["scopes"] == ["tool_type:Read", "rule:foo"]

    def test_approval_requested(self, writer):
        writer.write_approval_requested(
            request_id="01KREQ",
            tool_name="Bash",
            input_preview="git push --force",
            reason="Soft-deny: force_push_any",
            severity="high",
            timeout_s=300,
            matching_rule_ids=["force_push_any"],
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_requested"
        assert metadata["request_id"] == "01KREQ"
        assert metadata["tool_name"] == "Bash"
        assert metadata["input_preview"] == "git push --force"
        assert metadata["severity"] == "high"
        assert metadata["timeout_s"] == 300
        assert metadata["matching_rule_ids"] == ["force_push_any"]

    def test_approval_requested_truncates_long_preview(self, writer):
        long_preview = "x" * 5000
        writer.write_approval_requested(
            request_id="01KREQ",
            tool_name="Bash",
            input_preview=long_preview,
            reason="Soft-deny: force_push_any",
            severity="high",
            timeout_s=300,
            matching_rule_ids=[],
        )
        _, metadata = self._last_event(writer)
        assert len(metadata["input_preview"]) <= 210

    def test_approval_granted(self, writer):
        writer.write_approval_granted(
            request_id="01KREQ", scope="tool_type:Read", decided_at="2026-05-07T00:00:00Z"
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_granted"
        assert metadata["request_id"] == "01KREQ"
        assert metadata["scope"] == "tool_type:Read"
        assert metadata["decided_at"] == "2026-05-07T00:00:00Z"

    def test_approval_denied(self, writer):
        writer.write_approval_denied(
            request_id="01KREQ", reason="build the Makefile target first", decided_at=None
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_denied"
        assert metadata["request_id"] == "01KREQ"
        assert metadata["reason"] == "build the Makefile target first"
        assert metadata["decided_at"] is None

    def test_approval_timed_out(self, writer):
        writer.write_approval_timed_out(request_id="01KREQ", timeout_s=300)
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_timed_out"
        assert metadata["request_id"] == "01KREQ"
        assert metadata["timeout_s"] == 300

    def test_approval_granted_includes_created_at_when_supplied(self, writer):
        writer.write_approval_granted(
            request_id="01KREQ",
            scope="tool_type:Read",
            decided_at="2026-05-07T00:00:05Z",
            created_at="2026-05-07T00:00:00Z",
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_granted"
        assert metadata["created_at"] == "2026-05-07T00:00:00Z"
        assert metadata["decided_at"] == "2026-05-07T00:00:05Z"

    def test_approval_granted_omits_created_at_when_absent(self, writer):
        writer.write_approval_granted(
            request_id="01KREQ",
            scope="tool_type:Read",
            decided_at="2026-05-07T00:00:05Z",
        )
        _, metadata = self._last_event(writer)
        assert "created_at" not in metadata

    def test_approval_denied_includes_created_at_when_supplied(self, writer):
        writer.write_approval_denied(
            request_id="01KREQ",
            reason="build the Makefile target first",
            decided_at="2026-05-07T00:00:05Z",
            created_at="2026-05-07T00:00:00Z",
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_denied"
        assert metadata["created_at"] == "2026-05-07T00:00:00Z"

    def test_approval_denied_omits_created_at_when_absent(self, writer):
        writer.write_approval_denied(
            request_id="01KREQ",
            reason="build the Makefile target first",
            decided_at=None,
        )
        _, metadata = self._last_event(writer)
        assert "created_at" not in metadata

    def test_approval_timed_out_includes_8a_fields_when_supplied(self, writer):
        writer.write_approval_timed_out(
            request_id="01KREQ",
            timeout_s=300,
            created_at="2026-05-07T00:00:00Z",
            effective_timeout_s=120,
            matching_rule_ids=["deny-force-push", "escalate-credentials"],
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_timed_out"
        assert metadata["timeout_s"] == 300
        assert metadata["created_at"] == "2026-05-07T00:00:00Z"
        assert metadata["effective_timeout_s"] == 120
        assert metadata["matching_rule_ids"] == [
            "deny-force-push",
            "escalate-credentials",
        ]

    def test_approval_timed_out_omits_8a_fields_when_absent(self, writer):
        writer.write_approval_timed_out(request_id="01KREQ", timeout_s=300)
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_timed_out"
        assert "created_at" not in metadata
        assert "effective_timeout_s" not in metadata
        assert "matching_rule_ids" not in metadata

    def test_approval_timed_out_matching_rule_ids_list_copy(self, writer):
        rule_ids = ["a", "b"]
        writer.write_approval_timed_out(
            request_id="01KREQ", timeout_s=300, matching_rule_ids=rule_ids
        )
        rule_ids.append("c")
        _, metadata = self._last_event(writer)
        assert metadata["matching_rule_ids"] == ["a", "b"]

    def test_approval_stranded(self, writer):
        writer.write_approval_stranded(request_id="01KREQ", age_s=600, reason="container evicted")
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_stranded"
        assert metadata["age_s"] == 600
        assert metadata["reason"] == "container evicted"

    def test_approval_write_failed(self, writer):
        writer.write_approval_write_failed(request_id="01KREQ", error="TransactionCanceled")
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_write_failed"
        assert metadata["request_id"] == "01KREQ"
        assert metadata["error"] == "TransactionCanceled"

    def test_approval_write_failed_request_id_may_be_none(self, writer):
        writer.write_approval_write_failed(request_id=None, error="boom")
        _, metadata = self._last_event(writer)
        assert metadata["request_id"] is None

    def test_approval_resume_failed(self, writer):
        writer.write_approval_resume_failed(request_id="01KREQ", error="task cancelled")
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_resume_failed"

    def test_approval_poll_degraded(self, writer):
        writer.write_approval_poll_degraded(request_id="01KREQ", consecutive_failures=3)
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_poll_degraded"
        assert metadata["consecutive_failures"] == 3

    def test_approval_timeout_capped_rule_annotation(self, writer):
        writer.write_approval_timeout_capped(
            request_id="01KREQ",
            requested_timeout_s=600,
            effective_timeout_s=300,
            reason="rule_annotation",
            matching_rule_ids=["write_credentials"],
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_timeout_capped"
        assert metadata["reason"] == "rule_annotation"
        assert metadata["matching_rule_ids"] == ["write_credentials"]

    def test_approval_timeout_capped_maxlifetime_omits_rule_ids(self, writer):
        writer.write_approval_timeout_capped(
            request_id="01KREQ",
            requested_timeout_s=600,
            effective_timeout_s=120,
            reason="maxLifetime_ceiling",
        )
        _, metadata = self._last_event(writer)
        assert metadata["reason"] == "maxLifetime_ceiling"
        assert "matching_rule_ids" not in metadata

    def test_approval_ceiling_shrinking(self, writer):
        writer.write_approval_ceiling_shrinking(
            request_id="01KREQ",
            max_lifetime_remaining_s=900,
            cleanup_margin_s=120,
            task_default_timeout_s=300,
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_ceiling_shrinking"
        assert metadata["maxLifetime_remaining_s"] == 900
        assert metadata["cleanup_margin_s"] == 120
        assert metadata["task_default_timeout_s"] == 300

    def test_approval_cap_exceeded(self, writer):
        writer.write_approval_cap_exceeded(request_id="01KREQ", count=50, cap=50)
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_cap_exceeded"
        assert metadata["count"] == 50
        assert metadata["cap"] == 50

    def test_approval_rate_limit_exceeded(self, writer):
        writer.write_approval_rate_limit_exceeded(request_id="01KREQ", rate=20, limit=20)
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_rate_limit_exceeded"
        assert metadata["rate"] == 20
        assert metadata["limit"] == 20

    def test_approval_late_win(self, writer):
        writer.write_approval_late_win(
            request_id="01KREQ",
            outcome="APPROVED",
            reason="user decision landed during TIMED_OUT write",
        )
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "approval_late_win"
        assert metadata["outcome"] == "APPROVED"
        assert metadata["reason"] == "user decision landed during TIMED_OUT write"

    def test_policy_decision_cached(self, writer):
        writer.write_policy_decision_cached(
            tool_name="Bash",
            tool_input_sha256="abcdef123456",
            cached_decision="DENIED",
            cached_reason="user said force-push is too risky",
            original_decision_ts="2026-05-07T12:00:00Z",
        )
        event_type, metadata = self._last_event(writer)
        assert event_type == "agent_milestone"
        assert metadata["milestone"] == "policy_decision"
        assert metadata["decision_source"] == "recent_decision_cache"
        assert metadata["tool_name"] == "Bash"
        assert metadata["tool_input_sha256"] == "abcdef123456"
        assert metadata["cached_decision"] == "DENIED"
        assert metadata["cached_reason"] == "user said force-push is too risky"
        assert metadata["original_decision_ts"] == "2026-05-07T12:00:00Z"
        assert "matched_rule_id" not in metadata

    def test_policy_decision_cached_truncates_long_reason(self, writer):
        writer.write_policy_decision_cached(
            tool_name="Bash",
            tool_input_sha256="abc",
            cached_decision="TIMED_OUT",
            cached_reason="x" * 5000,
            original_decision_ts="2026-05-07T12:00:00Z",
        )
        _, metadata = self._last_event(writer)
        assert len(metadata["cached_reason"]) <= 210

    def test_rule_level_cache_hit_reaches_the_event_stream(self, writer):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine.recent_decisions.record_rule_decision(
            "Bash",
            "force_push_any",
            "DENIED",
            "no force pushes",
            original_decision_ts="2026-05-12T19:00:00Z",
        )
        result = asyncio.run(
            pre_tool_use_hook(
                {"tool_name": "Bash", "tool_input": {"command": "git push --force origin b"}},
                "tu-1",
                {},
                engine=engine,
                progress=writer,
            )
        )
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
        _, metadata = self._last_event(writer)
        assert metadata["milestone"] == "policy_decision"
        assert metadata["decision_source"] == "recent_decision_cache"
        assert metadata["matched_rule_id"] == "force_push_any"
        assert metadata["cached_reason"] == "no force pushes"
        assert metadata["original_decision_ts"] == "2026-05-12T19:00:00Z"


class TestFormatBlockerReason:
    def test_basic_format(self):
        assert format_blocker_reason("missing_secret", "no OPENAI_API_KEY") == (
            "BLOCKED[missing_secret]: no OPENAI_API_KEY"
        )

    def test_appends_resource_when_set(self):
        assert (
            format_blocker_reason("egress_denied", "host blocked", resource="pypi.org")
            == "BLOCKED[egress_denied]: host blocked (resource: pypi.org)"
        )

    def test_unknown_kind_falls_back(self):
        assert format_blocker_reason("bogus", "detail").startswith(
            "BLOCKED[unknown_environmental]:"
        )

    def test_every_kind_round_trips(self):
        for kind in BLOCKER_KINDS:
            reason = format_blocker_reason(kind, "detail", resource="res")
            assert reason.startswith(f"BLOCKED[{kind}]:")
            assert reason.endswith("(resource: res)")
