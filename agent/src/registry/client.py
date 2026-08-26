"""The read-side ``RegistryClient`` port for the agent (#246).

The agent is a read-only consumer: it resolves refs and fetches records, but never
publishes or governs. It talks to the substrate through this Protocol, never a raw
AWS SDK client — the one implementation is ``AgentRegistryClient``
(``registry.agent_registry_client``), so a substrate swap is confined there.

The write-side verbs (publish / submit / approve) live only on the TypeScript port
(``cdk/src/handlers/shared/registry/client.ts``); the agent has no business
mutating the registry.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from registry.ref import ParsedRef


@dataclass(frozen=True)
class ResolvedAsset:
    """One resolved asset: enough to load it without knowing where bytes live."""

    kind: str
    namespace: str
    name: str
    version: str
    runtime: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


class RegistryResolutionError(Exception):
    """Raised when a ref cannot be resolved. ``reason`` matches the TS token set
    (``NO_MATCHING_VERSION`` / ``REMOVED`` / ``INVALID_CONSTRAINT`` /
    ``INVALID_REGISTRY_REF``) so both languages agree on *why*."""

    def __init__(self, reason: str, ref: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.ref = ref


class RegistryClient(Protocol):
    """Read-only registry access. See the TS port for the full (write) surface."""

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
