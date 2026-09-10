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
from typing import NamedTuple

# Repo-LOCATION vars, as distinct from config-CONTENT vars. Stripping these is
# load-bearing, not tidiness: while any one of them is set, every other containment
# measure below is bypassed.
#
# Every entry REDIRECTS git to a repository of the environment's choosing, so the
# correct treatment for all of them is removal. ``GIT_CEILING_DIRECTORIES`` is
# deliberately NOT here even though it also affects resolution, because it does the
# opposite thing: it LIMITS the discovery walk. Deleting it widens what git can reach,
# so it is *pinned* below instead of stripped. It was in this tuple until a review
# pointed out that the fixture was therefore removing its own fence.
#
# Mirrored — with the same 7 entries and the same explicit ceiling pin — in
# ``scripts/check-git-config-clean.mjs`` and ``cdk/test/scripts/check-git-config-clean.test.ts``.
# ``tests/test_git_fixture_isolation.py`` asserts the three copies agree, because a
# mirror nobody checks drifts.
GIT_LOCATION_VARS: tuple[str, ...] = (
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
)

# RFC-2606 reserved TLD: unroutable by construction, and recognisable in a stray
# commit. #720 was filed because the literal `t <t@t>` from a fixture was transcribed
# into a real repo's config and then into real commits.
TEST_IDENTITY_NAME = "ABCA Test"
TEST_IDENTITY_EMAIL = "abca-test@example.invalid"

# The keys that ARE the leak, and the only ones a mutation is failed on. Kept in step
# with the three rules in ``scripts/check-git-config-clean.mjs`` (Layer 3) so the two
# layers cannot disagree about what counts as corruption.
#
# Scoped deliberately. A whole-file digest is a strictly stronger *detector* but a
# worse *gate*: the shared config is written by routine work too — ``git fetch`` can
# rewrite ``remote.*``, ``git checkout -b``/``push -u`` add ``branch.<name>.remote``
# and ``.merge``, and this suite runs as a pre-push hook while the developer may have
# another worktree open. Failing the suite on that churn produces a red that names no
# fixture and has no remedy, and a gate people learn to re-run past is not a gate.
# Non-signature drift is still reported (see ``conftest``), just not fatal.
SIGNATURE_KEYS: tuple[str, ...] = (
    "core.worktree",
    "core.bare",
    "user.name",
    "user.email",
)

# `git config` timeout. Bounded so a wedged git cannot stall the session-level
# fingerprint and burn the suite's wall-clock budget.
_GIT_TIMEOUT_S = 30


class GitConfigLookupError(RuntimeError):
    """A repository WAS found, but its shared config could not be resolved or read.

    Distinct from ``None`` on purpose, and the distinction is the whole point: ``None``
    means "there is nothing here to protect" (no ``.git`` anywhere above cwd — the built
    container image, for instance), which is a genuine no-risk pass. This exception means
    "there is something to protect and the guard could not look at it", which is
    indistinguishable from a leak going unnoticed and must be reported loudly. The
    earlier version of this module collapsed both into ``None``, so the one state the
    detector exists for — a config too broken for git to describe — silently switched it
    off.
    """


def isolated_git_env(repo, base: dict[str, str] | None = None) -> dict[str, str]:
    """Return an environment in which git cannot reach outside *repo*.

    Order matters. The location vars are removed **first**, because the pins added
    afterwards are all ineffective while a ``GIT_DIR`` is still present.

    *repo* doubles as ``HOME``, so a fixture that transcribes a bare
    ``git config user.email ...`` (no ``--local``) lands in a throwaway file rather
    than the developer's ``~/.gitconfig``.

    ``GIT_CEILING_DIRECTORIES`` is pinned to *repo*'s parent rather than dropped. That
    closes the route the stripping does not: a command aimed at a directory which turns
    out not to be a repository — ``git -C <tmp>/scratch config user.email t@t`` — walks
    UP, and if ``TMPDIR`` happens to sit inside a checkout on this machine the walk
    finds it. The parent, not *repo* itself, so *repo* stays discoverable.
    """
    env = {k: v for k, v in (base or os.environ).items() if k not in GIT_LOCATION_VARS}
    env.update(
        {
            "HOME": str(repo),
            "XDG_CONFIG_HOME": str(repo),
            "GIT_CEILING_DIRECTORIES": os.path.dirname(os.path.abspath(str(repo))),
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


def _ceiling_directories() -> frozenset[str]:
    """``GIT_CEILING_DIRECTORIES`` as a set of resolved absolute paths.

    Honoured by the walk below so it stops where git's own discovery would. Without it a
    test that chdirs into a throwaway directory would get a verdict that depends on
    whether ``TMPDIR`` happens to sit inside somebody's checkout — and that is not
    hypothetical: measured on git 2.50.1, a bare ``git config user.email t@t`` run from a
    non-repository subdirectory of a repository walks UP and writes the parent's config,
    rc 0. That is the #855 leak reached without any ``GIT_DIR`` at all.

    ``realpath``, not ``abspath``, because git resolves ceiling entries through symlinks
    (verified: a ceiling spelled through a symlinked ``$HOME`` still stops git's walk). An
    ``abspath`` copy silently fails to match on any host where ``$HOME`` or ``TMPDIR`` is a
    symlink, which is the shape this repo's own dev hosts have — the mirror would then be
    strictly weaker than the thing it claims to mirror.

    NOTE the one deliberate asymmetry with ``scripts/check-git-config-clean.mjs``: its walk
    ignores ceilings entirely. That is correct there and wrong here. The gate must find the
    repository it is about to let a commit into, so an ambient ceiling must not be able to
    make it skip (fail-open); this suite must be reproducible wherever ``TMPDIR`` lands.
    """
    raw = os.environ.get("GIT_CEILING_DIRECTORIES", "")
    return frozenset(os.path.realpath(part) for part in raw.split(os.pathsep) if part)


def find_git_dir(start: str | None = None) -> str | None:
    """The gitdir for the tree containing *start*, found WITHOUT consulting any config.

    Mirrors ``findGitDir`` in ``scripts/check-git-config-clean.mjs``; the two must agree,
    because a leak the gate refuses at pre-push but the suite does not detect (or vice
    versa) is a layer that only appears to be there.

    ``GIT_DIR`` wins when set, because git exports it to hooks in a linked worktree and
    it names the exact tree being committed to. Note the asymmetry with the leak itself:
    an inherited ``GIT_DIR`` is the hazard for a WRITE aimed somewhere else, and the
    authoritative answer for a READ that wants *this* repository.

    Returns None when no ``.git`` exists at or above *start*.
    """
    env_dir = os.environ.get("GIT_DIR")
    if env_dir:
        return os.path.abspath(env_dir)

    ceilings = _ceiling_directories()
    # realpath to match the ceiling set above, which git resolves through symlinks.
    directory = os.path.realpath(start if start is not None else os.getcwd())
    while True:
        if directory in ceilings:
            return None
        candidate = os.path.join(directory, ".git")
        if os.path.isdir(candidate):
            return candidate
        if os.path.isfile(candidate):
            # Linked worktree (or a submodule): a `gitdir: <path>` pointer, possibly
            # relative to the directory holding the `.git` file.
            try:
                with open(candidate, encoding="utf-8") as handle:
                    contents = handle.read()
            except OSError as exc:
                raise GitConfigLookupError(f"cannot read {candidate}: {exc}") from exc
            pointed = next(
                (
                    line.partition(":")[2].strip()
                    for line in contents.splitlines()
                    if line.startswith("gitdir:")
                ),
                "",
            )
            if not pointed:
                raise GitConfigLookupError(
                    f"{candidate} is a file with no `gitdir:` line — cannot locate the repository."
                )
            return (
                pointed
                if os.path.isabs(pointed)
                else os.path.normpath(os.path.join(directory, pointed))
            )
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def shared_git_config_path() -> str | None:
    """Absolute path of the repository-shared ``.git/config``.

    Resolved by walking the filesystem for ``.git`` and following the ``commondir``
    pointer — **no ``git rev-parse`` at all**, because no form of it survives the state
    being detected. Measured on git 2.50.1, with ``core.worktree`` set (the key this leak
    writes):

    ============================================  ==========================
    ``core.worktree`` value                       ``--git-common-dir``
    ============================================  ==========================
    absolute, exists                              rc 0
    absolute, one missing leaf                    rc 0
    absolute, two or more missing components      rc 128 ``Invalid path``
    relative, missing                             rc 128 ``cannot chdir``
    ============================================  ==========================

    A deleted pytest ``tmp_path`` is the third shape, so the previous implementation
    returned None — "nothing to protect" — in precisely the case this guard exists for:
    the pollution disabling its own detector. (``--show-toplevel`` is worse still: it is
    *redirected* rather than failing, so it answers confidently with the wrong tree.) The
    filesystem walk reads no config, so it answers correctly on a repository too broken
    for git to describe.

    Returns None only when there is genuinely nothing to protect: no ``.git`` at or above
    cwd, e.g. inside the built container image. Raises ``GitConfigLookupError`` when a
    repository IS found but its shared config cannot be resolved — see that class for why
    the two cases must not be collapsed.
    """
    git_dir = find_git_dir()
    if git_dir is None:
        return None

    # A linked worktree's gitdir holds a `commondir` pointer to the SHARED `.git`, which
    # is the file at risk; a per-worktree config would not be.
    common_dir = git_dir
    commondir_file = os.path.join(git_dir, "commondir")
    if os.path.isfile(commondir_file):
        try:
            with open(commondir_file, encoding="utf-8") as handle:
                pointed = handle.read().strip()
        except OSError as exc:
            raise GitConfigLookupError(f"cannot read {commondir_file}: {exc}") from exc
        if pointed:
            common_dir = (
                pointed
                if os.path.isabs(pointed)
                else os.path.normpath(os.path.join(git_dir, pointed))
            )

    config = os.path.join(common_dir, "config")
    if not os.path.isfile(config):
        raise GitConfigLookupError(
            f"{config} does not exist or is not a file. Every git repository has one, so "
            f"{git_dir} is in an unexpected state — check it by hand."
        )
    return config


class GitConfigFingerprint(NamedTuple):
    """What the shared config looked like at one moment.

    ``signature`` is what a mutation is *failed* on; ``digest``/``names`` cover the whole
    file and are reported but not fatal. Splitting the two is what lets the detector stay
    mechanism-independent — it still notices any write, however it arrived — without
    turning routine ``branch.*``/``remote.*`` churn into a red suite.
    """

    signature: tuple[tuple[str, tuple[str, ...]], ...]
    digest: str
    names: frozenset[str]


def fingerprint_git_config(path: str) -> GitConfigFingerprint | None:
    """Fingerprint *path*, or None if it cannot be read or parsed.

    Values are captured for the signature keys so a value-only change is caught (a
    ``user.email`` overwritten with a fixture's), but only key **names** are ever
    reported: a ``.git/config`` can legally hold a remote URL with embedded credentials,
    and the report goes to CI logs.
    """
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        return None
    entries = _config_entries(path)
    if entries is None:
        return None
    return GitConfigFingerprint(
        signature=tuple((key, entries.get(key, ())) for key in SIGNATURE_KEYS),
        digest=hashlib.sha256(raw).hexdigest(),
        names=frozenset(entries),
    )


def signature_keys_changed(before: GitConfigFingerprint, after: GitConfigFingerprint) -> list[str]:
    """Signature keys whose value set differs between the two fingerprints."""
    after_values = dict(after.signature)
    return [key for key, values in before.signature if after_values.get(key, ()) != values]


def _config_entries(path: str) -> dict[str, tuple[str, ...]] | None:
    """Every key -> values in *path*, parsed by git itself. None if git could not read it.

    ``--list -z`` rather than ``--get-all`` per key, and that choice removes a bug class
    rather than guarding against one: ``--get-all`` exits **1** both for "key absent" and
    for "file unreadable" (permission-denied is only a stderr *warning*), so a caller that
    reads the exit code cannot tell a clean config from one it never opened.
    ``--list -z`` has no such overlap — rc 0 with empty output for an empty or
    comment-only file, rc 128 for unreadable or malformed. So a non-zero status here is
    unambiguously a failure to read, never a clean result.

    Record format is ``key\\nvalue\\0``; a valueless key (an implicit-true bool, written
    as a bare ``bare`` under ``[core]``) arrives as ``key\\0`` with no newline.
    """
    try:
        result = subprocess.run(
            ["git", "config", "--file", path, "--list", "-z"],
            capture_output=True,
            text=True,
            check=False,
            timeout=_GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None

    entries: dict[str, list[str]] = {}
    for record in result.stdout.split("\0"):
        if not record:
            continue
        key, separator, value = record.partition("\n")
        entries.setdefault(key, []).append(value if separator else "")
    return {key: tuple(values) for key, values in entries.items()}
