"""Unit tests for models.py — TaskType enum."""

from models import TaskType


class TestTaskType:
    def test_new_task_value(self):
        assert TaskType.new_task == "new_task"

    def test_pr_iteration_value(self):
        assert TaskType.pr_iteration == "pr_iteration"

    def test_pr_review_value(self):
        assert TaskType.pr_review == "pr_review"

    def test_new_task_is_not_pr_task(self):
        assert not TaskType.new_task.is_pr_task

    def test_pr_iteration_is_pr_task(self):
        assert TaskType.pr_iteration.is_pr_task

    def test_pr_review_is_pr_task(self):
        assert TaskType.pr_review.is_pr_task

    def test_new_task_is_not_read_only(self):
        assert not TaskType.new_task.is_read_only

    def test_pr_iteration_is_not_read_only(self):
        assert not TaskType.pr_iteration.is_read_only

    def test_pr_review_is_read_only(self):
        assert TaskType.pr_review.is_read_only

    def test_str_enum_membership(self):
        assert TaskType.new_task == "new_task"
        assert TaskType.pr_review == "pr_review"
