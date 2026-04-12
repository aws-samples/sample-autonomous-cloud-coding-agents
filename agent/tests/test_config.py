"""Unit tests for config.py — build_config and constants."""

import pytest

from config import PR_TASK_TYPES, build_config


class TestAgentWorkspaceConstant:
    def test_default_value(self, monkeypatch):
        monkeypatch.delenv("AGENT_WORKSPACE", raising=False)
        import importlib

        import config

        importlib.reload(config)
        assert config.AGENT_WORKSPACE == "/workspace"


class TestPRTaskTypes:
    def test_contains_pr_iteration(self):
        assert "pr_iteration" in PR_TASK_TYPES

    def test_contains_pr_review(self):
        assert "pr_review" in PR_TASK_TYPES

    def test_does_not_contain_new_task(self):
        assert "new_task" not in PR_TASK_TYPES


class TestTaskTypeValidation:
    def test_invalid_task_type_raises(self):
        with pytest.raises(ValueError, match="Invalid task_type"):
            build_config(
                repo_url="owner/repo",
                task_description="fix bug",
                github_token="ghp_test123",
                aws_region="us-east-1",
                task_type="unknown_type",
            )

    def test_valid_task_types_accepted(self):
        for tt in ("new_task", "pr_iteration", "pr_review"):
            desc = "" if tt in ("pr_iteration", "pr_review") else "fix bug"
            pr = "42" if tt in ("pr_iteration", "pr_review") else ""
            config = build_config(
                repo_url="owner/repo",
                task_description=desc,
                github_token="ghp_test123",
                aws_region="us-east-1",
                task_type=tt,
                pr_number=pr,
            )
            assert config["task_type"] == tt


class TestBuildConfig:
    def test_valid_config_returns_dict(self):
        config = build_config(
            repo_url="owner/repo",
            task_description="fix bug",
            github_token="ghp_test123",
            aws_region="us-east-1",
            task_id="test-id",
        )
        assert isinstance(config, dict)
        assert config["repo_url"] == "owner/repo"
        assert config["task_id"] == "test-id"

    def test_missing_repo_raises(self):
        with pytest.raises(ValueError, match="repo_url"):
            build_config(
                repo_url="",
                task_description="fix bug",
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
        assert config["task_id"]
        assert len(config["task_id"]) == 12
