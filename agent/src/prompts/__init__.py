"""Prompt module — selects the system prompt template by resolved workflow id.

In Phases 1-3 the runner uses these built-in prompt modules (the workflow file's
``prompt.template: registry://...`` is resolved by the registry only in Phase 4,
per WORKFLOWS.md). The lookup is keyed by workflow id; ``DEFAULT_WORKFLOW_ID`` is
the fallback for an unknown/absent id.
"""

from .base import BASE_PROMPT
from .default_agent import DEFAULT_AGENT_PROMPT
from .new_task import NEW_TASK_WORKFLOW
from .pr_iteration import PR_ITERATION_WORKFLOW
from .pr_review import PR_REVIEW_WORKFLOW

DEFAULT_WORKFLOW_ID = "coding/new-task-v1"

_PROMPTS = {
    "coding/new-task-v1": BASE_PROMPT.replace("{workflow}", NEW_TASK_WORKFLOW),
    "coding/pr-iteration-v1": BASE_PROMPT.replace("{workflow}", PR_ITERATION_WORKFLOW),
    "coding/pr-review-v1": BASE_PROMPT.replace("{workflow}", PR_REVIEW_WORKFLOW),
    # Repo-less knowledge workflow (#248 Phase 3) — no git/branch/PR placeholders.
    "default/agent-v1": DEFAULT_AGENT_PROMPT,
}


def get_system_prompt(workflow_id: str = DEFAULT_WORKFLOW_ID) -> str:
    """Return the system prompt template for the given resolved workflow id.

    Falls back to the default coding workflow's prompt for an id without a
    built-in template (e.g. ``default/agent-v1`` until its prompt ships, or a
    registry-only workflow in Phase 4).
    """
    return _PROMPTS.get(workflow_id, _PROMPTS[DEFAULT_WORKFLOW_ID])
