"""Prompt module — selects the system prompt template by task type."""

from .base import BASE_PROMPT
from .new_task import NEW_TASK_WORKFLOW
from .pr_iteration import PR_ITERATION_WORKFLOW
from .pr_review import PR_REVIEW_WORKFLOW

_PROMPTS = {
    "new_task": BASE_PROMPT.replace("{workflow}", NEW_TASK_WORKFLOW),
    "pr_iteration": BASE_PROMPT.replace("{workflow}", PR_ITERATION_WORKFLOW),
    "pr_review": BASE_PROMPT.replace("{workflow}", PR_REVIEW_WORKFLOW),
}


def get_system_prompt(task_type: str = "new_task") -> str:
    """Return the system prompt template for the given task type.

    Raises ValueError for unknown task types.
    """
    if task_type not in _PROMPTS:
        raise ValueError(f"Unknown task_type: {task_type!r}. Valid types: {list(_PROMPTS.keys())}")
    return _PROMPTS[task_type]
