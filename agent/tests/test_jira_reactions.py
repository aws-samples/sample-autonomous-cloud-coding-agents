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


def _issue_resp(
    *transitions: dict,
    current_name: str = "To Do",
    current_category: str = "new",
) -> MagicMock:
    """Build a 200 GET issue (?fields=status&expand=transitions) response.

    Includes both the issue's current ``status`` (default ``To Do``/``new``) and
    the available ``transitions`` — the shape ``_get_issue_transitions`` reads.
    """
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
    def test_prefers_in_progress_by_name_over_blocked(self, monkeypatch):
        """#605: both Blocked and In Progress are `indeterminate`; a name match
        must land on In Progress regardless of list order."""
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        # Blocked listed FIRST — a category-only heuristic would wrongly pick it.
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
        # POST still goes to the transitions endpoint.
        assert post.call_args[0][0].endswith("/rest/api/3/issue/KAN-1/transitions")

    def test_falls_back_to_indeterminate_category(self, monkeypatch):
        """No In-Progress-named transition → any indeterminate (not Blocked)."""
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
        """#605: if the only indeterminate transition is Blocked, skip — the
        category fallback must not silently land on Blocked."""
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
        """#605: a re-trigger on an already-In-Progress issue must not move it
        (and must not move it backward)."""
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
        """Already past In Progress (In Review is indeterminate too) → skip."""
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
        # Name match on the override wins over the In-Progress name heuristic.
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
        """An explicit override is a deliberate instruction — honor it
        regardless of the current status (no already-past skip)."""
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

    def test_missing_override_target_skips_without_fallback(self, monkeypatch):
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        meta = {**JIRA_META, "jira_status_on_start": "Nonexistent"}
        issue = _issue_resp(_transition("21", "In Progress", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get", return_value=issue),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", meta)
        # An explicit override that isn't reachable must NOT fall back to the
        # name/category heuristic — it's a deliberate skip.
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
        """GET returns [] when the OAuth user lacks Transition Issues perm."""
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
        # hasScreen transitions may require fields we can't supply — skip.
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
        """#605: a 'Code Review' column (no literal 'In Review') still matches."""
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
        """When both exist, the higher-priority 'In Review' name wins."""
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
        """#605: a board with no review status stays at / moves to In Progress
        rather than silently no-opping (mirrors Linear's fallback)."""
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        # Issue is still To Do (start hook may have failed); PR hook should at
        # least advance it to In Progress via the name fallback.
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
        """Only skip the PR transition if the issue is already Done."""
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
        # No review-named, no In Progress name, only a Done transition → skip.
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
        issue = _issue_resp(_transition("21", "In Progress", category="indeterminate"))
        with (
            patch("jira_reactions.requests.get", return_value=issue),
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

    @pytest.mark.parametrize("body", [None, [], 42, "scalar"])
    def test_non_dict_json_does_not_raise(self, monkeypatch, body):
        """#605: valid JSON that isn't an object must not raise AttributeError
        (which would propagate out of the hook and flip the task to FAILED)."""
        monkeypatch.setenv("JIRA_API_TOKEN", "jira_at")
        r = MagicMock()
        r.status_code = 200
        r.text = ""
        r.json.return_value = body
        with (
            patch("jira_reactions.requests.get", return_value=r),
            patch("jira_reactions.requests.post") as post,
        ):
            transition_task_started("jira", JIRA_META)  # must not raise
            post.assert_not_called()
