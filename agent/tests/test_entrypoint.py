"""Unit tests for pure functions in entrypoint.py."""

import os
import tempfile

import pytest

from entrypoint import (
    _build_system_prompt,
    _discover_project_config,
    assemble_prompt,
    build_config,
    format_bytes,
    redact_secrets,
    slugify,
    truncate,
)

# ---------------------------------------------------------------------------
# AGENT_WORKSPACE
# ---------------------------------------------------------------------------


class TestAgentWorkspace:
    def test_defaults_to_workspace(self, monkeypatch):
        monkeypatch.delenv("AGENT_WORKSPACE", raising=False)
        # Re-import to pick up the env change
        import importlib

        import entrypoint

        importlib.reload(entrypoint)
        assert entrypoint.AGENT_WORKSPACE == "/workspace"

    def test_reads_env_var(self, monkeypatch):
        monkeypatch.setenv("AGENT_WORKSPACE", "/mnt/workspace")
        import importlib

        import entrypoint

        importlib.reload(entrypoint)
        assert entrypoint.AGENT_WORKSPACE == "/mnt/workspace"


# ---------------------------------------------------------------------------
# slugify
# ---------------------------------------------------------------------------


class TestSlugify:
    def test_basic(self):
        assert slugify("Fix the login bug") == "fix-the-login-bug"

    def test_special_chars(self):
        assert slugify("Add feature: OAuth2.0!") == "add-feature-oauth20"

    def test_max_len(self):
        result = slugify("a very long task description indeed", max_len=10)
        assert len(result) <= 10
        assert not result.endswith("-")

    def test_empty(self):
        assert slugify("") == "task"

    def test_only_special_chars(self):
        assert slugify("!!!") == "task"

    def test_whitespace_and_dashes(self):
        assert slugify("  a--b  c  ") == "a-b-c"


# ---------------------------------------------------------------------------
# redact_secrets
# ---------------------------------------------------------------------------


class TestRedactSecrets:
    def test_ghp_token(self):
        assert "***" in redact_secrets("ghp_abc123XYZ")
        assert "abc123XYZ" not in redact_secrets("ghp_abc123XYZ")

    def test_github_pat_token(self):
        result = redact_secrets("github_pat_abcDEF123")
        assert "abcDEF123" not in result

    def test_x_access_token(self):
        result = redact_secrets("https://x-access-token:mysecret@github.com/foo/bar")
        assert "mysecret" not in result

    def test_no_secrets(self):
        text = "nothing secret here"
        assert redact_secrets(text) == text


# ---------------------------------------------------------------------------
# format_bytes
# ---------------------------------------------------------------------------


class TestFormatBytes:
    def test_bytes(self):
        assert format_bytes(500) == "500.0 B"

    def test_kilobytes(self):
        assert format_bytes(2048) == "2.0 KB"

    def test_megabytes(self):
        assert format_bytes(5 * 1024 * 1024) == "5.0 MB"

    def test_gigabytes(self):
        assert format_bytes(3 * 1024**3) == "3.0 GB"

    def test_terabytes(self):
        assert "TB" in format_bytes(2 * 1024**4)


# ---------------------------------------------------------------------------
# truncate
# ---------------------------------------------------------------------------


class TestTruncate:
    def test_short_text(self):
        assert truncate("hello") == "hello"

    def test_long_text(self):
        long = "a" * 300
        result = truncate(long, max_len=100)
        assert len(result) == 103  # 100 + "..."
        assert result.endswith("...")

    def test_empty(self):
        assert truncate("") == ""

    def test_newlines_replaced(self):
        assert truncate("line1\nline2") == "line1 line2"


# ---------------------------------------------------------------------------
# build_config
# ---------------------------------------------------------------------------


class TestBuildConfig:
    def test_valid_config(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
            task_id="test-id",
        )
        assert config["repo_url"] == "owner/repo"
        assert config["task_id"] == "test-id"
        assert config["max_turns"] == 10  # default

    def test_missing_repo_url(self):
        with pytest.raises(ValueError, match="repo_url"):
            build_config(
                repo_url="",
                task_description="fix bug",
                github_token="ghp_test",
                aws_region="us-east-1",
            )

    def test_missing_github_token(self):
        with pytest.raises(ValueError, match="github_token"):
            build_config(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="",
                aws_region="us-east-1",
            )

    def test_missing_task_and_issue(self):
        with pytest.raises(ValueError, match="issue_number or task_description"):
            build_config(
                repo_url="owner/repo",
                github_token="ghp_test",
                aws_region="us-east-1",
            )

    def test_auto_generated_task_id(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="do something",
            github_token="ghp_test",
            aws_region="us-east-1",
        )
        assert config["task_id"]  # non-empty
        assert len(config["task_id"]) == 12

    def test_env_fallback(self, monkeypatch):
        monkeypatch.setenv("AWS_REGION", "eu-west-1")
        config = build_config(
            repo_url="owner/repo",
            task_description="do something",
            github_token="ghp_test",
        )
        assert config["aws_region"] == "eu-west-1"


# ---------------------------------------------------------------------------
# assemble_prompt
# ---------------------------------------------------------------------------


class TestAssemblePrompt:
    def test_with_description(self):
        config = {
            "task_id": "abc123",
            "repo_url": "owner/repo",
            "task_description": "Fix the login bug",
            "issue_number": "",
        }
        result = assemble_prompt(config)
        assert "abc123" in result
        assert "owner/repo" in result
        assert "Fix the login bug" in result

    def test_with_issue(self):
        config = {
            "task_id": "abc123",
            "repo_url": "owner/repo",
            "task_description": "",
            "issue": {
                "number": 42,
                "title": "Login broken",
                "body": "Users cannot log in",
                "comments": [{"author": "alice", "body": "Confirmed!"}],
            },
        }
        result = assemble_prompt(config)
        assert "#42" in result
        assert "Login broken" in result
        assert "@alice" in result


# ---------------------------------------------------------------------------
# _discover_project_config
# ---------------------------------------------------------------------------


class TestDiscoverProjectConfig:
    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = _discover_project_config(tmpdir)
            assert result == {}

    def test_finds_claude_md(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Top-level CLAUDE.md
            with open(os.path.join(tmpdir, "CLAUDE.md"), "w") as f:
                f.write("instructions")
            result = _discover_project_config(tmpdir)
            assert "instructions" in result
            assert "CLAUDE.md" in result["instructions"]

    def test_finds_dotclaude_claude_md(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            claude_dir = os.path.join(tmpdir, ".claude")
            os.makedirs(claude_dir)
            with open(os.path.join(claude_dir, "CLAUDE.md"), "w") as f:
                f.write("instructions")
            result = _discover_project_config(tmpdir)
            assert "instructions" in result

    def test_finds_rules(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rules_dir = os.path.join(tmpdir, ".claude", "rules")
            os.makedirs(rules_dir)
            with open(os.path.join(rules_dir, "style.md"), "w") as f:
                f.write("rule")
            result = _discover_project_config(tmpdir)
            assert "rules" in result

    def test_finds_settings(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            claude_dir = os.path.join(tmpdir, ".claude")
            os.makedirs(claude_dir)
            with open(os.path.join(claude_dir, "settings.json"), "w") as f:
                f.write("{}")
            result = _discover_project_config(tmpdir)
            assert "settings" in result

    def test_finds_mcp(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, ".mcp.json"), "w") as f:
                f.write("{}")
            result = _discover_project_config(tmpdir)
            assert "mcp_servers" in result


# ---------------------------------------------------------------------------
# _build_system_prompt
# ---------------------------------------------------------------------------


class TestBuildSystemPrompt:
    def test_placeholder_substitution(self):
        config = {"repo_url": "owner/repo", "task_id": "t123", "max_turns": 50}
        setup = {
            "branch": "bgagent/t123/fix",
            "default_branch": "main",
            "notes": ["Note 1"],
        }
        result = _build_system_prompt(config, setup, None, "")
        assert "owner/repo" in result
        assert "t123" in result
        assert "bgagent/t123/fix" in result
        assert "50" in result

    def test_memory_context_injected(self):
        config = {"repo_url": "o/r", "task_id": "t1", "max_turns": 10}
        setup = {"branch": "b", "default_branch": "main", "notes": []}
        hydrated = {
            "memory_context": {
                "repo_knowledge": ["Uses TypeScript"],
                "past_episodes": ["Task t0 completed"],
            }
        }
        result = _build_system_prompt(config, setup, hydrated, "")
        assert "Uses TypeScript" in result
        assert "Task t0 completed" in result

    def test_overrides_appended(self):
        config = {"repo_url": "o/r", "task_id": "t1", "max_turns": 10}
        setup = {"branch": "b", "default_branch": "main", "notes": []}
        result = _build_system_prompt(config, setup, None, "Always use tabs")
        assert "Always use tabs" in result
        assert "Additional instructions" in result


# ---------------------------------------------------------------------------
# build_config — task_type handling
# ---------------------------------------------------------------------------


class TestBuildConfigTaskType:
    def test_pr_iteration_with_pr_number(self):
        config = build_config(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_type="pr_iteration",
            pr_number="42",
        )
        assert config["task_type"] == "pr_iteration"
        assert config["pr_number"] == "42"

    def test_pr_iteration_without_pr_number_raises(self):
        with pytest.raises(ValueError, match="pr_number is required"):
            build_config(
                repo_url="owner/repo",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_type="pr_iteration",
            )

    def test_new_task_default(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="Fix it",
            github_token="ghp_test",
            aws_region="us-east-1",
        )
        assert config["task_type"] == "new_task"

    def test_pr_review_with_pr_number(self):
        config = build_config(
            repo_url="owner/repo",
            github_token="ghp_test",
            aws_region="us-east-1",
            task_type="pr_review",
            pr_number="55",
        )
        assert config["task_type"] == "pr_review"
        assert config["pr_number"] == "55"

    def test_pr_review_without_pr_number_raises(self):
        with pytest.raises(ValueError, match="pr_number is required"):
            build_config(
                repo_url="owner/repo",
                github_token="ghp_test",
                aws_region="us-east-1",
                task_type="pr_review",
            )


# ---------------------------------------------------------------------------
# _build_system_prompt — task_type handling
# ---------------------------------------------------------------------------


class TestBuildSystemPromptTaskType:
    def test_selects_new_task_prompt(self):
        config = {
            "repo_url": "owner/repo",
            "task_id": "test-123",
            "max_turns": 100,
            "task_type": "new_task",
        }
        setup = {
            "branch": "bgagent/test-123/fix",
            "default_branch": "main",
            "notes": ["All OK"],
        }
        prompt = _build_system_prompt(config, setup, None, "")
        assert "Create a Pull Request" in prompt

    def test_selects_pr_iteration_prompt(self):
        config = {
            "repo_url": "owner/repo",
            "task_id": "test-123",
            "max_turns": 100,
            "task_type": "pr_iteration",
            "pr_number": "42",
        }
        setup = {
            "branch": "feature/fix",
            "default_branch": "main",
            "notes": ["All OK"],
        }
        prompt = _build_system_prompt(config, setup, None, "")
        assert "Post a summary comment on the PR" in prompt
        assert "Reply to each review comment thread" in prompt
        assert "42" in prompt

    def test_selects_pr_review_prompt(self):
        config = {
            "repo_url": "owner/repo",
            "task_id": "test-123",
            "max_turns": 100,
            "task_type": "pr_review",
            "pr_number": "55",
        }
        setup = {
            "branch": "feature/review",
            "default_branch": "main",
            "notes": ["All OK"],
        }
        prompt = _build_system_prompt(config, setup, None, "")
        assert "READ-ONLY" in prompt
        assert "must NOT modify" in prompt
        assert "55" in prompt
