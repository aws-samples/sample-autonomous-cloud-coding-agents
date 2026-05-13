"""Unit tests for linear_reactions — channel gating + GraphQL wire shape."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from linear_reactions import (
    EMOJI_FAILURE,
    EMOJI_STARTED,
    EMOJI_SUCCESS,
    LINEAR_GRAPHQL_URL,
    react_task_finished,
    react_task_started,
)


def _ok_response(reaction_id: str = "r-1") -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    payload = {"data": {"reactionCreate": {"success": True, "reaction": {"id": reaction_id}}}}
    resp.content = b'{"ok": true}'
    resp.json.return_value = payload
    return resp


def _ok_delete_response() -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    payload = {"data": {"reactionDelete": {"success": True}}}
    resp.content = b'{"ok": true}'
    resp.json.return_value = payload
    return resp


class TestChannelGate:
    """Non-Linear channels are silent no-ops — no network, no log noise."""

    def test_start_noop_for_slack(self):
        with patch("linear_reactions.requests.post") as post:
            assert react_task_started("slack", {"linear_issue_id": "X"}) is None
            post.assert_not_called()

    def test_start_noop_for_api(self):
        with patch("linear_reactions.requests.post") as post:
            assert react_task_started("api", None) is None
            post.assert_not_called()

    def test_finish_noop_for_webhook(self):
        with patch("linear_reactions.requests.post") as post:
            react_task_finished("webhook", None, success=True)
            post.assert_not_called()

    def test_start_noop_when_issue_id_missing(self):
        """Linear channel but no issue_id — can't address a reaction."""
        with patch("linear_reactions.requests.post") as post:
            assert react_task_started("linear", {}) is None
            assert react_task_started("linear", None) is None
            post.assert_not_called()


class TestLinearPath:
    """channel='linear' with issue id → correct GraphQL shape per hook."""

    def test_start_posts_eyes_and_returns_reaction_id(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            return_value=_ok_response(reaction_id="react-42"),
        ) as post:
            rid = react_task_started("linear", {"linear_issue_id": "issue-123"})
            assert rid == "react-42"
            post.assert_called_once()
            args, kwargs = post.call_args
            assert args[0] == LINEAR_GRAPHQL_URL
            assert kwargs["headers"]["Authorization"] == "lin_api_test"
            vars_ = kwargs["json"]["variables"]
            assert vars_["issueId"] == "issue-123"
            assert vars_["emoji"] == EMOJI_STARTED

    def test_finish_success_deletes_eyes_then_posts_check(self, monkeypatch):
        """✅ path: delete the 👀 reaction first, then post the success emoji."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=[_ok_delete_response(), _ok_response()],
        ) as post:
            react_task_finished(
                "linear",
                {"linear_issue_id": "issue-abc"},
                success=True,
                started_reaction_id="react-42",
            )
            assert post.call_count == 2
            # First call: delete
            assert post.call_args_list[0].kwargs["json"]["variables"] == {"id": "react-42"}
            # Second call: create ✅
            assert post.call_args_list[1].kwargs["json"]["variables"]["emoji"] == EMOJI_SUCCESS
            assert post.call_args_list[1].kwargs["json"]["variables"]["issueId"] == "issue-abc"

    def test_finish_failure_deletes_eyes_then_posts_x(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=[_ok_delete_response(), _ok_response()],
        ) as post:
            react_task_finished(
                "linear",
                {"linear_issue_id": "issue-abc"},
                success=False,
                started_reaction_id="react-42",
            )
            assert post.call_count == 2
            assert post.call_args_list[1].kwargs["json"]["variables"]["emoji"] == EMOJI_FAILURE

    def test_finish_without_reaction_id_only_posts_terminal(self, monkeypatch):
        """If the 👀 POST failed earlier, there's nothing to delete — skip deletion."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            return_value=_ok_response(),
        ) as post:
            react_task_finished(
                "linear",
                {"linear_issue_id": "issue-abc"},
                success=True,
                started_reaction_id=None,
            )
            assert post.call_count == 1
            assert post.call_args.kwargs["json"]["variables"]["emoji"] == EMOJI_SUCCESS


class TestFailureIsSwallowed:
    """Reactions are advisory — network/API failures never propagate."""

    def test_http_error_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        resp = MagicMock()
        resp.status_code = 500
        resp.content = b"server error"
        resp.json.return_value = {}
        with patch("linear_reactions.requests.post", return_value=resp):
            # must not raise
            react_task_started("linear", {"linear_issue_id": "issue-1"})

    def test_request_exception_does_not_raise(self, monkeypatch):
        import requests as rq

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch("linear_reactions.requests.post", side_effect=rq.ConnectionError("nope")):
            # must not raise
            react_task_finished("linear", {"linear_issue_id": "issue-1"}, success=True)

    def test_graphql_errors_do_not_raise(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        resp = MagicMock()
        resp.status_code = 200
        resp.content = b'{"errors":[{"message":"boom"}]}'
        resp.json.return_value = {"errors": [{"message": "boom"}]}
        with patch("linear_reactions.requests.post", return_value=resp):
            react_task_started("linear", {"linear_issue_id": "issue-1"})

    def test_missing_token_does_not_raise(self, monkeypatch):
        monkeypatch.delenv("LINEAR_API_TOKEN", raising=False)
        with patch("linear_reactions.requests.post") as post:
            react_task_started("linear", {"linear_issue_id": "issue-1"})
            post.assert_not_called()
