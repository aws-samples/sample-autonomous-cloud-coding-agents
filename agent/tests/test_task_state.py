"""Task persistence behavior and the agent's IAM write contract."""

import ast
import json
import re
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import task_state
from task_state import TaskFetchError, _build_logs_url, _now_iso


@pytest.mark.parametrize("writer", [task_state.write_running, task_state.write_heartbeat])
@pytest.mark.parametrize(
    ("reasons", "expected_warning"),
    [
        ([{"Code": "ConditionalCheckFailed"}, {"Code": "None"}], False),
        ([{"Code": "None"}, {"Code": "ConditionalCheckFailed"}], True),
        ([{"Code": "ConditionalCheckFailed"}, {"Code": "ConditionalCheckFailed"}], True),
        ([], True),
    ],
)
def test_status_race_logging_preserves_worker_fence_failures(
    monkeypatch, writer, reasons, expected_warning
):
    from botocore.exceptions import ClientError

    monkeypatch.setattr(task_state, "_get_table", MagicMock())
    monkeypatch.setattr(
        task_state,
        "_update_task",
        MagicMock(
            side_effect=ClientError(
                {
                    "Error": {
                        "Code": "TransactionCanceledException",
                        "Message": "transaction failed",
                    },
                    "CancellationReasons": reasons,
                },
                "TransactWriteItems",
            )
        ),
    )
    log = MagicMock()
    monkeypatch.setattr(task_state, "log", log)
    writer("owned-task")
    assert any(call.args[0] == "WARN" for call in log.call_args_list) is expected_warning


@pytest.mark.parametrize(
    ("codes", "can_heal"),
    [
        (["ConditionalCheckFailed", "None"], True),
        (["None", "ConditionalCheckFailed"], False),
        (["ConditionalCheckFailed", "ConditionalCheckFailed"], False),
        (["TransactionConflict", "None"], False),
        ([], False),
    ],
)
def test_terminal_transaction_heals_trace_only_when_worker_lease_passed(
    monkeypatch, codes, can_heal
):
    from botocore.exceptions import ClientError

    monkeypatch.setattr(task_state, "_get_table", MagicMock())
    error = ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )
    monkeypatch.setattr(task_state, "_update_task", MagicMock(side_effect=error))
    heal = MagicMock(return_value=True)
    report = MagicMock()
    monkeypatch.setattr(task_state, "write_trace_uri_conditional", heal)
    monkeypatch.setattr(task_state, "log_error_cw", report)
    task_state.write_terminal("task", "COMPLETED", {"trace_s3_uri": "s3://bucket/trace"})
    assert heal.called is can_heal
    if can_heal:
        heal.assert_called_once_with("task", "s3://bucket/trace")
    else:
        assert "TransactionCanceledException" in report.call_args.args[0]
        assert "CancellationReasons" in report.call_args.args[0]


@pytest.mark.parametrize(
    ("codes", "benign"),
    [
        (["ConditionalCheckFailed", "None"], True),
        (["None", "ConditionalCheckFailed"], False),
        (["ConditionalCheckFailed", "ConditionalCheckFailed"], False),
    ],
)
def test_trace_transaction_classifies_status_race_separately_from_lease_loss(
    monkeypatch, codes, benign
):
    from botocore.exceptions import ClientError

    error = ClientError(
        {
            "Error": {"Code": "TransactionCanceledException"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )
    monkeypatch.setattr(task_state, "_get_table", MagicMock())
    monkeypatch.setattr(task_state, "_update_task", MagicMock(side_effect=error))
    report = MagicMock()
    monkeypatch.setattr(task_state, "log", report)
    assert not task_state.write_trace_uri_conditional("task", "s3://bucket/trace")
    assert report.call_args.args[0] == ("INFO" if benign else "WARN")
    if not benign:
        assert "CancellationReasons=" in report.call_args.args[1]


@pytest.mark.parametrize(
    "codes", [["TransactionConflict", "None"], ["None", "TransactionConflict"]]
)
def test_task_transaction_retries_conflict_with_identical_ownership_fence(monkeypatch, codes):
    from botocore.exceptions import ClientError

    error = ClientError(
        {
            "Error": {"Code": "TransactionCanceledException"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )
    client = MagicMock()
    client.transact_write_items.side_effect = [error, {"committed": True}]
    monkeypatch.setattr(task_state.time, "sleep", MagicMock())
    lease = {
        "ConditionCheck": {
            "ConditionExpression": "lease_attempt_id = :attempt",
            "ExpressionAttributeValues": {":attempt": "original-worker"},
        }
    }
    monkeypatch.setattr(task_state, "_lease_check", lambda *args, **kwargs: lease)
    operation = {"TableName": "tasks", "Key": {"task_id": {"S": "task"}}}
    assert task_state._update_task(client, "task", low_level=True, **operation) == {
        "committed": True
    }
    assert client.transact_write_items.call_count == 2
    for call in client.transact_write_items.call_args_list:
        assert call.kwargs["TransactItems"] == [{"Update": operation}, lease]


@pytest.mark.parametrize(
    ("codes", "attempts"),
    [
        (["TransactionConflict", "None"], 3),
        (["TransactionConflict", "ConditionalCheckFailed"], 1),
        (["None", "ConditionalCheckFailed"], 1),
        ([], 1),
    ],
)
def test_transaction_retry_is_bounded_and_never_retries_ownership_denial(
    monkeypatch, codes, attempts
):
    from botocore.exceptions import ClientError

    error = ClientError(
        {
            "Error": {"Code": "TransactionCanceledException"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )
    client = MagicMock()
    client.transact_write_items.side_effect = error
    monkeypatch.setattr(task_state.time, "sleep", MagicMock())
    with pytest.raises(ClientError):
        task_state._transact_with_conflict_retry(client, [])
    assert client.transact_write_items.call_count == attempts


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (None, task_state.TerminalWriteOutcome.WRITTEN),
        ("ConditionalCheckFailedException", task_state.TerminalWriteOutcome.SUPERSEDED),
        ("AccessDeniedException", task_state.TerminalWriteOutcome.FAILED),
    ],
)
def test_terminal_returns_persistence_outcome(monkeypatch, failure, expected):
    from botocore.exceptions import ClientError

    monkeypatch.setattr(task_state, "_get_table", MagicMock())
    monkeypatch.setattr(
        task_state,
        "_update_task",
        MagicMock(
            side_effect=(
                ClientError({"Error": {"Code": failure}}, "UpdateItem") if failure else None
            )
        ),
    )
    assert task_state.write_terminal("task", "COMPLETED") is expected


class TestAgentWriteContract:
    def test_current_task_writers_fit_the_deployed_attribute_allowlist(self, monkeypatch):
        """Exercise real writers; detect a new field before IAM rejects it live.

        This checks request/contract compatibility, not AWS IAM enforcement.
        """
        table = MagicMock()
        client = MagicMock()
        monkeypatch.setattr(task_state, "_get_table", lambda: table)
        monkeypatch.setenv("TASK_TABLE_NAME", "Tasks")
        monkeypatch.setenv("TASK_APPROVALS_TABLE_NAME", "Approvals")
        monkeypatch.setenv("AWS_REGION", "us-east-1")
        monkeypatch.setenv("LOG_GROUP_NAME", "/test")

        task_state.write_running("t1")
        task_state.write_heartbeat("t1")
        task_state.write_terminal(
            "t1",
            "COMPLETED",
            {
                "pr_url": "https://example.com/pr/1",
                "error": "example",
                "cost_usd": 1,
                "duration_s": 10,
                "turns": 3,
                "turns_attempted": 3,
                "turns_completed": 2,
                "prompt_version": "v1",
                "memory_written": True,
                "build_passed": True,
                "lint_passed": True,
                "code_changed": True,
                "head_sha": "abc",
                "answer_text": "done",
                "otel_trace_id": "trace",
                "trace_s3_uri": "s3://b/trace",
                "artifact_uri": "s3://b/artifact",
            },
        )
        assert task_state.write_trace_uri_conditional("t1", "s3://b/trace")
        task_state.transact_write_approval_request(
            "t1",
            "r1",
            {
                "task_id": "t1",
                "request_id": "r1",
                "status": "PENDING",
                "tool_name": "Bash",
                "tool_input_preview": "example",
                "tool_input_sha256": "a" * 64,
                "reason": "approval required",
                "severity": "high",
                "matching_rule_ids": ["rule1"],
                "created_at": "2026-09-13T00:00:00Z",
                "timeout_s": 300,
                "ttl": 1800000000,
                "user_id": "u1",
                "repo": "owner/repo",
            },
            client=client,
        )
        task_state.transact_resume_from_approval("t1", "r1", client=client)
        assert task_state.increment_approval_gate_count_in_ddb("t1", client=client)

        requests = [c.kwargs for c in table.update_item.call_args_list]
        requests += [c.kwargs for c in client.update_item.call_args_list]
        for call in client.transact_write_items.call_args_list:
            for item in call.kwargs["TransactItems"]:
                action, request = next(iter(item.items()))
                if request["TableName"] == "Tasks":
                    assert action == "Update"  # Never Put/Delete the task row.
                    requests.append(request)
        assert len(requests) == 7
        table.put_item.assert_not_called()
        table.delete_item.assert_not_called()

        contract = Path(__file__).resolve().parents[2] / (
            "cdk/src/constructs/agent-task-write-attributes.json"
        )
        allowed = set(json.loads(contract.read_text()))
        seen: set[str] = set()
        for request in requests:
            # Current writers use flat attributes. Resolve aliases and ignore
            # value placeholders/operators/functions in their DDB expressions.
            expression = request["UpdateExpression"] + " " + request.get("ConditionExpression", "")
            expression = re.sub(r":[A-Za-z0-9_]+", "", expression)
            for alias, name in request.get("ExpressionAttributeNames", {}).items():
                expression = expression.replace(alias, name)
            names = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expression))
            names -= {"SET", "REMOVE", "ADD", "IN", "AND", "attribute_not_exists"}
            names |= set(request["Key"])
            assert names <= allowed, (
                f"Task writer needs a reviewed IAM contract update: {names - allowed}"
            )
            seen |= names
        # No stale writable attribute may linger after its writer is removed.
        assert seen == allowed

    def test_write_inventory_requires_review_when_a_new_writer_is_added(self):
        tree = ast.parse(Path(task_state.__file__).read_text())
        writers = {
            node.name
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and any(
                isinstance(child, ast.Call)
                and (
                    (
                        isinstance(child.func, ast.Attribute)
                        and child.func.attr
                        in {
                            "update_item",
                            "put_item",
                            "delete_item",
                            "transact_write_items",
                            "batch_writer",
                        }
                    )
                    or (
                        isinstance(child.func, ast.Name)
                        and child.func.id
                        in {"_update_task", "_transact_task", "_transact_with_conflict_retry"}
                    )
                )
                for child in ast.walk(node)
            )
        }
        assert writers == {
            "_transact_with_conflict_retry",
            "_update_task",
            "_transact_task",
            "write_running",
            "write_heartbeat",
            "write_terminal",
            "write_trace_uri_conditional",
            "transact_write_approval_request",
            "transact_resume_from_approval",
            "increment_approval_gate_count_in_ddb",
            "publish_continuation_checkpoint",
            "consume_restored_continuation",
            "best_effort_update_approval_status",  # Writes only the supporting approvals table.
        }


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
    """``write_terminal`` persists ``trace_s3_uri`` from
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


class TestWriteTerminalArtifactUri:
    """#248 Phase 3 — write_terminal persists artifact_uri so a repo-less task's
    delivered S3 artifact is discoverable via TaskDetail. Regression guard: the
    field was previously dropped by the write_terminal allowlist."""

    def test_artifact_uri_written_when_present(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal(
            "t-art",
            "COMPLETED",
            {"artifact_uri": "s3://bkt/artifacts/t-art/result.md"},
        )
        update_expr = calls[0]["UpdateExpression"]
        assert "artifact_uri = :au" in update_expr
        assert calls[0]["ExpressionAttributeValues"][":au"] == "s3://bkt/artifacts/t-art/result.md"

    def test_artifact_uri_omitted_when_absent(self, monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        task_state.write_terminal(
            "t-noart", "COMPLETED", {"pr_url": "https://github.com/o/r/pull/1"}
        )
        assert "artifact_uri" not in calls[0]["UpdateExpression"]


class TestWriteTerminalReplayFields:
    """#515 — write_terminal persists the verification verdict and otel_trace_id
    so the replay bundle carries them. Regression guard: build_passed/lint_passed
    were historically present on TaskResult but dropped by the write allowlist."""

    @staticmethod
    def _capture(monkeypatch):
        calls: list[dict] = []

        class _FakeTable:
            def update_item(self, **kwargs):
                calls.append(kwargs)

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        return calls

    def test_build_and_lint_passed_written(self, monkeypatch):
        calls = self._capture(monkeypatch)
        task_state.write_terminal("t-v", "COMPLETED", {"build_passed": True, "lint_passed": False})
        expr = calls[0]["UpdateExpression"]
        values = calls[0]["ExpressionAttributeValues"]
        assert "build_passed = :bp" in expr
        assert "lint_passed = :lp" in expr
        assert values[":bp"] is True
        assert values[":lp"] is False

    def test_build_passed_false_is_written_not_dropped(self, monkeypatch):
        # `is not None` guard, not truthiness — a failing build must persist.
        calls = self._capture(monkeypatch)
        task_state.write_terminal("t-fail", "FAILED", {"build_passed": False})
        assert calls[0]["ExpressionAttributeValues"][":bp"] is False

    def test_otel_trace_id_written_when_present(self, monkeypatch):
        calls = self._capture(monkeypatch)
        task_state.write_terminal(
            "t-otel", "COMPLETED", {"otel_trace_id": "aabbccddeeff00112233445566778899"}
        )
        expr = calls[0]["UpdateExpression"]
        assert "otel_trace_id = :otid" in expr
        assert calls[0]["ExpressionAttributeValues"][":otid"] == "aabbccddeeff00112233445566778899"

    def test_otel_trace_id_omitted_when_absent(self, monkeypatch):
        calls = self._capture(monkeypatch)
        task_state.write_terminal("t-nootel", "COMPLETED", {"pr_url": "x"})
        assert "otel_trace_id" not in calls[0]["UpdateExpression"]

    def test_build_lint_omitted_when_none(self, monkeypatch):
        # Repo-less / crash tasks leave build_passed/lint_passed as None (the
        # gate did not run). They must be OMITTED, so the replay bundle reports
        # verification:null rather than a fictional build_passed:false.
        calls = self._capture(monkeypatch)
        task_state.write_terminal(
            "t-repoless", "COMPLETED", {"build_passed": None, "lint_passed": None}
        )
        expr = calls[0]["UpdateExpression"]
        assert "build_passed" not in expr
        assert "lint_passed" not in expr

    def test_conditional_check_failed_with_trace_uri_logs_orphan_diagnostic(
        self,
        monkeypatch,
        capfd,
    ):
        """When ``write_terminal``'s precondition
        fails (typically: concurrent cancel) and a ``trace_s3_uri`` was
        already uploaded, the orphaned S3 object needs a dedicated log
        line — otherwise the generic ``skipped: precondition not met``
        message hides silently-lost trace URIs.

        Extension: after the orphan log prints, the self-heal
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
        out = capfd.readouterr().out
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
        capfd,
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
        out = capfd.readouterr().out
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

    def test_uri_already_present_returns_false_and_logs_info(self, monkeypatch, capfd):
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
        out = capfd.readouterr().out
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

    def test_transient_ddb_error_returns_false_and_logs_warn(self, monkeypatch, capfd):
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
        out = capfd.readouterr().out
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
    def test_resume_refreshes_heartbeat_in_the_same_conditional_write(
        self, approval_tables_env, monkeypatch
    ):
        """A poll immediately after a long approval wait must see a fresh heartbeat."""
        monkeypatch.setattr(task_state, "_now_iso", lambda: "2026-09-13T12:05:00Z")
        client = MagicMock()

        task_state.transact_resume_from_approval("01KTASK", "01KREQ", client=client)

        client.transact_write_items.assert_called_once()
        updates = client.transact_write_items.call_args.kwargs["TransactItems"]
        assert len(updates) == 1
        update = updates[0]["Update"]
        assert "agent_heartbeat_at = :heartbeat" in update["UpdateExpression"]
        assert "#s = :running" in update["UpdateExpression"]
        assert update["ExpressionAttributeValues"][":heartbeat"] == {"S": "2026-09-13T12:05:00Z"}
        assert update["ConditionExpression"] == (
            "#s = :awaiting AND awaiting_approval_request_id = :rid"
        )
        # An independent write would leave the old heartbeat visible after RUNNING.
        client.update_item.assert_not_called()

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
            "01KTASK", "01KREQ", "TIMED_OUT", reason="polling failed", client=client
        )

        call = client.update_item.call_args
        assert "deny_reason = :reason" in call.kwargs["UpdateExpression"]
        assert call.kwargs["ExpressionAttributeValues"][":reason"] == {"S": "polling failed"}

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


class TestContinuationClaimReadback:
    @pytest.mark.parametrize(
        "changed", ["none", "cancelled", "worker", "record", "request", "lease"]
    )
    def test_lost_response_requires_exact_consumed_assignment(
        self, approval_tables_env, monkeypatch, changed
    ):
        from boto3.dynamodb.types import TypeSerializer

        record = {
            "version": 1,
            "state": "RESTORING",
            "worker_id": "microvm-new",
            "identity": {
                "task_id": "task",
                "attempt_id": "microvm-old",
                "request_id": "request",
                "user_id": "user",
                "repo": "owner/repo",
            },
            "manifest": {"key": "exact-saved-key"},
        }
        consumed = {**record, "state": "CONSUMED"}
        task = {"status": "RUNNING", "session_id": "microvm-new", "continuation": consumed}
        if changed == "cancelled":
            task["status"] = "CANCELLED"
        elif changed == "worker":
            task["session_id"] = "microvm-other"
        elif changed == "record":
            task["continuation"] = {**consumed, "manifest": {"key": "different"}}
        elif changed == "request":
            task["awaiting_approval_request_id"] = "another-request"
        client = MagicMock()
        client.transact_write_items.side_effect = TimeoutError("response lost after commit")
        serialize = TypeSerializer().serialize
        client.get_item.return_value = {"Item": {k: serialize(v) for k, v in task.items()}}
        lease = MagicMock(side_effect=RuntimeError("lease lost") if changed == "lease" else None)
        monkeypatch.setattr(task_state, "verify_worker_lease", lease)
        if changed == "none":
            task_state.consume_restored_continuation("task", "microvm-new", record, client=client)
            lease.assert_called_once_with("task", client=client)
        else:
            with pytest.raises(RuntimeError):
                task_state.consume_restored_continuation(
                    "task", "microvm-new", record, client=client
                )
        assert client.get_item.call_args.kwargs["ConsistentRead"] is True
