"""Unit tests for the Jira issue-comment REST shim (jira_reactions)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import jira_reactions
from jira_reactions import (
    comment_task_started,
    transition_pr_opened,
    transition_task_started,
)

JIRA_META = {"jira_cloud_id": "cloud-1", "jira_issue_key": "KAN-1"}


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
    """Build one entry of the transitions API ``transitions[]`` list."""
    to: dict = {"id": f"s-{transition_id}", "name": to_name}
    if category is not None:
        to["statusCategory"] = {"key": category}
    return {"id": transition_id, "name": to_name, "hasScreen": has_screen, "to": to}


def _transitions_resp(*transitions: dict) -> MagicMock:
    """Build a 200 GET /transitions response wrapping the given transitions."""
    r = MagicMock()
    r.status_code = 200
    r.text = ""
    r.json.return_value = {"transitions": list(transitions)}
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


class TestTerminalCommentDemoted:
    """Since issue #573 the fan-out plane (``dispatchToJira``) owns the Jira
    terminal comment, so the agent no longer exposes ``comment_task_finished``.
    This pins the demotion so a future refactor can't silently re-introduce a
    duplicate terminal comment on the agent side."""

    def test_comment_task_finished_is_gone(self):
        assert not hasattr(jira_reactions, "comment_task_finished")


class TestFailureIsSwallowed:
    def test_http_500_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with patch("jira_reactions.requests.post", return_value=_resp(500, "boom")):
            # Must not raise.
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
            # Three consecutive 401s open the breaker.
            for _ in range(jira_reactions._AUTH_FAILURE_THRESHOLD):
                comment_task_started("jira", JIRA_META)
            calls_after_open = post.call_count
            # Further calls short-circuit without hitting the network.
            comment_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
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
    def test_prefers_indeterminate_category(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        transitions = _transitions_resp(
            _transition("11", "Done", category="done"),
            _transition("21", "In Progress", category="indeterminate"),
            _transition("31", "Backlog", category="new"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", JIRA_META)
        assert post.call_count == 1
        url = post.call_args[0][0]
        assert url == (
            "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/KAN-1/transitions"
        )
        assert post.call_args[1]["json"] == {"transition": {"id": "21"}}

    def test_override_status_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "Doing"}
        transitions = _transitions_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("41", "Doing", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", meta)
        # Name match on the override wins over the category heuristic.
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_override_matches_case_insensitively(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "doing"}
        transitions = _transitions_resp(_transition("41", "Doing", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_task_started("jira", meta)
        assert post.call_args[1]["json"] == {"transition": {"id": "41"}}

    def test_missing_override_target_skips_without_fallback(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "Nonexistent"}
        transitions = _transitions_resp(
            _transition("21", "In Progress", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", meta)
        # An explicit override that isn't reachable must NOT fall back to the
        # category heuristic — it's a deliberate skip.
        post.assert_not_called()

    def test_no_indeterminate_transition_skips(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        transitions = _transitions_resp(
            _transition("11", "Done", category="done"),
            _transition("31", "Backlog", category="new"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_empty_transition_list_skips(self, monkeypatch):
        """GET returns [] when the OAuth user lacks Transition Issues perm."""
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        with (
            patch("jira_reactions.requests.get", return_value=_transitions_resp()),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        post.assert_not_called()

    def test_skips_transition_requiring_screen(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        transitions = _transitions_resp(
            _transition("21", "In Progress", category="indeterminate", has_screen=True),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)
        # hasScreen transitions may require fields we can't supply — skip.
        post.assert_not_called()


class TestPrTransitionSelection:
    def test_matches_in_review_by_name(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        transitions = _transitions_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("51", "In Review", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "51"}}

    def test_matches_in_review_case_insensitively(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        transitions = _transitions_resp(_transition("51", "IN REVIEW"))
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post", return_value=_resp(204)) as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        assert post.call_args[1]["json"] == {"transition": {"id": "51"}}

    def test_no_review_status_leaves_unchanged(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        transitions = _transitions_resp(
            _transition("21", "In Progress", category="indeterminate"),
            _transition("11", "Done", category="done"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_pr_opened("jira", JIRA_META)
        # No "In Review"-named destination → status unchanged.
        post.assert_not_called()

    def test_override_status_on_pr(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_pr": "Code Review"}
        transitions = _transitions_resp(
            _transition("51", "In Review"),
            _transition("61", "Code Review"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
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
            # Once open, transitions AND comments short-circuit.
            transition_task_started("jira", JIRA_META)
            comment_task_started("jira", JIRA_META)
            assert get.call_count == calls_after_open
            post.assert_not_called()

    def test_open_breaker_short_circuits_before_get(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        # Trip the breaker via comments, then confirm transitions never GET.
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
        transitions = _transitions_resp(
            _transition("21", "In Progress", category="indeterminate"),
        )
        with (
            patch("jira_reactions.requests.get", return_value=transitions),
            patch("jira_reactions.requests.post", return_value=_resp(500, "boom")),
        ):
            # Must not raise even though the POST fails.
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
