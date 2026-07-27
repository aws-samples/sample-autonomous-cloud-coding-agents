"""Strict ``registry://`` reference grammar for the agent asset registry (#246).

::

    registry://<kind>/<namespace>/<name>@<constraint>
      kind       = [a-z][a-z0-9_]*            snake_case: mcp_server, cedar_policy_module
      namespace  = [a-z][a-z0-9-]*
      name       = [a-z0-9][a-z0-9._-]*
      constraint = [^~]?MAJOR.MINOR.PATCH[-prerelease]   exact / caret / tilde only

The ``@<constraint>`` pin is MANDATORY (fail-closed: no implicit "latest").

This module mirrors ``cdk/src/handlers/shared/registry/ref.ts`` byte-for-byte and
is exercised by the ``contracts/registry-resolution/`` parity corpus. Keep the two
in lockstep — a change here without the matching TS change (or vice versa) is a
parity break that CI must catch.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# MVP asset kinds the registry loads end-to-end or stages.
REGISTRY_KINDS = ("mcp_server", "cedar_policy_module", "skill")
# Reserved kinds accepted by the grammar but rejected at publish (no loader yet).
RESERVED_KINDS = ("plugin", "subagent", "prompt_fragment", "capability")

# Structural split — scheme + 3 path segments + the (mandatory) constraint.
_REF_SHAPE = re.compile(
    r"^registry://([a-z][a-z0-9_]*)/([a-z][a-z0-9-]*)/([a-z0-9][a-z0-9._-]*)@(.+)$"
)
# exact / caret / tilde over MAJOR.MINOR.PATCH with an optional prerelease.
# Rejects ``*``, ``latest``, ``>=``, ``<=``, x-ranges, and bare prerelease modifiers.
_CONSTRAINT = re.compile(
    r"^([\^~]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$"
)
_OP_BY_PREFIX = {"": "exact", "^": "caret", "~": "tilde"}


class RefError(ValueError):
    """Raised when a ``registry://`` ref is malformed.

    ``reason`` is one of ``INVALID_REGISTRY_REF`` / ``INVALID_CONSTRAINT`` — the
    same reason tokens the TS resolver reports, so both sides agree on *why* a
    ref failed, not just *that* it failed.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class ParsedConstraint:
    op: str  # exact | caret | tilde
    major: int
    minor: int
    patch: int
    prerelease: str | None
    raw: str


@dataclass(frozen=True)
class ParsedRef:
    kind: str
    namespace: str
    name: str
    constraint: ParsedConstraint


def parse_constraint(raw: str) -> ParsedConstraint | None:
    """Parse + validate a constraint string in isolation. ``None`` if invalid."""
    m = _CONSTRAINT.match(raw)
    if not m:
        return None
    prefix, major, minor, patch, prerelease = m.groups()
    return ParsedConstraint(
        op=_OP_BY_PREFIX[prefix],
        major=int(major),
        minor=int(minor),
        patch=int(patch),
        prerelease=prerelease,
        raw=raw,
    )


def parse_ref(ref: str) -> ParsedRef:
    """Parse a strict ``registry://kind/namespace/name@constraint`` reference.

    Raises ``RefError`` (with a ``reason``) on a malformed ref or a floating /
    unsupported constraint — pins are mandatory.
    """
    shape = _REF_SHAPE.match(ref)
    if not shape:
        raise RefError(
            "INVALID_REGISTRY_REF",
            f"not a valid registry ref (expected registry://kind/namespace/name@constraint): {ref}",
        )
    kind, namespace, name, raw_constraint = shape.groups()
    constraint = parse_constraint(raw_constraint)
    if constraint is None:
        raise RefError(
            "INVALID_CONSTRAINT",
            f"unsupported version constraint '{raw_constraint}' (use exact, ^, or ~)",
        )
    return ParsedRef(kind=kind, namespace=namespace, name=name, constraint=constraint)
