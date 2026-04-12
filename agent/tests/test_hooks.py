"""Unit tests for hooks.py — Cedar policy SDK hook callbacks."""

import asyncio

import pytest

cedarpy = pytest.importorskip("cedarpy")

from hooks import build_hook_matchers, pre_tool_use_hook
from policy import PolicyEngine


def _run(coro):
    """Helper to run async coroutine in tests."""
    return asyncio.run(coro)


class TestPreToolUseHook:
    def test_allows_permitted_tool(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Read",
            "tool_input": {"file_path": "src/main.py"},
            "tool_use_id": "test-123",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-123", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "allow"

    def test_denies_restricted_tool(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "tool_input": {"file_path": "src/main.py"},
            "tool_use_id": "test-456",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-456", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
        assert "pr_review" in result["hookSpecificOutput"]["permissionDecisionReason"]

    def test_denies_protected_path(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "tool_input": {"file_path": ".github/workflows/ci.yml"},
            "tool_use_id": "test-789",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-789", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_denies_destructive_bash(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "rm -rf /"},
            "tool_use_id": "test-abc",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-abc", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_allows_normal_bash(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "npm test"},
            "tool_use_id": "test-def",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-def", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "allow"

    def test_handles_string_tool_input(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Read",
            "tool_input": '{"file_path": "test.py"}',
            "tool_use_id": "test-ghi",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-ghi", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "allow"

    def test_denies_non_dict_hook_input(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = _run(pre_tool_use_hook("not a dict", "test-x", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
        assert "invalid hook input" in result["hookSpecificOutput"]["permissionDecisionReason"]

    def test_denies_unparseable_string_tool_input(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Read",
            "tool_input": "not valid json{{{",
            "tool_use_id": "test-bad",
            "session_id": "sess-1",
            "transcript_path": "/tmp/t",
            "cwd": "/workspace",
        }
        result = _run(pre_tool_use_hook(hook_input, "test-bad", {}, engine=engine))
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"
        assert "unparseable tool input" in result["hookSpecificOutput"]["permissionDecisionReason"]


class TestBuildHookMatchers:
    def test_returns_correct_structure(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        matchers = build_hook_matchers(engine=engine)
        assert "PreToolUse" in matchers
        assert "PostToolUse" not in matchers
        assert len(matchers["PreToolUse"]) == 1

    def test_hook_matchers_have_callbacks(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        matchers = build_hook_matchers(engine=engine)
        pre_matcher = matchers["PreToolUse"][0]
        # HookMatcher has matcher=None (match all) and hooks list
        assert pre_matcher.matcher is None
        assert len(pre_matcher.hooks) == 1

    def test_matchers_with_trajectory(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        # Pass None for trajectory — should still work
        matchers = build_hook_matchers(engine=engine, trajectory=None)
        assert "PreToolUse" in matchers
        assert "PostToolUse" not in matchers
