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
