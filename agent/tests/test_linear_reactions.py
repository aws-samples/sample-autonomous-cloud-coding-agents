"""Unit tests for linear_reactions — channel gating + GraphQL wire shape."""

from __future__ import annotations

import threading
from unittest.mock import MagicMock, patch

import pytest

import linear_reactions
from linear_reactions import (
    EMOJI_FAILURE,
    EMOJI_STARTED,
    EMOJI_SUCCESS,
    LINEAR_GRAPHQL_URL,
    react_task_finished,
    react_task_started,
)


@pytest.fixture(autouse=True)
def _reset_module_state():
    """Reset module-level caches and the auth circuit breaker between tests
    so one test's state never leaks into another (viewer cache, consecutive
    auth-failure counter, circuit-open flag)."""
    linear_reactions._viewer_id_cache = None
    linear_reactions._consecutive_auth_failures = 0
    linear_reactions._auth_circuit_open = False
    yield
    linear_reactions._viewer_id_cache = None
    linear_reactions._consecutive_auth_failures = 0
    linear_reactions._auth_circuit_open = False


def _viewer_response(viewer_id: str = "viewer-bot") -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    payload = {"data": {"viewer": {"id": viewer_id}}}
    resp.content = b'{"ok": true}'
    resp.json.return_value = payload
    return resp


def _empty_reactions_response() -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    payload = {"data": {"issue": {"reactions": []}}}
    resp.content = b'{"ok": true}'
    resp.json.return_value = payload
    return resp


def _reactions_response(reactions: list[dict]) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    payload = {"data": {"issue": {"reactions": reactions}}}
    resp.content = b'{"ok": true}'
    resp.json.return_value = payload
    return resp


def _clean_start_calls(reaction_id: str = "r-new") -> list[MagicMock]:
    """Side-effect list for a typical react_task_started call where the
    issue has no prior bgagent reactions to sweep. Order matches the
    runtime call sequence: 👀 is posted first; the sweep (viewer +
    reactions queries) runs after on a background thread.
      1. reactionCreate → returns the new 👀 id
      2. viewer query → returns the bot's id (sweep)
      3. issue reactions query → returns empty list (sweep)
    """
    return [
        _ok_response(reaction_id=reaction_id),
        _viewer_response("viewer-bot"),
        _empty_reactions_response(),
    ]


def _join_sweep_thread(timeout: float = 2.0) -> None:
    """Block until the daemonized sweep thread (started by react_task_started)
    finishes. Tests that assert on call counts must call this after the
    function returns — otherwise the sweep may still be in flight and
    `requests.post` mock counts will race."""
    for t in threading.enumerate():
        if t.name == "linear-reactions-sweep":
            t.join(timeout=timeout)


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
        """Happy path: 👀 posted first → sweep dispatched on background thread."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=_clean_start_calls(reaction_id="react-42"),
        ) as post:
            rid = react_task_started("linear", {"linear_issue_id": "issue-123"})
            assert rid == "react-42"
            # First call is the user-visible reactionCreate for 👀; this lands
            # before the sweep starts so the agent never blocks on Linear API.
            create_call = post.call_args_list[0]
            assert create_call.args[0] == LINEAR_GRAPHQL_URL
            assert create_call.kwargs["headers"]["Authorization"] == "lin_api_test"
            vars_ = create_call.kwargs["json"]["variables"]
            assert vars_["issueId"] == "issue-123"
            assert vars_["emoji"] == EMOJI_STARTED
            # Wait for sweep to finish so we can assert it ran.
            _join_sweep_thread()
            assert post.call_count == 3

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
        """All three calls (viewer, reactions, create) return 500 — must not raise."""
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
        """All three calls return GraphQL `errors` envelopes — must not raise."""
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


class TestSweepStaleReactions:
    """react_task_started sweeps prior bgagent-owned 👀/✅/❌ before posting
    the new 👀, so re-runs (label removed and re-applied; or pre-container ❌
    from the orchestrator/processor followed by a successful retry) don't
    show stale terminal markers next to the new 👀.

    Scoping rules the tests pin:
      - delete only the 3 bgagent emojis (eyes, white_check_mark, x)
      - delete only reactions owned by the API-token viewer
      - never touch human-added reactions, even if they happen to use the
        same emoji
      - never touch bot reactions of OTHER emojis (defensive)
      - sweep failures don't block the 👀 post that follows
    """

    def test_sweep_deletes_only_viewer_owned_bgagent_emojis(self, monkeypatch):
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        prior_reactions = [
            # Bot's own prior 👀, ✅, ❌ — should all be deleted.
            {"id": "r-bot-eyes", "emoji": EMOJI_STARTED, "user": {"id": "viewer-bot"}},
            {"id": "r-bot-check", "emoji": EMOJI_SUCCESS, "user": {"id": "viewer-bot"}},
            {"id": "r-bot-x", "emoji": EMOJI_FAILURE, "user": {"id": "viewer-bot"}},
            # Human-added 👀 — must NOT be deleted (different user id).
            {"id": "r-human-eyes", "emoji": EMOJI_STARTED, "user": {"id": "user-alice"}},
            # Bot's reaction of a non-bgagent emoji — must NOT be deleted (defensive).
            {"id": "r-bot-thumbsup", "emoji": "thumbsup", "user": {"id": "viewer-bot"}},
            # Human reaction with a non-bgagent emoji — must NOT be deleted.
            {"id": "r-human-rocket", "emoji": "rocket", "user": {"id": "user-bob"}},
        ]
        delete_resp = _ok_delete_response()
        with patch(
            "linear_reactions.requests.post",
            side_effect=[
                _ok_response(reaction_id="r-new-eyes"),  # new 👀 (first, user-visible)
                _viewer_response("viewer-bot"),  # sweep: viewer fetch
                _reactions_response(prior_reactions),  # sweep: reactions query
                delete_resp,  # delete r-bot-eyes
                delete_resp,  # delete r-bot-check
                delete_resp,  # delete r-bot-x
            ],
        ) as post:
            rid = react_task_started("linear", {"linear_issue_id": "issue-1"})
            assert rid == "r-new-eyes"
            _join_sweep_thread()

            # First call is the reactionCreate for the new 👀.
            assert post.call_args_list[0].kwargs["json"]["variables"]["emoji"] == EMOJI_STARTED

            # Pull out the reactionDelete calls and assert they are exactly
            # the 3 bot-owned bgagent reactions, no more, no less.
            delete_ids = [
                call.kwargs["json"]["variables"]["id"]
                for call in post.call_args_list
                if "reactionDelete" in call.kwargs["json"]["query"]
            ]
            assert sorted(delete_ids) == sorted(["r-bot-eyes", "r-bot-check", "r-bot-x"])

    def test_sweep_noop_when_issue_has_no_prior_reactions(self, monkeypatch):
        """Empty reactions list → no deletes, just the new 👀."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=_clean_start_calls(),
        ) as post:
            react_task_started("linear", {"linear_issue_id": "issue-1"})
            _join_sweep_thread()
            # 3 calls total: create (👀), viewer, reactions (empty). No deletes.
            queries = [c.kwargs["json"]["query"] for c in post.call_args_list]
            assert sum("reactionDelete" in q for q in queries) == 0

    def test_sweep_noop_when_viewer_fetch_fails(self, monkeypatch):
        """Viewer fetch returning errors short-circuits the sweep — we
        can't safely filter without knowing the viewer id, so skip rather
        than risk deleting a human's reaction. The 👀 post still runs
        (and succeeds first, before the sweep even starts)."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        viewer_err = MagicMock()
        viewer_err.status_code = 200
        viewer_err.content = b'{"errors":[{"message":"auth"}]}'
        viewer_err.json.return_value = {"errors": [{"message": "auth"}]}
        with patch(
            "linear_reactions.requests.post",
            side_effect=[_ok_response(reaction_id="r-new"), viewer_err],
        ) as post:
            rid = react_task_started("linear", {"linear_issue_id": "issue-1"})
            assert rid == "r-new"
            _join_sweep_thread()
            # 2 calls: 👀 first (success), then failed viewer. No reactions query, no deletes.
            assert post.call_count == 2
            assert post.call_args_list[0].kwargs["json"]["variables"]["emoji"] == EMOJI_STARTED

    def test_sweep_failure_does_not_block_eyes_post(self, monkeypatch):
        """Reactions query fails → sweep gives up but the 👀 already landed
        (it posts first, before the sweep starts)."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        reactions_err = MagicMock()
        reactions_err.status_code = 500
        reactions_err.content = b"err"
        reactions_err.json.return_value = {}
        with patch(
            "linear_reactions.requests.post",
            side_effect=[
                _ok_response(reaction_id="r-new"),
                _viewer_response("viewer-bot"),
                reactions_err,
            ],
        ) as post:
            rid = react_task_started("linear", {"linear_issue_id": "issue-1"})
            assert rid == "r-new"
            _join_sweep_thread()
            assert post.call_count == 3

    def test_viewer_id_cached_across_calls(self, monkeypatch):
        """Second call within the same container reuses the cached viewer id —
        no second viewer query, just create + reactions."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=[
                _ok_response(reaction_id="r-1"),  # 1st call's 👀
                _viewer_response("viewer-bot"),  # 1st call's viewer fetch (sweep)
                _empty_reactions_response(),  # 1st call's reactions query (sweep)
                _ok_response(reaction_id="r-2"),  # 2nd call's 👀
                _empty_reactions_response(),  # 2nd call's reactions only (cached viewer)
            ],
        ) as post:
            react_task_started("linear", {"linear_issue_id": "issue-1"})
            _join_sweep_thread()
            react_task_started("linear", {"linear_issue_id": "issue-1"})
            _join_sweep_thread()
            queries = [c.kwargs["json"]["query"] for c in post.call_args_list]
            # Only one viewer query across both calls.
            assert sum("Viewer" in q for q in queries) == 1

    def test_sweep_preserves_just_posted_eyes_via_exclude_id(self, monkeypatch):
        """If Linear's reactions query happens to return our just-posted 👀
        (e.g. on a tight retry where the prior run's reaction id was reused
        by Linear), the sweep MUST NOT delete it — exclude_id is what keeps
        the new marker safe. Tests would otherwise pass with exclude_id=None
        because the prior reaction ids never collide with the new one."""
        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        new_rid = "r-new-eyes"
        prior_reactions = [
            # The just-posted 👀 — sweep must SKIP this one.
            {"id": new_rid, "emoji": EMOJI_STARTED, "user": {"id": "viewer-bot"}},
            # An older bgagent ❌ from a prior run — sweep MUST delete this.
            {"id": "r-old-x", "emoji": EMOJI_FAILURE, "user": {"id": "viewer-bot"}},
        ]
        with patch(
            "linear_reactions.requests.post",
            side_effect=[
                _ok_response(reaction_id=new_rid),
                _viewer_response("viewer-bot"),
                _reactions_response(prior_reactions),
                _ok_delete_response(),  # only one delete expected
            ],
        ) as post:
            react_task_started("linear", {"linear_issue_id": "issue-1"})
            _join_sweep_thread()
            delete_ids = [
                call.kwargs["json"]["variables"]["id"]
                for call in post.call_args_list
                if "reactionDelete" in call.kwargs["json"]["query"]
            ]
            # The new 👀 must NOT be deleted; only the old ❌ should be.
            assert delete_ids == ["r-old-x"]


class TestAuthCircuitBreaker:
    """The circuit breaker in `_graphql` flips open after
    ``_AUTH_FAILURE_THRESHOLD`` consecutive 401/403s and short-circuits all
    subsequent calls until container restart. Auto-reset fixture clears
    ``_consecutive_auth_failures`` and ``_auth_circuit_open`` between tests.

    These tests target `_graphql` directly via the public `react_task_started`
    entry point — by exhausting the auth-failure budget on early sweeps and
    asserting later calls don't hit the network.
    """

    def _auth_response(self, status: int = 401) -> MagicMock:
        resp = MagicMock()
        resp.status_code = status
        resp.content = b'{"errors":[{"message":"auth"}]}'
        resp.json.return_value = {"errors": [{"message": "auth"}]}
        return resp

    def test_three_consecutive_401s_open_the_circuit(self, monkeypatch):
        """Threshold is 3 — call `_graphql` directly via the private API to
        exercise the increment + open logic without depending on the
        public-API call shape."""
        import linear_reactions

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=[self._auth_response(401)] * 3,
        ) as post:
            assert linear_reactions._graphql("query Q { x }", {}) is None
            assert linear_reactions._graphql("query Q { x }", {}) is None
            assert linear_reactions._graphql("query Q { x }", {}) is None
            assert post.call_count == 3
        assert linear_reactions._consecutive_auth_failures == 3
        assert linear_reactions._auth_circuit_open is True

    def test_open_circuit_short_circuits_subsequent_calls(self, monkeypatch):
        """Once the circuit is open, no network calls — the function returns
        None immediately."""
        import linear_reactions

        linear_reactions._auth_circuit_open = True
        with patch("linear_reactions.requests.post") as post:
            assert linear_reactions._graphql("query Q { x }", {}) is None
            assert linear_reactions._graphql("query Q { x }", {}) is None
            post.assert_not_called()

    def test_2xx_response_resets_failure_counter(self, monkeypatch):
        """A 200 between 401s clears the counter — the circuit only trips on
        consecutive failures, not cumulative."""
        import linear_reactions

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        ok = MagicMock()
        ok.status_code = 200
        ok.content = b'{"data":{"x":1}}'
        ok.json.return_value = {"data": {"x": 1}}
        with patch(
            "linear_reactions.requests.post",
            side_effect=[
                self._auth_response(401),
                self._auth_response(401),
                ok,  # resets counter
                self._auth_response(401),
                self._auth_response(401),
            ],
        ):
            for _ in range(5):
                linear_reactions._graphql("query Q { x }", {})
        # 2 failures after the reset, threshold=3 → circuit still closed.
        assert linear_reactions._consecutive_auth_failures == 2
        assert linear_reactions._auth_circuit_open is False

    def test_non_auth_errors_do_not_increment_failure_counter(self, monkeypatch):
        """A 500 is a server problem, not an auth problem — must not
        contribute to the auth-failure budget."""
        import linear_reactions

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        five_hundred = MagicMock()
        five_hundred.status_code = 500
        five_hundred.content = b"server error"
        five_hundred.json.return_value = {}
        with patch(
            "linear_reactions.requests.post",
            side_effect=[five_hundred] * 5,
        ):
            for _ in range(5):
                linear_reactions._graphql("query Q { x }", {})
        assert linear_reactions._consecutive_auth_failures == 0
        assert linear_reactions._auth_circuit_open is False

    def test_403_treated_same_as_401(self, monkeypatch):
        """Both auth-failure status codes count toward the threshold."""
        import linear_reactions

        monkeypatch.setenv("LINEAR_API_TOKEN", "lin_api_test")
        with patch(
            "linear_reactions.requests.post",
            side_effect=[
                self._auth_response(401),
                self._auth_response(403),
                self._auth_response(401),
            ],
        ):
            for _ in range(3):
                linear_reactions._graphql("query Q { x }", {})
        assert linear_reactions._auth_circuit_open is True
