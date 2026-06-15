"""Tests for repo.setup_repo branch selection.

Focus: the agent MUST use the platform-provided ``config.branch_name``
verbatim when present, for every workflow — not just PR workflows, and never
re-deriving its own slug. A re-derived slug diverges from the platform's
(shell.py slugify strips dots / truncates at 40; gateway.ts uses dashes /
truncates at 50), which silently breaks #247 A4 stacking: a stacked child
fetches the predecessor's platform-named branch, the agent pushed a
differently-named one, the fetch 404s, and the child falls back to main.
"""

from unittest.mock import patch

from models import RepoSetup, TaskConfig


def _run_setup(config: TaskConfig) -> RepoSetup:
    """Run setup_repo with all side-effecting shell/build steps stubbed.

    We only care which branch string setup_repo selects, so run_cmd is a
    no-op returning success, and the build/install/default-branch helpers
    are neutralised.
    """
    import repo

    class _Ok:
        returncode = 0
        stdout = ""
        stderr = ""

    with patch.object(repo, "run_cmd", return_value=_Ok()), \
            patch.object(repo, "detect_default_branch", return_value="main"), \
            patch.object(repo, "_install_commit_hook", return_value=None):
        return repo.setup_repo(config)


def _cfg(**kw) -> TaskConfig:
    base = dict(
        aws_region="us-east-1",
        repo_url="owner/repo",
        task_id="01TESTTASKID",
        github_token="x",
    )
    base.update(kw)
    return TaskConfig(**base)


def test_uses_platform_branch_name_verbatim_for_new_task():
    # new_task (is_pr_workflow=False) with a platform branch_name carrying a
    # dotted/dashed slug. The agent must NOT re-slugify it.
    cfg = _cfg(
        is_pr_workflow=False,
        branch_name="bgagent/01TESTTASKID/abca-166-add-seville-guide-html",
        task_description="ABCA-166: Add seville-guide.html",
    )
    setup = _run_setup(cfg)
    assert setup.branch == "bgagent/01TESTTASKID/abca-166-add-seville-guide-html"


def test_uses_platform_branch_name_verbatim_for_pr_workflow():
    cfg = _cfg(
        is_pr_workflow=True,
        branch_name="bgagent/01TESTTASKID/existing-pr-branch",
        task_description="iterate",
    )
    setup = _run_setup(cfg)
    assert setup.branch == "bgagent/01TESTTASKID/existing-pr-branch"


def test_falls_back_to_derived_slug_only_when_no_branch_name():
    # No platform branch_name → derive from description (resilience path).
    cfg = _cfg(
        is_pr_workflow=False,
        branch_name="",
        task_description="add a thing",
    )
    setup = _run_setup(cfg)
    assert setup.branch.startswith("bgagent/01TESTTASKID/")
    assert setup.branch != "bgagent/01TESTTASKID/"
