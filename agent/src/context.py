"""Context hydration: GitHub issue fetching and prompt assembly."""

import requests

from models import GitHubIssue, IssueComment, TaskConfig


def fetch_github_issue(repo_url: str, issue_number: str, token: str) -> GitHubIssue:
    """Fetch a GitHub issue's title, body, and comments."""
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }

    # Fetch issue
    issue_resp = requests.get(
        f"https://api.github.com/repos/{repo_url}/issues/{issue_number}",
        headers=headers,
        timeout=30,
    )
    issue_resp.raise_for_status()
    issue = issue_resp.json()

    # Fetch comments
    comments: list[IssueComment] = []
    if issue.get("comments", 0) > 0:
        comments_resp = requests.get(
            f"https://api.github.com/repos/{repo_url}/issues/{issue_number}/comments",
            headers=headers,
            timeout=30,
        )
        comments_resp.raise_for_status()
        comments = [
            IssueComment(id=int(c["id"]), author=c["user"]["login"], body=c["body"] or "")
            for c in comments_resp.json()
        ]

    return GitHubIssue(
        title=issue["title"],
        body=issue.get("body", "") or "",
        number=issue["number"],
        comments=comments,
    )


def assemble_prompt(config: TaskConfig) -> str:
    """Assemble the user prompt from issue context and task description.

    .. deprecated::
        In production (AgentCore server mode), the orchestrator's
        ``assembleUserPrompt()`` in ``context-hydration.ts`` is the sole prompt
        assembler. The hydrated prompt arrives via
        ``HydratedContext.user_prompt`` (validated from the incoming JSON).
        This Python implementation is retained only for **local batch mode**
        (``python src/entrypoint.py``) and **dry-run mode** (``DRY_RUN=1``).
    """
    parts = []

    parts.append(f"Task ID: {config.task_id}")
    parts.append(f"Repository: {config.repo_url}")

    if config.issue:
        issue = config.issue
        parts.append(f"\n## GitHub Issue #{issue.number}: {issue.title}\n")
        parts.append(issue.body or "(no description)")
        if issue.comments:
            parts.append("\n### Comments\n")
            for c in issue.comments:
                parts.append(f"**@{c.author}**: {c.body}\n")

    if config.task_description:
        parts.append(f"\n## Task\n\n{config.task_description}")
    elif config.issue:
        parts.append(
            "\n## Task\n\nResolve the GitHub issue described above. "
            "Follow the workflow in your system instructions."
        )

    return "\n".join(parts)
