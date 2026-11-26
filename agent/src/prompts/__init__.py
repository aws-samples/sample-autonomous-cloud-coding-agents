from config import DEFAULT_WORKFLOW_ID, REPO_LESS_DEFAULT_WORKFLOW_ID
from shell import log

from .base import BASE_PROMPT
from .default_agent import DEFAULT_AGENT_PROMPT
from .new_task import NEW_TASK_WORKFLOW
from .pr_iteration import PR_ITERATION_WORKFLOW
from .pr_review import PR_REVIEW_WORKFLOW
from .restack import RESTACK_WORKFLOW
from .web_research import WEB_RESEARCH_PROMPT

_PROMPTS = {
    "coding/new-task-v1": BASE_PROMPT.replace("{workflow}", NEW_TASK_WORKFLOW),
    "coding/pr-iteration-v1": BASE_PROMPT.replace("{workflow}", PR_ITERATION_WORKFLOW),
    "coding/pr-review-v1": BASE_PROMPT.replace("{workflow}", PR_REVIEW_WORKFLOW),
    "coding/restack-v1": BASE_PROMPT.replace("{workflow}", RESTACK_WORKFLOW),
    "default/agent-v1": DEFAULT_AGENT_PROMPT,
    "knowledge/web-research-v1": WEB_RESEARCH_PROMPT,
}


def get_system_prompt(workflow_id: str = DEFAULT_WORKFLOW_ID, *, repo_less: bool = False) -> str:
    """Return the system prompt template for the given resolved workflow id.

    Falls back to a built-in template for an id that has no registered prompt of
    its own. The fallback is the **repo-less** default-agent prompt when
    ``repo_less`` is set, else the coding default.
    """
    fallback = REPO_LESS_DEFAULT_WORKFLOW_ID if repo_less else DEFAULT_WORKFLOW_ID
    if workflow_id not in _PROMPTS:
        log(
            "WARN",
            f"no registered system prompt for workflow {workflow_id!r}; "
            f"falling back to {fallback!r}",
        )
    return _PROMPTS.get(workflow_id, _PROMPTS[fallback])
