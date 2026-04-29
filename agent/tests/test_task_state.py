"""Unit tests for pure functions in task_state.py."""

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
    """Verify the NotFound vs FetchFailed distinction added in rev-5 (P0-b).

    The rev-5 RUN_ELSEWHERE guard on Runtime-JWT depends on being able to
    tell "record doesn't exist" (fail-open, spawn) from "couldn't read"
    (fail-closed, 503). Before this split both collapsed to ``None`` and a
    DDB blip would cause duplicate pipelines.
    """

    def test_returns_none_when_no_table(self, monkeypatch):
        monkeypatch.setattr(task_state, "_get_table", lambda: None)
        assert task_state.get_task("t-any") is None

    def test_returns_item_when_found(self, monkeypatch):
        class _FakeTable:
            def get_item(self, Key):  # noqa: N803 — boto kwarg name
                assert Key == {"task_id": "t-present"}
                return {"Item": {"task_id": "t-present", "status": "RUNNING"}}

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        item = task_state.get_task("t-present")
        assert item == {"task_id": "t-present", "status": "RUNNING"}

    def test_returns_none_when_item_absent(self, monkeypatch):
        class _FakeTable:
            def get_item(self, Key):  # noqa: N803
                return {}  # DDB returns no "Item" key when not found.

        monkeypatch.setattr(task_state, "_get_table", lambda: _FakeTable())
        assert task_state.get_task("t-missing") is None

    def test_raises_TaskFetchError_on_ddb_failure(self, monkeypatch):
        class _FakeTable:
            def get_item(self, Key):  # noqa: N803
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
        assert values[":cm"] == {"runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123:runtime/jwt-xyz"}

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
