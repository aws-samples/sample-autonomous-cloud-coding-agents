# Vision

This document states the long-term direction of **ABCA (Autonomous Background Coding Agents on AWS)** and the **tenets** that should guide design, implementation, and review. Use it when you evaluate pull requests, RFCs, and ADRs. If a change clearly advances the vision and respects the tenets, it belongs. If a change trades tenets away without an explicit, documented rationale, it needs more discussion.

- **Use this doc for:** alignment checks in review. Ask "does this fit where we are going?"
- **Not a substitute for:** [ARCHITECTURE.md](./ARCHITECTURE.md) (system shape), [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) (planned work and priorities), or [docs/decisions/](../decisions/) (specific accepted choices).

## Vision

ABCA is a **reference sample** of a self-hosted **software dark factory** on AWS. It is a platform that accepts high-level engineering intent, runs autonomous coding work in isolated cloud environments, and returns **reviewable outcomes** (pull requests, review comments, validation evidence) under human governance. It is not a chat session that happens to edit files.

We are building toward **lights-sparse**, **graduated** autonomy (both defined below). The default experience is **fire-and-forget**: submit, walk away, review the outcome. The platform can still escalate to humans when policy or risk requires it, without turning every task into a live pair-programming session. Customers should be able to start conservative and loosen over time (per repo, per policy, per task) as trust in outcomes grows. The platform's job is to surround the agent with a **durable control plane**, so that background agents are reliable, bounded, and improvable at organizational scale. The control plane covers admission, orchestration, memory, policy, HITL gates, cost limits, and observability.

### What "lights-sparse" means

**Lights-sparse** is project vocabulary, not general industry jargon. It names the autonomy posture that ABCA targets today, and it comes from the software dark factory analogy in the [introduction](../src/content/docs/index.md).

- **Lights-out** (the end state of the analogy). Humans set goals, policy, and constraints. Production runs without people on the floor.
- **Lights-sparse** (where teams are now). The implementation loop of editing code, running tests, and opening pull requests is increasingly unattended, while governance, merge authority, and production release stay supervised. Humans are not at the keyboard for every step. They are still accountable for what ships.

ABCA is built for that posture, with asynchronous tasks, policy-gated escalation when risk requires a person, and a control plane that bounds blast radius and cost. The longer-term direction is **self-evolving** delivery (tenet 9). The platform learns from outcomes through memory, review feedback, and evaluation, so that repeat work gets cheaper and more reliable. The aim is more than one-off autonomous runs.

### What "graduated" means here

**Graduated** autonomy is not a single on/off switch. Operators tighten or loosen gates over time (Cedar policies, `--pre-approve`, per-repo posture) without forking the deployment. See tenet 2 and [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md).

Success means that teams can submit work and walk away, trust that doomed work fails fast and cheaply, inspect every important decision in an audit trail, and see measurable improvement over time (fewer revision cycles, higher first-review merge rates, predictable cost).

## Tenets

Tenets are durable preferences. They can conflict. Resolving a conflict is a design choice that should be written down in an ADR or RFC, not only embedded in code.

### 1. Fire-and-forget default; escalate when required

**The normal path is asynchronous and unattended.** Submit a task, leave, and come back to a PR, a review, or a failure reason. Human involvement during a run is by exception and policy-driven. It is not the default way to "drive" the agent.

- Progress and outcomes reach the human through status, events, and notifications (GitHub comment, Slack, email). The platform reaches the human. The human does not watch a terminal.
- **Human-in-the-loop (HITL)** is how we escalate when autonomy must pause. Cedar soft-deny rules become approval gates. Hard-deny rules still fail closed. `--pre-approve` scopes let trusted work proceed without repeated gates. See [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md) and [INTERACTIVE_AGENTS.md](./INTERACTIVE_AGENTS.md).
- Real-time steering (nudge, watch) is for operator intervention. It is not the primary product shape.
- **In review.** Do not conflate "background agent" with "no human ever." Ask whether the change preserves fire-and-forget for the submitter and makes escalation reachable, attributable, and policy-gated when risk warrants it.

### 2. Graduated autonomy — customers evolve with the platform

**The same deployment should support different autonomy postures**, so that teams can adopt incrementally without forking the platform. Early on, the gates are tight. Later, pre-approval is broader and interrupts are fewer.

- Autonomy is expressed through configuration and policy (Blueprint, Cedar policies, submit-time `--pre-approve`, per-repo overrides). It is not hard-coded per customer in core orchestrator logic.
- A repo can run **fully gated** (many soft-deny rules, narrow pre-approve), **mostly autonomous** (`all_session` pre-approve with hard-deny still enforced), or anywhere between. Platform maturity is tracked through [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) with priority labels such as `P0` and `P1`, not through a single global on/off switch.
- **Merge and release authority** stay human regardless of autonomy level. Raising autonomy means fewer *in-run* interruptions, not unsupervised production promotion.
- **In review.** Prefer settings that let operators tighten or loosen autonomy per repo or per task. Flag designs that lock everyone to one posture or that bypass policy to "make demos easier."

### 3. Platform owns the control plane; agent owns reasoning

**Deterministic, cheap platform steps and expensive, flexible agent steps stay separated.**

- The orchestrator enforces invariants: admission, hydration, pre-flight, polling, finalization, concurrency, and terminal status. It enforces them even when the agent crashes or misbehaves.
- The agent does not bypass platform policy (tokens, tool allowlists, budgets, Cedar gates).
- **In review.** Move non-LLM bookkeeping out of the agent runtime. Move LLM-only work out of hot-path Lambdas unless there is a strong, documented reason.

### 4. Fail closed on risk; fail open only where safety allows

**When security, policy, or validation cannot be enforced, we stop or reject. We do not silently proceed with unscreened or unauthenticated input.**

- Pre-flight, guardrails, Cedar defaults, and auth failures reject work with clear reasons.
- Memory and other learning subsystems may fail open so that a task still completes, but never at the cost of exfiltration or cross-tenant leakage. Learning must not become a covert channel.
- **In review.** Treat "degrade to unauthenticated / unscreened / unbounded" as a warning sign unless an ADR documents the threat model.

### 5. Isolation and least privilege are non-negotiable

**Every task gets a fresh, bounded blast radius: one session, scoped credentials, no shared agent state between tasks.**

- Compute is sandboxed. Egress and tools are allowlisted. Secrets never enter model context.
- Human merge remains outside the agent's authority.
- **In review.** Question any change that widens the set of tools, shares state across tasks, or merges orchestrator privileges into the agent without a security design update.

### 6. Cost and capacity are first-class

**Inference and compute dominate spend. The platform must meter, cap, and attribute them.**

- Per-task turns and USD budget, per-user concurrency, and efficient orchestration are product features, not ops afterthoughts.
- Expensive paths (extra model calls, redundant hydration, blocking polls) need justification.
- **In review.** Ask "what does this cost at 500 tasks/month?" and "what happens when the cap is hit?"

### 7. Observable, attributable, replayable

**Operators and reviewers must be able to answer what happened, why, and with which prompt, model, policy, and memory.**

- Task lifecycle, tool use, guardrail blocks, and model invocations leave an audit-friendly trail.
- Prompt and policy versions are tied to runs so that regressions can be diagnosed.
- **In review.** Favor changes that add structured events, spans, or version stamps over ad-hoc logging that is visible in only one runtime.

### 8. Extensible without forking the core

**Teams adopt ABCA by deploying and configuring it (Blueprint, policies, channels), or by implementing swappable interfaces. They do not patch the orchestrator for every repo.**

- Compute, memory, and optional steps plug in behind stable internal contracts.
- Per-repo behavior lives in configuration and repo-local agent guidance (`AGENTS.md`, rules), not in hard-coded repo names in platform code.
- **In review.** Prefer extension through constructs and config over one-off conditionals. Flag changes that would force every consumer to merge upstream for a single tenant.

### 9. Measurable improvement over time

**The platform should get better with use, through memory, review feedback, and evaluation. It should not only execute one-off tasks.**

- Learnings are scoped, provenance-tracked, and subject to integrity controls and to planned trust controls.
- Outcomes (merge, revision cycles, CI pass rate) are the feedback signal, not vanity task counts.
- **In review.** Connect features to learning or evaluation loops. Avoid "write once, never read" memory paths.

### 10. Sample, not shrink-wrapped product

**ABCA is an AWS sample and reference architecture. It is experimental, fork-friendly, and honest about gaps.**

- We document what is **planned** versus **shipped**. We do not imply production completeness that we have not built.
- Breaking changes and operational burden are acceptable when they serve clarity for builders who study the pattern.
- **In review.** Avoid scope that turns the repo into a generic SaaS control plane. Keep the narrative "deployable reference for dark-factory patterns on AWS."

## How to use this in review

When you review a PR or RFC, walk through these questions:

1. **Vision fit.** Does the change move an attribute of the dark factory (intake, isolation, orchestration, evaluation, memory, observability, metering, release governance) forward, or only add local convenience?
2. **Tenet tradeoffs.** Which tenets does it strengthen or weaken? If two tenets conflict, is the tradeoff explicit (in an ADR or RFC section)?
3. **Boundaries.** Does it keep merge authority, blast radius, and fail-closed behavior intact?
4. **Evidence.** Will operators still be able to attribute behavior after the change (events, tests, docs)?

A change can be valuable when it addresses only one tenet. It should not systematically erode several tenets without a deliberate, recorded decision.

## Anti-goals

The following anti-goals are out of scope for the project vision. Reject or redirect proposals that primarily serve them.

| Anti-goal | Why |
|-----------|-----|
| **In-IDE copilot replacement** | ABCA is background and repo-scoped, not latency-sensitive inline completion. |
| **Unsupervised production deploy** | Release authority stays human- and policy-gated. The agent opens PRs. It does not own production. |
| **Published construct library or stable public API** | Consumers deploy and fork the app. We do not optimize for npm-style versioning of internal interfaces. |
| **Single-tenant hard-coding** | One organization's repos, channels, or policies should not become the default code path for everyone. |
| **Autonomy without attribution** | "The agent did something" without task id, prompt version, and trace is insufficient for this vision. |

## Relationship to other documents

| Document | Role |
|----------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Component design and design principles for the current system |
| [GitHub issues](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) | Planned work, priorities (such as `P0` and `P1`), and maturity tracking |
| [SECURITY.md](./SECURITY.md) | Threat model and controls (tenets 4 and 5 in depth) |
| [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md) | HITL approval gates, pre-approve scopes, graduated in-run autonomy |
| [INTERACTIVE_AGENTS.md](./INTERACTIVE_AGENTS.md) | Async UX, watch and nudge, notification plane, approval state machine |
| [docs/decisions/](../decisions/) | Recorded choices when tenets conflict or ambiguity is resolved |
| [docs/src/content/docs/index.md](../src/content/docs/index.md) (synced intro) | Public-facing narrative, including the dark-factory attribute table |

When tenets and architecture principles overlap, **tenets win for review judgment**. **Architecture and ADRs win for implementation detail** once a direction is chosen.
