# Agent asset registry

A **registry asset** is a versioned, immutable-per-version runtime artifact that a task can load — an MCP server, a Cedar policy module, or a skill. Today those artifacts are vendored into the container image (`agent/src/channel_mcp.py`), inlined on the Blueprint construct (Cedar policies), or committed to a repo (`.mcp.json`). None of them are versioned, none carry an audit trail, and adding one means a **core-code change plus a CDK deploy**. The registry replaces that with a catalog: publishers push typed, versioned records via an API; blueprints pin them by `registry://kind/namespace/name@constraint`; the orchestrator resolves the pins at task start; and the agent receives a resolved bundle.

- **Use this doc for:** the asset-kind catalog, the storage schema (DynamoDB + S3), the publish/resolve/list/show API contract, resolution semantics (semver, immutability, status), and how a resolved bundle flows from orchestrator to agent.
- **Related docs:** [WORKFLOWS.md](./WORKFLOWS.md) for the `registry://` grammar and asset-kind vocabulary this generalizes, [REPO_ONBOARDING.md](./REPO_ONBOARDING.md) for the per-repo **Blueprint** that references assets, [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md) for the policy engine that consumes `cedar_policy_module` assets, [SECURITY.md](./SECURITY.md) for tool tiers, and [IDENTITY_AND_AUTH.md](./IDENTITY_AND_AUTH.md) for the Cognito groups that gate publish.
- **Decision record:** [ADR-018](../decisions/ADR-018-agent-asset-registry.md).
- **Tracking issue:** [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246). Child issues: [#478](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/478) (lifecycle), [#479](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/479) (versioning + immutability), [#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480) (Blueprint integration + ACLs), [#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481) (capability descriptors).

> **Substrate.** ADR-018 prefers AWS Agent Registry (Bedrock AgentCore) but requires a design-time prototype and defines four fall-back conditions. This document specifies the **DynamoDB + S3 fallback** (ADR-018 substrate option 2), which the fall-back conditions already select at authoring time (AgentCore Registry is in public preview and hard-migrates namespaces on 2026-08-06). The `RegistryClient` seam (§8) keeps the AgentCore path open as a later swap without changing the contract.

## 1. Goals and non-goals

**Goals (MVP, closes #246):**

- A versioned, immutable-per-version catalog of typed runtime artifacts.
- Publish, resolve, list, and show over a REST API — no CDK deploy to add an asset.
- Semver-pinned references (`registry://kind/namespace/name@constraint`) resolved at the create-task boundary.
- One end-to-end asset kind proven (`mcp_server`); two more wired but staged (`cedar_policy_module`, `skill`).
- Descriptor validation at publish; resolved `{kind, id, version}` triples stamped on the task record for audit.
- Fail-closed resolution — a task never silently downgrades or substitutes an asset.

**Non-goals (deferred to child issues / Phase 3):**

- Transitive dependencies between registry assets (explicitly disallowed in MVP).
- Plugin, subagent, prompt_fragment, and capability (= workflow) loaders — declared in the schema, not loaded.
- Federation to / mirroring from upstream registries (official MCP registry, CNCF catalogs) — see §11.
- Cedar-governed publish ACLs and per-namespace granularity — MVP uses two Cognito groups (§10).
- EventBridge as a primary bus for asset events; migrating first-party workflows into the registry.

## 2. Asset kinds for MVP

| Kind | MVP status | Artifact | Loaded by |
|------|-----------|----------|-----------|
| `mcp_server` | **implemented E2E** | MCP server config JSON (`mcpServers` entry) | agent → merged into `.mcp.json` |
| `cedar_policy_module` | resolved + staged | Cedar policy text | agent → appended to `PolicyEngine` policies |
| `skill` | resolved + staged | prompt fragment + tool hints | agent → SDK `setting_sources` |
| `plugin`, `subagent`, `prompt_fragment`, `capability` | **declared, not loaded** | — | — (reserved kinds; §12 of ADR-018) |

`capability` is reserved for workflows (ADR-014 vocabulary); workflows do **not** migrate into the registry in this work (ADR-018 sub-decision 12). Reserved kinds are accepted by the schema so the grammar is stable, but publish rejects them until a loader ships.

## 3. Schema

### 3.1 `RegistryAssetsTable` (DynamoDB)

Metadata records. One row per published `(kind, namespace, name, version)`.

| Attribute | Type | Key | Notes |
|-----------|------|-----|-------|
| `pk` | S | **partition** | `{kind}#{namespace}/{name}` — e.g. `mcp_server#acme/pdf-tools` |
| `sk` | S | **sort** | `version` — e.g. `1.4.1` (semver string) |
| `kind` | S | | denormalized for the list GSI |
| `namespace` | S | | |
| `name` | S | | |
| `version` | S | | semver, immutable once written |
| `descriptor` | M | | typed per-kind descriptor (§3.3) — validated at publish |
| `artifact_ref` | S | | S3 key (§3.4); empty for descriptor-only kinds |
| `status` | S | | `draft` \| `submitted` \| `approved` \| `rejected` \| `deprecated` \| `removed` (§5) |
| `publisher` | S | | Cognito `sub` of the publishing principal |
| `created_at` | S | | ISO-8601, set at publish |
| `status_history` | L | | append-only audit: `[{status, actor, at, rationale}]` |

**GSI `kind-index`** — partition `kind`, sort `pk` — powers `GET /registry/assets?kind=mcp_server` (list) without a scan.

> **Canonical status token.** The approved-and-resolvable state is spelled **`approved`** everywhere — in DynamoDB, the TypeScript resolver, and the Python loader. ADR-018 prose mentions "`active`" as a synonym; that word is **not** a value in code. One token, byte-for-byte, across both languages (the parity hazard ADR-018's `(−)` bullet flags).

### 3.2 Partition/sort rationale

`pk = {kind}#{namespace}/{name}` groups every version of one asset under a single partition; `sk = version` orders them. `GET /registry/assets/{id}` (show all versions) is a single `Query` on `pk`. Resolution (`resolveRef`) is a `Query` on `pk` that returns all versions, then ranks client-side by parsed semver (§5) — DynamoDB cannot sort semver lexicographically (`1.10.0` < `1.9.0` as strings), so ranking is always in code.

### 3.3 Per-kind descriptor shapes

Every record carries a typed `descriptor`, validated at publish (§4). Shared required fields: `summary` (string), `permissions` (list of strings). Per kind:

```jsonc
// mcp_server
{ "summary": "...", "permissions": ["network:egress"],
  "transport": "http" | "stdio",
  "egress_domains": ["mcp.example.com"],   // feeds Blueprint egress review
  "tool_prefix": "mcp__example__",         // tools surface under this prefix
  "server_config": { /* mcpServers entry, or in artifact for large configs */ } }

// cedar_policy_module
{ "summary": "...", "permissions": [],
  "cedar_actions": ["Action::\"ForcePush\""],  // actions the module introduces
  "policy_text_ref": "artifact" }              // Cedar text lives in the artifact

// skill
{ "summary": "...", "permissions": [],
  "prompt_fragment_ref": "artifact",
  "tool_hints": ["Bash", "Edit"] }
```

### 3.4 `RegistryArtifactsBucket` (S3)

Artifact bytes (MCP config JSON, Cedar text, skill prompt fragment). Key structure:

```
{kind}/{namespace}/{name}/{version}/artifact
```

e.g. `mcp_server/acme/pdf-tools/1.4.1/artifact`. Versioning **on**, SSE (S3-managed or KMS), public access blocked, TLS-only bucket policy, lifecycle rule to expire noncurrent versions. Mirrors `ecs-payload-bucket.ts` / `attachments-bucket.ts`. Immutability (§5) is enforced at the DynamoDB write, not by S3 object-lock, so `removed` can tombstone a record without a compliance-grade delete (ADR-018 risk bullet).

## 4. API contract

All routes are under the existing API Gateway stage (`/v1`), Cognito-authenticated. Wire fields are snake_case (matching the rest of the API).

### 4.1 `POST /registry/assets` — publish

Request:

```jsonc
{ "kind": "mcp_server", "namespace": "acme", "name": "pdf-tools",
  "version": "1.4.1", "descriptor": { /* §3.3 */ },
  "artifact_b64": "..." }          // optional; required for kinds with an artifact
```

- Validates kind ∈ MVP kinds, semver shape (§5), descriptor required fields (§3.3).
- **Immutability:** if `(kind, namespace, name, version)` exists → `409 REGISTRY_VERSION_EXISTS`.
- Uploads artifact to S3 (§3.4), writes the DynamoDB row.
- Initial `status`: `submitted` for a `RegistryPublisher`; `approved` if the caller is also a `RegistryApprover` and passes `?auto_approve=true` (dev). See §10.
- Response `201`: the created record (minus artifact bytes).

### 4.2 `GET /registry/resolve?ref=registry://...` — resolve

- Parses the ref (§6), queries candidate versions, ranks by semver, applies the constraint and status rules (§5).
- Response `200`: `{ kind, namespace, name, version, descriptor, artifact_url, warnings[] }` where `artifact_url` is a short-lived presigned GET (callers that want the bytes directly).
- Failure: `422 REGISTRY_RESOLUTION_FAILED` with `reason ∈ { NO_MATCHING_VERSION, REMOVED, INVALID_CONSTRAINT, INVALID_REGISTRY_REF }`.

### 4.3 `GET /registry/assets?kind=mcp_server` — list

- Queries `kind-index`. Optional `?namespace=` filter, `?status=` filter (default: exclude `removed`).
- Response `200`: `{ assets: [{ kind, namespace, name, latest_version, status }] }`.

### 4.4 `GET /registry/assets/{kind}/{namespace}/{name}` — show

- `Query` on `pk`; returns every version of one asset with status.
- Response `200`: `{ kind, namespace, name, versions: [{ version, status, created_at, publisher }] }`.

## 5. Resolution semantics

**Allowed constraint syntaxes** (validated at publish *and* at blueprint validation):

| Syntax | Example | Matches |
|--------|---------|---------|
| exact | `1.4.1` | only `1.4.1` |
| caret | `^1.4.1` | `>=1.4.1 <2.0.0` |
| tilde | `~1.4.1` | `>=1.4.1 <1.5.0` |
| *(none)* | `registry://.../pdf-tools` | treated as `*` → **rejected** |

**Rejected** at validation time with `INVALID_CONSTRAINT` / `INVALID_REGISTRY_REF`: `*`, `latest`, `>=`, `<=`, `>`, `<`, `x`-ranges, and bare prerelease modifiers. A ref with **no** `@constraint` is rejected — pins are mandatory (fail-closed; no implicit "latest").

**Resolution rule:** highest semver-comparable version matching the constraint wins; prereleases rank below their base version (`1.4.1-rc.1` < `1.4.1`).

**Status handling:**

| Status | Resolves? | Behavior |
|--------|-----------|----------|
| `approved` | yes | silent |
| `deprecated` | yes | resolves + `warnings: ["DEPRECATED"]` on response and a warning event on the task record |
| `submitted`, `draft`, `rejected` | no | not a candidate; if it's the only match → `NO_MATCHING_VERSION` |
| `removed` | no | if it's the highest match → `REMOVED` (distinct reason, so operators see a tombstoned pin vs. a never-existed one) |

**Fail-closed:** any unresolved ref fails task admission with `REGISTRY_RESOLUTION_FAILED` and a specific reason. A running task never re-resolves or substitutes.

## 6. URI grammar

ADR-018 grammar: `registry://<kind>/<namespace>/<name>@<constraint>`.

The shipped `_REGISTRY_REF` regex (`agent/src/workflow/validator.py`) predates this contract and does **not** match it — it has no `@` and allows only hyphens in the kind segment (so `mcp_server` and `@^1.4.1` both fail). This work **extends** the shipped grammar (ADR-018, corrected per review): the kind segment gains `_` (all MVP kinds are snake_case) and an optional `@<constraint>` group is added. The extension ships in this PR on **both** sides — Python (`validator.py`) and TypeScript (`registry-resolver.ts`) — and is covered by the parity corpus (§12).

Extended grammar (both languages must agree byte-for-byte):

```
registry://<kind>/<namespace>/<name>[@<constraint>]
  kind       = [a-z][a-z0-9_]*          # snake_case: mcp_server, cedar_policy_module
  namespace  = [a-z][a-z0-9-]*
  name       = [a-z0-9][a-z0-9._-]*
  constraint = [\^~]?MAJOR.MINOR.PATCH[-prerelease]   # exact / caret / tilde only
```

> **Note — two grammars in the tree today.** WORKFLOWS.md examples use a 2-segment `registry://prompt/name` form. The 3-segment ADR-018 grammar above is authoritative for #246; the WORKFLOWS.md examples are illustrative and pre-date this contract. Reconciling those examples is a docs-only follow-up (tracked in the WORKFLOWS.md registry section), not a code change here.

## 7. Orchestrator integration (preview — full impl in PR 2)

At the create-task boundary (where `workflow_ref` already resolves, `cdk/src/handlers/shared/`), after loading the Blueprint config and before hydration:

1. Collect `registry://` refs from the Blueprint's asset fields.
2. `resolveAll(refs)` → `ResolvedAssetBundle` (§8), failing admission on any unresolved ref.
3. Stamp `resolved_assets: [{kind, id, version}]` on the `TaskRecord` (audit).
4. Thread the full bundle into the agent invocation payload.

PR 1 ships the resolver library and API only; nothing in the orchestrator calls it yet (purely additive).

## 8. Agent integration (preview — full impl in PR 2/3)

The agent receives `resolved_assets` in its payload and a per-kind loader applies each:

- `mcp_server` → merge `server_config` into `.mcp.json` alongside `channel_mcp.py` output (PR 2).
- `cedar_policy_module` → append Cedar text to the `PolicyEngine` policy set (PR 3).
- `skill` → write the prompt fragment into the SDK `setting_sources` extension points (PR 3).

**`RegistryClient` seam:** both sides talk to a `RegistryClient` abstraction, never to a raw AWS SDK client. The DDB+S3 implementation lives in one file per language; swapping to AgentCore Registry later (or absorbing the 2026-08-06 namespace rename) is confined there.

## 9. Blueprint construct extension (preview — full impl in PR 2/3)

`BlueprintProps.assets?: { mcpServers?: string[]; cedarPolicyModules?: string[]; skills?: string[] }`. Each entry is a `registry://` ref, validated at synth (reject floating constraints early). The refs flatten into `RepoConfig` columns (`mcp_servers`, `cedar_policy_modules`, `skills`). Existing inline `security.cedarPolicies` keep working alongside `cedarPolicyModules` refs (mixed case tested in PR 3).

## 10. Access control (MVP)

Two Cognito groups (ADR-018 sub-decision 11):

- **`RegistryPublisher`** — may `POST /registry/assets`; records land in `submitted`.
- **`RegistryApprover`** — may transition `submitted → approved | rejected` and `approved → deprecated`, and may `?auto_approve=true` on publish (dev).

Resolve / list / show are available to any authenticated caller. No per-namespace ACL in MVP. Every status transition appends to `status_history` with actor + timestamp + rationale (audit is a MUST). Cedar-governed publish ACLs are Phase 3 ([#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480)/[#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481)).

## 11. Relationship to upstream registries

The registry is a **self-contained catalog** in MVP: assets are published to ABCA's own store, not mirrored from or federated to external registries. This is deliberate — the resolution invariants (semver, immutability, fail-closed, descriptor validation) are ABCA-side guarantees, and an upstream source would have to satisfy them before ABCA could depend on it.

Ecosystem catalogs exist and are relevant as **future discovery sources**, not MVP substrates:

- The official **MCP registry** (`registry.modelcontextprotocol.io`, [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)) — the closest analogue for the `mcp_server` kind.
- **AWS Agent Registry (Bedrock AgentCore)** — the ADR-018 *preferred* substrate; the `RegistryClient` seam (§8) is the swap point.
- Language/package precedents (PyPI, npm, container registries) — the "registry of registries" model.

**MVP answer to "how is the lookup maintained":** by publishers, via the publish API, into ABCA's own DynamoDB catalog — ABCA is the single source of truth for what a task can load, so the resolution contract is enforceable. **Federation** (ingesting/mirroring an upstream registry behind the same `RegistryClient` interface, with a trust/verification gate) is a Phase 3 option the seam permits without re-opening the contract. It is out of scope for #246 and should not be added by scope-creep, because an unverified upstream would undermine the fail-closed guarantee.

## 12. Test plan

- **Resolver unit tests** (`cdk/test/handlers/shared/registry-resolver.test.ts`): URI parse valid/invalid; semver match for exact/`^`/`~`; highest-version selection; prerelease ranking; no-match → `NO_MATCHING_VERSION`; `deprecated` → warning; `removed` → `REMOVED`; floating constraint → `INVALID_CONSTRAINT`.
- **Grammar parity corpus** (`contracts/registry-resolution/`): annotated `(ref) → verdict` fixtures run against **both** the Python `_REGISTRY_REF` and the TS `parseRef`, mirroring `contracts/cedar-parity/` and `contracts/workflow-validation/`. Includes the exact cases from the PR #548 review (snake_case kinds, `@constraint`).
- **Handler tests**: publish happy path, `409` immutability, descriptor validation errors, auth refusal (non-publisher), resolve/list/show.
- **Construct tests**: `registry-assets-table.test.ts`, `registry-artifacts-bucket.test.ts` (encryption, versioning, public-access-block, TLS policy).
- **E2E (PR 2)**: publish an MCP server → reference from a Blueprint → run a task → assert the agent payload carries the bundle and the `TaskRecord` has `resolved_assets`.

## 13. Out of scope (explicit)

Transitive registry-asset dependencies; plugin/subagent/prompt_fragment/capability loaders; upstream federation; per-namespace ACL; EventBridge as primary event bus; migrating first-party workflows into the registry; compliance-grade (GDPR) deletion of artifact bytes (`removed` tombstones the record only).
