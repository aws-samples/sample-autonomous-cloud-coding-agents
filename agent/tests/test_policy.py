"""Unit tests for policy.py — Cedar policy engine."""

import pytest

cedarpy = pytest.importorskip("cedarpy")

from policy import PolicyDecision, PolicyEngine


class TestPolicyDecision:
    def test_allowed_decision(self):
        d = PolicyDecision(allowed=True, reason="permitted", duration_ms=0.5)
        assert d.allowed is True
        assert d.reason == "permitted"
        assert d.duration_ms >= 0

    def test_denied_decision(self):
        d = PolicyDecision(allowed=False, reason="denied", duration_ms=1.0)
        assert d.allowed is False


class TestNewTaskPermissions:
    def test_allows_write(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": "src/main.py"})
        assert result.allowed is True

    def test_allows_edit(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Edit", {"file_path": "src/main.py"})
        assert result.allowed is True

    def test_allows_bash(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "npm test"})
        assert result.allowed is True

    def test_allows_read(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Read", {"file_path": "src/main.py"})
        assert result.allowed is True

    def test_allows_glob(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Glob", {"pattern": "**/*.py"})
        assert result.allowed is True

    def test_allows_grep(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Grep", {"pattern": "TODO"})
        assert result.allowed is True


class TestPrReviewPermissions:
    def test_denies_write(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": "src/main.py"})
        assert result.allowed is False
        assert "pr_review" in result.reason

    def test_denies_edit(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Edit", {"file_path": "src/main.py"})
        assert result.allowed is False

    def test_allows_read(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Read", {"file_path": "src/main.py"})
        assert result.allowed is True

    def test_allows_glob(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Glob", {"pattern": "**/*.py"})
        assert result.allowed is True

    def test_allows_grep(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Grep", {"pattern": "TODO"})
        assert result.allowed is True

    def test_allows_bash(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "npm test"})
        assert result.allowed is True


class TestProtectedPaths:
    def test_denies_write_to_github_workflows(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": ".github/workflows/ci.yml"})
        assert result.allowed is False
        assert ".github/workflows/ci.yml" in result.reason

    def test_denies_write_to_git_dir(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": ".git/config"})
        assert result.allowed is False

    def test_allows_write_to_normal_path(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": "src/app.ts"})
        assert result.allowed is True

    def test_denies_edit_to_github_workflows(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Edit", {"file_path": ".github/workflows/deploy.yml"})
        assert result.allowed is False


class TestDestructiveBashCommands:
    def test_denies_rm_rf_root(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "rm -rf /"})
        assert result.allowed is False

    def test_denies_git_push_force(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "git push --force origin main"})
        assert result.allowed is False

    def test_denies_git_push_f(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "git push -f origin main"})
        assert result.allowed is False

    def test_allows_normal_bash(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "npm test"})
        assert result.allowed is True

    def test_allows_mise_run_build(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "mise run build"})
        assert result.allowed is True


class TestExtraPolicies:
    def test_extra_forbid_applied(self):
        extra = [
            'forbid (principal, action == Agent::Action::"invoke_tool", '
            'resource == Agent::Tool::"WebFetch");'
        ]
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", extra_policies=extra)
        result = engine.evaluate_tool_use("WebFetch", {})
        assert result.allowed is False


class TestFailClosed:
    def test_invalid_policy_syntax_fails_closed(self):
        """Invalid Cedar policy syntax should fail closed (deny the call)."""
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        # Override with invalid policies
        engine._policies = "THIS IS NOT VALID CEDAR"
        result = engine.evaluate_tool_use("Write", {"file_path": "test.py"})
        assert result.allowed is False
        assert "fail-closed" in result.reason or "NoDecision" in result.reason


class TestDurationMetrics:
    def test_decision_has_nonnegative_duration(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Read", {"file_path": "test.py"})
        assert result.duration_ms >= 0

    def test_denied_decision_has_nonnegative_duration(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": "test.py"})
        assert result.duration_ms >= 0


class TestTaskTypeProperty:
    def test_task_type_property(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        assert engine.task_type == "new_task"

    def test_task_type_pr_review(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo")
        assert engine.task_type == "pr_review"
