"""Unit tests for pure functions in task_state.py."""

from task_state import _build_logs_url, _now_iso


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
