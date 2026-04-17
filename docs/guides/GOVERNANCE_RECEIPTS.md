# Signed Decision Receipts for ABCA Agent Runs

**Add cryptographically verifiable evidence of every tool call an ABCA agent makes, so PR reviewers and regulators can verify the agent's behavior without trusting the orchestrator.**

---

## Why this matters for ABCA

ABCA agents run autonomously in isolated cloud environments, clone repos,
write code, run tests, and open pull requests. Each step is a tool call
(`git clone`, `npm install`, `npm test`, shell commands, file edits). By
default, the evidence that each step happened and was authorized lives in
CloudWatch logs, which are operator-controlled and trust the orchestrator
not to redact or edit entries after the fact.

For regulated environments (financial services, healthcare, public sector)
or for teams that want to hand a PR to a regulator or counterparty, a
stronger evidence model is needed: each policy decision, signed at the
moment it is made, with a tamper-evident chain across the full agent run.

Signed decision receipts provide this. A receipt is a small JSON object,
signed with Ed25519, JCS-canonicalized, and hash-chained to its
predecessor. Anyone with the public key can verify the whole chain offline.

## What this adds to the default ABCA pipeline

The ABCA agent runs inside the Dockerfile in `agent/`. Three additions:

1. **PreToolUse hook**: before every tool call, evaluate the call against a
   Cedar policy. Cedar denial blocks the tool call.
2. **PostToolUse hook**: after every tool call, sign an Ed25519 receipt
   describing the decision, the policy digest, the inputs, and a hash link
   to the previous receipt.
3. **Receipt artifact**: the receipt directory (`/tmp/receipts/`) is
   uploaded as a build artifact alongside the PR, and the PR body includes
   a one-line verification instruction.

Result: a reviewer or auditor running `npx @veritasacta/verify
./receipts/*.json` gets an offline proof that every step of the agent run
was authorized under the declared policy, with exit code 0 for valid, 1 for
tampered, or 2 for malformed.

## The pattern

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   ABCA Autonomous Agent Runtime                          │
│                                                                          │
│  ┌────────────────┐                                                      │
│  │ Orchestrator   │                                                      │
│  └───────┬────────┘                                                      │
│          │ invokes                                                       │
│          ▼                                                               │
│  ┌────────────────┐    PreToolUse hook    ┌───────────────────────────┐  │
│  │ Agent Runtime  │ ───────────────────▶  │ Cedar Policy Evaluator    │  │
│  │ (Claude Code / │   (before each call)  │ ./protect.cedar           │  │
│  │  Amazon Q /    │                       │ allow → continue          │  │
│  │  similar)      │                       │ deny  → exit 2, block     │  │
│  └───────┬────────┘                       └───────────────────────────┘  │
│          │ post-execution                                                │
│          ▼                                                               │
│  ┌────────────────┐    PostToolUse hook    ┌──────────────────────────┐  │
│  │ Tool output    │ ────────────────────▶  │ Ed25519 Receipt Signer   │  │
│  └────────────────┘   (after each call)    │ JCS canonical + chain    │  │
│                                            │ /tmp/receipts/*.json     │  │
│                                            └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Setup

### 1. Add protect-mcp to the agent container

In `agent/Dockerfile`, ensure Node.js 18+ is installed (for `npx`):

```dockerfile
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs
```

### 2. Ship a Cedar policy with the agent image

Create `agent/protect.cedar` with allow/deny rules appropriate to the agent's
scope. Example for a coding agent that runs in an isolated environment:

```cedar
// Allow read-oriented tools on source files.
permit (
    principal,
    action in [Action::"Read", Action::"Glob", Action::"Grep"],
    resource
);

// Allow the build/test commands the agent needs.
permit (
    principal,
    action == Action::"Bash",
    resource
) when {
    context.command_pattern in [
        "git", "npm", "pnpm", "yarn", "uv", "python",
        "pytest", "cargo", "go", "make"
    ]
};

// Deny destructive commands even in the isolated environment.
forbid (
    principal,
    action == Action::"Bash",
    resource
) when {
    context.command_pattern in ["rm -rf", "dd", "mkfs", "shred"]
};

// Writes only to the agent's working directory.
permit (
    principal,
    action in [Action::"Write", Action::"Edit"],
    resource
) when {
    context.path_starts_with == "/workspace/"
};
```

Policy authoring tips:

- **`forbid` is authoritative.** Destructive rules cannot be bypassed by a
  later permissive rule. Always write `forbid` for genuinely dangerous
  patterns.
- **Restrict writes by path prefix.** Pin the agent to its working directory
  so it cannot accidentally modify CI config or credentials.
- **Allow-list commands, do not deny-list.** The `Bash` permit rule above
  lists exactly the commands the agent is allowed to run. Any unknown
  command (e.g., a prompt-injected `curl malicious-url`) falls through to
  an implicit deny.

### 3. Configure Claude Code hooks

If the ABCA agent uses Claude Code, drop `.claude/settings.json` into the
working directory before invoking:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hook": {
          "type": "command",
          "command": "npx protect-mcp@latest evaluate --policy /agent/protect.cedar --tool \"$TOOL_NAME\" --input \"$TOOL_INPUT\" --fail-on-missing-policy false"
        }
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hook": {
          "type": "command",
          "command": "npx protect-mcp@latest sign --tool \"$TOOL_NAME\" --input \"$TOOL_INPUT\" --output \"$TOOL_OUTPUT\" --receipts /tmp/receipts/ --key /agent/protect-mcp.key"
        }
      }
    ]
  }
}
```

The signing key (`/agent/protect-mcp.key`) is generated on first run.
Persist it to AWS Secrets Manager for long-lived agents, or regenerate per
run for ephemeral ones. Keep the **public** key fingerprint (visible in
every receipt's `public_key` field) alongside the agent definition for
verifiers.

### 4. Upload receipts as a PR artifact

In the agent's PR-opening step (`agent/src/...`), after the agent finishes:

```python
import shutil, subprocess
from pathlib import Path

# Archive receipts alongside the PR
receipts_dir = Path("/tmp/receipts")
if receipts_dir.exists():
    tarball = Path("/workspace/decision-receipts.tar.gz")
    subprocess.run(
        ["tar", "-czf", str(tarball), "-C", str(receipts_dir), "."],
        check=True,
    )

    # Upload to S3 for long-term retention (bucket from environment)
    subprocess.run(
        ["aws", "s3", "cp", str(tarball),
         f"s3://abca-receipts/{task_id}/decision-receipts.tar.gz"],
        check=True,
    )

    # Reference from the PR body
    pr_body += "\n\n## Decision Receipts\n"
    pr_body += f"This PR was produced by an autonomous agent. Decision receipts "
    pr_body += f"for every tool call are archived at "
    pr_body += f"`s3://abca-receipts/{task_id}/decision-receipts.tar.gz`.\n\n"
    pr_body += "Verify offline:\n\n"
    pr_body += "```bash\n"
    pr_body += f"aws s3 cp s3://abca-receipts/{task_id}/decision-receipts.tar.gz - | tar xz\n"
    pr_body += "npx @veritasacta/verify receipts/*.json\n"
    pr_body += "```\n"
```

Reviewers see a link in the PR body; any stakeholder can run two commands
to confirm the chain is intact.

## Receipt format

A single receipt:

```json
{
  "receipt_id": "rcpt-a8f3c9d2",
  "receipt_version": "1.0",
  "issuer_id": "abca-agent-protect-mcp",
  "event_time": "2026-04-17T12:34:56.123Z",
  "tool_name": "Bash",
  "input_hash": "sha256:a3f8c9d2e1b7465f...",
  "decision": "allow",
  "policy_id": "protect.cedar",
  "policy_digest": "sha256:b7e2f4a6c8d0e1f3...",
  "parent_receipt_id": "rcpt-3d1ab7c2",
  "public_key": "4437ca56815c0516...",
  "signature": "4cde814b7889e987..."
}
```

Three invariants make this verifiable offline across any conformant
implementation:

- **JCS canonicalization (RFC 8785)** before signing
- **Ed25519 signatures (RFC 8032)** over the canonical bytes
- **Hash chain linkage** via `parent_receipt_id`

Full wire-format spec:
[draft-farley-acta-signed-receipts](https://datatracker.ietf.org/doc/draft-farley-acta-signed-receipts/).

## Why Cedar for ABCA specifically

ABCA already uses AWS CDK for infrastructure. Cedar is AWS's open
authorization language (used in Amazon Verified Permissions, AWS IAM
Access Analyzer, and the CDK policy constructs). Using Cedar for agent
authorization means:

- Same policy engine your AWS infrastructure teams already know
- WASM bindings available ([cedar-policy/cedar-for-agents](https://github.com/cedar-policy/cedar-for-agents))
  so policy evaluation does not require a Rust toolchain in the container
- AWS IAM analyzer can audit the policy file for logical errors
- Policy changes are diffable in Git alongside the rest of the IaC

## Composition with SLSA provenance

When an ABCA agent produces a PR, the commit is the subject of a SLSA
Provenance v1 attestation. The receipt chain rides as a ResourceDescriptor
byproduct in that provenance, following the
[agent-commit build type](https://refs.arewm.com/agent-commit/v0.2):

```json
{
  "name": "decision-receipts",
  "digest": { "sha256": "..." },
  "uri": "s3://abca-receipts/<task_id>/decision-receipts.tar.gz",
  "annotations": {
    "predicateType": "https://veritasacta.com/attestation/decision-receipt/v0.1",
    "signerRole": "supervisor-hook"
  }
}
```

The SLSA provenance (signed by ABCA orchestrator identity) references the
receipt chain (signed by the agent's supervisor-hook identity). Two trust
domains, cross-referenced at the byproduct layer. See
[slsa-framework/slsa#1594](https://github.com/slsa-framework/slsa/issues/1594)
for the composition discussion.

## Verifying a PR from outside AWS

A reviewer without AWS account access can still verify an ABCA agent's run
if the receipts are published in a publicly readable location:

```bash
# 1. Download the archive
curl -sL https://example.com/abca-receipts/task-123.tar.gz | tar xz

# 2. Verify the chain offline
npx @veritasacta/verify receipts/*.json
#   Exit 0 = chain valid, 1 = tampered, 2 = malformed

# 3. Inspect any specific receipt
jq '.' receipts/rcpt-a8f3c9d2.json
```

No AWS credentials, no ABCA runtime, no trust in the orchestrator required.

## Cross-implementation interoperability

The receipt format is implemented by four independent codebases today:

| Implementation | Language | Use case |
|----------------|----------|----------|
| [protect-mcp](https://www.npmjs.com/package/protect-mcp) | TypeScript | Claude Code, Cursor |
| [protect-mcp-adk](https://pypi.org/project/protect-mcp-adk/) | Python | Google ADK |
| [sb-runtime](https://github.com/ScopeBlind/sb-runtime) | Rust | OS-level sandbox |
| APS governance hook | Python | CrewAI, LangChain |

A chain produced in any of them verifies with any conformant verifier. The
format is the contract.

## What this guide does not cover

- **Policy authoring at scale.** A production ABCA deployment likely needs
  multiple policies (per environment, per task risk tier). Cedar supports
  policy composition with explicit precedence rules; start simple and
  iterate.
- **Key management.** The example above generates a key per run. Production
  deployments should use AWS Secrets Manager, AWS KMS, or a hardware
  security module (CloudHSM). For the strongest guarantee, bind the signing
  key to an ATECC608B secure element outside the agent's trust boundary.
- **Transparency log anchoring.** Receipts can be anchored in Sigstore
  Rekor for cross-org verification with inclusion proofs. See
  [sigstore/rekor#2798](https://github.com/sigstore/rekor/issues/2798).

## References

- [`draft-farley-acta-signed-receipts`](https://datatracker.ietf.org/doc/draft-farley-acta-signed-receipts/) — IETF draft, receipt wire format
- [RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032) — Ed25519
- [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) — JCS
- [Cedar policy language](https://docs.cedarpolicy.com/)
- [cedar-policy/cedar-for-agents](https://github.com/cedar-policy/cedar-for-agents) — WASM bindings
- [protect-mcp on npm](https://www.npmjs.com/package/protect-mcp)
- [@veritasacta/verify on npm](https://www.npmjs.com/package/@veritasacta/verify)
- [in-toto/attestation#549](https://github.com/in-toto/attestation/pull/549) — Decision Receipt predicate proposal
- [agent-commit build type](https://refs.arewm.com/agent-commit/v0.2) — SLSA provenance for agent-produced commits
