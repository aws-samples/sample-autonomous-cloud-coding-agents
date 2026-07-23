# ADR-018: Central agent asset registry

**Status:** proposed
**Date:** 2026-07-08

## Context

Adding a new runtime artifact to ABCA today — an MCP server, a Cedar policy module, a skill, a prompt fragment — is a **core-code change plus a CDK deploy**. Artifacts are either vendored into the container image (built-in MCP servers, first-party workflows), inlined on the Blueprint construct (Cedar policies), or served from repo-local files (`.mcp.json`, `AGENTS.md`). There is no versioned catalog, no immutability guarantee at a given version, and no audit trail of "which asset versions did this task actually run."

This has three costs:

1. **Every new tool/skill/policy costs a deploy.** Rolling out a new MCP server to N repos is N Blueprint edits + a CDK deploy. Teams can't publish autonomously.
2. **No pin, no reproducibility.** Because assets aren't versioned, "the tool the agent used on 2026-05-01" can't be reconstructed from the task record.
3. **The vocabulary already anticipates a registry.** [ADR-014](./ADR-014-workflow-driven-tasks.md) and [WORKFLOWS.md](../design/WORKFLOWS.md) already:
   - Coined `registry://kind/name` refs (grammar in [`agent/src/workflow/validator.py`](../../agent/src/workflow/validator.py) `_REGISTRY_REF`).
   - Modeled `agent_config` asset kinds (`mcp_servers`, `skills`, `plugins`, `subagents`, `prompt_fragments`, `cedar_policy_modules`) 1:1 with the vocabulary this ADR needs.
   - Designed a resolver interface as a **drop-in swap** — filesystem-backed today, registry-backed later ([`agent/src/workflow/loader.py:107`](../../agent/src/workflow/loader.py), WORKFLOWS.md §"Registry integration (#246)").
   - Left validator rule 8 as a deferred check: every asset ref resolves — builtins today, registry refs when the registry lands.

Issue [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246) proposes closing this gap with a **central versioned asset registry**: a catalog of typed, immutable-at-version artifact records that blueprints pin by `registry://kind/name@constraint`, that the orchestrator resolves at task start, and that the agent receives as a resolved bundle. Six acceptance criteria — asset kinds enumerated, publish+resolve with semver+immutability, blueprint reference of at least one kind, agent E2E for one kind, descriptor validation at publish, tests + docs.

Two forces shape the decision:

- **Prior art exists at AWS.** [AWS Agent Registry (Bedrock AgentCore)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html) is a managed service — public preview — whose native resource types (**MCP servers**, **agents (A2A)**, **skills**, plus **custom resources** with a caller-defined JSON schema) map directly onto #246's asset-kind list. It ships governance (approval workflow), audit (CloudTrail), notifications (EventBridge), discovery (hybrid semantic + keyword search), MCP-native discovery endpoint, and IAM-or-JWT authorization out of the box. Two caveats: (a) it does not commit to **semver constraint resolution** — records carry a version string and support revisions, but the resolution semantics WORKFLOWS.md commits to (`^`/`~`/exact, "highest matching version wins", reject `*`/`latest`) are an ABCA-side concern; (b) it is in **public preview under `bedrock-agentcore` and moves to a new `agent-registry` namespace on 2026-08-06** — a hard cutover affecting API endpoints, IAM actions, SDK client names, CLI commands, and registry data itself.
- **Substrate is not the invariant.** The invariants #246 needs — semver grammar, immutability per version, resolve-at-task-start, fail-closed on missing pin, descriptor validation at publish — are contract-level, independent of whether the data lives in AgentCore Registry or in DynamoDB + S3. ABCA has a precedent for this factoring: ADR-014's resolver interface deliberately abstracts filesystem-vs-registry so the substrate is swappable.

Adjacent decisions the ADR must respect but not re-open:

- **[#381](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/381) — ADR↔Persona↔Skill graph.** #381 wires bidirectional frontmatter edges between ADRs, personas, and skills as `docs/` and plugin markdown, enforced by a parity linter. Both #246 and #381 mention "skills," but they mean different things: #381 is *documentation graph consistency*; #246 is a *runtime artifact catalog*. This ADR keeps them cleanly separated.
- **[ADR-014](./ADR-014-workflow-driven-tasks.md).** Workflows are the registry's first `capability`-kind consumer; the `workflow_ref` field's resolution semantics are the model this ADR generalizes to all asset kinds. Workflows themselves stay filesystem-backed in the MVP — they already ship and are validated; migrating them to the registry is a separate follow-up, not part of #246.

## Decision

ABCA gains a **central agent asset registry**: a versioned, immutable-per-version, platform-managed catalog of runtime artifacts. Blueprints reference assets via `registry://kind/namespace/name@constraint`; the orchestrator resolves refs at the create-task boundary; resolved `{kind, id, version}` triples are stamped on the task record; the agent receives a resolved bundle alongside the workflow file.

The ADR fixes the **contract**. Substrate is deferred to the design PR, with a **preferred direction** and a **documented fallback**.

### Sub-decisions

1. **URI grammar and kinds.** `registry://<kind>/<namespace>/<name>@<constraint>`. MVP kinds: `mcp_server`, `cedar_policy_module`, `skill`. Schema declares — but does not yet load — `plugin`, `subagent`, `prompt_fragment`, `capability` (`capability` = workflow, ADR-014 vocabulary). URI regex matches the shape already committed at [`agent/src/workflow/validator.py:50`](../../agent/src/workflow/validator.py).

2. **Semver, not floating.** Allowed constraints: exact (`1.4.1`), caret (`^1.4.1`), tilde (`~1.4.1`). Rejected at validation time: `*`, `latest`, `>=`, and bare prerelease modifiers. Resolution rule: *highest semver-comparable version matching the constraint; prereleases rank below their base version.*

3. **Immutable per version.** `(kind, namespace, name, version)` is immutable once published. Republish attempts fail 409 `REGISTRY_VERSION_EXISTS`. Content changes require a new version. Mutable metadata is confined to a lifecycle status field.

4. **Lifecycle status.** Full set: `draft` → `submitted` → (`approved`/`rejected`) → `deprecated` → `removed`. `approved` (also called `active`) resolves silently; `deprecated` resolves with a warning event on the task record; `submitted`, `draft`, `rejected`, and `removed` all fail resolution. See sub-decision 10 for the governance transitions between these states. Immutability of the artifact bytes is orthogonal — status transitions do not rewrite content.

5. **Resolve at the create-task boundary.** Same location `workflow_ref` resolves today (`cdk/src/handlers/shared/`), so the orchestrator and agent always receive fully-pinned `{id, version}` triples. Task records persist `resolved_assets: [{kind, id, version}]` for audit.

6. **Fail-closed.** A ref that does not resolve fails admission with `REGISTRY_RESOLUTION_FAILED` and a specific reason (`NO_MATCHING_VERSION`, `REMOVED`, `INVALID_CONSTRAINT`). No implicit fallback to a "latest" version. A running task never silently downgrades or substitutes a resolved asset.

7. **Descriptor validation at publish.** Every published asset carries a typed descriptor per kind (tool surface, egress domains, Cedar actions introduced, minimum compute profile, permissions required). Descriptor shape is validated at publish; missing required fields reject publish. Descriptor lives in the record; the artifact bytes are separate.

8. **Resolver interface as the seam.** Both #246 sides — the CDK/TypeScript orchestrator and the Python agent runtime — talk to a `RegistryClient` abstraction, not to a specific AWS SDK client. This mirrors ADR-014's filesystem-vs-registry seam and confines any substrate change (or the AgentCore Aug 2026 rename) to one implementation file per language.

9. **MVP E2E path is one asset kind: MCP server.** Per issue AC4, one end-to-end path is sufficient for MVP. MCP server is chosen because it is the most heavily used asset kind (already vendored built-in in the container) and because AgentCore Registry has native, protocol-validated support for it. Cedar policy modules and skills follow in child issues ([#478](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/478)/[#479](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/479)/[#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480)/[#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481)).

10. **Governance workflow ships in MVP.** Publishing follows a lifecycle: **draft → submitted → approved | rejected → deprecated → removed**. The `active` status on a record means "approved" — resolvers only match approved records; submitted/rejected/draft records exist but do not resolve. Governance is what separates a registry from a directory; deferring it entirely to Phase 3 would drop ABCA into the "partial-match" tier that community catalogs occupy. MVP requirements: (a) publish creates a record in `submitted` state (or `active` if the operator has approver rights); (b) an approver can transition submitted → approved or submitted → rejected with an audit trail; (c) an event fires on state transitions so external review pipelines (ticketing, security scan, human approval) can integrate; (d) auto-approve mode is available for dev environments. Rich audit metadata (approver identity, timestamp, rationale) is a MUST on every state transition.

11. **MVP access control.** Two Cognito groups: `RegistryPublisher` (can create records in `submitted` state) and `RegistryApprover` (can approve/reject/deprecate). Resolve/read is available to any authenticated caller. **Cedar-governed publish/promote ACLs are Phase 3 ([#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480)/[#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481)).** No per-namespace ACL granularity in MVP; the two-role split is the minimum that makes sub-decision 10's approval workflow meaningful.

12. **Workflows do not migrate to the registry in this ADR.** ADR-014 first-party workflows stay filesystem-backed in the container image. The resolver interface leaves the door open (the vocabulary is aligned 1:1), but the migration is a separate decision not needed to close #246.

13. **Split cleanly from [#381](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/381).** Registry stores skill **runtime artifacts** — prompt+tools bundles the agent loads at task start. #381's ADR↔Persona↔Skill **documentation graph** stays in `docs/` and plugin markdown with frontmatter edges + parity linter. The two must not conflate: an operator publishing a skill artifact is not the same act as an author linking a skill markdown to an ADR. If a skill record's descriptor eventually cites an ADR, that citation is metadata, not a graph edge #381 owns.

### Substrate: preferred choice, fallback, and considered alternatives

The ADR does not pick the substrate. It ranks candidates by fit for ABCA and defers the substrate selection itself to the design PR, which MUST prototype the top-ranked candidate before committing.

Across the registry platforms available as of mid-2026, the five requirements this ADR treats as invariants (publishing, searchable catalog, governance, access control, and multi-resource type support) narrow the field to a small number of viable options. All meaningful candidates remain in preview or early maturity, which reinforces that the `RegistryClient` seam (sub-decision 8) is the substrate-independent hedge — ABCA should not be locked to any one substrate while the ecosystem is still moving.

**1. Preferred: [AWS Agent Registry (Bedrock AgentCore)](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html).** Rationale:

- Native resource types map 1:1 onto MVP kinds: `mcp_server` (MCP protocol-validated), `skill`, `custom` (Cedar module, prompt fragment via caller-defined JSON schema). Five native types — the broadest coverage of any managed offering in the current field.
- **Governance ships as a first-class lifecycle** — Draft → Pending Approval → Approved/Rejected with deprecation support — driven by EventBridge notifications and an `UpdateRegistryRecordStatus` API that lets external review pipelines (ticketing, security scan, human approval) close the loop programmatically. Auto-approve mode is available for dev environments. This is a direct match for sub-decision 10.
- Hybrid semantic + keyword search with weighted relevance ranking.
- MCP-native discovery endpoint — an agent can query the registry via MCP without ABCA-specific glue.
- IAM or JWT (Cognito) authorization — ABCA already uses Cognito, so JWT drops in for the resolve path. Fine-grained IAM actions like `bedrock-agentcore:InvokeRegistryMcp` support the two-role model in sub-decision 11.
- CloudTrail control-plane audit trail.
- Multi-registry organizational scoping — separate registries per team / environment / business unit are first-class, matching how ABCA operators would isolate dev from production catalogs.
- Available in five regions during preview at **no charge**; cost is not a factor for MVP.
- AWS-managed. No new operational surface (no MongoDB, no auth server, no self-run gateway). A support contract exists.
- Best fit for an AWS-native platform, which ABCA is by construction.

**2. Fallback: DynamoDB (metadata) + S3 (artifacts).** Use when preferred is blocked. Rationale:

- Matches existing ABCA patterns (`RepoTable`, `attachments-bucket`).
- Full control over semver resolution and immutability semantics — no gap between what WORKFLOWS.md commits to and what the substrate enforces.
- No preview-status risk. No third-party dependency to trust.
- Cost: extra code to write and maintain (publish handler, resolve handler, IAM grants, descriptor validators, governance state machine, discovery/search). The governance flow in sub-decision 10 is essentially a re-implementation of what AgentCore ships.

**3. Considered — not adopted for MVP: [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry) (open-source, Apache-2.0, self-hosted).** An Apache-2.0 project combining a gateway (nginx data plane) and registry (FastAPI control plane, MongoDB-backed) with native support for MCP servers, A2A agents, skills, and admin-defined custom entities. Federation to AWS Agent Registry, Anthropic MCP Registry, and peer instances is built in. Published on the [AWS Open Source Blog (June 2026)](https://aws.amazon.com/blogs/opensource/governing-ai-assets-at-scale-with-mcp-gateway-and-registry/), which materially raises its credibility beyond the typical community project. Reasons it ranks below the preferred and fallback options for ABCA:

- **New operational surface.** ABCA is DynamoDB-native. This project introduces MongoDB (or Amazon DocumentDB), a FastAPI service, an nginx proxy, and an auth server — four new components to deploy, patch, monitor, back up, restore, and reason about at incident time. That is a substantial addition for a sample/reference project whose current stack is intentionally slim.
- **Scope mismatch.** The gateway/proxy features (per-user 3LO OAuth, virtual MCP servers, gateway-brokered egress) are valuable capabilities, but they solve problems #246 does not ask us to solve in MVP. Paying the operational cost for capabilities MVP does not require is over-scoping.
- **Federation is real, but hedged elsewhere.** Its ability to federate to AWS Agent Registry + others behind one API is architecturally interesting, but the substrate-independence property that federation provides is already delivered by sub-decision 8 (the `RegistryClient` interface). ABCA does not need a second layer of indirection for the same purpose.
- **Governance model is webhook-based** rather than a fully-integrated lifecycle. Wiring the webhook approval into ABCA's own workflows is additional glue we do not need to write.

If preferred and fallback are both blocked, or if a future issue explicitly needs the gateway/federation capabilities, this candidate should be re-evaluated then.

**4. Considered and not adopted: [agentregistry.ai (Solo.io)](https://www.solo.io/products/agentregistry).** Kubernetes-native, multi-cloud, four resource types (agents, MCP, skills, prompts) with a full artifact approval mode. Best suited to Kubernetes-first / multi-cloud platforms. ABCA is neither — it is single-cloud (AWS), CDK-deployed, not Kubernetes-first. Adopting this substrate would inherit a K8s-shaped model ABCA does not use elsewhere.

**5. Considered and not adopted: [Microsoft Entra Agent Registry + Agent Governance Toolkit](https://microsoft.github.io/agent-governance-toolkit/).** Treats agents as first-class identities via Entra Conditional Access, supports 20+ agent types, provides shift-left CI/CD governance and multi-cloud agent surfacing (including AWS Bedrock). Best suited to Microsoft-ecosystem platforms. ABCA has no Entra / Microsoft-ecosystem alignment; adopting this substrate would force introducing that ecosystem for a single subsystem.

#### Also considered, briefly

The following platforms were reviewed but did not warrant a full write-up above, because each falls short of the invariants this ADR fixes (typically on governance, resource-type breadth, or fit for an AWS-native, non-Kubernetes-first, non-Microsoft-ecosystem platform). Named here so future readers see they were weighed and disqualified.

- **[Google Cloud Agent Registry](https://docs.cloud.google.com/agent-registry/overview)** — GCP-native, launched preview April 2026. Supports agents, MCP servers, endpoints. Ruled out: GCP-only (ABCA is AWS-native); keyword-only search (no semantic); IAM-only governance with no explicit approval workflow.
- **[Smithery](https://smithery.ai/)** — largest open MCP server registry (3,000+ servers), community-driven, SaaS + managed gateway. Ruled out: relies on a "verified" flag rather than a formal pre-publication review workflow; October 2025 supply-chain incident illustrated the risk of that model for a governed platform. Useful as a *discovery* source, not a governed catalog.
- **[Glama](https://apis.io/providers/glama-ai/)** — very large community MCP directory (23,000+ servers). Ruled out for the same reason as Smithery: discovery-only, no governance.
- **[PulseMCP](https://www.pulsemcp.com/servers)** — community MCP directory. Ruled out: directory, not a registry.
- **[ACI.dev](https://aci.dev/)** — 600+ integrations, semantic search, hierarchical access control. Ruled out: tool-calling platform, not a governed registry; no submit/review/approve workflow; agents not first-class resources.
- **[Composio](https://composio.dev/)** — 1,000+ toolkits, 20,000+ tools, granular per-user OAuth. Ruled out: same shape as ACI.dev — tool-calling catalog, no governance workflow, agents not first-class.
- **[Toolhouse](https://toolhouse.ai/)** — 40+ built-in MCP servers with agent deployment. Ruled out: minimal registry semantics (no semantic search, no RBAC, no governance workflow).
- **[Docker MCP Catalog](https://www.docker.com/blog/enhancing-mcp-trust-with-the-docker-mcp-catalog/)** — Docker-published catalog with commit pinning, publisher trust tiers, cosign signature verification. Ruled out as a substrate: single-vendor curated catalog rather than a self-hostable registry ABCA operators can publish to. Its supply-chain patterns (commit pinning, cosign) inform sub-decisions 3 (immutability) and 7 (descriptor validation) even though the platform itself is not adopted.
- **[Jozu Hub](https://jozu.com/mcp-registry/)** — MCP registry with cryptographic signing, security scanning, and runtime policy gating via Jozu Agent Guard. Ruled out: narrower scope than the AWS-native option, unclear alignment with ABCA's Cognito/IAM auth model, and treating it as a substrate would introduce a second vendor on the critical path.
- **[Stacklok / ToolHive](https://stacklok.com/resources/building-a-local-mcp-registry/)** — open-source local registry with strong audit/OTEL story and vMCP for curated tool sets. Ruled out as a substrate for the same operational-surface reason as mcp-gateway-registry: adopting it introduces new components (registry service, its own auth/audit paths) without covering the governance workflow (sub-decision 10) as well as the preferred managed option. Its audit-trail patterns inform observability decisions in the design PR.

**Design PR decision framework.** Choose the fallback (option 2) when *any* of the following is true:

- AgentCore Registry is not GA in every target ABCA deployment region.
- AgentCore's revision model cannot be constrained to enforce `(name, version)` immutability with acceptable client-side guards.
- Semver resolution added on top of AgentCore's version string materially complicates the resolver or breaks the parity contract with WORKFLOWS.md.
- The 2026-08-06 namespace migration cost, weighed against ABCA's release timeline, exceeds the cost of building DDB+S3 once.

Regardless of substrate, the invariants above (semver, immutability, resolve-at-boundary, descriptor validation, governance workflow, fail-closed, resolver interface as the seam) hold.

## Consequences

- (+) **New tools/skills/policies do not require CDK deploys.** Publishers push new versions to the registry; blueprints re-pin when ready. The compile-and-deploy path is only for platform-level changes.
- (+) **Per-task audit.** `resolved_assets` on every task record answers "what did this task actually run" from a single field, without excavating deploy timestamps or Git blame.
- (+) **Reproducibility.** A task's pins fully determine its asset surface. Re-running the same task with the same pins produces the same asset load, modulo LLM nondeterminism.
- (+) **Registry vocabulary already committed.** Because the URI grammar, asset kinds, and resolver interface were pre-declared in ADR-014 / WORKFLOWS.md, this ADR closes the loop rather than opening it — the code already parses and validates `registry://` refs and defers only the resolution step.
- (+) **Preferred-substrate direction gives implementers a clear default.** Reviewers and future contributors don't need to re-litigate AgentCore-vs-native from first principles; the trade-off is captured with an explicit fallback rule.
- (+) **Aligned with AWS-native architecture.** AgentCore Registry is a managed AWS service that natively covers the invariants (governance lifecycle, audit, discovery, MCP-native endpoint, IAM/JWT auth). ABCA is AWS-native by construction, so this alignment avoids re-implementing what AWS already ships.
- (+) **Governance is a first-class MVP concern.** Sub-decision 10 gives ABCA a real approval workflow — submit → approve/reject → deprecate with audit trail and event-driven review integration — at MVP, not Phase 3. This is what distinguishes a registry from a directory.
- (+) **Clean handoff to child issues.** [#478](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/478) (lifecycle), [#479](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/479) (versioning + immutability), [#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480) (Blueprint integration + ACLs), [#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481) (capability descriptors) each map to a specific sub-decision above, giving each a scoped, non-overlapping mandate.
- (−) **Two-language resolver contract.** The `RegistryClient` interface and the semver rules must agree between the TypeScript orchestrator and the Python agent. This is the same class of parity hazard the repo has learned from twice (Cedar bindings, workflow validation). Mitigation: publish the resolver contract as a golden corpus (`contracts/registry-resolution/`) mirroring the existing `contracts/cedar-parity/` and `contracts/workflow-validation/` mechanisms — annotated `(ref, catalog) → verdict` fixtures run against every implementation in CI.
- (−) **Descriptor schema is a new maintained surface.** Each asset kind's descriptor shape must be authored, versioned, and evolved compatibly. Mitigation: JSON Schema as single source of truth (mirroring the workflow-schema decision in ADR-014); one implementation, both languages consume it via standard libraries.
- (−) **MVP access control is coarse-grained.** Two Cognito groups (`RegistryPublisher`, `RegistryApprover`) are a single tenant boundary — no per-namespace ACL, no publisher-per-team. Acceptable for MVP because it makes the sub-decision 10 approval workflow meaningful; Phase 3 Cedar-governed ACLs ([#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480)/[#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481)) close it.
- (−) **Substrate deferral is real work not done here.** The design PR must produce a substrate decision with evidence (a spike or two against AgentCore Registry, sized against DDB+S3). This ADR delegates that work but does not do it.
- (!) **AgentCore Registry preview + 2026-08-06 namespace migration.** If preferred substrate is chosen, ABCA inherits the rename: API endpoints, IAM policies, SDK clients, CLI scripts, and registry data must all move on cutover. Mitigation: the `RegistryClient` interface (sub-decision 8) confines the change to one implementation file per language; the CI parity corpus catches semantic drift. Design PR MUST record which target regions have GA before merging a production dependency on AgentCore, and MUST document a rollback path to the DDB+S3 fallback if preview constraints materialize.
- (!) **Semver-on-a-non-semver-substrate.** AgentCore Registry's version field is a string, not a semver-aware column. The ABCA-side resolver has to (a) query candidate records and (b) rank them by parsed semver. This is safe when catalogs are small, but a large catalog could pay a list-cost per resolve. Mitigation: cache resolved pins per `(ref, catalog-fingerprint)` at the create-task boundary; measure at MVP scale before optimizing.
- (!) **"Removed" vs GDPR-style deletion are different.** `removed` means "fails to resolve, refuse to run tasks pinned to this"; it does not necessarily mean the bytes are gone. If a compliance-driven true deletion is ever required, it is a separate operation on the substrate and outside the resolver contract. Design PR to note.
- (!) **Non-goal drift.** MVP does not include: transitive registry-asset dependencies, EventBridge as a primary bus for asset events, replacing repo-local `.mcp.json`/`AGENTS.md`, publisher-per-team ACL, or the meta-agent path from [#99](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/99). Any of these arriving via scope-creep undermines the "resolve at task start" boundary and should be pushed to a follow-up ADR.
- (!) **Governance for `production` publish is a trust decision.** Until Cedar-governed ACLs land, publish rights are keyed by Cognito group membership — a coarse gate. Any exposure of the publish endpoint outside a trusted operator group is a security decision, not a convenience decision.

## References

- Issue [#246](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/246) — this ADR's tracking issue.
- Issue [#381](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/381) — ADR↔Persona↔Skill graph (overlap resolved by sub-decision 12).
- Issue [#478](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/478) — asset lifecycle (publish/deprecate/retire).
- Issue [#479](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/479) — asset versioning + immutability.
- Issue [#480](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/480) — Blueprint registry refs + access control.
- Issue [#481](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/481) — capability descriptors.
- Issue [#230](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/230) — event-rule packs (defer to registry Phase 3).
- Issue [#99](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/99) — ToolBuilderAgent / meta-agent vision (out of scope; registry is a prerequisite).
- [ADR-003](./ADR-003-contribution-governance.md) — contribution governance (publish/promote follows the same approval path).
- [ADR-014](./ADR-014-workflow-driven-tasks.md) — workflow-driven tasks (defines the `registry://` grammar, resolver interface, and asset-kind vocabulary this ADR generalizes).
- [docs/design/WORKFLOWS.md](../design/WORKFLOWS.md) §"Registry integration (#246)" — the workflow-side spec this ADR closes.
- [`agent/src/workflow/validator.py`](../../agent/src/workflow/validator.py) `_REGISTRY_REF` — URI grammar already shipped.
- [`agent/src/workflow/loader.py:107`](../../agent/src/workflow/loader.py) — Phase 4 deferral comment this ADR unblocks.
- [AWS Agent Registry documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html) — preferred substrate candidate.
- [AWS Agent Registry key capabilities](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-key-capabilities.html) — governance lifecycle, hybrid search, EventBridge integration.
- [AWS Agent Registry: Migration from public preview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-faq.html) — the 2026-08-06 namespace migration referenced in risks.
- [The future of managing agents at scale: AWS Agent Registry now in preview (AWS Machine Learning Blog)](https://aws.amazon.com/blogs/machine-learning/the-future-of-managing-agents-at-scale-aws-agent-registry-now-in-preview/) — preview announcement, regional availability, pricing.
- [mcp-gateway-registry (GitHub)](https://github.com/agentic-community/mcp-gateway-registry) — considered alternative (Apache-2.0, self-hosted); not adopted for MVP, see substrate section for rationale.
- [Governing AI assets at scale with MCP Gateway & Registry (AWS Open Source Blog, June 2026)](https://aws.amazon.com/blogs/opensource/governing-ai-assets-at-scale-with-mcp-gateway-and-registry/) — AWS endorsement of the mcp-gateway-registry OSS path.
- [Solo.io agentregistry](https://www.solo.io/products/agentregistry) — considered alternative for K8s-first / multi-cloud platforms; not applicable to ABCA.
- [Microsoft Entra Agent Registry](https://www.docs.microsoft.com/en-us/entra/agent-id/identity-platform/what-is-agent-registry) and [Agent Governance Toolkit](https://microsoft.github.io/agent-governance-toolkit/) — considered alternative for Microsoft-ecosystem platforms; not applicable to ABCA.
