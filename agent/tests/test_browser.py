"""Unit tests for browser.py screenshot functions."""

import json
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

import browser


@pytest.fixture(autouse=True)
def _reset_client():
    """Reset the cached Lambda client between tests."""
    browser._lambda_client = None
    yield
    browser._lambda_client = None


class TestCaptureScreenshot:
    def test_success_returns_presigned_url(self, monkeypatch):
        monkeypatch.setenv("BROWSER_TOOL_FUNCTION_NAME", "my-browser-fn")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        response_payload = json.dumps({
            "status": "success",
            "screenshotS3Key": "screenshots/abc123.png",
            "presignedUrl": "https://s3.amazonaws.com/bucket/screenshots/abc123.png",
        }).encode()

        mock_client = MagicMock()
        mock_client.invoke.return_value = {
            "Payload": BytesIO(response_payload),
        }

        with patch("boto3.client", return_value=mock_client):
            url = browser.capture_screenshot("https://github.com/owner/repo/pull/1", "task-123")

        assert url == "https://s3.amazonaws.com/bucket/screenshots/abc123.png"
        mock_client.invoke.assert_called_once()

    def test_error_response_returns_none(self, monkeypatch):
        monkeypatch.setenv("BROWSER_TOOL_FUNCTION_NAME", "my-browser-fn")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        response_payload = json.dumps({
            "status": "error",
            "error": "page not found",
        }).encode()

        mock_client = MagicMock()
        mock_client.invoke.return_value = {
            "Payload": BytesIO(response_payload),
        }

        with patch("boto3.client", return_value=mock_client):
            url = browser.capture_screenshot("https://example.com", "task-123")

        assert url is None

    def test_missing_env_var_returns_none(self, monkeypatch):
        monkeypatch.delenv("BROWSER_TOOL_FUNCTION_NAME", raising=False)

        url = browser.capture_screenshot("https://example.com", "task-123")

        assert url is None

    def test_lambda_invocation_exception_returns_none(self, monkeypatch):
        monkeypatch.setenv("BROWSER_TOOL_FUNCTION_NAME", "my-browser-fn")
        monkeypatch.setenv("AWS_REGION", "us-east-1")

        mock_client = MagicMock()
        mock_client.invoke.side_effect = Exception("Lambda timeout")

        with patch("boto3.client", return_value=mock_client):
            url = browser.capture_screenshot("https://example.com", "task-123")

        assert url is None
