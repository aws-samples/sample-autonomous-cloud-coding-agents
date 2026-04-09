"""Unit tests for the prompts module."""

import pytest

from prompts import get_system_prompt


class TestGetSystemPrompt:
    def test_new_task_returns_prompt_with_create_pr(self):
        prompt = get_system_prompt("new_task")
        assert "Create a Pull Request" in prompt
        assert "{repo_url}" in prompt
        assert "{branch_name}" in prompt
        assert "{workflow}" not in prompt

    def test_pr_iteration_returns_prompt_with_update_pr(self):
        prompt = get_system_prompt("pr_iteration")
        assert "Post a summary comment on the PR" in prompt
        assert "Reply to each review comment thread" in prompt
        assert "gh api" in prompt
        assert "comments/<comment_id>/replies" in prompt
        assert "{pr_number}" in prompt
        assert "{repo_url}" in prompt
        assert "{branch_name}" in prompt
        assert "{workflow}" not in prompt

    def test_pr_review_returns_prompt_with_review_workflow(self):
        prompt = get_system_prompt("pr_review")
        assert "READ-ONLY" in prompt
        assert "must NOT modify" in prompt
        assert "gh api" in prompt
        assert "{pr_number}" in prompt
        assert "{repo_url}" in prompt
        assert "Write and Edit are not available" in prompt
        assert "{workflow}" not in prompt

    def test_all_types_contain_shared_base_sections(self):
        for task_type in ("new_task", "pr_iteration", "pr_review"):
            prompt = get_system_prompt(task_type)
            assert "## Environment" in prompt, f"Missing Environment in {task_type}"
            has_rules = "## Rules" in prompt or "## Rules override" in prompt
            assert has_rules, f"Missing Rules in {task_type}"

    def test_unknown_task_type_raises(self):
        with pytest.raises(ValueError, match="Unknown task_type"):
            get_system_prompt("invalid_type")
