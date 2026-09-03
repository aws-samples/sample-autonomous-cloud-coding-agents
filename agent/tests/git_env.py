"""Single source of truth for isolating test git invocations (#855).

Four earlier fixes for the same leak (#622/#623, #695, #720/#731, #665) were each
placed in the file where the leak was observed, so none of them could protect the
next test file to shell out to git — #665 added a fresh unguarded helper seven days
after #731 hardened a different file. This module exists so there is exactly one
definition to import, and ``tests/conftest.py`` applies it to every test whether or
not the test author knew to ask.

The mechanism, because it is not obvious from any single call site:

An explicit ``GIT_DIR`` overrides repository **discovery** outright. That beats
``git -C <path>``, ``cwd=``, ``HOME=``, ``--local``, and the ``GIT_CONFIG_*`` pins
*simultaneously* — ``--local`` in particular resolves relative to ``GIT_DIR``, so it
is no defence. Git exports ``GIT_DIR``/``GIT_COMMON_DIR`` to hooks **only in a linked
worktree** (they are unset in a normal checkout), which is exactly how this suite runs
as a pre-push gate from ``.worktrees/``. Under that environment
``git -C <tmp> config user.email t@t`` writes into the *real* shared ``.git/config``
and ``git -C <tmp> init`` re-inits the *real* repository instead of creating one in
``<tmp>``.

That is why the bug reads as unreproducible: run the same tests by hand from the main
checkout and nothing leaks.
"""

from __future__ import annotations

import hashlib
import os
import subprocess

# Repo-LOCATION vars, as distinct from config-CONTENT vars. Stripping these is
# load-bearing, not tidiness: while any one of them is set, every other containment
# measure below is bypassed. Keep this tuple as the only copy in the tree.
GIT_LOCATION_VARS: tuple[str, ...] = (
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
)

# RFC-2606 reserved TLD: unroutable by construction, and recognisable in a stray
# commit. #720 was filed because the literal `t <t@t>` from a fixture was transcribed
# into a real repo's config and then into real commits.
TEST_IDENTITY_NAME = "ABCA Test"
TEST_IDENTITY_EMAIL = "abca-test@example.invalid"

# `git config` timeout. Bounded so a wedged git cannot stall the session-level
# fingerprint and burn the suite's wall-clock budget.
_GIT_TIMEOUT_S = 30


def isolated_git_env(repo, base: dict[str, str] | None = None) -> dict[str, str]:
    """Return an environment in which git cannot reach outside *repo*.

    Order matters. The location vars are removed **first**, because the pins added
    afterwards are all ineffective while a ``GIT_DIR`` is still present.

    *repo* doubles as ``HOME``, so a fixture that transcribes a bare
    ``git config user.email ...`` (no ``--local``) lands in a throwaway file rather
    than the developer's ``~/.gitconfig``.
    """
    env = {k: v for k, v in (base or os.environ).items() if k not in GIT_LOCATION_VARS}
    env.update(
        {
            "HOME": str(repo),
            "XDG_CONFIG_HOME": str(repo),
            "GIT_CONFIG_GLOBAL": os.path.join(str(repo), ".gitconfig-test"),
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            # Identity via env, not config: these outrank every config file, so a
            # commit is correctly attributed even if a config write is missed.
            "GIT_AUTHOR_NAME": TEST_IDENTITY_NAME,
            "GIT_AUTHOR_EMAIL": TEST_IDENTITY_EMAIL,
            "GIT_COMMITTER_NAME": TEST_IDENTITY_NAME,
            "GIT_COMMITTER_EMAIL": TEST_IDENTITY_EMAIL,
        }
    )
    return env


def shared_git_config_path() -> str | None:
    """Absolute path of the repository-shared ``.git/config``, or None if unavailable.

    Resolved via ``--git-common-dir`` rather than ``--show-toplevel`` **on purpose**.
    ``core.worktree`` — one of the values this leak writes — changes what
    ``--show-toplevel`` returns, so an already-polluted repo would make this function
    compute a path that does not exist and report "nothing to protect": the pollution
    would disable its own detector. ``--git-common-dir`` is answered from the gitdir
    alone and also resolves to the *shared* ``.git`` when called from a linked
    worktree, which is the file actually at risk. Requires git >= 2.31 for
    ``--path-format``.

    Returns None when there is no repository to protect (no git on PATH, or running
    outside a checkout — e.g. inside the built container image). That is a genuine
    "no risk" case, not a failure to look.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True,
            text=True,
            check=False,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    common_dir = result.stdout.strip()
    if not common_dir:
        return None
    config = os.path.join(common_dir, "config")
    return config if os.path.isfile(config) else None


def fingerprint_git_config(path: str) -> tuple[str, frozenset[str]] | None:
    """Digest *path* plus its key names, or None if it cannot be read.

    Deliberately returns key **names** and not values. A ``.git/config`` can legally
    hold a remote URL with embedded credentials, so a change report built from this
    can name what moved without printing anything secret.
    """
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        return None
    digest = hashlib.sha256(raw).hexdigest()
    names = frozenset(_config_key_names(path))
    return digest, names


def _config_key_names(path: str) -> list[str]:
    """Config key names in *path*, via git itself so the parse matches git's."""
    try:
        result = subprocess.run(
            ["git", "config", "--file", path, "--list", "--name-only"],
            capture_output=True,
            text=True,
            check=False,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line]
