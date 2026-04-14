---
title: Network architecture
---

# Network Architecture

This document describes the network isolation layer for the AgentCore Runtime.

## VPC Layout

The Runtime runs inside a VPC with 2 Availability Zones:

```
┌─────────────────── VPC (10.0.0.0/16) ───────────────────┐
│                                                           │
│  ┌─ Public Subnets ──┐     ┌─ Private Subnets ─────────┐ │
│  │  NAT Gateway ──────┼─→  │  AgentCore Runtime (ENIs) │ │
│  │  (→ IGW → GitHub)  │     │  SG: egress 443 only     │ │
│  └────────────────────┘     └───────────────────────────┘ │
│                                                           │
│  VPC Endpoints: S3, DynamoDB (gw), ECR API, ECR Docker,  │
│                 CloudWatch Logs, Secrets Manager,          │
│                 Bedrock Runtime, STS, X-Ray (interface)   │
└───────────────────────────────────────────────────────────┘

  Outside VPC: Orchestrator Lambda, API Lambdas, API Gateway
```

- **Public subnets** — Host the NAT Gateway and Internet Gateway. No compute resources.
- **Private subnets (with egress)** — Host the AgentCore Runtime ENIs. All outbound traffic goes through VPC endpoints or the NAT Gateway.
- **Single NAT Gateway** — Provides internet egress (HTTPS only) for external services that have no VPC endpoint: GitHub (source control, API) and package registries (npm, PyPI). Deployed in one AZ to minimize cost.

## Egress paths

Traffic from the agent runtime takes one of two paths depending on the destination:

| Destination | Path | Examples |
|-------------|------|----------|
| **AWS services** | VPC endpoints (private network, no internet traversal) | Bedrock Runtime, DynamoDB, S3, Secrets Manager, ECR, CloudWatch Logs, STS, X-Ray |
| **GitHub** | NAT Gateway → Internet Gateway → internet | `github.com` (git clone/push), `api.github.com` (PRs, issues, `gh` CLI), `*.githubusercontent.com` (raw content) |
| **Package registries** | NAT Gateway → Internet Gateway → internet | `registry.npmjs.org` / `*.npmjs.org` (npm), `pypi.org` / `*.pypi.org` / `files.pythonhosted.org` (pip) |
| **Everything else** | Blocked at the port level by the security group (only TCP 443 is allowed). At the domain level, the DNS Firewall allowlist controls which domains can be resolved (see [DNS Firewall](#dns-firewall)). | — |

The Runtime security group enforces **HTTPS-only egress** (TCP 443 to 0.0.0.0/0). It restricts the port but not the destination — domain-level restriction is the responsibility of the DNS Firewall.

**Important:** The NAT Gateway itself does not filter or restrict traffic. It is a packet forwarder. The actual egress controls are:

1. **Security group** — enforces TCP 443 only (active, always enforced).
2. **DNS Firewall** — enforces a domain allowlist (currently in **observation mode** — logs non-allowlisted queries as ALERT but does not block them). Once switched to enforcement mode, only domains on the platform baseline and Blueprint `egressAllowlist` can be resolved. See [DNS Firewall](#dns-firewall) for the rollout process.

Until the DNS Firewall is switched to enforcement mode, the agent can reach any HTTPS endpoint on the internet via the NAT Gateway.

## VPC Endpoints

| Endpoint | Type | Purpose |
|----------|------|---------|
| S3 | Gateway | ECR image layers, artifact storage |
| DynamoDB | Gateway | Task state tables |
| ECR API | Interface | Container image metadata |
| ECR Docker | Interface | Container image pull |
| CloudWatch Logs | Interface | Runtime application and flow logs |
| Secrets Manager | Interface | GitHub token retrieval |
| Bedrock Runtime | Interface | Model invocation |
| STS | Interface | Temporary credential retrieval for AWS SDK calls |
| X-Ray | Interface | Distributed tracing via OpenTelemetry/ADOT |

Gateway endpoints are free. Interface endpoints have per-hour and per-GB costs.

## Flow Logs

VPC flow logs are enabled for **all traffic** (ACCEPT + REJECT) and sent to CloudWatch Logs with 30-day retention. This satisfies the `AwsSolutions-VPC7` cdk-nag rule and provides audit visibility into network activity.

## What is NOT in the VPC

The following resources remain outside the VPC (public Lambda execution):

- **Orchestrator Lambda** — Invokes the AgentCore Runtime API (not the Runtime itself).
- **API handler Lambdas** — Serve the REST API behind API Gateway.
- **API Gateway** — Public-facing REST API with Cognito auth.

These do not need VPC access and would incur unnecessary cold-start latency and ENI costs if placed in a VPC.

## DNS Firewall

Route 53 Resolver DNS Firewall provides domain-level egress filtering for the agent VPC. Only domains on the allowlist can be resolved; all other DNS queries are logged (observation mode) or blocked (enforcement mode).

### How it works

The DNS Firewall evaluates DNS queries at the VPC Resolver level using a rule group with three rules, evaluated in priority order:

1. **Priority 100 — ALLOW platform baseline domains.** Always-allowed domains required for core agent operations: GitHub (`github.com`, `api.github.com`, `*.githubusercontent.com`), npm (`registry.npmjs.org`, `*.npmjs.org`), PyPI (`pypi.org`, `*.pypi.org`, `files.pythonhosted.org`), and AWS services (`*.amazonaws.com`).
2. **Priority 200 — ALLOW additional domains.** Aggregated from Blueprint `networking.egressAllowlist` values. Empty by default.
3. **Priority 300 — ALERT or BLOCK all other domains.** In observation mode (default), non-allowlisted queries are logged with an ALERT action. In enforcement mode, they are blocked with a NODATA response.

### Observation vs enforcement mode

The construct deploys in **observation mode** by default (`observationMode: true`). In this mode, DNS Firewall logs all queries but does not block anything, allowing safe analysis of real traffic before switching to enforcement.

**Rollout process:**
1. Deploy with `observationMode: true` — DNS queries are logged (ALERT) but not blocked.
2. Analyze CloudWatch DNS query logs over 1-2 weeks of real usage.
3. Add any missing domains to the platform baseline or Blueprint `egressAllowlist`.
4. Switch to `observationMode: false` — non-allowlisted domains are blocked (NODATA).

### Query logging

DNS query logs are sent to a dedicated CloudWatch Logs log group with 30-day retention. Logs capture every DNS query from the VPC, including the queried domain, source IP, and the firewall action taken (ALLOW, ALERT, or BLOCK).

### Fail-open mode

The DNS Firewall is configured with `FirewallFailOpen: ENABLED`. If the DNS Firewall service experiences a transient issue, DNS queries are allowed through rather than blocked. This prevents a DNS Firewall outage from killing running agent sessions (which can last up to 8 hours).

### Per-repo egressAllowlist

The Blueprint construct supports a `networking.egressAllowlist` prop:

```typescript
new Blueprint(this, 'MyRepoBlueprint', {
  repo: 'org/my-repo',
  repoTable: repoTable.table,
  networking: {
    egressAllowlist: ['npm.internal.example.com', '*.private-registry.io'],
  },
});
```

**Important:** Per-repo `egressAllowlist` values are aggregated into the platform-wide DNS Firewall policy. They document intent and feed the allowlist, but they do not provide per-session isolation. All agent sessions in the VPC share the same DNS Firewall rules.

### Limitations

- **VPC-wide policy, not per-session** — All agent sessions share one VPC and DNS Firewall rule group. AgentCore Runtime has no per-session network configuration. Per-repo `egressAllowlist` entries are union-ed into the platform allowlist.
- **DNS-only** — DNS Firewall intercepts DNS queries. A direct connection to an IP address (e.g. `curl https://1.2.3.4/`) bypasses DNS and is not blocked. This is acceptable for the "confused agent" threat model (the agent uses domain names) but not for a sophisticated adversary.
- **Wildcard scope** — `*.amazonaws.com` is broad but necessary for VPC endpoint private DNS. GitHub wildcards (`*.githubusercontent.com`) include GitHub Pages, which is a potential exfiltration vector. Narrowing may be considered after analyzing query logs.
- **Missing ecosystems** — The platform baseline covers npm and PyPI. Go (`proxy.golang.org`), Rust (`crates.io`, `static.crates.io`), and OS packages (`dl-cdn.alpinelinux.org`) may need to be added based on observation mode logs.

## NAT Gateway removal tradeoffs

The NAT Gateway (~$32/month) exists because two categories of external services lack VPC endpoint equivalents: GitHub and package registries. Removing it would require replacing both:

1. **GitHub access** — Move git clone, push, and all GitHub API calls out of the agent container and into the orchestrator (Lambda, which has internet access). Alternatively, use a forward proxy in the public subnet or a PrivateLink partner integration. This changes the agent's execution model — the agent would no longer directly interact with git.
2. **Package registries** — Use [AWS CodeArtifact](https://docs.aws.amazon.com/codeartifact/) as a private npm/PyPI mirror. CodeArtifact has a VPC endpoint (`codeartifact.api` and `codeartifact.repositories`), so agent traffic stays on the private network. This adds operational overhead (upstream sync, storage costs) but removes the last internet dependency from the agent runtime.

If both are addressed, the agent runtime can run in `PRIVATE_ISOLATED` subnets with no NAT Gateway and no internet access at all. This is the strongest network isolation posture — the agent can only reach AWS services via VPC endpoints and has zero internet egress. The tradeoff is added complexity (proxy or orchestrator-mediated git, CodeArtifact mirrors) and the restriction that any new external dependency requires a VPC endpoint or proxy path.

## Cost Impact

Estimated monthly cost of the network and edge security layer (~$145-150/month):

| Resource | Estimated Cost |
|----------|---------------|
| NAT Gateway (1× fixed + data) | ~$32/month |
| Interface endpoints (7× $0.01/hr/AZ × 2 AZs) | ~$102/month |
| Flow logs (CloudWatch ingestion) | ~$3/month |
| DNS Firewall (queries) | <$1/month |
| DNS query log group (CloudWatch ingestion) | ~$1-3/month |
| WAFv2 Web ACL (3 rules + requests) | ~$6/month |

## Security Considerations

- **Defense in depth** — Multiple layers restrict egress: security group (HTTPS-only), DNS Firewall (domain allowlist with observation or enforcement mode), and VPC endpoints (AWS service traffic stays on-network). See the [DNS Firewall](#dns-firewall) section for details and limitations.
- **AWS service isolation** — VPC endpoints keep AWS API traffic on the AWS network, reducing exposure.
- **Audit trail** — Flow logs record IP-level network activity; DNS query logs record domain-level resolution activity. Together they provide comprehensive egress audit visibility.
- **Remaining gap** — DNS Firewall does not prevent direct IP-based connections. A connection to `https://1.2.3.4/` bypasses DNS resolution entirely. The security group still allows TCP 443 to `0.0.0.0/0`. This gap is acceptable for the "confused agent" threat model but not for a "sophisticated adversary" threat model. AWS Network Firewall (SNI-based filtering) would close this gap at significantly higher cost (~$274/month/endpoint).
- **Single NAT Gateway availability risk** — The NAT Gateway is deployed in a single AZ to minimize cost (~$32/month vs ~$64/month for two). If that AZ experiences an outage, all agent sessions lose internet egress (GitHub API access). For a platform where sessions run up to 8 hours, losing egress mid-session means the agent cannot push code or create PRs. **Mitigation options:** (a) Accept the risk for cost-sensitive deployments (single-developer or small-team usage). (b) Add a second NAT Gateway in the other AZ for production deployments — the additional ~$32/month is justified by the availability improvement. (c) Use a NAT instance (cheaper, but operational overhead). The `Blueprint` construct or stack props should allow configuring single vs. multi-AZ NAT (default: single for cost; opt-in to multi-AZ for production).
