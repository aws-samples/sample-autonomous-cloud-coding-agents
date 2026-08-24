---
title: Registry
---

# Agent asset registry

A **registry asset** is a versioned, immutable-per-version runtime artifact that a task can load — an MCP server, a Cedar policy module, or a skill. Today those artifacts are vendored into the container image (`agent/src/channel_mcp.py`), inlined on the Blueprint construct (Cedar policies), or committed to a repo (`.mcp.json`). None of them are versioned, none carry an audit trail, and adding one means a **core-code change plus a CDK deploy**. The registry replaces that with a catalog: publishers push typed, versioned records via an API; blueprints pin them by `registry://kind/namespace/name@constraint`; the orchestrator resolves the pins at task start; and the agent receives a resolved bundle.

- **Use this doc for:** the asset-kind catalog, the substrate mapping (Agent Registry descriptor types + the `_meta` runtime convention), the publish/resolve/list/show API contract, resolution semantics (semver, immutability, status), governance (the approval state machine), and how a resolved bundle flows from orchestrator to agent.
- **Related docs:** [WORKFLOWS.md](/sample-autonomous-cloud-coding-agents/architecture/workflows) for the `registry://` grammar and asset-kind vocabulary, [REPO_ONBOARDING.md](/sample-autonomous-cloud-coding-agents/architecture/repo-onboarding) for the per-repo **Blueprint** that references assets, [CEDAR_HITL_GATES.md](/sample-autonomous-cloud-coding-agents/architecture/cedar-hitl-gates) for the policy engine that consumes `cedar_policy_module` assets, [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security) for tool tiers, and [IDENTITY_AND_AUTH.md](/sample-autonomous-cloud-coding-agents/architecture/identity-and-auth) for the Cognito groups that gate publish.
- **Tracking issue:** [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246).

> **Substrate: AWS Agent Registry.** The registry uses the standalone AWS Agent Registry service namespace (currently in preview), not a first-party DynamoDB+S3 store. Agent Registry provides typed descriptor validation, a governance state machine, hybrid search, and audit — so ABCA builds only the substrate-agnostic parts (grammar, semver resolution, orchestrator/agent integration) plus one adapter. The original implementation used the Bedrock AgentCore public-preview namespace; issue [#771](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/771) migrates the SDK, IAM actions, ARNs, and descriptor shapes to the standalone `agent-registry` namespace.

## 1. Goals and non-goals

**Goals (MVP, closes #246):**

- A versioned, immutable-per-version catalog of typed runtime artifacts.
- Publish, resolve, list, and show over a REST API — no CDK deploy to add an asset.
- Semver-pinned references (`registry://kind/namespace/name@constraint`) resolved at the create-task boundary.
- One end-to-end asset kind proven (`mcp_server`); two more wired but staged (`cedar_policy_module`, `skill`).
- Descriptor validation at publish; resolved `{kind, id, version}` triples stamped on the task record for audit.
- Fail-closed resolution — a task never silently downgrades or substitutes an asset.

**Non-goals (deferred to child issues / later phases):**

- Transitive dependencies between registry assets (explicitly disallowed in MVP).
- Plugin, subagent, prompt_fragment, and capability (= workflow) loaders — declared in the grammar, not loaded.
- Federation to / mirroring from upstream registries (official MCP registry, CNCF catalogs).
- Cedar-governed publish ACLs and per-namespace granularity — MVP uses two Cognito groups (§9).

## 2. Asset kinds for MVP

| Kind | MVP status | Runtime payload | Applied by |
|------|-----------|----------------|-----------|
| `mcp_server` | **implemented E2E** | `.mcp.json` connection config (transport/url/headers/tool_prefix) | agent → merged into `.mcp.json` |
| `cedar_policy_module` | **implemented E2E** | `cedar_text` (Cedar policy source) | orchestrator → merged into the `cedar_policies` payload (byte-identical to inline blueprint policies) → agent `PolicyEngine` |
| `skill` | **implemented E2E** | `prompt_fragment` (+ `tool_hints`) | agent → appended to the system prompt |
| `plugin`, `subagent`, `prompt_fragment`, `capability` | **reserved** | — | — (grammar accepts them; publish rejects until a loader ships) |

**Cedar parity.** Registry Cedar text reaches the agent through the **same** `cedar_policies` payload field as inline blueprint policies, so it is byte-identical from the `PolicyEngine`'s view. **Skills** are prompt text only: a skill cannot invoke tools; its `tool_hints` are advisory prose referencing tools an MCP server separately provides (no transitive dependency — the operator attaches both).

## 3. Substrate mapping (the core design)

Agent Registry answers *"what servers/skills exist, find me one"* (discovery metadata + semantic search). ABCA needs *"give me the exact runtime config to load this pinned asset."* These are two different objects, and the service validates the discovery object against the official schemas (an MCP record's body must be a valid MCP `server.json`, not our `.mcp.json`). So **every record carries BOTH a discovery descriptor AND ABCA's runtime payload.**

### 3.1 Descriptor types

| Kind | Default Agent Registry type | Validated against | Where runtime config lives |
|------|------------------------|-------------------|----------------------------|
| `mcp_server` | `MCP` | official MCP `server.json` | `_meta["dev.abca.runtime"]` inside `mcpServer.data` |
| `skill` | `SKILL` | Agent Skills spec (`SKILL.md`) | `x-abca-runtime` frontmatter inside `agentSkillsDefinition.additionalData.skillMd.data` |
| `cedar_policy_module` | `CUSTOM` | none (arbitrary JSON) | the JSON in `custom.data`, under `runtime` |

**Purist by default + `--custom` escape hatch.** Native types (`MCP`, `SKILL`) are used by default for their discovery/validation/search value. MCP runtime data rides in `_meta`; skill runtime data is serialized into a dedicated `SKILL.md` frontmatter key. When `--custom` is passed — or when content cannot satisfy the official schema — the record is stored as `CUSTOM`, whose `data` field contains the structurally validated ABCA body. In **both** modes the resolver and agent loaders read the runtime payload, never the validated discovery body. The `--custom` flag toggles native validation/discoverability; it does not change the fact that runtime config is stored separately from discovery metadata.

### 3.2 Namespace (Option A)

Agent Registry has no namespace concept, so ABCA folds `kind/namespace/name` into the record `name` (`mcp_server/acme/pdf-tools`) and the adapter splits/joins on read. This keeps the `registry://` grammar, CLI, resolver, and audit shape unchanged, and uses a single ABCA registry. (Alternatives considered: registry-per-namespace = more infra + single-registry search limits; drop namespace = breaks the grammar + loses ownership scoping.)

## 4. Ports & adapters

- **`RegistryClient` port** — substrate-neutral verbs (`publish`, `getRecord`, `listRecords`, `resolve`), one per language: TypeScript (`cdk/src/handlers/shared/registry/client.ts`) for handlers/orchestrator, Python (`agent/src/registry/client.py`, read-only) for the agent. **Nothing upstream imports the AWS SDK directly.**
- **`AgentRegistryClient`** — the one implementation per language (`agent-registry-client.ts` / `agent_registry_client.py`). Owns: the native-vs-`CUSTOM` descriptor decision, the runtime-data convention, Option-A name encode/decode, the async-record polling, and the multi-call publish (§6).
- **Stays ABCA-side (substrate-agnostic):** the `registry://` grammar (`ref.ts` / `ref.py`, mirrored by the `contracts/registry-resolution/` parity corpus), **semver resolution** (`resolver.ts` / `resolver.py` — Agent Registry stores a plain version string, so ranking is always in code), the orchestrator resolve-step, and the agent loaders.
- **Ceded to Agent Registry (not built):** MCP/A2A schema validation, hybrid search, EventBridge notifications, CloudTrail audit, and the governance *state machine* (§6). ABCA still *drives* that state machine — see the multi-call publish.

## 5. Provisioning

The registry itself is provisioned by a CDK **Provider-framework custom resource** (`cdk/src/constructs/registry.ts`), because standalone `CreateRegistry` and `DeleteRegistry` are asynchronous and there is no CDK L1/L2 construct yet. `onEvent` starts the operation; `isComplete` polls `GetRegistry` until `READY` or until deletion returns not found. Standalone deletion removes the registry and its records, so the custom resource no longer drains records first. The stack exposes `AgentRegistryId` / `AgentRegistryArn` outputs.

The namespace migration is a **fresh-registry cutover** for ABCA. The custom-resource type changes from `Custom::AgentCoreRegistry` to `Custom::AgentRegistry`, forcing CloudFormation replacement because a registry id from the former namespace cannot be updated through the standalone API. Existing assets are not copied by this deployment: re-publish them into the new registry, or use AWS's migration tooling outside ABCA before switching workloads.

### 5.1 Optional deployment

Agent Registry is enabled by default for compatibility. Customers that cannot use the service in their account or region can omit the complete registry surface:

```bash
cdk deploy --context enableAgentRegistry=false
```

The boolean or string value `false` omits the registry nested stack, registry API, IAM grants, `AGENT_REGISTRY_ID`, and registry outputs. Blueprints without `registry://` references continue to run normally. If a Blueprint still contains a registry reference, task startup fails closed with an error directing the operator to remove the references or deploy with `enableAgentRegistry=true`.

This is an infrastructure switch, not a pause control. Changing an existing enabled deployment to `false` removes its CloudFormation-managed registry and records; re-enabling creates an empty registry that must be republished.

## 6. Governance: the approval state machine

Records move through `CREATING → DRAFT → PENDING_APPROVAL → APPROVED` (plus `REJECTED`, `DEPRECATED`). **Only `APPROVED` resolves.** The spike established three facts that shape the design:

1. **`CreateRegistryRecord` is async** and lands in `DRAFT` — even when the registry has `autoApproval: true`. The `autoApproval` flag does **not** auto-publish our records.
2. **`DRAFT → APPROVED` is not a legal direct transition.** `PENDING_APPROVAL` is a mandatory waypoint (`UpdateRegistryRecordStatus(DRAFT→APPROVED)` is rejected).
3. Both transition calls return synchronously; only `create` needs polling.

So the port's **`publish` is a multi-call operation**, not one SDK call:

```
CreateRegistryRecord → poll until not CREATING
  → (if autoApprove) SubmitRegistryRecordForApproval → UpdateRegistryRecordStatus(APPROVED)
```

"Dev auto-approve" therefore means *ABCA orchestrating these calls under an approver identity*, not the Agent Registry `autoApproval` flag. This maps cleanly onto the two Cognito groups (§9): a `RegistryPublisher` publishes (record lands `PENDING_APPROVAL` after submit); a `RegistryApprover` drives the final `UpdateRegistryRecordStatus`.

## 7. API contract

The registry API is a **separate API Gateway** from the main Task API (its own `RestApi`, exposed as the `RegistryApiUrl` stack output), but authorized against the **same** Cognito user pool — so a caller's existing JWT works on both without re-auth. All routes are under the `/v1` stage, Cognito-authenticated. Wire fields are snake_case.

> **Why a separate API.** The registry API's handler Lambdas + routes are ~35 CloudFormation resources. Once the orchestration arc (#695) landed, the root `AgentStack` was near CloudFormation's hard 500-resource-per-stack limit; API Gateway routes must live on the same stack as their `RestApi`, so giving the registry its own API (in a nested stack) is the only way to move that surface off the root and keep both the default and ECS compute paths under the cap. The cost is one extra config value: the CLI reads `registry_api_url` (from the `RegistryApiUrl` output) for `bgagent registry` commands — `bgagent configure --stack-name …` captures it automatically, or pass `--registry-api-url` explicitly.

### 7.1 `POST /registry/records` — publish

```jsonc
{ "kind": "mcp_server", "namespace": "acme", "name": "pdf-tools",
  "asset_version": "1.4.1",          // exact semver, immutable
  "discovery": { /* server.json / SKILL.md / arbitrary JSON */ },
  "runtime":   { /* connection config / cedar_text / prompt_fragment */ },
  "custom": false,                    // optional: force verbatim CUSTOM storage
  "auto_approve": false }             // optional: drive to APPROVED (dev)
```

- Auth: `RegistryPublisher`. `auto_approve` additionally requires `RegistryApprover`.
- Validates kind ∈ MVP kinds (reserved kinds rejected), namespace/name shape, exact semver.
- **Immutability:** an existing `(kind, namespace, name, version)` → `409 REGISTRY_VERSION_EXISTS`.
- Response `201`: `{ kind, namespace, name, version, status, storage_mode }`.

### 7.2 `GET /registry/resolve?ref=registry://…` — resolve

- Parses the ref, gathers candidate versions, ranks by semver, applies the constraint + status rules (§8).
- Response `200`: `{ kind, namespace, name, version, runtime, warnings[] }`.
- Failure: `422 REGISTRY_RESOLUTION_FAILED` with `reason ∈ { NO_MATCHING_VERSION, REMOVED, INVALID_CONSTRAINT, INVALID_REGISTRY_REF }`.

### 7.3 `GET /registry/records?kind=&namespace=` — list

- Response `200`: `{ assets: [{ kind, namespace, name, latest_version, status }] }` (one row per asset, at its highest version).

### 7.4 `GET /registry/records/{kind}/{namespace}/{name}` — show

- Response `200`: `{ kind, namespace, name, versions: [{ version, status, created_at, publisher }] }` (highest-first).

## 8. Resolution semantics

**Allowed constraint syntaxes** (validated at publish *and* blueprint validation):

| Syntax | Example | Matches |
|--------|---------|---------|
| exact | `1.4.1` | only `1.4.1` |
| caret | `^1.4.1` | `>=1.4.1 <2.0.0` (`^0.x` keeps the minor) |
| tilde | `~1.4.1` | `>=1.4.1 <1.5.0` |
| *(none)* | `registry://.../pdf-tools` | **rejected** — pins are mandatory |

**Rejected** with `INVALID_CONSTRAINT` / `INVALID_REGISTRY_REF`: `*`, `latest`, `>=`, `<=`, `<`, `>`, x-ranges, partial versions, and bare prerelease modifiers.

**Resolution rule:** highest semver-comparable version matching the constraint wins; prereleases rank below their base version (`1.4.1-rc.1` < `1.4.1`) and are excluded from range matches.

**Status handling:**

| Status | Resolves? | Behavior |
|--------|-----------|----------|
| `APPROVED` | yes | silent |
| `DEPRECATED` | yes | resolves + `warnings: ["DEPRECATED"]` |
| `DRAFT`, `PENDING_APPROVAL`, `REJECTED`, `CREATING` | no | not a candidate; if the only match → `NO_MATCHING_VERSION` |

**Fail-closed:** any unresolved ref fails task admission with `REGISTRY_RESOLUTION_FAILED`. A running task never re-resolves or substitutes.

## 9. Access control (MVP)

Two Cognito groups (created by the API construct as `CfnUserPoolGroup`):

- **`RegistryPublisher`** — may `POST /registry/records`; the record is submitted for approval (`PENDING_APPROVAL`).
- **`RegistryApprover`** — additionally drives `UpdateRegistryRecordStatus` to `APPROVED`/`REJECTED`/`DEPRECATED`, and may `auto_approve` on publish (dev).

Resolve / list / show are available to any authenticated caller. No per-namespace ACL in MVP; Cedar-governed publish ACLs are a later phase.

## 10. Grammar

```
registry://<kind>/<namespace>/<name>@<constraint>
  kind       = [a-z][a-z0-9_]*          # snake_case: mcp_server, cedar_policy_module
  namespace  = [a-z][a-z0-9-]*
  name       = [a-z0-9][a-z0-9._-]*
  constraint = [\^~]?MAJOR.MINOR.PATCH[-prerelease]   # exact / caret / tilde only
```

The strict grammar is implemented by `parseRef` (TS) and `parse_ref` (Python), kept in lockstep by the `contracts/registry-resolution/` parity corpus (dual-runner, mirroring `contracts/cedar-parity/`).

> **Note — two grammars in the tree.** The workflow validator's `_REGISTRY_REF` (`agent/src/workflow/validator.py`) is a deliberately *looser* acceptance check that also admits the legacy 2-segment illustrative form used by `contracts/workflow-validation/`. The strict grammar above is authoritative for #246 and is what resolution enforces.

## 11. Orchestrator + agent integration (staged)

**PR 1 (this work)** ships the resolver library, port, adapter, provisioning, API, and CLI — purely additive; nothing in the orchestrator/agent calls it yet.

**PR 2** wired the resolve step in the orchestrator (not create-task — see note below): it collects `registry://` refs from the Blueprint, resolves them via the `RegistryClient` (fail-closed — an unresolved ref fails the task), stamps `resolved_assets: [{kind, id, version}]` on the `TaskRecord`, threads the bundle into the agent payload, and loads `mcp_server` assets (merge into `.mcp.json`).

**PR 3** added the `cedar_policy_module` and `skill` loaders: resolved Cedar text is concatenated into the **same** `cedar_policies` payload field as inline blueprint policies (byte-identical from the `PolicyEngine`'s view — cedar-parity holds by construction), and resolved skill `prompt_fragment`s are appended to the system prompt (`prompt_builder.py`, after channel guidance).

> **Resolve happens in the orchestrator, not create-task.** `createTaskCore` is shared by 5+ entry-point Lambdas (API, Slack, Jira, Linear, webhook); resolving there would force the Agent Registry SDK + IAM into all of them. The orchestrator is a single Lambda that already loads `blueprintConfig` and assembles the payload — exactly how `cedar_policies` already flows. Trade-off: an unresolvable ref surfaces as a FAILED task rather than a 422 at submit. This is still fail-closed (the task never runs with a missing/substituted asset), and Blueprint refs are already validated at synth by the construct.

## 12. Test plan

- **Resolver unit tests** (`cdk/test/handlers/shared/registry-resolver.test.ts`): semver match for exact/`^`/`~`; highest-version selection; prerelease ranking; no-match.
- **Grammar parity corpus** (`contracts/registry-resolution/`): annotated `(ref) → verdict` fixtures run against **both** the Python `parse_ref` and the TS `parseRef`.
- **Adapter tests** (`agent-registry-client.test.ts`): 3-call publish, native runtime embedding, `CUSTOM` round-trip, immutability, resolve status-filter + semver + deprecation warning.
- **Handler tests**: publish auth/validation/`409`, resolve `422` reasons, list grouping, show.
- **Construct tests**: `registry.test.ts` (Provider wiring + IAM).
- **E2E (PR 2)**: publish an MCP server → reference from a Blueprint → run a task → assert the agent payload carries the bundle and the `TaskRecord` has `resolved_assets`.

### 12.1 Reproducing the E2E — the `forkBlueprintRepo` demo hook

The stack ships an **opt-in** deploy hook that onboards one repo with all three MVP asset kinds pinned, so the end-to-end path can be exercised without hand-authoring a Blueprint. It is off by default (no fork is hardcoded for other contributors). Enable it by pointing it at a repo you control:

```bash
# via CDK context…
cdk deploy --context forkBlueprintRepo=owner/repo
# …or via env var
FORK_BLUEPRINT_REPO=owner/repo cdk deploy
```

When set, the stack adds a `Blueprint` for `owner/repo` pinning
`registry://mcp_server/acme/aws-knowledge@^1.0.0`,
`registry://cedar_policy_module/acme/guard@^1.0.0`, and
`registry://skill/acme/readme-helper@^1.0.0`. Those `acme/*` records must be
published to the registry first (they are illustrative, not seeded) — otherwise
task admission fails closed on the unresolved pins. Leave the flag unset for a
normal deploy.

## 13. Accepted risk

AWS Agent Registry is not necessarily available or permitted in every customer account and target region. The default-on context gate preserves existing deployments while `enableAgentRegistry=false` lets those customers deploy ABCA without the service. The remaining accepted migration risk is catalog continuity: the standalone namespace requires a fresh registry and explicit asset migration or re-publication.

## 14. Out of scope (explicit)

Transitive registry-asset dependencies; plugin/subagent/prompt_fragment/capability loaders; upstream federation; per-namespace ACL; EventBridge as a primary bus; migrating first-party workflows into the registry.
