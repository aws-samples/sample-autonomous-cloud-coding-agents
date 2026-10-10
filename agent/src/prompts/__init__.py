"""Prompt module — selects the system prompt template by resolved workflow id.

Today the runner uses these built-in prompt modules. A planned later stage will
instead resolve a workflow file's ``prompt.template: registry://...`` through a
prompt registry (see WORKFLOWS.md). The lookup is keyed by workflow id;
``DEFAULT_WORKFLOW_ID`` is the fallback for an unknown/absent id.
"""

from shell import log

from .base import BASE_PROMPT
from .default_agent import DEFAULT_AGENT_PROMPT
from .new_task import NEW_TASK_WORKFLOW
from .pr_iteration import PR_ITERATION_WORKFLOW
from .pr_review import PR_REVIEW_WORKFLOW
from .restack import RESTACK_WORKFLOW
from .self_review import SELF_REVIEW_PROMPT as SELF_REVIEW_PROMPT
from .web_research import WEB_RESEARCH_PROMPT

DEFAULT_WORKFLOW_ID = "coding/new-task-v1"
# The fallback template for a repo-less workflow id that has no registered prompt
# of its own. Falling back to the *coding* default would leak
# {repo_url}/{branch_name} placeholders the repo-less prompt builder cannot
# substitute, so repo-less ids fall back to a repo-less prompt instead.
REPO_LESS_DEFAULT_WORKFLOW_ID = "default/agent-v1"

_PROMPTS = {
    "coding/new-task-v1": BASE_PROMPT.replace("{workflow}", NEW_TASK_WORKFLOW),
    "coding/pr-iteration-v1": BASE_PROMPT.replace("{workflow}", PR_ITERATION_WORKFLOW),
    "coding/pr-review-v1": BASE_PROMPT.replace("{workflow}", PR_REVIEW_WORKFLOW),
    # Re-stack: re-merge a changed predecessor branch into an existing
    # stacked-child branch. Pushes to the existing PR; not new work.
    "coding/restack-v1": BASE_PROMPT.replace("{workflow}", RESTACK_WORKFLOW),
    # Repo-less knowledge workflow — no git/branch/PR placeholders.
    "default/agent-v1": DEFAULT_AGENT_PROMPT,
    # Repo-less reference knowledge workflow — a research-specialized prompt so it
    # no longer silently degrades to the generic default-agent prompt.
    "knowledge/web-research-v1": WEB_RESEARCH_PROMPT,
}


def get_system_prompt(workflow_id: str = DEFAULT_WORKFLOW_ID, *, repo_less: bool = False) -> str:
    """Return the system prompt template for the given resolved workflow id.

    Falls back to a built-in template for an id that has no registered prompt of
    its own. The fallback is the **repo-less** default-agent prompt when
    ``repo_less`` is set (so a knowledge workflow never inherits the coding
    prompt's git/branch/PR placeholders), else the coding default.
    """
    fallback = REPO_LESS_DEFAULT_WORKFLOW_ID if repo_less else DEFAULT_WORKFLOW_ID
    if workflow_id not in _PROMPTS:
        # No registered prompt for this id (a typo, or a workflow whose prompt
        # has not shipped yet). Surface it: silently substituting a generic
        # prompt degrades agent behavior with zero signal otherwise.
        log(
            "WARN",
            f"no registered system prompt for workflow {workflow_id!r}; "
            f"falling back to {fallback!r}",
        )
    return _PROMPTS.get(workflow_id, _PROMPTS[fallback])
