from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

import jira_reactions
from jira_reactions import (
    comment_task_started,
    transition_pr_opened,
    transition_task_started,
)

JIRA_META = {"jira_cloud_id": "cloud-1", "jira_issue_key": "KAN-1"}

ITERATION_META = {
    "jira_trigger_comment_id": "10042",
    "jira_prior_task_id": "01JD0PRIORTASK",
    "trigger_comment_id": "10042",
    "trigger_comment_issue_id": "KAN-1",
}


def _resp(status_code: int = 201, text: str = "") -> MagicMock:
    r = MagicMock()
    r.status_code = status_code
    r.text = text
    return r


def _transition(
    transition_id: str,
    to_name: str,
    *,
    category: str | None = None,
    has_screen: bool = False,
) -> dict:
    to: dict = {"id": f"s-{transition_id}", "name": to_name}
    if category is not None:
        to["statusCategory"] = {"key": category}
    return {"id": transition_id, "name": to_name, "hasScreen": has_screen, "to": to}


def _issue_resp(
    *transitions: dict,
    current_name: str = "To Do",
    current_category: str = "new",
) -> MagicMock:
    r = MagicMock()
    r.status_code = 200
    r.text = ""
    r.json.return_value = {
        "fields": {"status": {"name": current_name, "statusCategory": {"key": current_category}}},
        "transitions": list(transitions),
    }
    return r


@pytest.fixture(autouse=True)
def _reset_circuit():
    for key in (
        "JIRA_APP_ACTOR_CONFIGURED",
        "JIRA_APP_ACTOR_PROXY_URL",
        "JIRA_APP_ACTOR_SHARED_SECRET",
    ):
        os.environ.pop(key, None)
    jira_reactions._reset_state_for_testing()
    yield
    jira_reactions._reset_state_for_testing()


class TestChannelGate:
    def test_non_jira_source_is_noop(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post") as post:
            comment_task_started("linear", JIRA_META)
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
    def test_uses_signed_forge_app_actor_when_configured(self, monkeypatch):
        import hashlib
        import hmac
        import json

        monkeypatch.setenv("JIRA_API_TOKEN", "human-oauth-token")
        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv(
            "JIRA_APP_ACTOR_PROXY_URL",
            "https://install.webtrigger.atlassian.app/public/trigger",
        )
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)
        with patch("jira_reactions.requests.post", return_value=_resp(201)) as post:
            comment_task_started("jira", JIRA_META)

        assert post.call_args[0][0].endswith(".webtrigger.atlassian.app/public/trigger")
        assert "json" not in post.call_args.kwargs
        headers = post.call_args.kwargs["headers"]
        assert "Authorization" not in headers
        raw_body = post.call_args.kwargs["data"].decode()
        payload = json.loads(raw_body)
        assert payload["operation"] == "comment"
        assert payload["issue_key"] == "KAN-1"
        timestamp = headers["X-Bgagent-Timestamp"]
        expected = hmac.new(
            ("s" * 64).encode(),
            f"{timestamp}.{raw_body}".encode(),
            hashlib.sha256,
        ).hexdigest()
        assert headers["X-Bgagent-Signature"] == f"sha256={expected}"

    def test_invalid_configured_app_actor_never_falls_back_to_oauth(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "human-oauth-token")
        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv("JIRA_APP_ACTOR_PROXY_URL", "https://attacker.example/proxy")
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)
        with patch("jira_reactions.requests.post") as post:
            comment_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_logs_bounded_proxy_error_code_for_permanent_failure(self, monkeypatch, capfd):
        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv(
            "JIRA_APP_ACTOR_PROXY_URL",
            "https://install.webtrigger.atlassian.app/public/trigger",
        )
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)
        with patch(
            "jira_reactions.requests.post",
            return_value=_resp(401, '{"error":"invalid_signature","detail":"do-not-log"}'),
        ):
            comment_task_started("jira", JIRA_META)

        output = capfd.readouterr().out
        assert "error_id=JIRA_APP_ACTOR_PROXY_REJECTED" in output
        assert "proxy_error=invalid_signature" in output
        assert "do-not-log" not in output

    def test_rate_limit_from_the_proxy_is_logged_as_transient(self, monkeypatch, capfd):
        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv(
            "JIRA_APP_ACTOR_PROXY_URL",
            "https://install.webtrigger.atlassian.app/public/trigger",
        )
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)
        with patch(
            "jira_reactions.requests.post",
            return_value=_resp(429, '{"error":"rate_limited"}'),
        ):
            comment_task_started("jira", JIRA_META)

        proxy_line = next(
            line for line in capfd.readouterr().out.splitlines() if "Forge app proxy" in line
        )
        assert "error_id=JIRA_APP_ACTOR_PROXY_TRANSIENT" in proxy_line
        assert " WARN " in proxy_line

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


class TestTerminalCommentDemoted:
    def test_comment_task_finished_is_gone(self):
        assert not hasattr(jira_reactions, "comment_task_finished")


class TestFailureIsSwallowed:
    def test_http_500_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(500, "boom")):
            comment_task_started("jira", JIRA_META)

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
            for _ in range(jira_reactions._AUTH_FAILURE_THRESHOLD):
                comment_task_started("jira", JIRA_META)
            calls_after_open = post.call_count
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            assert post.call_count == calls_after_open

    def test_2xx_resets_failure_counter(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        responses = [_resp(401), _resp(401), _resp(201), _resp(401)]
        with patch("jira_reactions.requests.post", side_effect=responses) as post:
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            assert post.call_count == 4
            assert jira_reactions._auth_circuit_open is False

    def test_open_message_calls_out_forge_secret_drift(self, monkeypatch, capfd):
        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv(
            "JIRA_APP_ACTOR_PROXY_URL",
            "https://install.webtrigger.atlassian.app/public/trigger",
        )
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)
        with patch(
            "jira_reactions.requests.post",
            return_value=_resp(401, '{"error":"invalid_signature"}'),
        ):
            for _ in range(jira_reactions._AUTH_FAILURE_THRESHOLD):
                comment_task_started("jira", JIRA_META)

        output = capfd.readouterr().out
        assert "BGAGENT_PROXY_SECRET matches JIRA_APP_ACTOR_SHARED_SECRET" in output


class TestTransitionChannelGate:
    def test_non_jira_source_is_noop(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with (
            patch("jira_reactions.requests.get") as get,
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("linear", JIRA_META)
            transition_pr_opened("linear", JIRA_META)
            get.assert_not_called()
            post.assert_not_called()

    def test_empty_metadata_is_noop(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.get") as get:
            transition_task_started("jira", None)
            transition_task_started("jira", {})
            get.assert_not_called()

    def test_skips_when_token_missing(self, monkeypatch):
        monkeypatch.delenv("JIRA_API_TOKEN", raising=False)
        with patch("jira_reactions.requests.get") as get:
            transition_task_started("jira", JIRA_META)
            get.assert_not_called()


class TestStartTransitionSelection:
    def test_uses_app_actor_for_transition_read_and_write(self, monkeypatch):
        import json

        monkeypatch.setenv("JIRA_APP_ACTOR_CONFIGURED", "1")
        monkeypatch.setenv(
            "JIRA_APP_ACTOR_PROXY_URL",
            "https://install.webtrigger.atlassian.app/public/trigger",
        )
        monkeypatch.setenv("JIRA_APP_ACTOR_SHARED_SECRET", "s" * 64)
        issue = _issue_resp(_transition("21", "In Progress", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get") as get,
            patch(
                "jira_reactions.requests.post",
                side_effect=[issue, _resp(204)],
            ) as post,
        ):
            transition_task_started("jira", JIRA_META)

        get.assert_not_called()
        assert post.call_count == 2
        operations = [
            json.loads(call.kwargs["data"].decode())["operation"] for call in post.call_args_list
        ]
        assert operations == ["get_transitions", "transition"]

    def test_prefers_in_progress_by_name_over_blocked(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("71", "Blocked", category="indeterminate"),
            _transition("21", "In Progress", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "21"}}
        assert post.call_args[0][0].endswith("/rest/api/3/issue/KAN-1/transitions")

    def test_falls_back_to_indeterminate_category(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("11", "Done", category="done"),
            _transition("41", "Doing", category="indeterminate"),
            _transition("31", "Backlog", category="new"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_category_fallback_never_picks_blocked(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("71", "Blocked", category="indeterminate"),
            _transition("11", "Done", category="done"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_skips_when_already_in_progress(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("31", "To Do", category="new"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_skips_when_already_in_review(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            current_name="In Review",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_override_status_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "Doing"}
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("41", "Doing", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", meta)
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_override_matches_case_insensitively(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "doing"}
        issue = _issue_resp(_transition("41", "Doing", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", meta)
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_override_honored_even_when_already_in_progress(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "Doing"}
        issue = _issue_resp(
            _transition("41", "Doing", category="indeterminate"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", meta)
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_iteration_with_override_leaves_an_in_review_issue_alone(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, **ITERATION_META, "jira_status_on_start": "In Progress"}
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("11", "Done", category="done"),
            current_name="In Review",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", meta)
        post.assert_not_called()

    def test_iteration_with_override_moves_a_to_do_issue_to_it(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, **ITERATION_META, "jira_status_on_start": "Doing"}
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("41", "Doing", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", meta)
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_missing_override_target_skips_without_fallback(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "Nonexistent"}
        issue = _issue_resp(_transition("21", "In Progress", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", meta)
        post.assert_not_called()

    def test_no_indeterminate_transition_skips(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("11", "Done", category="done"),
            _transition("31", "Backlog", category="new"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_empty_transition_list_skips(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with (
            patch("jira_reactions.requests.get", return_value=_issue_resp()),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_skips_transition_requiring_screen(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate", has_screen=True),
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()


class TestPrTransitionSelection:
    def test_matches_in_review_by_name(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("51", "In Review", category="indeterminate"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "51"}}

    def test_matches_in_review_case_insensitively(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("51", "IN REVIEW", category="indeterminate"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "51"}}

    def test_matches_code_review_synonym(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("61", "Code Review", category="indeterminate"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "61"}}

    def test_prefers_in_review_over_code_review(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("61", "Code Review", category="indeterminate"),
            _transition("51", "In Review", category="indeterminate"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "51"}}

    def test_stock_board_falls_back_to_in_progress(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("11", "Done", category="done"),
            current_name="To Do",
            current_category="new",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "21"}}

    def test_skips_when_already_done(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("51", "In Review", category="indeterminate"),
            current_name="Done",
            current_category="done",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        post.assert_not_called()

    def test_no_review_or_in_progress_leaves_unchanged(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("11", "Done", category="done"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        post.assert_not_called()

    def test_already_in_review_is_not_moved_back_to_in_progress(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("11", "Done", category="done"),
            current_name="In Review",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        post.assert_not_called()

    def test_in_progress_stays_put_when_the_board_has_no_review_status(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(
            _transition("31", "On Hold", category="indeterminate"),
            _transition("11", "Done", category="done"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        post.assert_not_called()

    def test_override_status_on_pr(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_pr": "Code Review"}
        issue = _issue_resp(
            _transition("51", "In Review", category="indeterminate"),
            _transition("61", "Code Review", category="indeterminate"),
            current_name="In Progress",
            current_category="indeterminate",
        )
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", meta)
        assert post.call_args[1]["json"] == {"transition": {"id": "61"}}


class TestTransitionAuthCircuitBreaker:
    def test_get_401s_open_shared_breaker(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with (
            patch("jira_reactions.requests.get", return_value=_resp(401)) as get,
            patch("jira_reactions.requests.post") as post,
        ):
            for _ in range(jira_reactions._AUTH_FAILURE_THRESHOLD):
                transition_task_started("jira", JIRA_META)
            assert jira_reactions._auth_circuit_open is True
            calls_after_open = get.call_count
            transition_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            assert get.call_count == calls_after_open
            post.assert_not_called()

    def test_open_breaker_short_circuits_before_get(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(401)):
            for _ in range(jira_reactions._AUTH_FAILURE_THRESHOLD):
                comment_task_started("jira", JIRA_META)
        assert jira_reactions._auth_circuit_open is True
        with patch("jira_reactions.requests.get") as get:
            transition_task_started("jira", JIRA_META)
            get.assert_not_called()


class TestTransitionFailureIsSwallowed:
    def test_get_500_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with (
            patch("jira_reactions.requests.get", return_value=_resp(500, "boom")),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
            post.assert_not_called()

    def test_post_500_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        issue = _issue_resp(_transition("21", "In Progress", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post", return_value=_resp(500, "boom")),
        ):
            transition_task_started("jira", JIRA_META)

    def test_get_request_exception_does_not_raise(self, monkeypatch):
        import requests

        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with (
            patch(
                "jira_reactions.requests.get",
                side_effect=requests.RequestException("network down"),
            ),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
            post.assert_not_called()

    def test_non_json_get_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        bad = MagicMock()
        bad.status_code = 200
        bad.text = "not json"
        bad.json.side_effect = ValueError("no json")
        with (
            patch("jira_reactions.requests.get", return_value=bad),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
            post.assert_not_called()

    @pytest.mark.parametrize("body", [None, [], 42, "scalar"])
    def test_non_dict_json_does_not_raise(self, monkeypatch, body):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        r = MagicMock()
        r.status_code = 200
        r.text = ""
        r.json.return_value = body
        with (
            patch("jira_reactions.requests.get", return_value=r),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
            post.assert_not_called()
