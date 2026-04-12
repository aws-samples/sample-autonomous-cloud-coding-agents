"""Data models and enumerations for the agent pipeline."""

from enum import StrEnum


class TaskType(StrEnum):
    """Supported task types."""

    new_task = "new_task"
    pr_iteration = "pr_iteration"
    pr_review = "pr_review"

    @property
    def is_pr_task(self) -> bool:
        return self in (TaskType.pr_iteration, TaskType.pr_review)

    @property
    def is_read_only(self) -> bool:
        return self == TaskType.pr_review
