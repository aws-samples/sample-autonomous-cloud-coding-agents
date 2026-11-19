"""The ``prepare-commit-msg`` hook, run by git in a repository under ``tmp_path``.

The agent installs the hook into every repository it works on (``repo.py``). It
puts a ``Task-Id`` and a ``Prompt-Version`` trailer on each commit. Git reads the
trailers of a message from its LAST paragraph only, so where the hook writes its
two decides whether the trailers the message already ends with, such as
``Co-Authored-By``, are still trailers afterwards.
"""

import os
import subprocess

import pytest

from repo import _install_commit_hook

_CO_AUTHOR = "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
_TASK_ID = "Task-Id: 01KRPZ3PF8ZBRZ2600GRJS2VF7"
_PROMPT_VERSION = "Prompt-Version: 1c9c10e027a2"


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
    """An empty repository with the hook installed the way the agent installs it."""
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "--local", "user.email", "abca-test@example.invalid")
    _git(tmp_path, "config", "--local", "user.name", "ABCA Test")
    _install_commit_hook(str(tmp_path))
    return tmp_path


def _commit(repo, *args, prompt_version="1c9c10e027a2") -> None:
    """Commit as the agent does: the task and the prompt version are in the environment."""
    _git(
        repo,
        "commit",
        "-q",
        "--allow-empty",
        *args,
        TASK_ID="01KRPZ3PF8ZBRZ2600GRJS2VF7",
        PROMPT_VERSION=prompt_version,
    )


def _message(repo) -> str:
    return _git(repo, "log", "-1", "--format=%B").strip()


def _trailers(repo) -> list[str]:
    """The trailers git itself finds on the last commit."""
    return _git(repo, "log", "-1", "--format=%(trailers)").strip().splitlines()


def test_trailers_the_message_ends_with_stay_trailers(repo):
    _commit(repo, "-m", f"fix: handle empty input\n\nReject it early.\n\n{_CO_AUTHOR}")

    assert _trailers(repo) == [_CO_AUTHOR, _TASK_ID, _PROMPT_VERSION]


def test_message_without_trailers_gets_a_block_of_its_own(repo):
    # A Conventional Commits subject has the shape of a trailer. It is the title.
    _commit(repo, "-m", "fix: handle empty input", prompt_version="")

    assert _message(repo) == f"fix: handle empty input\n\n{_TASK_ID}"


def test_amending_a_commit_adds_no_trailer_twice(repo):
    _commit(repo, "-m", f"fix: handle empty input\n\n{_CO_AUTHOR}")

    _commit(repo, "--amend", "--no-edit")

    assert _trailers(repo) == [_CO_AUTHOR, _TASK_ID, _PROMPT_VERSION]


def test_rule_in_the_body_is_not_taken_for_the_end_of_the_message(repo):
    _commit(repo, "-m", "docs: describe the flow\n\nBefore the rule.\n\n---\n\nAfter the rule.")

    assert _message(repo).endswith(f"After the rule.\n\n{_TASK_ID}\n{_PROMPT_VERSION}")
