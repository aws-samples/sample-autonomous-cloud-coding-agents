from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from registry.ref import ParsedRef


@dataclass(frozen=True)
class ResolvedAsset:
    kind: str
    namespace: str
    name: str
    version: str
    runtime: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


class RegistryResolutionError(Exception):
    """Raised when a ref cannot be resolved. ``reason`` matches the TS token set
    (``NO_MATCHING_VERSION`` / ``REMOVED`` / ``MALFORMED`` /
    ``INVALID_CONSTRAINT`` / ``INVALID_REGISTRY_REF``)."""

    def __init__(self, reason: str, ref: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.ref = ref


class RegistryRecordMalformedError(Exception):
    """Raised when a record's descriptor payload is present but unparseable — a
    SKILL.md frontmatter block that fails to YAML-parse, an ``x-abca-runtime``
    value that is not decodable base64/JSON, or a CUSTOM/MCP body that is not valid
    JSON. Distinct from an *absent* record and from an *empty* runtime. The
    underlying cause travels on ``__cause__``."""


class RegistryClient(Protocol):
    def get_record(
        self, kind: str, namespace: str, name: str, version: str
    ) -> dict[str, Any] | None:
        """Fetch a single record by exact coordinates, or ``None`` if absent."""
        ...

    def resolve(self, ref: ParsedRef) -> ResolvedAsset:
        """Resolve a parsed ref to a single APPROVED (or DEPRECATED+warn) asset.

        Fail-closed: raises ``RegistryResolutionError`` with a specific reason on
        any unresolved ref.
        """
        ...
