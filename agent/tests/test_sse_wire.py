# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Unit tests for sse_wire.translate — the AG-UI semantic→wire translator.

Pure function tests: construct a semantic event dict, call translate with
a fresh _TranslationState, assert on the list of AG-UI event dicts.
"""

from __future__ import annotations

import re

import pytest

from sse_wire import (
    _TranslationState,
    make_run_error,
    make_run_finished,
    make_run_started,
    translate,
)

_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def _fresh() -> _TranslationState:
    return _TranslationState()


# ---------------------------------------------------------------------------
# agent_turn
# ---------------------------------------------------------------------------


class TestAgentTurn:
    def test_turn_with_text_emits_three_text_message_events(self):
        state = _fresh()
        out = translate(
            {
                "type": "agent_turn",
                "turn": 1,
                "model": "claude-sonnet-4-5",
                "thinking": "",
                "text": "Hello world",
                "tool_calls_count": 0,
            },
            state=state,
        )
        types = [e["type"] for e in out]
        assert types == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]
        # Same messageId across all three
        msg_ids = {e["messageId"] for e in out}
        assert len(msg_ids) == 1
        mid = next(iter(msg_ids))
        assert _ULID_RE.match(mid)
        assert state.last_message_id == mid
        # Role set only on START
        assert out[0]["role"] == "assistant"
        assert "role" not in out[2]
        # Content delta is the text
        assert out[1]["delta"] == "Hello world"
        # Timestamps are ints
        for e in out:
            assert isinstance(e["timestamp"], int)

    def test_turn_with_thinking_prefixes_custom_event(self):
        state = _fresh()
        out = translate(
            {
                "type": "agent_turn",
                "turn": 3,
                "thinking": "Let me think about this...",
                "text": "Answer",
                "tool_calls_count": 0,
            },
            state=state,
        )
        types = [e["type"] for e in out]
        assert types == [
            "CUSTOM",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
        ]
        assert out[0]["name"] == "agent_thinking"
        assert out[0]["value"] == {"turn": 3, "thinking": "Let me think about this..."}

    def test_turn_with_empty_text_still_emits_message_triple(self):
        """Empty text is still a valid turn — content delta is empty string."""
        state = _fresh()
        out = translate(
            {"type": "agent_turn", "turn": 1, "thinking": "", "text": "", "tool_calls_count": 0},
            state=state,
        )
        assert [e["type"] for e in out] == [
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
        ]
        assert out[1]["delta"] == ""

    def test_turn_updates_last_message_id_across_turns(self):
        state = _fresh()
        translate({"type": "agent_turn", "turn": 1, "text": "a"}, state=state)
        first = state.last_message_id
        translate({"type": "agent_turn", "turn": 2, "text": "b"}, state=state)
        second = state.last_message_id
        assert first != second


# ---------------------------------------------------------------------------
# agent_tool_call
# ---------------------------------------------------------------------------


class TestAgentToolCall:
    def test_tool_call_emits_start_args_end(self):
        state = _fresh()
        out = translate(
            {
                "type": "agent_tool_call",
                "tool_name": "Bash",
                "tool_input": "ls -la",
                "turn": 1,
            },
            state=state,
        )
        assert [e["type"] for e in out] == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]
        ids = {e["toolCallId"] for e in out}
        assert len(ids) == 1
        assert _ULID_RE.match(next(iter(ids)))
        assert out[0]["toolCallName"] == "Bash"
        assert out[1]["delta"] == "ls -la"

    def test_tool_call_attaches_parent_message_id_when_available(self):
        state = _fresh()
        translate({"type": "agent_turn", "turn": 1, "text": "x"}, state=state)
        out = translate(
            {"type": "agent_tool_call", "tool_name": "Read", "tool_input": "{}", "turn": 1},
            state=state,
        )
        assert out[0]["parentMessageId"] == state.last_message_id

    def test_tool_call_without_prior_turn_omits_parent_message_id(self):
        state = _fresh()
        out = translate(
            {"type": "agent_tool_call", "tool_name": "Read", "tool_input": "{}", "turn": 1},
            state=state,
        )
        assert "parentMessageId" not in out[0]

    def test_tool_call_pending_id_tracked_for_later_result(self):
        state = _fresh()
        translate(
            {"type": "agent_tool_call", "tool_name": "Bash", "tool_input": "a", "turn": 1},
            state=state,
        )
        assert (1, "Bash") in state.tool_calls_pending
        assert len(state.tool_calls_pending[(1, "Bash")]) == 1


# ---------------------------------------------------------------------------
# agent_tool_result
# ---------------------------------------------------------------------------


class TestAgentToolResult:
    def test_tool_result_correlates_with_prior_tool_call(self):
        state = _fresh()
        call_out = translate(
            {"type": "agent_tool_call", "tool_name": "Bash", "tool_input": "ls", "turn": 2},
            state=state,
        )
        call_id = call_out[0]["toolCallId"]
        result_out = translate(
            {
                "type": "agent_tool_result",
                "tool_name": "Bash",
                "is_error": False,
                "content": "output",
                "turn": 2,
            },
            state=state,
        )
        assert len(result_out) == 1
        assert result_out[0]["type"] == "TOOL_CALL_RESULT"
        assert result_out[0]["toolCallId"] == call_id
        assert result_out[0]["role"] == "tool"
        assert result_out[0]["content"] == "output"
        assert "error" not in result_out[0]
        # Pending bucket cleared
        assert (2, "Bash") not in state.tool_calls_pending

    def test_tool_result_marks_error_when_is_error_true(self):
        state = _fresh()
        translate(
            {"type": "agent_tool_call", "tool_name": "Bash", "tool_input": "x", "turn": 1},
            state=state,
        )
        out = translate(
            {
                "type": "agent_tool_result",
                "tool_name": "Bash",
                "is_error": True,
                "content": "boom",
                "turn": 1,
            },
            state=state,
        )
        assert out[0]["error"] is True

    def test_tool_result_without_matching_call_synthesises_id(self):
        state = _fresh()
        out = translate(
            {
                "type": "agent_tool_result",
                "tool_name": "Read",
                "is_error": False,
                "content": "",
                "turn": 1,
            },
            state=state,
        )
        assert len(out) == 1
        assert _ULID_RE.match(out[0]["toolCallId"])

    def test_multiple_same_tool_in_turn_correlate_fifo(self):
        state = _fresh()
        c1 = translate(
            {"type": "agent_tool_call", "tool_name": "Bash", "tool_input": "1", "turn": 1},
            state=state,
        )[0]["toolCallId"]
        c2 = translate(
            {"type": "agent_tool_call", "tool_name": "Bash", "tool_input": "2", "turn": 1},
            state=state,
        )[0]["toolCallId"]
        r1 = translate(
            {
                "type": "agent_tool_result",
                "tool_name": "Bash",
                "is_error": False,
                "content": "a",
                "turn": 1,
            },
            state=state,
        )[0]["toolCallId"]
        r2 = translate(
            {
                "type": "agent_tool_result",
                "tool_name": "Bash",
                "is_error": False,
                "content": "b",
                "turn": 1,
            },
            state=state,
        )[0]["toolCallId"]
        assert [r1, r2] == [c1, c2]


# ---------------------------------------------------------------------------
# milestone / cost / error
# ---------------------------------------------------------------------------


class TestAgentMilestone:
    def test_milestone_emits_step_started_and_finished(self):
        out = translate(
            {
                "type": "agent_milestone",
                "milestone": "repo_setup_complete",
                "details": "branch=main",
            },
            state=_fresh(),
        )
        assert [e["type"] for e in out] == ["STEP_STARTED", "STEP_FINISHED"]
        assert out[0]["stepName"] == "repo_setup_complete"
        assert out[1]["stepName"] == "repo_setup_complete"
        assert out[1]["details"] == "branch=main"

    def test_milestone_without_details_omits_details_field(self):
        out = translate({"type": "agent_milestone", "milestone": "pr_created"}, state=_fresh())
        assert "details" not in out[1]


class TestAgentCostUpdate:
    def test_cost_update_is_custom_event(self):
        out = translate(
            {
                "type": "agent_cost_update",
                "cost_usd": 0.1234,
                "input_tokens": 100,
                "output_tokens": 50,
                "turn": 3,
            },
            state=_fresh(),
        )
        assert len(out) == 1
        assert out[0]["type"] == "CUSTOM"
        assert out[0]["name"] == "agent_cost_update"
        assert out[0]["value"] == {
            "cost_usd": 0.1234,
            "input_tokens": 100,
            "output_tokens": 50,
            "turn": 3,
        }

    def test_cost_update_with_none_cost_preserves_none(self):
        out = translate(
            {
                "type": "agent_cost_update",
                "cost_usd": None,
                "input_tokens": 0,
                "output_tokens": 0,
                "turn": 0,
            },
            state=_fresh(),
        )
        assert out[0]["value"]["cost_usd"] is None


class TestAgentError:
    def test_error_sets_saw_error_flag(self):
        state = _fresh()
        out = translate(
            {"type": "agent_error", "error_type": "RuntimeError", "message": "boom"},
            state=state,
        )
        assert state.saw_error is True
        assert out[0]["type"] == "CUSTOM"
        assert out[0]["name"] == "agent_error"
        assert out[0]["value"] == {"error_type": "RuntimeError", "message": "boom"}

    def test_error_with_missing_fields_defaults_sensibly(self):
        state = _fresh()
        out = translate({"type": "agent_error"}, state=state)
        assert out[0]["value"]["error_type"] == "UnknownError"
        assert out[0]["value"]["message"] == ""


class TestUnknown:
    def test_unknown_event_type_returns_empty_list(self):
        assert translate({"type": "nonsense"}, state=_fresh()) == []

    def test_missing_type_returns_empty_list(self):
        assert translate({}, state=_fresh()) == []


# ---------------------------------------------------------------------------
# synthesised run-level events
# ---------------------------------------------------------------------------


class TestRunEvents:
    def test_run_started_shape(self):
        e = make_run_started("task-123")
        assert e["type"] == "RUN_STARTED"
        assert e["runId"] == "task-123"
        assert e["threadId"] == "task-123"
        assert isinstance(e["timestamp"], int)

    def test_run_finished_shape(self):
        e = make_run_finished("task-abc", thread_id="thr-1")
        assert e["type"] == "RUN_FINISHED"
        assert e["runId"] == "task-abc"
        assert e["threadId"] == "thr-1"

    def test_run_error_shape(self):
        e = make_run_error("t", code="AgentError", message="fail")
        assert e["type"] == "RUN_ERROR"
        assert e["code"] == "AgentError"
        assert e["message"] == "fail"


# ---------------------------------------------------------------------------
# field-format invariants
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "event",
    [
        {"type": "agent_turn", "turn": 1, "text": "t"},
        {"type": "agent_tool_call", "tool_name": "X", "tool_input": "{}", "turn": 1},
        {
            "type": "agent_tool_result",
            "tool_name": "X",
            "is_error": False,
            "content": "",
            "turn": 1,
        },
        {"type": "agent_milestone", "milestone": "m"},
        {
            "type": "agent_cost_update",
            "cost_usd": 0.0,
            "input_tokens": 0,
            "output_tokens": 0,
            "turn": 0,
        },
        {"type": "agent_error", "error_type": "E", "message": "m"},
    ],
)
def test_every_event_has_type_and_timestamp(event):
    out = translate(event, state=_fresh())
    assert out  # non-empty
    for e in out:
        assert "type" in e
        assert "timestamp" in e
        assert isinstance(e["timestamp"], int)
