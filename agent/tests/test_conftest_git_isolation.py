"""Regression guard for the session-wide git isolation in ``conftest.py`` (#855).

An in-process assertion cannot prove that isolation: wherever this suite normally
runs, the variables it removes are absent to begin with, so deleting the scrub
would leave such a test green. This test therefore starts a fresh interpreter
with the environment a git hook in a linked worktree hands to pytest — plus
stand-ins for the contributor's user and system git config — imports
``tests.conftest`` the way pytest does, and then runs the unguarded git commands
a careless fixture would run.

The interpreter is handed every variable the conftest block removes, not only the
ones those git commands react to, and reports which are still set after the
import: a name dropped from that block fails here by name.

Every hostile value points into ``tmp_path``. No real repository or config file
is named anywhere, so a broken scrub fails this test without leaking into one.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent

# What tests/conftest.py removes: git's own list of the variables that tie a
# command to one repository (`git rev-parse --local-env-vars`). A second copy on
# purpose — read from conftest, a name dropped there would be dropped here too.
_REPOSITORY_VARIABLES = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
)

_PROBE = """
import json, os, subprocess, sys

import tests.conftest  # the import under test: it must isolate git before anything else runs

sandbox, enclosing = sys.argv[1:]


def git(*args, cwd=sandbox):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)


git("init", "-q")
git("init", "-q", cwd=enclosing)
print(json.dumps({
    # Names and scopes only, never values: under a broken pin they are the contributor's.
    # `env` is asked, not this process: what git is handed is what a child inherits.
    "still_set": sorted(
        line.split(b"=")[0].decode()
        for line in subprocess.check_output(["env"]).splitlines()
        if line.startswith(b"GIT_")
    ),
    "config_scopes": sorted({
        line.split()[0]
        for line in git("config", "--list", "--show-scope").stdout.splitlines()
        if line.strip()
    }),
    "identity_read": git("config", "--get", "user.email").stdout.strip(),
    "user_config_write": git("config", "--global", "user.name", "probe").returncode,
    # Read-only on purpose: these two start OUTSIDE any repository of their own.
    "found_from_suite_cwd": git("rev-parse", "--git-dir", cwd=os.getcwd()).stdout.strip(),
    "found_from_temp_dir": git(
        "rev-parse", "--git-dir", cwd=os.path.join(enclosing, "tmp", "not-a-repo")
    ).stdout.strip(),
}))
"""


def test_git_config_is_pinned_where_nothing_can_be_created():
    # git replaces a config file by renaming a new one over it, so a pinned path
    # that exists — the null device included — or that could be created is one
    # root can write. A path below the null device is not, for anyone.
    for name in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"):
        path = os.environ.get(name, "")
        assert path and not os.path.lexists(path) and not os.path.isdir(os.path.dirname(path)), (
            f"{name} is {path!r}: tests/conftest.py must pin it to a path that neither exists "
            "nor can be created — as root, `git config --global` / `--system` would otherwise "
            "succeed and replace the file."
        )


def test_a_hook_environment_cannot_point_git_at_another_repository(tmp_path):
    hook_git_dir = tmp_path / "repository-the-hook-ran-in"  # must never be created
    user_config = tmp_path / "user-gitconfig"
    user_config.write_text("[user]\n\temail = contributor@user-config.example\n")
    system_config = tmp_path / "system-gitconfig"
    system_config.write_text("[user]\n\temail = contributor@system-config.example\n")
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    # A repository that CONTAINS the temp directory, as a version-controlled $HOME does.
    enclosing = tmp_path / "enclosing"
    (enclosing / "tmp" / "not-a-repo").mkdir(parents=True)

    hostile: dict[str, str] = {
        **os.environ,
        # Every variable conftest removes arrives set (to a placeholder inside tmp_path),
        # so that the probe can name the ones the import left behind. The entries below
        # replace the placeholder where the probe's git commands act on the value.
        **dict.fromkeys(_REPOSITORY_VARIABLES, str(hook_git_dir)),
        "PYTHONPATH": str(AGENT_DIR / "src"),
        "TMPDIR": str(enclosing / "tmp"),
        "GIT_DIR": str(hook_git_dir),
        "GIT_COMMON_DIR": str(hook_git_dir),
        "GIT_INDEX_FILE": str(hook_git_dir / "index"),
        "GIT_WORK_TREE": str(tmp_path),
        "GIT_CONFIG_GLOBAL": str(user_config),
        "GIT_CONFIG_SYSTEM": str(system_config),
        # What `git -c user.email=... commit` passes on to the hooks it runs …
        "GIT_CONFIG_PARAMETERS": "'user.email'='contributor@command-line.example'",
        # … and what a shell exports to configure git without a file.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "user.email",
        "GIT_CONFIG_VALUE_0": "contributor@command-line.example",
    }
    # The child must establish these itself; do not let it inherit this session's.
    hostile.pop("GIT_CONFIG_NOSYSTEM", None)
    hostile.pop("GIT_CEILING_DIRECTORIES", None)

    proc = subprocess.run(
        [sys.executable, "-c", _PROBE, str(sandbox), str(enclosing)],
        cwd=str(AGENT_DIR),
        env=hostile,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    seen = json.loads(proc.stdout.splitlines()[-1])

    fix = " — tests/conftest.py must isolate git at import; see the #855 block there."
    leftover = sorted(set(_REPOSITORY_VARIABLES) & set(seen["still_set"]))
    assert not leftover, (
        f"{', '.join(leftover)} still set after the import: the removal loop must name "
        "every variable that ties git to one repository" + fix
    )
    assert "GIT_CONFIG_NOSYSTEM" in seen["still_set"], (
        "GIT_CONFIG_NOSYSTEM is not set after the import: Apple's git then reads the "
        "system-wide file it ships with, whatever GIT_CONFIG_SYSTEM names" + fix
    )
    assert not hook_git_dir.exists() and (sandbox / ".git").is_dir(), (
        "`git init` in a sandbox acted on the repository an inherited GIT_DIR names" + fix
    )
    assert seen["identity_read"] == "", (
        f"git took an identity from outside the test repository ({seen['identity_read']})" + fix
    )
    assert seen["config_scopes"] == ["local"], (
        "`git config --list --show-scope` in a new test repository reported the scopes "
        f"{seen['config_scopes']}, expected only local. `command` is an inherited "
        "GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS; `global`, `system` and `unknown` are the "
        "host's files, which the GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM "
        "pins switch off; no scope at all means the command failed (it needs git 2.26)" + fix
    )
    assert seen["user_config_write"] != 0 and "probe" not in user_config.read_text(), (
        "`git config --global` wrote to the contributor's user configuration" + fix
    )
    assert seen["found_from_suite_cwd"] == "", (
        f"git discovered the checkout this suite runs from ({seen['found_from_suite_cwd']}), "
        "so a bare `git config` in a test would write to it" + fix
    )
    assert seen["found_from_temp_dir"] == "", (
        "git walked up from a temp directory that is not a repository and adopted "
        f"{seen['found_from_temp_dir']}" + fix
    )
