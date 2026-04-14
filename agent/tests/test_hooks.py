"""Unit tests for hooks.py — Cedar policy SDK hook callbacks."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

cedarpy = pytest.importorskip("cedarpy")

from hooks import build_hook_matchers, post_tool_use_hook, pre_tool_use_hook
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

    def test_denies_git_internals_path(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        hook_input = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Write",
            "tool_input": {"file_path": ".git/config"},
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


class TestPostToolUseHook:
    def test_passes_through_clean_output(self):
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
            "tool_response": "def hello():\n    return 'world'\n",
        }
        result = _run(post_tool_use_hook(hook_input, "test-1", {}))
        output = result["hookSpecificOutput"]
        assert output["hookEventName"] == "PostToolUse"
        assert "updatedMCPToolOutput" not in output

    def test_redacts_aws_key_in_output(self):
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        }
        result = _run(post_tool_use_hook(hook_input, "test-2", {}))
        output = result["hookSpecificOutput"]
        assert output["hookEventName"] == "PostToolUse"
        assert "updatedMCPToolOutput" in output
        assert "AKIAIOSFODNN7EXAMPLE" not in output["updatedMCPToolOutput"]
        assert "[REDACTED-AWS_KEY]" in output["updatedMCPToolOutput"]

    def test_redacts_github_token_in_output(self):
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        }
        result = _run(post_tool_use_hook(hook_input, "test-3", {}))
        output = result["hookSpecificOutput"]
        assert "updatedMCPToolOutput" in output
        assert "ghp_" not in output["updatedMCPToolOutput"]
        assert "[REDACTED-GITHUB_TOKEN]" in output["updatedMCPToolOutput"]

    def test_redacts_private_key_in_output(self):
        pem = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEowIBAAKCAQEA0Z3VS5JJcds3xf...\n"
            "-----END RSA PRIVATE KEY-----"
        )
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
            "tool_response": f"file contents:\n{pem}\nend",
        }
        result = _run(post_tool_use_hook(hook_input, "test-4", {}))
        output = result["hookSpecificOutput"]
        assert "updatedMCPToolOutput" in output
        assert "BEGIN RSA PRIVATE KEY" not in output["updatedMCPToolOutput"]
        assert "[REDACTED-PRIVATE_KEY]" in output["updatedMCPToolOutput"]
        # Surrounding content preserved
        assert "file contents:" in output["updatedMCPToolOutput"]
        assert "end" in output["updatedMCPToolOutput"]

    def test_handles_non_dict_hook_input(self):
        result = _run(post_tool_use_hook("not a dict", "test-5", {}))
        output = result["hookSpecificOutput"]
        assert output["hookEventName"] == "PostToolUse"
        assert "updatedMCPToolOutput" not in output

    def test_handles_non_string_tool_response(self):
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": {"output": "AKIAIOSFODNN7EXAMPLE"},
        }
        result = _run(post_tool_use_hook(hook_input, "test-6", {}))
        output = result["hookSpecificOutput"]
        # dict converted to str, AWS key detected
        assert "updatedMCPToolOutput" in output
        assert "AKIAIOSFODNN7EXAMPLE" not in output["updatedMCPToolOutput"]

    def test_handles_missing_tool_response(self):
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
        }
        result = _run(post_tool_use_hook(hook_input, "test-7", {}))
        output = result["hookSpecificOutput"]
        assert output["hookEventName"] == "PostToolUse"
        assert "updatedMCPToolOutput" not in output

    # ---- Telemetry integration ----

    def test_trajectory_called_on_redaction(self):
        trajectory = MagicMock()
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": "key=AKIAIOSFODNN7EXAMPLE",
        }
        _run(post_tool_use_hook(hook_input, "test-t1", {}, trajectory=trajectory))
        trajectory.write_output_screening_decision.assert_called_once()
        call_args = trajectory.write_output_screening_decision.call_args
        # positional args: tool_name, findings, redacted, duration_ms
        assert call_args[0][0] == "Bash"
        assert "AWS_KEY detected" in call_args[0][1]

    def test_trajectory_not_called_on_clean_output(self):
        trajectory = MagicMock()
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
            "tool_response": "clean content",
        }
        _run(post_tool_use_hook(hook_input, "test-t2", {}, trajectory=trajectory))
        trajectory.write_output_screening_decision.assert_not_called()

    # ---- Scanner exception handling (fail-closed) ----

    def test_fail_closed_on_scanner_exception(self):
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": "some content",
        }
        with patch("hooks.scan_tool_output", side_effect=RuntimeError("regex boom")):
            result = _run(post_tool_use_hook(hook_input, "test-err", {}))
        output = result["hookSpecificOutput"]
        assert output["hookEventName"] == "PostToolUse"
        assert "updatedMCPToolOutput" in output
        assert "fail-closed" in output["updatedMCPToolOutput"]

    def test_fail_closed_emits_telemetry(self):
        trajectory = MagicMock()
        hook_input = {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": "some content",
        }
        with patch("hooks.scan_tool_output", side_effect=RuntimeError("regex boom")):
            _run(post_tool_use_hook(hook_input, "test-err2", {}, trajectory=trajectory))
        trajectory.write_output_screening_decision.assert_called_once()
        call_args = trajectory.write_output_screening_decision.call_args
        assert call_args[0][0] == "Bash"
        assert any("SCANNER_ERROR" in f for f in call_args[0][1])


class TestBuildHookMatchers:
    def test_returns_correct_structure(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        matchers = build_hook_matchers(engine=engine)
        assert "PreToolUse" in matchers
        assert "PostToolUse" in matchers
        assert len(matchers["PreToolUse"]) == 1
        assert len(matchers["PostToolUse"]) == 1

    def test_hook_matchers_have_callbacks(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        matchers = build_hook_matchers(engine=engine)
        pre_matcher = matchers["PreToolUse"][0]
        # HookMatcher has matcher=None (match all) and hooks list
        assert pre_matcher.matcher is None
        assert len(pre_matcher.hooks) == 1

    def test_post_hook_matcher_structure(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        matchers = build_hook_matchers(engine=engine)
        post_matcher = matchers["PostToolUse"][0]
        assert post_matcher.matcher is None
        assert len(post_matcher.hooks) == 1

    def test_matchers_with_trajectory(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        # Pass None for trajectory — should still work
        matchers = build_hook_matchers(engine=engine, trajectory=None)
        assert "PreToolUse" in matchers
        assert "PostToolUse" in matchers
