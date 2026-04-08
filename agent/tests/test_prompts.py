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
        assert "Update the PR" in prompt
        assert "{pr_number}" in prompt
        assert "{repo_url}" in prompt
        assert "{branch_name}" in prompt
        assert "{workflow}" not in prompt

    def test_both_contain_shared_base_sections(self):
        new_task = get_system_prompt("new_task")
        pr_iter = get_system_prompt("pr_iteration")
        # Both should have Environment and Rules sections
        assert "## Environment" in new_task
        assert "## Environment" in pr_iter
        assert "## Rules" in new_task
        assert "## Rules" in pr_iter

    def test_unknown_task_type_raises(self):
        with pytest.raises(ValueError, match="Unknown task_type"):
            get_system_prompt("invalid_type")
