"""Unit tests for pure functions in task_state.py."""

from unittest.mock import MagicMock

import pytest

import task_state
from task_state import TaskFetchError, _build_logs_url, _now_iso


class TestNowIso:
    def test_format(self):
        result = _now_iso()
        # ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ
        assert len(result) == 20
        assert result[4] == "-"
        assert result[10] == "T"
        assert result.endswith("Z")


class TestBuildLogsUrl:
    def test_returns_none_without_region(self, monkeypatch):
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
        monkeypatch.setenv("LOG_GROUP_NAME", "/aws/logs/test")
        assert _build_logs_url("task-123") is None

    def test_returns_none_without_log_group(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
        assert _build_logs_url("task-123") is None

    def test_returns_url(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("LOG_GROUP_NAME", "/aws/logs/test")
        url = _build_logs_url("task-123")
        assert url is not None
        assert "us-east-1" in url
        assert "task-123" in url
        assert "cloudwatch" in url

    def test_encodes_slashes(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("LOG_GROUP_NAME", "/aws/vendedlogs/runtime/APP")
        url = _build_logs_url("t1")
        assert url is not None
        # Slashes in log group are encoded as $252F
        assert "$252F" in url

    def test_uses_default_region(self, monkeypatch):
        monkeypatch.delenv("AWS_REGION", raising=False)
        monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-west-1")
        monkeypatch.setenv("LOG_GROUP_NAME", "/test")
        url = _build_logs_url("t1")
        assert url is not None
        assert "eu-west-1" in url


class TestGetTask:
    """Verify the NotFound vs FetchFailed distinction.

    Callers must be able to tell "record doesn't exist" (``None``) from
    "couldn't read it" (``TaskFetchError``). Collapsing the two to ``None``
    would let a transient DDB blip look like a legitimate absence.
    """

    def test_returns_none_when_no_table(self, monkeypatch):
        monkeypatch.setattr(task_state, "_get_table", lambda: None)
        assert task_state.get_task("t-any") is None

    def test_returns_item_when_found(self, monkeypatch):
        class _FakeTable:
            def get_item(self, Key):
                assert Key == {"task_id": "t-present"}
                return {"Item": {"task_id": "t-present", "status": "RUNNING"}}

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        item = task_state.get_task("t-present")
        assert item == {"task_id": "t-present", "status": "RUNNING"}

    def test_returns_none_when_item_absent(self, monkeypatch):
        class _FakeTable:
            def get_item(self, Key):
                return {}  # DDB returns no "Item" key when not found.

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        assert task_state.get_task("t-missing") is None

    def test_raises_TaskFetchError_on_ddb_failure(self, monkeypatch):
        class _FakeTable:
            def get_item(self, Key):
                raise RuntimeError("ProvisionedThroughputExceededException")

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        with pytest.raises(TaskFetchError) as exc_info:
            task_state.get_task("t-throttled")
        assert "ProvisionedThroughputExceededException" in str(exc_info.value)


class TestWriteSessionInfo:
    """Rev-5 OBS-4: interactive path writes session_id + agent_runtime_arn."""

    def test_writes_session_id_and_arn(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())

        task_state.write_session_info(
            "t-interactive",
            "sess-abc123",
            "arn:aws:bedrock-agentcore:us-east-1:123:runtime/jwt-xyz",
        )

        assert len(calls) == 1
        call = calls[0]
        assert call["Key"] == {"task_id": "t-interactive"}
        assert "session_id = :sid" in call["UpdateExpression"]
        assert "agent_runtime_arn = :arn" in call["UpdateExpression"]
        assert "compute_type = :ct" in call["UpdateExpression"]
        assert "compute_metadata = :cm" in call["UpdateExpression"]
        values = call["ExpressionAttributeValues"]
        assert values[":sid"] == "sess-abc123"
        assert values[":arn"] == "arn:aws:bedrock-agentcore:us-east-1:123:runtime/jwt-xyz"
        assert values[":ct"] == "agentcore"
        assert values[":cm"] == {
            "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123:runtime/jwt-xyz"
        }

    def test_noop_when_both_empty(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())

        task_state.write_session_info("t-empty", "", "")
        assert calls == []

    def test_skips_silently_when_task_already_advanced(self, monkeypatch):
        from botocore.exceptions import ClientError

        class _FakeTable:
            def update_item(self, **kwargs):
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException"}},
                    "UpdateItem",
                )

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())

        # Must NOT raise — the conditional failure is expected when the
        # task has already transitioned past SUBMITTED/HYDRATING.
        task_state.write_session_info("t-raced", "sess-x", "arn:x")

    def test_writes_only_session_when_arn_missing(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())

        task_state.write_session_info("t-partial", "sess-only", "")
        assert len(calls) == 1
        assert "session_id = :sid" in calls[0]["UpdateExpression"]
        assert "agent_runtime_arn" not in calls[0]["UpdateExpression"]


class TestWriteRunningMaintainsStatusCreatedAt:
    """Regression guard: ``write_running`` must rewrite ``status_created_at``
    so the ``UserStatusIndex`` GSI sort key reflects the current status.
    Without this, ``bga list`` sorts by the stale SUBMITTED prefix and newly
    running / completed / cancelled tasks appear after stale SUBMITTED rows.
    """

    def test_writes_status_created_at_with_running_prefix(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_running("t-run")

        assert len(calls) == 1
        call = calls[0]
        assert "status_created_at = :sca" in call["UpdateExpression"]
        sca = call["ExpressionAttributeValues"][":sca"]
        assert sca.startswith("RUNNING#")
        # The timestamp after the '#' matches _now_iso()'s ISO-Z format.
        ts = sca.split("#", 1)[1]
        assert ts.endswith("Z")
        assert len(ts) == 20


class TestWriteTerminalMaintainsStatusCreatedAt:
    def test_completed_rewrites_sca_with_completed_prefix(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal("t-done", "COMPLETED")

        assert len(calls) == 1
        call = calls[0]
        assert "status_created_at = :sca" in call["UpdateExpression"]
        sca = call["ExpressionAttributeValues"][":sca"]
        assert sca.startswith("COMPLETED#")

    def test_failed_rewrites_sca_with_failed_prefix(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal("t-fail", "FAILED", {"error": "boom"})

        assert len(calls) == 1
        sca = calls[0]["ExpressionAttributeValues"][":sca"]
        assert sca.startswith("FAILED#")

    def test_sca_and_completed_at_share_timestamp(self, monkeypatch):
        """The SCA timestamp and completed_at should match so operators can
        cross-reference the GSI row against the base table without wondering
        which write happened first."""
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal("t-sync", "COMPLETED")

        values = calls[0]["ExpressionAttributeValues"]
        sca_ts = values[":sca"].split("#", 1)[1]
        completed_at = values[":t"]
        assert sca_ts == completed_at


class TestWriteTerminalTraceS3Uri:
    """K2 Stage 4 — ``write_terminal`` persists ``trace_s3_uri`` from
    the result dict so the ``get-trace-url`` handler (which reads the
    field off the TaskRecord) sees a consistent view the moment the
    task reaches terminal."""

    def test_trace_s3_uri_written_when_present_in_result(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal(
            "t-trace",
            "COMPLETED",
            {"trace_s3_uri": "s3://bucket/traces/u-1/t-trace.jsonl.gz"},
        )
        assert len(calls) == 1
        update_expr = calls[0]["UpdateExpression"]
        assert "trace_s3_uri = :ts3" in update_expr
        values = calls[0]["ExpressionAttributeValues"]
        assert values[":ts3"] == "s3://bucket/traces/u-1/t-trace.jsonl.gz"

    def test_trace_s3_uri_omitted_when_result_has_no_uri(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal(
            "t-plain",
            "COMPLETED",
            {"pr_url": "https://github.com/o/r/pull/1"},
        )
        assert len(calls) == 1
        update_expr = calls[0]["UpdateExpression"]
        assert "trace_s3_uri" not in update_expr
        values = calls[0]["ExpressionAttributeValues"]
        assert ":ts3" not in values

    def test_trace_s3_uri_none_omitted(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal(
            "t-null",
            "COMPLETED",
            {"trace_s3_uri": None},
        )
        update_expr = calls[0]["UpdateExpression"]
        assert "trace_s3_uri" not in update_expr

    def test_conditional_check_failed_with_trace_uri_logs_orphan_diagnostic(
        self,
        monkeypatch,
        capsys,
    ):
        """K2 final review SIG-1: when ``write_terminal``'s precondition
        fails (typically: concurrent cancel) and a ``trace_s3_uri`` was
        already uploaded, the orphaned S3 object needs a dedicated log
        line — otherwise the generic ``skipped: precondition not met``
        message hides silently-lost trace URIs.

        L4 extension: after the orphan log prints, the self-heal
        ``write_trace_uri_conditional`` fires; when the second
        UpdateItem succeeds, the self-heal log also prints."""
        from botocore.exceptions import ClientError

        class _FakeTable:
            def __init__(self):
                self.calls = 0

            def update_item(self, **_kwargs):
                self.calls += 1
                # First call (write_terminal) raises CCF.
                # Second call (self-heal) succeeds.
                if self.calls == 1:
                    raise ClientError(
                        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "!"}},
                        "UpdateItem",
                    )
                return {}

        fake = _FakeTable()
        monkeypatch.setattr(task_state, "_get_table", lambda: fake)
        task_state.write_terminal(
            "t-orphan",
            "COMPLETED",
            {"trace_s3_uri": "s3://bucket/traces/u-1/t-orphan.jsonl.gz"},
        )
        out = capsys.readouterr().out
        # Generic skip message still prints (benign-case compatibility).
        assert "write_terminal skipped" in out
        # And the specific orphan log calls out the URI + actionable
        # detail (7-day lifecycle) so operators can reason about cost.
        assert "orphaned by ConditionalCheckFailed" in out
        assert "s3://bucket/traces/u-1/t-orphan.jsonl.gz" in out
        assert "7-day lifecycle" in out
        # L4: self-heal fired (second update_item call) and logged success.
        assert fake.calls == 2
        assert "self-healed" in out

    def test_conditional_check_failed_without_trace_uri_skips_orphan_log(
        self,
        monkeypatch,
        capsys,
    ):
        """The orphan diagnostic must NOT fire on the common
        benign-cancel case (where no S3 write happened) — otherwise
        operators get log noise that blunts the signal of a real
        orphan."""
        from botocore.exceptions import ClientError

        class _FakeTable:
            def update_item(self, **_kwargs):
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException", "Message": "!"}},
                    "UpdateItem",
                )

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal("t-benign", "COMPLETED", {"pr_url": "https://pr"})
        out = capsys.readouterr().out
        assert "write_terminal skipped" in out
        assert "orphaned" not in out


class TestWriteTraceUriConditional:
    """L4 item 1a — ``write_trace_uri_conditional`` persists
    ``trace_s3_uri`` on an already-terminal record as a self-heal
    after ``write_terminal`` loses a race with cancel / reconciler.

    The helper is scoped to ``attribute_not_exists(trace_s3_uri) AND
    status IN (CANCELLED, COMPLETED, FAILED, TIMED_OUT)`` so it cannot
    clobber an existing URI or write on a non-terminal record."""

    def test_happy_path_writes_uri_and_returns_true(self, monkeypatch):
        """Status=COMPLETED, no existing trace_s3_uri → write succeeds."""
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)
                return {}

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        healed = task_state.write_trace_uri_conditional(
            "t-heal", "s3://bucket/traces/u-1/t-heal.jsonl.gz"
        )
        assert healed is True
        assert len(calls) == 1
        kwargs = calls[0]
        assert kwargs["Key"] == {"task_id": "t-heal"}
        assert kwargs["UpdateExpression"] == "SET trace_s3_uri = :ts3"
        # ConditionExpression must be scoped to both "URI not set" and
        # "status terminal" — either one alone would be unsafe.
        cond = kwargs["ConditionExpression"]
        assert "attribute_not_exists(trace_s3_uri)" in cond
        assert "#s IN" in cond
        assert kwargs["ExpressionAttributeNames"] == {"#s": "status"}
        values = kwargs["ExpressionAttributeValues"]
        assert values[":ts3"] == "s3://bucket/traces/u-1/t-heal.jsonl.gz"
        # All four terminal-status literals must appear in the IN-list
        # (the helper's contract is terminal-agnostic).
        assert values[":cancelled"] == "CANCELLED"
        assert values[":completed"] == "COMPLETED"
        assert values[":failed"] == "FAILED"
        assert values[":timed_out"] == "TIMED_OUT"

    def test_uri_already_present_returns_false_and_logs_info(self, monkeypatch, capsys):
        """``ConditionalCheckFailedException`` → returns False, INFO log (benign)."""
        from botocore.exceptions import ClientError

        class _FakeTable:
            def update_item(self, **_kwargs):
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException", "Message": "!"}},
                    "UpdateItem",
                )

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        healed = task_state.write_trace_uri_conditional(
            "t-already", "s3://bucket/traces/u/t-already.jsonl.gz"
        )
        assert healed is False
        out = capsys.readouterr().out
        assert "write_trace_uri_conditional skipped" in out
        assert "t-already" in out

    def test_non_terminal_status_returns_false(self, monkeypatch):
        """Non-terminal status raises CCF (status IN clause rejects) → False."""
        from botocore.exceptions import ClientError

        class _FakeTable:
            def update_item(self, **_kwargs):
                raise ClientError(
                    {"Error": {"Code": "ConditionalCheckFailedException", "Message": "!"}},
                    "UpdateItem",
                )

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        healed = task_state.write_trace_uri_conditional(
            "t-running", "s3://b/traces/u/t-running.jsonl.gz"
        )
        assert healed is False

    def test_transient_ddb_error_returns_false_and_logs_warn(self, monkeypatch, capsys):
        """A non-CCF ClientError (e.g., throttling) → returns False, WARN log."""
        from botocore.exceptions import ClientError

        class _FakeTable:
            def update_item(self, **_kwargs):
                raise ClientError(
                    {
                        "Error": {
                            "Code": "ProvisionedThroughputExceededException",
                            "Message": "!",
                        }
                    },
                    "UpdateItem",
                )

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        healed = task_state.write_trace_uri_conditional(
            "t-throttle", "s3://b/traces/u/t-throttle.jsonl.gz"
        )
        assert healed is False
        out = capsys.readouterr().out
        assert "write_trace_uri_conditional failed" in out
        # Log surfaces the exception type name to aid triage.
        assert "ClientError" in out

    def test_empty_uri_is_a_noop(self, monkeypatch):
        """Guard: empty URI → no DDB call, returns False."""
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        healed = task_state.write_trace_uri_conditional("t-x", "")
        assert healed is False
        assert calls == []

    def test_empty_task_id_is_a_noop(self, monkeypatch):
        """Guard: empty task_id → no DDB call, returns False."""
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        healed = task_state.write_trace_uri_conditional("", "s3://b/x.gz")
        assert healed is False
        assert calls == []

    def test_no_table_returns_false(self, monkeypatch):
        """When ``_get_table`` returns None (TASK_TABLE_NAME unset) → False."""
        monkeypatch.setattr(task_state, "_get_table", lambda: None)
        healed = task_state.write_trace_uri_conditional("t-x", "s3://b/x.gz")
        assert healed is False


# ---------------------------------------------------------------------------
# Chunk 3: TaskApprovalsTable + AWAITING_APPROVAL transition primitives
# ---------------------------------------------------------------------------


class _FakeClientError(Exception):
    """Minimal ClientError-shaped exception for the task_state tests.

    ``_extract_error_code`` / ``_extract_cancellation_reasons`` duck-type on
    ``exc.response``, so a plain class that carries a response dict lets us
    simulate ``TransactionCanceledException`` /
    ``ConditionalCheckFailedException`` without pulling in botocore.
    """

    def __init__(self, code: str, cancellation_reasons: list | None = None):
        super().__init__(code)
        self.response: dict = {"Error": {"Code": code}}
        if cancellation_reasons is not None:
            self.response["CancellationReasons"] = cancellation_reasons


@pytest.fixture()
def approval_tables_env(monkeypatch):
    """Set both approval-related env vars so _require_tables passes."""
    monkeypatch.setenv("TASK_TABLE_NAME", "task-table")
    monkeypatch.setenv("TASK_APPROVALS_TABLE_NAME", "approvals-table")
    monkeypatch.setenv("AWS_REGION", "us-east-1")


@pytest.fixture()
def approval_row():
    """A §10.1-shaped approval row for the happy-path write test."""
    return {
        "task_id": "01KTASK",
        "request_id": "01KREQ",
        "tool_name": "Bash",
        "tool_input_preview": "git push --force",
        "tool_input_sha256": "a" * 64,
        "reason": "Soft-deny: force_push_any",
        "severity": "high",
        "matching_rule_ids": ["force_push_any"],
        "status": "PENDING",
        "created_at": "2026-05-07T00:00:00Z",
        "timeout_s": 300,
        "ttl": 1_800_000_000,
        "user_id": "u-alice",
        "repo": "owner/repo",
    }


class TestTransactWriteApprovalRequest:
    def test_env_missing_raises(self, monkeypatch, approval_row):
        monkeypatch.delenv("TASK_TABLE_NAME", raising=False)
        monkeypatch.delenv("TASK_APPROVALS_TABLE_NAME", raising=False)
        with pytest.raises(task_state.ApprovalTablesUnavailable):
            task_state.transact_write_approval_request(
                "01KTASK", "01KREQ", approval_row, client=MagicMock()
            )

    def test_happy_path_calls_transact_write_items(self, approval_tables_env, approval_row):
        client = MagicMock()
        client.transact_write_items.return_value = {}

        task_state.transact_write_approval_request("01KTASK", "01KREQ", approval_row, client=client)

        call = client.transact_write_items.call_args
        items = call.kwargs["TransactItems"]
        assert len(items) == 2

        # Item 1 — Put on approvals table with attribute_not_exists(request_id)
        put = items[0]["Put"]
        assert put["TableName"] == "approvals-table"
        assert put["ConditionExpression"] == "attribute_not_exists(request_id)"
        assert put["Item"]["task_id"] == {"S": "01KTASK"}
        assert put["Item"]["request_id"] == {"S": "01KREQ"}
        assert put["Item"]["status"] == {"S": "PENDING"}
        assert put["Item"]["matching_rule_ids"] == {"L": [{"S": "force_push_any"}]}
        assert put["Item"]["timeout_s"] == {"N": "300"}

        # Item 2 — Update on task table with RUNNING precondition
        upd = items[1]["Update"]
        assert upd["TableName"] == "task-table"
        assert upd["Key"] == {"task_id": {"S": "01KTASK"}}
        assert "#s = :running" in upd["ConditionExpression"]
        assert upd["ExpressionAttributeValues"][":awaiting"] == {"S": "AWAITING_APPROVAL"}
        assert upd["ExpressionAttributeValues"][":running"] == {"S": "RUNNING"}
        assert upd["ExpressionAttributeValues"][":rid"] == {"S": "01KREQ"}

    def test_transaction_cancelled_raises_approval_write_error(
        self, approval_tables_env, approval_row
    ):
        client = MagicMock()
        reasons = [{"Code": "ConditionalCheckFailed"}, {"Code": "None"}]
        client.transact_write_items.side_effect = _FakeClientError(
            "TransactionCanceledException", cancellation_reasons=reasons
        )

        with pytest.raises(task_state.ApprovalWriteError) as exc_info:
            task_state.transact_write_approval_request(
                "01KTASK", "01KREQ", approval_row, client=client
            )
        assert exc_info.value.cancellation_reasons == reasons

    def test_other_errors_propagate(self, approval_tables_env, approval_row):
        client = MagicMock()
        client.transact_write_items.side_effect = _FakeClientError(
            "ProvisionedThroughputExceededException"
        )
        with pytest.raises(_FakeClientError):
            task_state.transact_write_approval_request(
                "01KTASK", "01KREQ", approval_row, client=client
            )

    def test_unsupported_row_type_rejected(self, approval_tables_env):
        client = MagicMock()
        # Deliberately malformed row — verifies the runtime guard in
        # ``_py_to_ddb_attr``. The static cast through ``Any`` is needed
        # because ``ApprovalRow`` is a TypedDict (S7); without it ``ty``
        # rejects the malformed dict at compile time, which would
        # defeat the runtime-check this test exists to pin.
        from typing import Any

        bad_row: Any = {"task_id": "01K", "request_id": "01R", "extra": 3.14}
        with pytest.raises(TypeError):
            task_state.transact_write_approval_request("01K", "01R", bad_row, client=client)
        client.transact_write_items.assert_not_called()

    def test_exact_condition_expressions_pinned(self, approval_tables_env, approval_row):
        """I5 — pin the exact ConditionExpression strings on both
        transact items so a future refactor that loosens the
        fail-closed enforcement layer fails here. The condition
        guards are the only thing standing between a stale-state
        request and a falsely-recorded approval; their strings
        deserve dedicated assertions, not just call-arg snooping
        in a happy-path test.
        """
        client = MagicMock()
        client.transact_write_items.return_value = {}

        task_state.transact_write_approval_request("01KTASK", "01KREQ", approval_row, client=client)

        items = client.transact_write_items.call_args.kwargs["TransactItems"]
        # 1. Approval row must be created exactly once per request_id
        #    — collision => the duplicate write is rejected at DDB.
        put_cond = items[0]["Put"]["ConditionExpression"]
        assert put_cond == "attribute_not_exists(request_id)"

        # 2. Task row precondition is the exact RUNNING check (the
        #    transition can only fire from RUNNING; AWAITING_APPROVAL
        #    or terminal statuses must reject the write).
        upd = items[1]["Update"]
        cond = upd["ConditionExpression"]
        assert "#s = :running" in cond
        # Defensive: the condition must NOT accept AWAITING_APPROVAL
        # as a precondition for *initial* gate-write — that would
        # let a runaway gate cascade re-pause an already-paused task.
        assert ":awaiting" not in cond

    def test_condition_failed_reason_includes_both_branches(
        self, approval_tables_env, approval_row
    ):
        """When TransactWriteItems is cancelled, both branches'
        cancellation reasons must propagate to the caller so the
        hook can distinguish "request_id collision" from "task
        already moved past RUNNING".
        """
        client = MagicMock()
        reasons = [
            {"Code": "ConditionalCheckFailed"},  # approvals row collision
            {"Code": "ConditionalCheckFailed"},  # task row no longer RUNNING
        ]
        client.transact_write_items.side_effect = _FakeClientError(
            "TransactionCanceledException", cancellation_reasons=reasons
        )

        with pytest.raises(task_state.ApprovalWriteError) as exc_info:
            task_state.transact_write_approval_request(
                "01KTASK", "01KREQ", approval_row, client=client
            )
        # Both branches of the cancellation must surface — the hook's
        # error-classification logic depends on inspecting both.
        assert len(exc_info.value.cancellation_reasons) == 2
        assert all(
            r.get("Code") == "ConditionalCheckFailed" for r in exc_info.value.cancellation_reasons
        )


class TestTransactResumeFromApproval:
    def test_env_missing_raises(self, monkeypatch):
        monkeypatch.delenv("TASK_TABLE_NAME", raising=False)
        monkeypatch.delenv("TASK_APPROVALS_TABLE_NAME", raising=False)
        with pytest.raises(task_state.ApprovalTablesUnavailable):
            task_state.transact_resume_from_approval("01K", "01R", client=MagicMock())

    def test_happy_path_updates_task_table(self, approval_tables_env):
        client = MagicMock()
        client.transact_write_items.return_value = {}

        task_state.transact_resume_from_approval("01KTASK", "01KREQ", client=client)

        items = client.transact_write_items.call_args.kwargs["TransactItems"]
        assert len(items) == 1
        upd = items[0]["Update"]
        assert upd["TableName"] == "task-table"
        assert "awaiting_approval_request_id = :rid" in upd["ConditionExpression"]
        assert "#s = :awaiting" in upd["ConditionExpression"]
        assert upd["ExpressionAttributeValues"][":rid"] == {"S": "01KREQ"}
        assert "REMOVE awaiting_approval_request_id" in upd["UpdateExpression"]

    def test_cancellation_raises_approval_resume_error(self, approval_tables_env):
        client = MagicMock()
        client.transact_write_items.side_effect = _FakeClientError(
            "TransactionCanceledException",
            cancellation_reasons=[{"Code": "ConditionalCheckFailed"}],
        )
        with pytest.raises(task_state.ApprovalResumeError):
            task_state.transact_resume_from_approval("01KTASK", "01KREQ", client=client)

    def test_resume_condition_pins_joint_invariant(self, approval_tables_env):
        """I5 — pin the joint condition expression so a refactor that
        forgets the ``awaiting_approval_request_id = :rid`` half
        (e.g. allowing resume on ANY AWAITING_APPROVAL row, not
        just the one matching the decided request_id) fails here.
        Mismatching that half would let an out-of-order
        approve_other_request decision resume the wrong gate.
        """
        client = MagicMock()
        client.transact_write_items.return_value = {}

        task_state.transact_resume_from_approval("01KTASK", "01KREQ", client=client)

        upd = client.transact_write_items.call_args.kwargs["TransactItems"][0]["Update"]
        cond = upd["ConditionExpression"]
        # Both halves must be present and joined by AND.
        assert "#s = :awaiting" in cond
        assert "awaiting_approval_request_id = :rid" in cond
        assert "AND" in cond
        # The cleared-on-resume column must be REMOVE'd, not just
        # overwritten — otherwise the next ``transact_write_approval_request``
        # would see a stale request_id pointing at a finished gate.
        assert "REMOVE awaiting_approval_request_id" in upd["UpdateExpression"]


class TestBestEffortUpdateApprovalStatus:
    def test_happy_path_returns_true(self, approval_tables_env):
        client = MagicMock()
        client.update_item.return_value = {}

        ok = task_state.best_effort_update_approval_status(
            "01KTASK", "01KREQ", "TIMED_OUT", client=client
        )

        assert ok is True
        call = client.update_item.call_args
        assert call.kwargs["TableName"] == "approvals-table"
        assert call.kwargs["ConditionExpression"] == "#s = :pending"
        assert call.kwargs["ExpressionAttributeValues"][":new"] == {"S": "TIMED_OUT"}
        # Default: no reason attr is added when caller omits it.
        assert "deny_reason" not in call.kwargs["UpdateExpression"]

    def test_reason_optional_attached(self, approval_tables_env):
        client = MagicMock()
        client.update_item.return_value = {}

        task_state.best_effort_update_approval_status(
            "01KTASK", "01KREQ", "DENIED", reason="no prod pushes", client=client
        )

        call = client.update_item.call_args
        assert "deny_reason = :reason" in call.kwargs["UpdateExpression"]
        assert call.kwargs["ExpressionAttributeValues"][":reason"] == {"S": "no prod pushes"}

    def test_conditional_check_failed_returns_false(self, approval_tables_env):
        """IMPL-24 — this is the VM-throttle race signal the hook re-reads on."""
        client = MagicMock()
        client.update_item.side_effect = _FakeClientError("ConditionalCheckFailedException")

        ok = task_state.best_effort_update_approval_status(
            "01KTASK", "01KREQ", "TIMED_OUT", client=client
        )

        assert ok is False

    def test_other_errors_propagate(self, approval_tables_env):
        client = MagicMock()
        client.update_item.side_effect = _FakeClientError("ProvisionedThroughputExceededException")
        with pytest.raises(_FakeClientError):
            task_state.best_effort_update_approval_status(
                "01KTASK", "01KREQ", "TIMED_OUT", client=client
            )


class TestGetApprovalRow:
    def test_consistent_read_default(self, approval_tables_env):
        client = MagicMock()
        client.get_item.return_value = {"Item": {}}

        task_state.get_approval_row("01KTASK", "01KREQ", client=client)

        call = client.get_item.call_args
        assert call.kwargs["ConsistentRead"] is True
        assert call.kwargs["TableName"] == "approvals-table"
        assert call.kwargs["Key"] == {
            "task_id": {"S": "01KTASK"},
            "request_id": {"S": "01KREQ"},
        }

    def test_eventual_read_opt_in(self, approval_tables_env):
        client = MagicMock()
        client.get_item.return_value = {"Item": {}}

        task_state.get_approval_row("01KTASK", "01KREQ", consistent_read=False, client=client)

        assert client.get_item.call_args.kwargs["ConsistentRead"] is False

    def test_row_not_found_returns_none(self, approval_tables_env):
        client = MagicMock()
        client.get_item.return_value = {}

        row = task_state.get_approval_row("01KTASK", "01KREQ", client=client)

        assert row is None

    def test_row_unmarshalled_to_python(self, approval_tables_env):
        client = MagicMock()
        client.get_item.return_value = {
            "Item": {
                "task_id": {"S": "01KTASK"},
                "request_id": {"S": "01KREQ"},
                "status": {"S": "APPROVED"},
                "scope": {"S": "tool_type:Read"},
                "timeout_s": {"N": "300"},
                "matching_rule_ids": {"L": [{"S": "force_push_any"}]},
                "deny_reason": {"NULL": True},
            }
        }

        row = task_state.get_approval_row("01KTASK", "01KREQ", client=client)

        assert row == {
            "task_id": "01KTASK",
            "request_id": "01KREQ",
            "status": "APPROVED",
            "scope": "tool_type:Read",
            "timeout_s": 300,
            "matching_rule_ids": ["force_push_any"],
            "deny_reason": None,
        }


class TestIncrementApprovalGateCountInDdb:
    """Chunk 7: best-effort persistence of ``approval_gate_count`` so a
    container restart (§13.6) resumes the cumulative gate budget instead
    of resetting to 0.
    """

    def test_happy_path_returns_true_and_issues_add(self, approval_tables_env):
        client = MagicMock()
        client.update_item.return_value = {}

        ok = task_state.increment_approval_gate_count_in_ddb("01KTASK", client=client)

        assert ok is True
        call = client.update_item.call_args
        # Writes to TaskTable (not approvals-table) — survival of the
        # TASK-owned counter, not of the approval row.
        assert call.kwargs["TableName"] == "task-table"
        assert call.kwargs["Key"] == {"task_id": {"S": "01KTASK"}}
        # Atomic ADD (not SET) so concurrent hooks never clobber the counter
        # and the CreateTaskFn seed of ``approval_gate_count: 0`` (which
        # initializes the attribute) is still respected.
        assert call.kwargs["UpdateExpression"] == "ADD approval_gate_count :one"
        assert call.kwargs["ExpressionAttributeValues"] == {":one": {"N": "1"}}
        # No ConditionExpression — the counter is monotonic; we never gate
        # the bump on any read-modify-write state.
        assert "ConditionExpression" not in call.kwargs

    def test_env_missing_returns_false_best_effort(self, monkeypatch):
        # §13.6: counter persistence is a safety bound, not a correctness
        # bound. A missing TASK_TABLE_NAME must not block the gate.
        monkeypatch.delenv("TASK_TABLE_NAME", raising=False)
        monkeypatch.delenv("TASK_APPROVALS_TABLE_NAME", raising=False)

        ok = task_state.increment_approval_gate_count_in_ddb("01KTASK", client=MagicMock())

        assert ok is False

    def test_ddb_client_error_returns_false_not_raises(self, approval_tables_env):
        client = MagicMock()
        client.update_item.side_effect = _FakeClientError("ProvisionedThroughputExceededException")

        # Best-effort: swallow the error so the hook proceeds with the
        # session-scoped counter as authoritative within the container.
        ok = task_state.increment_approval_gate_count_in_ddb("01KTASK", client=client)

        assert ok is False

    def test_ddb_unknown_exception_returns_false_not_raises(self, approval_tables_env):
        client = MagicMock()
        client.update_item.side_effect = RuntimeError("AWS SDK internal error")

        ok = task_state.increment_approval_gate_count_in_ddb("01KTASK", client=client)

        assert ok is False


class TestCancellationHelpers:
    def test_extract_error_code_none_on_missing_response(self):
        assert task_state._extract_error_code(RuntimeError("boom")) is None

    def test_extract_error_code_reads_clienterror_shape(self):
        assert (
            task_state._extract_error_code(_FakeClientError("TransactionCanceledException"))
            == "TransactionCanceledException"
        )

    def test_extract_cancellation_reasons(self):
        exc = _FakeClientError(
            "TransactionCanceledException",
            cancellation_reasons=[{"Code": "ConditionalCheckFailed"}],
        )
        reasons = task_state._extract_cancellation_reasons(exc)
        assert reasons == [{"Code": "ConditionalCheckFailed"}]

    def test_extract_cancellation_reasons_none_on_plain_exception(self):
        assert task_state._extract_cancellation_reasons(RuntimeError()) == []
