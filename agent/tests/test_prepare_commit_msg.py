"""Git reads the trailers of a message from its last paragraph only."""

import os
import subprocess

import pytest

from repo import _install_commit_hook

_CO_AUTHOR = "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
_TASK_ID = "Task-Id: 01KRPZ3PF8ZBRZ2600GRJS2VF7"
_PROMPT_VERSION = "Prompt-Version: 1c9c10e027a2"
_WORKFLOW_ID = "Workflow-Id: coding/new-task-v1"
_WORKFLOW_STEP = "Workflow-Step: implement"


def _git(repo, *args, **env) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        env={**os.environ, **env},
        check=True,
        capture_output=True,
        text=True,
    ).stdout


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "--local", "user.email", "abca-test@example.invalid")
    _git(tmp_path, "config", "--local", "user.name", "ABCA Test")
    _install_commit_hook(str(tmp_path))
    return tmp_path


def _commit(repo, *args, prompt_version="1c9c10e027a2", workflow_id="", workflow_step="") -> None:
    _git(
        repo,
        "commit",
        "-q",
        "--allow-empty",
        *args,
        TASK_ID="01KRPZ3PF8ZBRZ2600GRJS2VF7",
        PROMPT_VERSION=prompt_version,
        WORKFLOW_ID=workflow_id,
        WORKFLOW_STEP=workflow_step,
    )


def _message(repo) -> str:
    return _git(repo, "log", "-1", "--format=%B").strip()


def _trailers(repo) -> list[str]:
    return _git(repo, "log", "-1", "--format=%(trailers)").strip().splitlines()


def test_trailers_the_message_ends_with_stay_trailers(repo):
    _commit(repo, "-m", f"fix: handle empty input\n\nReject it early.\n\n{_CO_AUTHOR}")

    assert _trailers(repo) == [_CO_AUTHOR, _TASK_ID, _PROMPT_VERSION]


def test_message_without_trailers_gets_a_block_of_its_own(repo):
    # A Conventional Commits subject has the shape of a trailer. To git it is the title.
    _commit(repo, "-m", "fix: handle empty input", prompt_version="")

    assert _message(repo) == f"fix: handle empty input\n\n{_TASK_ID}"


def test_amending_a_commit_adds_no_trailer_twice(repo):
    _commit(repo, "-m", f"fix: handle empty input\n\n{_CO_AUTHOR}")

    _commit(repo, "--amend", "--no-edit")

    assert _trailers(repo) == [_CO_AUTHOR, _TASK_ID, _PROMPT_VERSION]


def test_rule_in_the_body_is_not_taken_for_the_end_of_the_message(repo):
    _commit(repo, "-m", "docs: describe the flow\n\nBefore the rule.\n\n---\n\nAfter the rule.")

    assert _message(repo).endswith(f"After the rule.\n\n{_TASK_ID}\n{_PROMPT_VERSION}")


def test_commit_of_a_workflow_step_names_the_workflow_and_the_step(repo):
    _commit(
        repo,
        "-m",
        f"fix: handle empty input\n\n{_CO_AUTHOR}",
        workflow_id="coding/new-task-v1",
        workflow_step="implement",
    )

    assert _trailers(repo) == [_CO_AUTHOR, _TASK_ID, _PROMPT_VERSION, _WORKFLOW_ID, _WORKFLOW_STEP]


def test_amended_commit_keeps_the_step_it_was_made_in(repo):
    _commit(
        repo,
        "-m",
        "fix: handle empty input",
        workflow_id="coding/new-task-v1",
        workflow_step="implement",
    )

    _commit(repo, "--amend", "--no-edit", workflow_id="coding/new-task-v1", workflow_step="build")

    assert _trailers(repo) == [_TASK_ID, _PROMPT_VERSION, _WORKFLOW_ID, _WORKFLOW_STEP]
