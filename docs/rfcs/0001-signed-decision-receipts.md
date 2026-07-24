# RFC 0001: Signed Decision Receipts for ABCA via AgentCore Gateway

**Status:** Draft for review. Prepared in response to [@krokoko](https://github.com/krokoko)'s feedback on the now-closed [#39](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/39).

**Author:** Tom Farley (independent capacity; IETF draft author for `draft-farley-acta-signed-receipts`). **Disclosure:** I am the author of the receipt format specification and of [`protect-mcp`](https://www.npmjs.com/package/protect-mcp), one of four conformant implementations referenced below. The contract in this RFC is a format, not a vendor choice; any implementation of that format is interchangeable.

**Reviewers requested:** @krokoko and ABCA maintainers.

**Scope:** ABCA only. The receipt format, trust boundaries, and CDK patterns described here are portable, but the integration this document proposes is specific to ABCA + Amazon Bedrock AgentCore Gateway.

---

## 1. Problem statement

ABCA agents run autonomously in MicroVMs, clone repositories, write code, execute tests, and open pull requests. Every consequential step is a tool call through AgentCore Gateway. By default, evidence that each call happened and under what authorization lives in CloudWatch logs, which are:

- **Operator-controlled.** CloudWatch entries can be redacted, amended, or deleted by the account that runs ABCA.
- **Not externally verifiable.** A PR reviewer or regulator without AWS account access has no way to confirm what the agent did to produce the commit.
- **Not tamper-evident as a whole.** Individual log entries are authenticated only to the extent that CloudTrail records CloudWatch writes; the log body itself is not cryptographically sealed.

For regulated deployments of ABCA (financial services, healthcare, public sector, critical infrastructure), this is insufficient. Teams need a stronger guarantee: each Cedar policy decision AgentCore Gateway makes is signed at decision time with a key the agent cannot access, with a tamper-evident chain across the session, verifiable offline by anyone with the signing public key and no AWS credentials.

This RFC proposes that extension. It does **not** replace AgentCore Gateway's native policy engine; it adds a parallel signed-receipt output.

## 2. What AgentCore Gateway already provides

Per the [AgentCore Gateway policy docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-getting-started.html), ABCA's existing gateway already supports:

- A **policy engine** attached in `ENFORCE` mode (`agentcore add policy-engine --attach-to-gateways <gw> --attach-mode ENFORCE`) that evaluates every tool call against attached Cedar policies.
- Cedar `permit` / `forbid` rules with entity types like `AgentCore::Action::"TargetName___toolname"` and `AgentCore::Gateway::"<gw-arn>"`.
- Default-deny semantics: all actions denied unless a `permit` policy matches.
- Forbid-wins semantics: if any `forbid` matches, access is denied.
- Policy decision logging to CloudWatch.

**This RFC does not propose reinventing any of the above.** The policy engine stays native. What this RFC adds is a signed-receipt output of each policy-engine decision, separate from CloudWatch, written to S3 by a new component whose identity is distinct from the agent's.

## 3. Goals and non-goals

### Goals

- **G1.** Every Cedar policy decision AgentCore Gateway makes for an ABCA run is persisted as a signed receipt in addition to the native CloudWatch log entry.
- **G2.** The signing identity is outside the agent's trust boundary. A compromised ABCA agent container or runtime role cannot forge, alter, or suppress receipts.
- **G3.** The receipt chain is tamper-evident as a whole. Insertions, deletions, and reorderings across the session break verification.
- **G4.** Verification is fully offline and does not require AWS credentials or ABCA runtime access. Any party with the signing public key verifies the chain using open-source tooling.
- **G5.** The receipt format is tool-agnostic. ABCA can swap the signing implementation without changing the contract.
- **G6.** Infrastructure is CDK-managed. Every IAM policy, KMS key, S3 bucket, and CloudTrail configuration is a code-reviewed artifact.

### Non-goals

- **NG1.** This RFC does not modify ABCA source code inside `agent/`. No new SDK, no library injection, no runtime changes.
- **NG2.** This RFC does not propose a replacement for AgentCore Gateway's native policy engine. Cedar evaluation stays native.
- **NG3.** This RFC does not cover policy-authoring at scale. Writing Cedar for regulated environments deserves its own guide.
- **NG4.** This RFC does not require any specific signing implementation. Section 4 defines the contract; Section 9 lists four conformant implementations.
- **NG5.** This RFC does not cover transparency-log anchoring (Sigstore Rekor). Anchoring is supported by the chain structure but out of scope here.
- **NG6.** This RFC does not change PR body conventions, CI, or the GitHub App surfaces. It adds an S3 artifact and a verification instruction.

## 4. Trust model

Trust boundaries are the part most prior proposals got wrong, including my own earlier draft. This section is intentionally explicit.

### 4.1 Entities

| Entity | What it is | Trust anchor |
|--------|-----------|--------------|
| **Task submitter** | User or service requesting an ABCA run | Human review authority |
| **ABCA Orchestrator** | AWS-hosted ABCA infrastructure (CDK-managed) | Trusted, code-reviewed |
| **Agent Runtime** | The MicroVM where the AI agent executes | **Untrusted.** Prompt injection and container compromise assumed possible. |
| **AgentCore Gateway** | The in-path tool-call gateway with a native Cedar policy engine | Trusted. The policy engine's evaluation is authoritative. |
| **Receipt Signer** | New Lambda whose only job is to sign a receipt of each policy decision | **Trusted.** Its own IAM role, its own KMS access, its own log destination. Deliberately distinct from the agent runtime. |
| **Signing Key** | Ed25519 key that signs receipts | **KMS-resident.** Scoped to the Receipt Signer IAM role only. Never materialized in the agent runtime or in any other process. |
| **Receipt Storage** | S3 bucket holding the signed receipt chain | Write access scoped to the Receipt Signer; read access open or signed-URL gated per deployment |
| **Verifier** | Any party wanting to confirm what the agent did | Needs only the public key + access to Receipt Storage |

### 4.2 Core assumption: the agent is untrusted

The Agent Runtime may be under the effective control of an adversary at any moment. Prompt injection, model compromise, or container escape are all in scope. Nothing the agent produces self-attests. The agent is the *subject* of receipts, never the *signer*.

### 4.3 Receipt Signer as a distinct identity

The Receipt Signer is a Lambda function with:

- Its own IAM role with a tightly-scoped policy (only `kms:Sign` on the specific signing key, `s3:PutObject` on the receipt-bucket prefix for the active session, nothing else).
- An explicit deny on the signing key for the Agent Runtime IAM role and for any other non-signer role.
- CloudTrail records of every `kms:Sign` invocation, independent of the receipt system, providing a second-layer audit.

A full compromise of the Agent Runtime does not yield signing-key access. A full compromise of the Receipt Signer Lambda yields forgery during the compromise window; CloudTrail cross-checks catch this.

## 5. The receipt contract

Wire format. Any conformant signing implementation produces receipts with these fields.

### 5.1 Receipt structure

```json
{
  "receipt_id":          "rcpt-<unique id>",
  "receipt_version":     "1.0",
  "issuer_id":           "<logical id of the Receipt Signer, e.g. arn:aws:lambda:...>",
  "event_time":          "<RFC 3339 UTC timestamp>",
  "session_id":          "<opaque string, unique per ABCA run>",
  "sequence":            <integer, monotonic within session, 1-indexed>,
  "gateway_arn":         "<AgentCore Gateway ARN that produced the decision>",
  "tool_name":           "<AgentCore tool identifier, e.g. RefundTarget___process_refund>",
  "tool_input_digest":   "sha256:<JCS-canonical hash of the tool input>",
  "decision":            "allow" | "deny",
  "policy_engine_id":    "<AgentCore policy engine id>",
  "policy_digest":       "sha256:<hash of the Cedar policy file evaluated>",
  "reason":              "<short human-readable explanation, optional>",
  "parent_receipt_hash": "sha256:<hash of previous receipt's JCS canonical form, null for sequence=1>",
  "public_key":          "<hex-encoded Ed25519 public key>",
  "signature":           "<hex-encoded Ed25519 signature over JCS canonical payload>"
}
```

### 5.2 The three invariants

1. **JCS canonicalization (RFC 8785)** before signing. Sorted keys, minimal whitespace, NFC-normalized strings. Any two conformant implementations produce byte-identical signing payloads for semantically equal receipts.
2. **Ed25519 signatures (RFC 8032)** over the canonical bytes. Deterministic, 64 bytes, widely implemented. A receipt signed by one implementation verifies against any other conformant verifier without coordination.
3. **Hash chain linkage.** `parent_receipt_hash` is the SHA-256 of the preceding receipt's JCS canonical form (excluding `signature` and `public_key` which are metadata). Insertions, deletions, and reorderings break all subsequent receipts in the chain.

### 5.3 Optional outcome receipts

For deployments that want to attest to tool outputs too, each `allow` decision receipt MAY be followed by an **outcome receipt** signed after the tool returns. The outcome receipt's `parent_receipt_hash` points at its decision receipt; its body carries `tool_output_digest` over the (optionally redacted) response. Auditors get the full call boundary: what was authorized, what actually returned.

This RFC treats outcome receipts as optional. The minimum conformance bar is one decision receipt per policy-engine evaluation.

### 5.4 Reference verifier

The open-source verifier [`@veritasacta/verify`](https://www.npmjs.com/package/@veritasacta/verify) (v0.3.0) accepts receipts in this shape, walks the chain, and exits `0` (valid) or `1` (invalid). Verifier source is public; running it requires no AWS credentials, no network, and no ABCA deployment knowledge.

## 6. Reference implementation: AgentCore Gateway + Receipt Signer

AgentCore Gateway already does Cedar policy evaluation natively. The RFC's contribution is a Receipt Signer Lambda that receives every policy-engine decision and signs a receipt for it.

```
                         ┌────────────────────────────────┐
                         │ Agent Runtime (MicroVM)        │
                         │  ─ untrusted ─                 │
                         └───────────────┬────────────────┘
                                         │ tool call
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    AgentCore Gateway                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Policy Engine (ENFORCE mode, native)                          │  │
│  │   ─ attached Cedar policies                                    │  │
│  │   ─ allow / deny decision per call                             │  │
│  │   ─ CloudWatch log emission (native)                           │  │
│  │   ─ EventBridge decision event emission (RFC-added)            │  │
│  └──────────────┬────────────────────────────────┬────────────────┘  │
│                 │ allow                          │ every decision    │
│                 ▼                                ▼                   │
│     ┌───────────────────────┐    ┌──────────────────────────────┐   │
│     │ Lambda Target         │    │ Receipt Signer Lambda (new)  │   │
│     │ (tool execution)      │    │                              │   │
│     └───────────────────────┘    │ 1. Read decision from event   │   │
│                                  │ 2. Compute prev_hash from     │   │
│                                  │    last receipt in chain      │   │
│                                  │ 3. Sign via KMS Ed25519       │   │
│                                  │ 4. Write to S3 chain prefix   │   │
│                                  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

The Receipt Signer is triggered by an **EventBridge rule** that subscribes to the policy-engine decision events that AgentCore emits (or, in deployments where the events are not exposed, by a CloudWatch Logs subscription filter on the policy-engine log group). Either way the trigger is cloud-native: no custom gateway code, no middleware.

This pattern keeps the Cedar evaluation and the decision authority inside AgentCore. The signer's only job is to attest to what AgentCore decided.

### 6.1 Open question: AgentCore event surface

The cleanest trigger for the Receipt Signer is an EventBridge decision event from the policy engine. The current AgentCore Gateway documentation does not explicitly enumerate the event names emitted by ENFORCE-mode decisions. Two fallbacks if native events are not available:

- **CloudWatch Logs subscription filter** on the policy-engine log group, triggering the Receipt Signer Lambda for each decision line.
- **Wrapper Lambda target** that calls the actual tool target and signs a receipt before returning to AgentCore. Less elegant but works with current features.

I would appreciate @krokoko or the AgentCore team confirming which of these paths is most stable and whether a native decision-event API is on the roadmap.

## 7. CDK infrastructure

The following resources are required. All expressed in TypeScript CDK so they are code-reviewed and version-controlled.

### 7.1 KMS signing key (Ed25519)

```typescript
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';

const signingKey = new kms.Key(this, 'DecisionReceiptSigningKey', {
  keySpec: kms.KeySpec.ED25519,
  keyUsage: kms.KeyUsage.SIGN_VERIFY,
  description: 'Ed25519 signing key for ABCA decision receipts',
  enableKeyRotation: false,   // Ed25519 keys rotate by replacement, not schedule
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

// Narrow grant: only the Receipt Signer can sign
signingKey.grant(receiptSignerLambda.role!, 'kms:Sign');

// Explicit deny for the agent runtime role
signingKey.addToResourcePolicy(new iam.PolicyStatement({
  effect: iam.Effect.DENY,
  principals: [new iam.ArnPrincipal(agentRuntimeRole.roleArn)],
  actions: ['kms:*'],
  resources: ['*'],
}));
```

### 7.2 Receipt storage S3 bucket

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';

const receiptBucket = new s3.Bucket(this, 'AbcaDecisionReceipts', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  versioned: true,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
  lifecycleRules: [
    { noncurrentVersionExpiration: cdk.Duration.days(7) },
  ],
});

receiptBucket.grantWrite(receiptSignerLambda);
// Explicit deny to the agent runtime role
receiptBucket.addToResourcePolicy(new iam.PolicyStatement({
  effect: iam.Effect.DENY,
  principals: [new iam.ArnPrincipal(agentRuntimeRole.roleArn)],
  actions: ['s3:*'],
  resources: [receiptBucket.bucketArn, `${receiptBucket.bucketArn}/*`],
}));
```

Public reads are off by default. Deployments that want external verifiers to fetch receipts without AWS credentials add a bucket policy with a narrow `s3:GetObject` allow on specific prefixes, or serve receipts through a signed-URL API endpoint.

### 7.3 Receipt Signer Lambda

```typescript
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

const receiptSignerLambda = new lambda.Function(this, 'ReceiptSigner', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/receipt-signer'),
  environment: {
    SIGNING_KEY_ID: signingKey.keyId,
    RECEIPT_BUCKET: receiptBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(10),
  // No VPC; talks to KMS and S3 only. No outbound egress to the internet.
});

// Trigger: subscribe to policy-engine decision events
const rule = new events.Rule(this, 'PolicyDecisionRule', {
  eventPattern: {
    source: ['aws.bedrock-agentcore'],
    detailType: ['Policy Engine Decision'],
    detail: {
      gatewayArn: [abcaGateway.attrArn],
    },
  },
});
rule.addTarget(new targets.LambdaFunction(receiptSignerLambda));
```

The event pattern above is the shape I expect from AgentCore's EventBridge integration. If the actual event name or source differs, this is the one place to update.

### 7.4 CloudTrail data-event logging for the signing key

```typescript
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';

new cloudtrail.Trail(this, 'SigningKeyAuditTrail', {
  bucket: auditBucket,
  includeGlobalServiceEvents: true,
  managementEvents: cloudtrail.ReadWriteType.ALL,
});

// Explicitly capture kms:Sign as a data event on the signing key
new cdk.CfnResource(this, 'SigningKeyDataEventsRule', {
  type: 'AWS::CloudTrail::EventDataStore',
  properties: {
    Name: 'DecisionReceiptSigningKeyDataEvents',
    AdvancedEventSelectors: [{
      FieldSelectors: [
        { Field: 'eventCategory', Equals: ['Data'] },
        { Field: 'resources.type', Equals: ['AWS::KMS::Key'] },
        { Field: 'resources.ARN', StartsWith: [signingKey.keyArn] },
      ],
    }],
  },
});
```

Every `kms:Sign` on the signing key is recorded independently of the receipt chain. A verifier with access to CloudTrail data events can cross-check: every receipt should correspond to exactly one `kms:Sign` event. Forging a receipt requires forging a CloudTrail entry too, which is a significantly higher bar.

### 7.5 Explicit denies on the Agent Runtime role

The ABCA agent runtime role is already scoped. This RFC adds belt-and-suspenders denies:

```typescript
agentRuntimeRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.DENY,
  actions: ['kms:Sign', 'kms:Verify', 's3:PutObject', 's3:DeleteObject'],
  resources: [signingKey.keyArn, receiptBucket.bucketArn + '/*'],
}));
```

An explicit deny overrides any inadvertent allow inherited from a broader policy attached elsewhere, and makes the intent unambiguous for future code reviewers.

## 8. Verification flow

External reviewer receiving an ABCA-produced PR:

```bash
# 1. Extract the receipt-chain location from the PR body
CHAIN_URL=$(gh pr view <PR_URL> --json body --jq '.body' \
  | grep 'decision-receipts:' \
  | awk '{print $NF}')

# 2. Fetch the chain (public read prefix; no AWS credentials required)
curl -sL "$CHAIN_URL" -o receipts.jsonl

# 3. Fetch the signing public key (committed alongside ABCA infra)
curl -sL https://<abca-public-keys>/signing-key.hex -o signing-key.hex

# 4. Offline verification
npx @veritasacta/verify@0.3.0 receipts.jsonl --key "$(cat signing-key.hex)"
# exit 0 = valid; exit 1 = tampered / invalid

# Optional: CloudTrail cross-check (requires account read-access)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=<signing-key-arn> \
  --max-results 100 > signing-events.json
python3 scripts/cross-check.py receipts.jsonl signing-events.json
```

Steps 1-4 require no AWS credentials. The CloudTrail cross-check is the second-layer audit defense for the most stringent reviews.

## 9. Compromise analysis

### 9.1 Agent Runtime compromised

**Can do:** Run arbitrary code, exfiltrate data the agent has access to, attempt tool calls the policy allows.

**Cannot do:** Forge receipts, modify existing receipts, skip the AgentCore policy engine (in-path at the gateway level), access the signing key, write to the receipt bucket.

**Detection:** The Receipt Signer captures every attempted call; the chain contains a receipt for every decision (allow and deny). Unusual egress shows up in VPC Flow Logs and CloudWatch metrics.

### 9.2 Receipt Signer IAM role compromised

**Can do:** Sign arbitrary receipts over forged content, write to the receipt bucket.

**Cannot do:** Affect the AgentCore policy decisions themselves (the gateway's policy engine is still authoritative for actual tool-call gating); forge CloudTrail data events that log the `kms:Sign` invocations.

**Detection:** CloudTrail cross-check catches `kms:Sign` events without corresponding legitimate triggers. Rotation of the signing key invalidates future receipts from the compromised role.

### 9.3 Signing key KMS access compromised

**Can do:** Sign anything the attacker wants to forge.

**Cannot do:** Modify receipts already signed with the (uncompromised) key.

**Detection:** Unauthorized `kms:Sign` operations in CloudTrail. If the key material is ever exfiltrated and used offline, CloudTrail will not see it; at that point the deployment treats all receipts after the compromise window as untrusted and rotates the key.

### 9.4 Receipt bucket write access compromised

**Can do:** Append forged receipts, delete receipts (versioning retains prior versions for 7 days).

**Cannot do:** Sign the forged receipts (signer identity is separate).

**Detection:** Signature verification fails on the forgery. Gaps in the `sequence` field are detectable by the verifier.

### 9.5 Operator collusion

**What happens:** ABCA operator deliberately signs false receipts or stages a clean chain for a compromised run.

**Defense:** Nothing in this RFC alone. Mitigated at a higher deployment tier by anchoring receipt hashes in a public transparency log (Sigstore Rekor) so retrospective forgery is detectable. Out of scope for v1.

## 10. Open questions

1. **AgentCore decision-event API.** Does AgentCore Gateway emit native EventBridge events per policy-engine decision, and if so what is the exact event shape and `detailType`? The RFC assumes `aws.bedrock-agentcore` + `Policy Engine Decision`; if the real shape differs, Section 7.3 updates accordingly. **Request for @krokoko or AgentCore docs.**
2. **CloudWatch Logs subscription fallback.** If native events are not available, is a CloudWatch Logs subscription filter on the policy-engine log group the supported pattern?
3. **Public-key distribution.** Where does the signing public key live for external verifiers? A dedicated S3 prefix in the receipt bucket? A JWKS endpoint? An SSM parameter? What fits ABCA deployment conventions best?
4. **Cedar policy versioning.** The `policy_digest` field in each receipt assumes the Cedar policy is stable for a session. Does the AgentCore Gateway policy engine support pinning to a specific policy version per session, or is the deployed policy always the current attached version?
5. **Session boundaries.** Is there an ABCA-native session identifier (task UUID, correlation ID) that the RFC should use for `session_id`, rather than introducing a new identifier?
6. **Subagent handling.** ABCA supports coordinator + implementer patterns with subagents. Should a subagent's receipts live in the parent session's chain, or in its own chain linked by a parent reference? My default is "own chain with a parent reference field"; open to alternatives.
7. **Output redaction.** For outcome receipts (optional per Section 5.3), AgentCore Gateway likely has its own redaction pipeline. The RFC assumes the receipt signs the redacted output that the agent saw. Is that consistent with AgentCore's redaction flow?

## 11. References

- IETF draft: [`draft-farley-acta-signed-receipts`](https://datatracker.ietf.org/doc/draft-farley-acta-signed-receipts/) — receipt wire format
- [AgentCore Gateway policy getting started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-getting-started.html) — native Cedar policy engine, this RFC composes with
- [cedar-policy/cedar-for-agents](https://github.com/cedar-policy/cedar-for-agents) — Cedar WASM bindings and MCP schema generator
- [SLSA for agents discussion](https://github.com/slsa-framework/slsa/issues/1594) — composition with build provenance
- [agent-commit build type v0.2](https://refs.arewm.com/agent-commit/v0.2) — SLSA build type for agent-produced commits, references decision receipts via ResourceDescriptor byproducts
- [in-toto attestation #549](https://github.com/in-toto/attestation/pull/549) — decision receipts as a standard in-toto predicate
- [Microsoft Agent Governance Toolkit `examples/protect-mcp-governed/`](https://github.com/microsoft/agent-governance-toolkit/tree/main/examples/protect-mcp-governed) — reference of decision-receipt composition with an internal Merkle audit log
- RFC 8032 — Ed25519 digital signatures
- RFC 8785 — JCS canonicalization

## 12. Conformant signing implementations

Four codebases currently emit receipts in the Section 5 wire format. Any of them can serve as the Receipt Signer Lambda's implementation.

| Implementation | Language | Source | Author |
|----------------|----------|--------|--------|
| `protect-mcp` | TypeScript | [npmjs.com/package/protect-mcp](https://www.npmjs.com/package/protect-mcp) | Tom Farley (RFC author) |
| `protect-mcp-adk` | Python | [pypi.org/project/protect-mcp-adk](https://pypi.org/project/protect-mcp-adk/) | Tom Farley |
| `sb-runtime` | Rust | [github.com/ScopeBlind/sb-runtime](https://github.com/ScopeBlind/sb-runtime) | Tom Farley |
| APS governance hook | Python | Independent | @aeoess |

Shared conformance test vectors for these implementations are at [ScopeBlind/agent-governance-testvectors](https://github.com/ScopeBlind/agent-governance-testvectors). A fifth implementation can prove conformance by running its output through the same fixtures.

**ABCA is not required to use any specific implementation.** Section 5's contract is the interop surface. Whichever signer the ABCA team chooses to bundle in the Receipt Signer Lambda (or write from scratch), its receipts must verify via `@veritasacta/verify`.

---

## Appendix A: How this RFC differs from the closed #39 guide

The original guide on [#39](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/39) had three weaknesses, all raised by @krokoko in review:

1. **Author transparency was implicit**, not explicit. This RFC names the author as the creator of most of the referenced tools in the header and notes the contract is tool-agnostic.
2. **"No code changes" was wrong framing.** The guide prescribed infrastructure changes. This RFC is explicitly an infrastructure proposal, with CDK as the concrete form.
3. **Trust boundaries were not drawn.** The guide put the signing key inside the agent container, creating a false sense of security because a container compromise compromised both the tool execution and the receipts. This RFC puts the signer explicitly outside the agent runtime, in a separate Lambda with its own IAM role, KMS key scope, and audit trail.

Thank you @krokoko for pulling the proposal toward a materially better design.
