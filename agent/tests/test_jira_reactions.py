"""Unit tests for the Jira issue-comment REST shim (jira_reactions)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import jira_reactions
from jira_reactions import comment_task_finished, comment_task_started

JIRA_META = {"jira_cloud_id": "cloud-1", "jira_issue_key": "KAN-1"}


def _resp(status_code: int = 201, text: str = "") -> MagicMock:
    r = MagicMock()
    r.status_code = status_code
    r.text = text
    return r


@pytest.fixture(autouse=True)
def _reset_circuit():
    """Each test starts with a closed (healthy) auth circuit.

    Autouse so it applies to module-level functions AND methods inside test
    classes (a module-level ``setup_function`` does not run for class methods).
    """
    jira_reactions._reset_state_for_testing()
    yield
    jira_reactions._reset_state_for_testing()


class TestChannelGate:
    def test_non_jira_source_is_noop(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post") as post:
            comment_task_started("linear", JIRA_META)
            comment_task_finished("linear", JIRA_META, success=True)
            post.assert_not_called()

    def test_empty_metadata_is_noop(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post") as post:
            comment_task_started("jira", None)
            comment_task_started("jira", {})
            post.assert_not_called()

    def test_missing_issue_key_is_noop(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post") as post:
            comment_task_started("jira", {"jira_cloud_id": "cloud-1"})
            post.assert_not_called()


class TestStartComment:
    def test_posts_adf_comment_to_correct_url(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(201)) as post:
            comment_task_started("jira", JIRA_META)
        assert post.call_count == 1
        url = post.call_args[0][0]
        assert url == ("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/KAN-1/comment")
        body = post.call_args[1]["json"]["body"]
        assert body["type"] == "doc"
        assert body["content"][0]["content"][0]["text"].startswith("🤖")
        headers = post.call_args[1]["headers"]
        assert headers["Authorization"] == "Bearer jira_at"

    def test_skips_when_token_missing(self, monkeypatch):
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        with patch("jira_reactions.requests.post") as post:
            comment_task_started("jira", JIRA_META)
            post.assert_not_called()


class TestFinishComment:
    def test_success_with_pr_includes_pr_url(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(201)) as post:
            comment_task_finished(
                "jira", JIRA_META, success=True, pr_url="https://github.com/o/r/pull/7"
            )
        text = post.call_args[1]["json"]["body"]["content"][0]["content"][0]["text"]
        assert "✅" in text
        assert "https://github.com/o/r/pull/7" in text

    def test_success_without_pr_notes_no_pr(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(201)) as post:
            comment_task_finished("jira", JIRA_META, success=True, pr_url=None)
        text = post.call_args[1]["json"]["body"]["content"][0]["content"][0]["text"]
        assert "✅" in text
        assert "No pull request" in text

    def test_failure_comment(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(201)) as post:
            comment_task_finished("jira", JIRA_META, success=False, pr_url=None)
        text = post.call_args[1]["json"]["body"]["content"][0]["content"][0]["text"]
        assert "❌" in text


class TestFailureIsSwallowed:
    def test_http_500_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(500, "boom")):
            # Must not raise.
            comment_task_started("jira", JIRA_META)
            comment_task_finished("jira", JIRA_META, success=True)

    def test_request_exception_does_not_raise(self, monkeypatch):
        import requests

        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch(
            "jira_reactions.requests.post",
            side_effect=requests.RequestException("network down"),
        ):
            comment_task_started("jira", JIRA_META)


class TestAuthCircuitBreaker:
    def test_opens_after_threshold_consecutive_401s(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(401)) as post:
            # Three consecutive 401s open the breaker.
            for _ in range(jira_reactions._AUTH_FAILURE_THRESHOLD):
                comment_task_started("jira", JIRA_META)
            calls_after_open = post.call_count
            # Further calls short-circuit without hitting the network.
            comment_task_started("jira", JIRA_META)
            comment_task_finished("jira", JIRA_META, success=True)
            assert post.call_count == calls_after_open

    def test_2xx_resets_failure_counter(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        # Two 401s (below threshold), then a success resets, so the breaker
        # never opens.
        responses = [_resp(401), _resp(401), _resp(201), _resp(401)]
        with patch("jira_reactions.requests.post", side_effect=responses) as post:
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)  # 201 → reset
            comment_task_started("jira", JIRA_META)  # 401, count back to 1
            assert post.call_count == 4
            assert jira_reactions._auth_circuit_open is False
