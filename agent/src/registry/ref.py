from __future__ import annotations

import re
from dataclasses import dataclass

REGISTRY_KINDS = ("mcp_server", "cedar_policy_module", "skill")
RESERVED_KINDS = ("plugin", "subagent", "prompt_fragment", "capability")

# ``\Z`` (absolute end of string), not ``$``: Python's ``$`` also matches just
# before a trailing newline, so ``$`` would accept ``…@1.0.0\n`` that the JS
# mirror (ref.ts, no ``m`` flag) rejects.
# The constraint is ``.+`` in the JS mirror, where the dot matches none of the four
# line terminators. Python's dot stops at ``\n`` only, so the class is spelled out.
_REF_SHAPE = re.compile(
    r"^registry://([a-z][a-z0-9_]*)/([a-z][a-z0-9-]*)/([a-z0-9][a-z0-9._-]*)"
    r"@([^\n\r\u2028\u2029]+)\Z"
)
# ``re.ASCII``: without it ``\d`` matches every Unicode decimal digit, which ``int()``
# then converts. In the JS mirror ``\d`` is 0-9.
_CONSTRAINT = re.compile(
    r"^([\^~]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?\Z", re.ASCII
)
_OP_BY_PREFIX = {"": "exact", "^": "caret", "~": "tilde"}

# JS ``Number.MAX_SAFE_INTEGER`` (2**53 - 1): the TS parser rounds components above it.
_MAX_SAFE_INT = 9007199254740991


class RefError(ValueError):
    """Raised when a ``registry://`` ref is malformed.

    ``reason`` is one of ``INVALID_REGISTRY_REF`` / ``INVALID_CONSTRAINT``.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class ParsedConstraint:
    op: str
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
    # Checked on the text: int() raises ValueError for more than 4300 digits.
    if max(len(major), len(minor), len(patch)) > len(str(_MAX_SAFE_INT)):
        return None
    major_i, minor_i, patch_i = int(major), int(minor), int(patch)
    if max(major_i, minor_i, patch_i) > _MAX_SAFE_INT:
        return None
    return ParsedConstraint(
        op=_OP_BY_PREFIX[prefix],
        major=major_i,
        minor=minor_i,
        patch=patch_i,
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
