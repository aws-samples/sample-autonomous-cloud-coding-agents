"""Semver constraint matching + highest-version selection (#246).

Mirrors ``cdk/src/handlers/shared/registry/resolver.ts`` — AgentCore stores a plain
version string with no native ``^``/``~`` matching, so both the orchestrator (TS)
and the agent (Python) rank in code, and must agree. The parity corpus
(``contracts/registry-resolution/``) covers the shared cases.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from registry.ref import ParsedConstraint

# ``\Z`` not ``$`` — see registry/ref.py: ``$`` matches before a trailing
# newline in Python, diverging from the JS mirror (resolver.ts).
_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?\Z")

# JS ``Number.MAX_SAFE_INTEGER`` (2**53 - 1); mirrors registry/ref.py._MAX_SAFE_INT.
# Kept local rather than imported to avoid a runtime import cycle with ref.py.
_MAX_SAFE_INT = 9007199254740991


@dataclass(frozen=True)
class SemVer:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...]
    raw: str


def parse_version(raw: str) -> SemVer | None:
    m = _SEMVER.match(raw)
    if not m:
        return None
    major, minor, patch, pre = m.groups()
    major_i, minor_i, patch_i = int(major), int(minor), int(patch)
    # Match ref.parse_constraint / resolver.ts: reject components the TS parser
    # would round past MAX_SAFE_INTEGER so a candidate version ranks identically.
    if max(major_i, minor_i, patch_i) > _MAX_SAFE_INT:
        return None
    return SemVer(
        major=major_i,
        minor=minor_i,
        patch=patch_i,
        prerelease=tuple(pre.split(".")) if pre else (),
        raw=raw,
    )


def _compare_prerelease(a: tuple[str, ...], b: tuple[str, ...]) -> int:
    if not a and not b:
        return 0
    if not a:
        return 1  # release outranks prerelease
    if not b:
        return -1
    for ai, bi in zip(a, b, strict=False):
        if ai == bi:
            continue
        an, bn = ai.isdigit(), bi.isdigit()
        if an and bn:
            return int(ai) - int(bi)
        if an:
            return -1
        if bn:
            return 1
        return -1 if ai < bi else 1
    return len(a) - len(b)


def compare_versions(a: SemVer, b: SemVer) -> int:
    if a.major != b.major:
        return a.major - b.major
    if a.minor != b.minor:
        return a.minor - b.minor
    if a.patch != b.patch:
        return a.patch - b.patch
    return _compare_prerelease(a.prerelease, b.prerelease)


def _core_equals(v: SemVer, c: ParsedConstraint) -> bool:
    return v.major == c.major and v.minor == c.minor and v.patch == c.patch


def satisfies(v: SemVer, c: ParsedConstraint) -> bool:
    constraint_core = SemVer(
        major=c.major,
        minor=c.minor,
        patch=c.patch,
        prerelease=tuple(c.prerelease.split(".")) if c.prerelease else (),
        raw=c.raw,
    )

    if c.op == "exact":
        return compare_versions(v, constraint_core) == 0

    if compare_versions(v, constraint_core) < 0:
        return False

    # Exclude prereleases from range matches unless the constraint pins the same
    # core version and is itself a prerelease.
    if v.prerelease and not (_core_equals(v, c) and constraint_core.prerelease):
        return False

    if c.op == "caret":
        if c.major > 0:
            return v.major == c.major
        if c.minor > 0:
            return v.major == 0 and v.minor == c.minor
        return v.major == 0 and v.minor == 0 and v.patch == c.patch

    # tilde: same major.minor
    return v.major == c.major and v.minor == c.minor


def select_highest(candidates: list[str], constraint: ParsedConstraint) -> str | None:
    best: SemVer | None = None
    for raw in candidates:
        v = parse_version(raw)
        if v is None or not satisfies(v, constraint):
            continue
        if best is None or compare_versions(v, best) > 0:
            best = v
    return best.raw if best else None
