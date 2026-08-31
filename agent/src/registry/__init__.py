"""Agent asset registry client + reference grammar (#246).

The agent is a *read-only* consumer of the registry: it receives already-resolved
assets in its task payload and, where it needs to look one up directly, talks to
the substrate through the ``RegistryClient`` port (never a raw AWS SDK client).

Public surface:
  - ``parse_ref`` / ``ParsedRef`` (``ref``) — the strict ``registry://`` grammar,
    mirrored byte-for-byte by ``cdk/src/handlers/shared/registry/ref.ts`` and the
    ``contracts/registry-resolution/`` parity corpus.

See ``docs/design/REGISTRY.md`` and ``ISSUE_246_AGENTCORE_FINDINGS.md``.
"""
