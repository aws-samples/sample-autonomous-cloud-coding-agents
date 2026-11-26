from unittest.mock import patch

import cedarpy  # noqa: F401
import pytest

import policy
from policy import PolicyEngine, _validate_constants


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


class TestReadOnlyPermissions:
    def test_denies_write(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Write", {"file_path": "src/main.py"})
        assert result.allowed is False

    def test_denies_edit(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Edit", {"file_path": "src/main.py"})
        assert result.allowed is False

    def test_denies_write_for_any_read_only_principal(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Write", {"file_path": "src/main.py"})
        assert result.allowed is False

    def test_writeable_principal_allows_write(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=False)
        result = engine.evaluate_tool_use("Write", {"file_path": "src/main.py"})
        assert result.allowed is True

    def test_allows_read(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Read", {"file_path": "src/main.py"})
        assert result.allowed is True

    def test_allows_glob(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Glob", {"pattern": "**/*.py"})
        assert result.allowed is True

    def test_allows_grep(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Grep", {"pattern": "TODO"})
        assert result.allowed is True

    def test_allows_bash(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Bash", {"command": "npm test"})
        assert result.allowed is True


class TestReadOnlyMissingAttributeFailsClosed:
    """Cedar skips a forbid rule whose ``when`` clause errors on a missing
    attribute: the base permit wins, and the answer is Allow with
    ``diagnostics.errors`` set."""

    def test_eval_tier_reraises_on_missing_read_only_attribute(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", read_only=True)
        with pytest.raises(RuntimeError, match="Cedar policy parse/eval errors"):
            engine._eval_tier(
                policies_text=engine._hard_policies,
                action="invoke_tool",
                resource_type="Agent::Tool",
                resource_id="Write",
                context={},
            )

    def test_evaluate_tool_use_always_injects_read_only(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Write", {"file_path": "src/app.py"})
        assert result.allowed is False


class TestProtectedPaths:
    def test_denies_write_to_git_dir(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": ".git/config"})
        assert result.allowed is False

    def test_denies_write_to_git_dir_absolute_path(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": "/workspace/abc123/.git/config"})
        assert result.allowed is False

    def test_allows_write_to_normal_path(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": "src/app.ts"})
        assert result.allowed is True

    def test_allows_write_to_github_workflows(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": ".github/workflows/ci.yml"})
        assert result.allowed is True

    def test_allows_edit_to_github_workflows(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Edit", {"file_path": ".github/workflows/deploy.yml"})
        assert result.allowed is True


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

    def test_denies_git_push_f_no_trailing_args(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "git push -f"})
        assert result.allowed is False

    def test_allows_normal_bash(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "npm test"})
        assert result.allowed is True

    def test_allows_mise_run_build(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": "mise run build"})
        assert result.allowed is True


class TestBashCommandsWithQuotes:
    @pytest.mark.parametrize(
        "cmd",
        [
            'git commit -m "fix: login bug"',
            'git commit-tree HEAD^{tree} -m "squash"',
            'gh pr create --title "my PR" --body "desc"',
            'gh api --method POST /repos/o/r/pulls -f title="PR"',
            "git commit -m \"$(cat <<'EOF'\nFix the bug\nEOF\n)\"",
        ],
        ids=["git-commit-msg", "git-commit-tree", "gh-pr-create", "gh-api-post", "heredoc-commit"],
    )
    def test_allows_command_with_quotes(self, cmd):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": cmd})
        assert result.allowed is True

    def test_denies_force_push_with_quotes(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Bash", {"command": 'git push --force "origin" main'})
        assert result.allowed is False


class TestFilePathsWithSpecialChars:
    def test_allows_path_with_quotes(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": '/workspace/it"s-a-file.ts'})
        assert result.allowed is True

    def test_denies_git_dir_path_with_quotes(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Write", {"file_path": '.git/hooks/pre"commit'})
        assert result.allowed is False


class TestExtraPolicies:
    def test_extra_forbid_applied(self):
        extra = [
            (
                'forbid (principal, action == Agent::Action::"invoke_tool", '
                'resource == Agent::Tool::"WebFetch");'
            )
        ]
        engine = PolicyEngine(task_type="new_task", repo="owner/repo", extra_policies=extra)
        result = engine.evaluate_tool_use("WebFetch", {})
        assert result.allowed is False


class TestFailClosed:
    def test_invalid_policy_syntax_fails_closed(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        engine._hard_policies = "THIS IS NOT VALID CEDAR"
        result = engine.evaluate_tool_use("Write", {"file_path": "test.py"})
        assert result.allowed is False
        assert "fail-closed" in result.reason or "NoDecision" in result.reason


class TestDurationMetrics:
    def test_decision_has_nonnegative_duration(self):
        engine = PolicyEngine(task_type="new_task", repo="owner/repo")
        result = engine.evaluate_tool_use("Read", {"file_path": "test.py"})
        assert result.duration_ms >= 0

    def test_denied_decision_has_nonnegative_duration(self):
        engine = PolicyEngine(task_type="pr_review", repo="owner/repo", read_only=True)
        result = engine.evaluate_tool_use("Write", {"file_path": "test.py"})
        assert result.duration_ms >= 0


class TestConstantsSemanticValidation:
    def test_rejects_approval_timeout_min_zero(self):
        with (
            patch.object(policy, "FLOOR_TIMEOUT_S", 0),
            pytest.raises(ValueError, match=r"approval_timeout_s\.min must be > 0"),
        ):
            _validate_constants()

    def test_rejects_approval_timeout_min_negative(self):
        with (
            patch.object(policy, "FLOOR_TIMEOUT_S", -1),
            pytest.raises(ValueError, match=r"approval_timeout_s\.min must be > 0"),
        ):
            _validate_constants()

    def test_rejects_approval_timeout_default_below_min(self):
        with (
            patch.object(policy, "FLOOR_TIMEOUT_S", 60),
            patch.object(policy, "DEFAULT_TASK_TIMEOUT_S", 30),
            pytest.raises(ValueError, match=r"approval_timeout_s\.default .* must be >= min"),
        ):
            _validate_constants()

    def test_rejects_approval_timeout_max_below_default(self):
        with (
            patch.object(policy, "FLOOR_TIMEOUT_S", 30),
            patch.object(policy, "DEFAULT_TASK_TIMEOUT_S", 300),
            patch.object(policy, "_ATS", {"min": 30, "max": 100, "default": 300}),
            pytest.raises(ValueError, match=r"approval_timeout_s\.max .* must be >= default"),
        ):
            _validate_constants()

    def test_rejects_approval_gate_cap_min_zero(self):
        with (
            patch.object(policy, "APPROVAL_GATE_CAP_MIN", 0),
            pytest.raises(ValueError, match=r"approval_gate_cap\.min must be > 0"),
        ):
            _validate_constants()

    def test_rejects_approval_gate_cap_default_below_min(self):
        with (
            patch.object(policy, "APPROVAL_GATE_CAP_MIN", 10),
            patch.object(policy, "DEFAULT_APPROVAL_GATE_CAP", 5),
            pytest.raises(ValueError, match=r"approval_gate_cap\.default .* must be >= min"),
        ):
            _validate_constants()

    def test_rejects_approval_gate_cap_max_below_default(self):
        with (
            patch.object(policy, "APPROVAL_GATE_CAP_MIN", 1),
            patch.object(policy, "DEFAULT_APPROVAL_GATE_CAP", 100),
            patch.object(policy, "APPROVAL_GATE_CAP_MAX", 50),
            pytest.raises(ValueError, match=r"approval_gate_cap\.max .* must be >= default"),
        ):
            _validate_constants()

    def test_passes_with_valid_constants(self):
        _validate_constants()
