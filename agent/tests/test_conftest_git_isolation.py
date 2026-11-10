"""Regression guard for the session-wide git isolation in ``conftest.py`` (#855).

An in-process assertion cannot prove that isolation: wherever this suite normally
runs, the variables it removes are absent to begin with, so deleting the scrub
would leave such a test green. This test therefore starts a fresh interpreter
with the environment a git hook in a linked worktree hands to pytest — plus
stand-ins for the contributor's user and system git config — imports
``tests.conftest`` the way pytest does, and then runs the unguarded git commands
a careless fixture would run.

Every hostile value points into ``tmp_path``. No real repository or config file
is named anywhere, so a broken scrub fails this test without leaking into one.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent

_PROBE = """
import json, subprocess, sys

import tests.conftest  # the import under test: it must isolate git before anything else runs

sandbox = sys.argv[1]


def git(*args):
    return subprocess.run(["git", *args], cwd=sandbox, capture_output=True, text=True, check=False)


git("init", "-q")
print(json.dumps({
    "identity_read": git("config", "--get", "user.email").stdout.strip(),
    "user_config_write": git("config", "--global", "user.name", "probe").returncode,
}))
"""


def test_a_hook_environment_cannot_point_git_at_another_repository(tmp_path):
    hook_git_dir = tmp_path / "repository-the-hook-ran-in"  # must never be created
    user_config = tmp_path / "user-gitconfig"
    user_config.write_text("[user]\n\temail = contributor@user-config.example\n")
    system_config = tmp_path / "system-gitconfig"
    system_config.write_text("[user]\n\temail = contributor@system-config.example\n")
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()

    hostile: dict[str, str] = {
        **os.environ,
        "PYTHONPATH": str(AGENT_DIR / "src"),
        "GIT_DIR": str(hook_git_dir),
        "GIT_COMMON_DIR": str(hook_git_dir),
        "GIT_INDEX_FILE": str(hook_git_dir / "index"),
        "GIT_WORK_TREE": str(tmp_path),
        "GIT_CONFIG_GLOBAL": str(user_config),
        "GIT_CONFIG_SYSTEM": str(system_config),
        # What `git -c user.email=... commit` passes on to the hooks it runs.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "user.email",
        "GIT_CONFIG_VALUE_0": "contributor@command-line.example",
    }
    # The child must establish this itself; do not let it inherit this session's.
    hostile.pop("GIT_CONFIG_NOSYSTEM", None)

    proc = subprocess.run(
        [sys.executable, "-c", _PROBE, str(sandbox)],
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
    assert not hook_git_dir.exists() and (sandbox / ".git").is_dir(), (
        "`git init` in a sandbox acted on the repository an inherited GIT_DIR names" + fix
    )
    assert seen["identity_read"] == "", (
        f"git took an identity from outside the test repository ({seen['identity_read']})" + fix
    )
    assert seen["user_config_write"] != 0 and "probe" not in user_config.read_text(), (
        "`git config --global` wrote to the contributor's user configuration" + fix
    )
