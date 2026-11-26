# Agent asset registry

A **registry asset** is a versioned runtime artifact that a task can load: an MCP server, a Cedar policy module, or a skill. Each version is immutable. Today those artifacts are vendored into the container image (`agent/src/channel_mcp.py`), inlined on the Blueprint construct (Cedar policies), or committed to a repo (`.mcp.json`). None of them are versioned, none carry an audit trail, and adding one means a core-code change plus a CDK deploy. The registry replaces that with a catalog. Publishers push typed, versioned records through an API. Blueprints pin the records by `registry://kind/namespace/name@constraint`. The orchestrator resolves the pins at task start, and the agent receives a resolved bundle.

- **Use this doc for:** the asset-kind catalog, the substrate mapping (Agent Registry descriptor types and the `_meta` runtime convention), the API contract for publish, resolve, list, and show, the resolution semantics (semver, immutability, status), the governance (the approval state machine), and the way a resolved bundle flows from the orchestrator to the agent.
- **Related docs:** [WORKFLOWS.md](./WORKFLOWS.md) for the `registry://` grammar and asset-kind vocabulary, [REPO_ONBOARDING.md](./REPO_ONBOARDING.md) for the per-repo Blueprint that references assets, [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md) for the policy engine that consumes `cedar_policy_module` assets, [SECURITY.md](./SECURITY.md) for tool tiers, and [IDENTITY_AND_AUTH.md](./IDENTITY_AND_AUTH.md) for the Cognito groups that gate publish.
- **Tracking issue:** [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246).

> **Substrate: AWS Agent Registry.** The registry uses the standalone AWS Agent Registry service namespace (currently in preview), not a first-party DynamoDB and S3 store. Agent Registry provides typed descriptor validation, a governance state machine, hybrid search, and audit. So ABCA builds only the substrate-agnostic parts (the grammar, the semver resolution, and the orchestrator and agent integration) plus one adapter. The original implementation used the Bedrock AgentCore public-preview namespace. Issue [#771](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/771) migrates the SDK, IAM actions, ARNs, and descriptor shapes to the standalone `agent-registry` namespace.

## 1. Goals and non-goals

**Goals (MVP, closes #246):**

- A versioned, immutable-per-version catalog of typed runtime artifacts.
- Publish, resolve, list, and show over a REST API. Adding an asset needs no CDK deploy.
- Semver-pinned references (`registry://kind/namespace/name@constraint`) resolved at the create-task boundary.
- One asset kind proven end to end (`mcp_server`). Two more wired but staged (`cedar_policy_module`, `skill`).
- Descriptor validation at publish. Resolved `{kind, id, version}` triples stamped on the task record for audit.
- Fail-closed resolution. A task never silently downgrades or substitutes an asset.

**Non-goals (deferred to child issues or later phases):**

- Transitive dependencies between registry assets (explicitly disallowed in MVP).
- Loaders for plugin, subagent, prompt_fragment, and capability (a capability is a workflow). The grammar declares these kinds, and nothing loads them.
- Federation to upstream registries, or mirroring from them (official MCP registry, CNCF catalogs).
- Cedar-governed publish ACLs and per-namespace granularity. MVP uses two Cognito groups (§9).

## 2. Asset kinds for MVP

| Kind | MVP status | Runtime payload | Applied by |
|------|-----------|----------------|-----------|
| `mcp_server` | **implemented end to end** | `.mcp.json` connection config (transport, url, headers). `tool_prefix` is accepted but not applied. The server is keyed `<namespace>__<name>`, so the tools of `acme/pdf-tools` appear as `mcp__acme__pdf-tools__*` | agent → merged into `.mcp.json` |
| `cedar_policy_module` | **implemented end to end** | `cedar_text` (Cedar policy source) | orchestrator → merged into the `cedar_policies` payload (byte-identical to inline blueprint policies) → agent `PolicyEngine` |
| `skill` | **implemented end to end** | `prompt_fragment` (plus `tool_hints`) | agent → appended to the system prompt |
| `plugin`, `subagent`, `prompt_fragment`, `capability` | **reserved** | — | None. The grammar accepts them, and publish rejects them until a loader ships |

**Cedar parity.** Registry Cedar text reaches the agent through the same `cedar_policies` payload field as inline blueprint policies, so the text is byte-identical from the `PolicyEngine`'s view. Skills are prompt text only. A skill cannot invoke tools. Its `tool_hints` are advisory prose that refers to tools that an MCP server provides separately. There is no transitive dependency, because the operator attaches both the skill and the MCP server.

### 2.1 Runtime network restriction for MCP servers

The agent connects to an `mcp_server` asset from inside the task's compute session, so the session's egress rules decide whether the server can be reached. On every compute backend (AgentCore, ECS and Lambda MicroVMs) the runtime security group allows outbound TCP 443 only. [COMPUTE.md](./COMPUTE.md#network-architecture) describes that rule and the DNS Firewall allowlist. An `http` or `sse` server therefore has to be served on port 443, the default of an `https://` URL. A server on another port is not supported on any backend. A `stdio` server starts inside the session, and the calls it makes are bound by the same rules.

Neither publish (§7.1) nor resolution (§8) looks at the port or tests connectivity. A pin to a server the session cannot reach resolves and loads like any other pin. The task starts, and the agent cannot use the server's tools.

## 3. Substrate mapping (the core design)

Agent Registry answers *"what servers/skills exist, find me one"* with discovery metadata and semantic search. ABCA needs *"give me the exact runtime config to load this pinned asset."* These are two different objects, and the service validates the discovery object against the official schemas. The body of an MCP record must be a valid MCP `server.json`, not ABCA's `.mcp.json`. So **every record carries both a discovery descriptor and ABCA's runtime payload.**

### 3.1 Descriptor types

| Kind | Default Agent Registry type | Validated against | Where runtime config lives |
|------|------------------------|-------------------|----------------------------|
| `mcp_server` | `MCP` | official MCP `server.json` | `_meta["dev.abca.runtime"]` inside `mcpServer.data` |
| `skill` | `SKILL` | Agent Skills spec (`SKILL.md`) | `x-abca-runtime` frontmatter inside `agentSkillsDefinition.additionalData.skillMd.data` |
| `cedar_policy_module` | `CUSTOM` | none (arbitrary JSON) | the JSON in `custom.data`, under `runtime` |

**Native types by default, `--custom` as the alternative.** Native types (`MCP`, `SKILL`) are the default, for their discovery, validation, and search value. MCP runtime data is stored in `_meta`. Skill runtime data is serialized into a dedicated `SKILL.md` frontmatter key. When `--custom` is passed, or when the content cannot satisfy the official schema, the record is stored as `CUSTOM`, and its `data` field contains the structurally validated ABCA body. In both modes the resolver and the agent loaders read the runtime payload, never the validated discovery body. The `--custom` flag switches native validation and discoverability on or off. It does not change the fact that runtime config is stored separately from discovery metadata.

### 3.2 Namespace (Option A)

Agent Registry has no namespace concept, so ABCA folds `kind/namespace/name` into the record `name` (`mcp_server/acme/pdf-tools`), and the adapter splits and joins the name on read. This encoding keeps the `registry://` grammar, the CLI, the resolver, and the audit shape unchanged, and uses a single ABCA registry. Two alternatives were considered. A registry per namespace means more infrastructure and single-registry search limits. Dropping the namespace breaks the grammar and loses ownership scoping.

## 4. Ports & adapters

- **`RegistryClient` port.** Substrate-neutral verbs (`publish`, `getRecord`, `listRecords`, `resolve`), with one port per language. TypeScript (`cdk/src/handlers/shared/registry/client.ts`) serves the handlers and the orchestrator. Python (`agent/src/registry/client.py`, read-only) serves the agent. Nothing upstream imports the AWS SDK directly.
- **`AgentRegistryClient`.** The one implementation per language (`agent-registry-client.ts` and `agent_registry_client.py`). It owns the native-vs-`CUSTOM` descriptor decision, the runtime-data convention, the Option A name encoding and decoding, the async-record polling, and the multi-call publish (§6).
- **Stays ABCA-side (substrate-agnostic):** the `registry://` grammar (`ref.ts` and `ref.py`, mirrored by the `contracts/registry-resolution/` parity corpus), semver resolution (`resolver.ts` and `resolver.py`), the orchestrator resolve step, and the agent loaders. Agent Registry stores a plain version string, so ranking is always in code.
- **Ceded to Agent Registry (not built):** MCP and A2A schema validation, hybrid search, EventBridge notifications, CloudTrail audit, and the governance state machine (§6). ABCA still drives that state machine. See the multi-call publish.

## 5. Provisioning

A CDK Provider-framework custom resource (`cdk/src/constructs/registry.ts`) provisions the registry, because standalone `CreateRegistry` and `DeleteRegistry` are asynchronous and there is no CDK L1 or L2 construct yet. `onEvent` starts the operation. `isComplete` polls `GetRegistry` until `READY`, or until deletion returns not found. AWS refuses `DeleteRegistry` while the registry holds a record. So on deletion both handlers first delete the records, for a bounded time per invocation, and then delete the registry. The stack exposes the `AgentRegistryId` and `AgentRegistryArn` outputs.

For ABCA, the namespace migration is a cutover to a fresh registry. The custom-resource type changes from `Custom::AgentCoreRegistry` to `Custom::AgentRegistry`. That change forces CloudFormation replacement, because a registry id from the former namespace cannot be updated through the standalone API. This deployment does not copy existing assets. Re-publish them into the new registry, or use AWS's migration tooling outside ABCA before you switch workloads.

### 5.1 Optional deployment

Agent Registry is enabled by default for compatibility. Customers that cannot use the service in their account or region can omit everything that belongs to the registry:

```bash
cdk deploy --context enableAgentRegistry=false
```

The boolean or string value `false` omits the registry nested stack, registry API, IAM grants, `AGENT_REGISTRY_ID`, and registry outputs. Blueprints without `registry://` references continue to run normally. If a Blueprint still contains a registry reference, task startup fails closed with an error that tells the operator to remove the references or to deploy with `enableAgentRegistry=true`.

The string form is case-sensitive. Use lowercase `true` or `false`. Any other value fails synthesis with an actionable validation error.

The context value is an infrastructure switch, not a pause control. Changing an existing enabled deployment to `false` removes its CloudFormation-managed registry and records. Re-enabling creates an empty registry, and the assets must be published to it again.

## 6. Governance: the approval state machine

Records move through `CREATING → DRAFT → PENDING_APPROVAL → APPROVED` (plus `REJECTED` and `DEPRECATED`). **Only `APPROVED` resolves.** The spike established three facts that shape the design:

1. **`CreateRegistryRecord` is async** and lands in `DRAFT`, even when the registry has `autoApproval: true`. The `autoApproval` flag does not auto-publish ABCA's records.
2. **`DRAFT → APPROVED` is not a legal direct transition.** `PENDING_APPROVAL` is a mandatory intermediate status. The service rejects `UpdateRegistryRecordStatus(DRAFT→APPROVED)`.
3. Both transition calls return synchronously. Only `create` needs polling.

So the port's `publish` is a multi-call operation, not one SDK call:

```
CreateRegistryRecord → poll until not CREATING
  → SubmitRegistryRecordForApproval
  → (if autoApprove) UpdateRegistryRecordStatus(APPROVED)
```

"Dev auto-approve" therefore means that ABCA makes these calls under an approver identity. It does not mean the Agent Registry `autoApproval` flag. These calls map onto the two Cognito groups (§9). A `RegistryPublisher` publishes, and the record lands in `PENDING_APPROVAL` after the submit. A `RegistryApprover` drives the final `UpdateRegistryRecordStatus`.

## 7. API contract

The registry API is a separate API Gateway from the main Task API. It has its own `RestApi`, exposed as the `RegistryApiUrl` stack output. It is authorized against the same Cognito user pool, so a caller's existing JWT works on both APIs without a second sign-in. All routes are under the `/v1` stage and are Cognito-authenticated. Wire fields are snake_case.

> **Why a separate API.** The handler Lambdas and routes of the registry API are about 35 CloudFormation resources. Once the orchestration work (#695) landed, the root `AgentStack` was near CloudFormation's hard limit of 500 resources per stack. API Gateway routes must live on the same stack as their `RestApi`. So giving the registry its own API, in a nested stack, is the only way to move those resources off the root stack and keep both the default and the ECS compute paths under the limit. The cost is one extra config value. The CLI reads `registry_api_url` (from the `RegistryApiUrl` output) for `bgagent registry` commands. `bgagent configure --stack-name …` captures the value automatically, or you can pass `--registry-api-url` explicitly.

### 7.1 `POST /registry/records` — publish

```jsonc
{ "kind": "mcp_server", "namespace": "acme", "name": "pdf-tools",
  "asset_version": "1.4.1",          // exact semver, immutable
  "discovery": { /* server.json / SKILL.md / arbitrary JSON */ },
  "runtime":   { /* connection config / cedar_text / prompt_fragment */ },
  "custom": false,                    // optional: force verbatim CUSTOM storage
  "auto_approve": false }             // optional: drive to APPROVED (dev)
```

- Auth: `RegistryPublisher`. `auto_approve` also requires `RegistryApprover`.
- Validates that the kind is an MVP kind (reserved kinds are rejected), the shape of the namespace and of the name, and that the version is exact semver.
- For `mcp_server` the runtime is validated as well. `transport` is `http`, `sse` or `stdio`. `url` (http, sse) or `command` (stdio) is a non-empty string. `headers`, when present, is an object with string values and `args` a list of strings. A field other than `transport`, `url`, `command`, `args`, `headers` and `tool_prefix` is refused. A runtime that fails one of these checks is answered `400`.
- **Immutability:** an existing `(kind, namespace, name, version)` is answered `409 REGISTRY_VERSION_EXISTS`.
- Response `201`: `{ kind, namespace, name, version, status, storage_mode }`.

### 7.2 `GET /registry/resolve?ref=registry://…` — resolve

- Parses the ref, gathers candidate versions, ranks them by semver, and applies the constraint and status rules (§8).
- Response `200`: `{ kind, namespace, name, version, runtime, warnings[] }`.
- Failure: `422 REGISTRY_RESOLUTION_FAILED` with `reason ∈ { NO_MATCHING_VERSION, REMOVED, INVALID_CONSTRAINT, INVALID_REGISTRY_REF, MALFORMED }`. `MALFORMED` means that the descriptor of the winning record is present but cannot be parsed, for example SKILL.md frontmatter that fails to parse as YAML. The ref is rejected rather than resolved with erased attribution (#791), and it is never downgraded to a lower valid version.

### 7.3 `GET /registry/records?kind=&namespace=` — list

- Response `200`: `{ assets: [{ kind, namespace, name, latest_version, status }] }` (one row per asset, at its highest version).

### 7.4 `GET /registry/records/{kind}/{namespace}/{name}` — show

- Response `200`: `{ kind, namespace, name, versions: [{ version, status, created_at, publisher, malformed? }] }` (highest version first). A version whose descriptor payload failed to parse carries `malformed: true`, with `publisher` and `created_at` set to `null`. The version is shown, not hidden, so that operators can see a corrupt version (#791).

## 8. Resolution semantics

**Allowed constraint syntaxes** (validated at publish and at blueprint validation):

| Syntax | Example | Matches |
|--------|---------|---------|
| exact | `1.4.1` | only `1.4.1` |
| caret | `^1.4.1` | `>=1.4.1 <2.0.0` (`^0.x` keeps the minor) |
| tilde | `~1.4.1` | `>=1.4.1 <1.5.0` |
| *(none)* | `registry://.../pdf-tools` | **rejected**. Pins are mandatory |

**Rejected** with `INVALID_CONSTRAINT` or `INVALID_REGISTRY_REF`: `*`, `latest`, `>=`, `<=`, `<`, `>`, x-ranges, partial versions, and bare prerelease modifiers.

**Resolution rule:** the highest semver-comparable version that matches the constraint wins. Prereleases rank below their base version (`1.4.1-rc.1` < `1.4.1`) and are excluded from range matches.

**Status handling:**

| Status | Resolves? | Behavior |
|--------|-----------|----------|
| `APPROVED` | yes | silent |
| `DEPRECATED` | yes | resolves with `warnings: ["DEPRECATED"]` |
| any other (`DRAFT`, `PENDING_APPROVAL`, `REJECTED`, `CREATING`, `UPDATING`, `CREATE_FAILED`, `UPDATE_FAILED`), including a status the service adds later | no | not a candidate. If it is the only match, the result is `NO_MATCHING_VERSION` |

**Fail-closed:** any unresolved ref fails task admission with `REGISTRY_RESOLUTION_FAILED`. A running task never re-resolves or substitutes. A candidate whose descriptor is present but cannot be parsed rejects the ref with `MALFORMED`. The candidate is never silently skipped in favour of a lower valid version, so a corrupt payload cannot cause a downgrade to a stale version (#791).

## 9. Access control (MVP)

The API construct creates two Cognito groups as `CfnUserPoolGroup`:

- **`RegistryPublisher`.** May call `POST /registry/records`. The record is submitted for approval (`PENDING_APPROVAL`).
- **`RegistryApprover`.** Also drives `UpdateRegistryRecordStatus` to `APPROVED`, `REJECTED`, or `DEPRECATED`, and may set `auto_approve` on publish (dev).

Resolve, list, and show are available to any authenticated caller. MVP has no per-namespace ACL. Cedar-governed publish ACLs are a later phase.

## 10. Grammar

```
registry://<kind>/<namespace>/<name>@<constraint>
  kind       = [a-z][a-z0-9_]*          # snake_case: mcp_server, cedar_policy_module
  namespace  = [a-z][a-z0-9-]*
  name       = [a-z0-9][a-z0-9._-]*
  constraint = [\^~]?MAJOR.MINOR.PATCH[-prerelease]   # exact / caret / tilde only
```

`parseRef` (TypeScript) and `parse_ref` (Python) implement the strict grammar. The `contracts/registry-resolution/` parity corpus keeps the two in step. The corpus has two runners, like `contracts/cedar-parity/`.

> **Note.** There are two grammars in the tree. The workflow validator's `_REGISTRY_REF` (`agent/src/workflow/validator.py`) is a deliberately looser acceptance check. It also admits the legacy 2-segment illustrative form that `contracts/workflow-validation/` uses. The strict grammar above is authoritative for #246, and resolution enforces it.

## 11. Orchestrator + agent integration (staged)

**PR 1 (this work)** ships the resolver library, port, adapter, provisioning, API, and CLI. It is purely additive. Nothing in the orchestrator or the agent calls it yet.

**PR 2** wired the resolve step in the orchestrator, not in create-task (see the note below). The step collects `registry://` refs from the Blueprint and resolves them through the `RegistryClient`. Resolution is fail-closed, so an unresolved ref fails the task. The step then stamps `resolved_assets: [{kind, id, version}]` on the `TaskRecord` and passes the bundle into the agent payload. PR 2 also loads `mcp_server` assets by merging them into `.mcp.json`. An `mcp_server` asset whose key (`<namespace>__<name>`) or connection config contains `linear`, in any letter case, cannot be loaded. The agent runtime removes every such server from `.mcp.json`, because the agent must have no Linear tools ([ADR-016](../decisions/ADR-016-pluggable-identity-and-auth.md)), and the task fails with `RegistryAssetLoadError` before the agent starts.

The merged `.mcp.json` may hold secrets (bearer headers, a token in a URL, an API-key argument), so the agent runtime makes git leave the file out of the commits made in the clone:

- Through the clone's `.git/info/exclude`, when the repository does not track `.mcp.json`.
- With git's `skip-worktree` flag, when the repository tracks the file, or when the exclude file does not make git ignore it (for example because the repository's own `.gitignore` re-includes it).

Where that cannot be established, the task fails with `RegistryAssetLoadError` before the agent starts:

- The repository's `.mcp.json` is a symbolic link (the config is not written through it).
- The `skip-worktree` flag cannot be read back from the index (another git process holds `index.lock`, `.mcp.json` has an unresolved merge conflict, or sparse checkout is enabled in the clone).

A file that the exclude file covers needs no index entry, so a held `index.lock` or sparse checkout does not fail its task.

For the length of a task that loads a registry `mcp_server`, the file is platform-managed. A change the agent itself makes to `.mcp.json` is not committed either, and git reports the path as ignored or as outside the sparse-checkout definition. The agent log records the cause in a `Registry: … is platform-managed for this task` line. [#760](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/760) tracks lifting that limit.

**PR 3** added the `cedar_policy_module` and `skill` loaders. Resolved Cedar text is concatenated into the same `cedar_policies` payload field as inline blueprint policies. The text is byte-identical from the `PolicyEngine`'s view, so cedar-parity holds by construction. Resolved skill `prompt_fragment`s are appended to the system prompt (`prompt_builder.py`, after channel guidance).

> **Resolve happens in the orchestrator, not create-task.** Five or more entry-point Lambdas share `createTaskCore` (API, Slack, Jira, Linear, webhook). Resolving there would force the Agent Registry SDK and its IAM permissions into all of them. The orchestrator is a single Lambda that already loads `blueprintConfig` and assembles the payload. `cedar_policies` already takes the same path. The trade-off is that an unresolvable ref appears as a FAILED task rather than as a 422 at submit. That is still fail-closed, because the task never runs with a missing or substituted asset. The construct already validates Blueprint refs at synth.

## 12. Test plan

- **Resolver unit tests** (`cdk/test/handlers/shared/registry-resolver.test.ts`): semver match for exact, `^`, and `~`, highest-version selection, prerelease ranking, and no-match.
- **Grammar parity corpus** (`contracts/registry-resolution/`): annotated `(ref) → verdict` fixtures that run against both the Python `parse_ref` and the TypeScript `parseRef`.
- **Adapter tests** (`agent-registry-client.test.ts`): 3-call publish, native runtime embedding, `CUSTOM` round-trip, immutability, and resolve with its status filter, semver ranking, and deprecation warning.
- **Handler tests**: the auth, validation, and `409` of publish, the `422` reasons of resolve, the grouping of list, and show.
- **Construct tests**: `registry.test.ts` (Provider wiring and IAM).
- **E2E (PR 2)**: publish an MCP server, reference it from a Blueprint, run a task, and assert that the agent payload carries the bundle and that the `TaskRecord` has `resolved_assets`.

### 12.1 Reproducing the E2E — the `forkBlueprintRepo` demo hook

The stack ships an opt-in deploy hook that onboards one repo with all three MVP asset kinds pinned, so you can exercise the end-to-end path without writing a Blueprint by hand. The hook is off by default, and no fork is hardcoded for other contributors. To enable the hook, point it at a repo that you control:

```bash
# via CDK context…
cdk deploy --context forkBlueprintRepo=owner/repo
# …or via env var
FORK_BLUEPRINT_REPO=owner/repo cdk deploy
```

When the flag is set, the stack adds a `Blueprint` for `owner/repo` that pins
`registry://mcp_server/acme/aws-knowledge@^1.0.0`,
`registry://cedar_policy_module/acme/guard@^1.0.0`, and
`registry://skill/acme/readme-helper@^1.0.0`. Publish those `acme/*` records to the
registry first. They are illustrative, not seeded, so without them task admission
fails closed on the unresolved pins. Leave the flag unset for a normal deploy.

## 13. Accepted risk

AWS Agent Registry may not be available or permitted in every customer account and target region. The context gate is on by default, so existing deployments keep the registry, and `enableAgentRegistry=false` lets those customers deploy ABCA without the service. The remaining accepted migration risk is catalog continuity. The standalone namespace requires a fresh registry and explicit asset migration or re-publication.

## 14. Out of scope (explicit)

The following are out of scope:

- Transitive registry-asset dependencies.
- Loaders for plugin, subagent, prompt_fragment, and capability.
- Upstream federation.
- A per-namespace ACL.
- EventBridge as a primary bus.
- Migration of first-party workflows into the registry.
