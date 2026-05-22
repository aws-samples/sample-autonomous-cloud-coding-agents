# Vision

This document states the long-term direction of **ABCA (Autonomous Background Coding Agents on AWS)** and the **tenets** that should guide design, implementation, and review. Use it when evaluating pull requests, RFCs, and ADRs: if a change clearly advances the vision and respects the tenets, it belongs; if it trades tenets away without an explicit, documented rationale, it needs more discussion.

- **Use this doc for:** alignment checks in review — “does this fit where we are going?”
- **Not a substitute for:** [ARCHITECTURE.md](./ARCHITECTURE.md) (system shape), [ROADMAP.md](../guides/ROADMAP.md) (what ships when), or [docs/decisions/](../decisions/) (specific accepted choices).

## Vision

ABCA is a **reference sample** of a self-hosted **software dark factory** on AWS: a platform that accepts high-level engineering intent, runs autonomous coding work in isolated cloud environments, and returns **reviewable outcomes** (pull requests, review comments, validation evidence) under human governance — not a chat session that happens to edit files.

We are building toward **lights-sparse**, **graduated** autonomy (defined below): the default experience is **fire-and-forget** (submit, walk away, review the outcome), while the platform can **escalate to humans** when policy or risk requires it — without turning every task into a live pair-programming session. Customers should be able to **start conservative and loosen over time** (per repo, per policy, per task) as trust in outcomes grows. The platform’s job is to surround the agent with a **durable control plane** — admission, orchestration, memory, policy, HITL gates, cost limits, and observability — so that background agents are **reliable, bounded, and improvable** at organizational scale.

### What "lights-sparse" means

**Lights-sparse** is project vocabulary (not general industry jargon): it names the autonomy posture ABCA targets today, drawn from the **software dark factory** analogy in the [introduction](../src/content/docs/index.md).

- **Lights-out** (the analogy’s end state): humans set goals, policy, and constraints; production runs without people on the floor.
- **Lights-sparse** (where teams are now): the **implementation loop** — edit code, run tests, open pull requests — is increasingly **unattended**, while **governance, merge authority, and production release** stay **supervised**. Humans are not at the keyboard for every step; they are still accountable for what ships.

ABCA is built for that posture: asynchronous tasks, policy-gated escalation when risk requires a person, and a control plane that bounds blast radius and cost. The longer-term direction is **self-evolving** delivery (tenet 9): the platform learns from outcomes—memory, review feedback, evaluation—so repeat work gets cheaper and more reliable, not just one-off autonomous runs.

### What "graduated" means here

**Graduated** autonomy is not a single on/off switch: operators tighten or loosen gates over time (Cedar policies, `--pre-approve`, per-repo posture) without forking the deployment. See tenet 2 and [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md).

Success looks like teams that can **submit work and walk away**, trust that doomed work fails fast and cheaply, inspect every important decision in an audit trail, and see **measurable improvement** over time (fewer revision cycles, higher first-review merge rates, predictable cost).

## Tenets

Tenets are durable preferences. They can conflict; resolving conflict is a design choice that should be written down (ADR or RFC), not only embedded in code.

### 1. Fire-and-forget default; escalate when required

**The normal path is asynchronous and unattended** — submit a task, leave, and come back to a PR, review, or failure reason. Human involvement during a run is **by exception and policy-driven**, not the default way to “drive” the agent.

- Progress and outcomes surface through **status, events, and notifications** (GitHub comment, Slack, email) — the platform reaches the human; the human does not babysit a terminal.
- **Human-in-the-loop (HITL)** is how we escalate when autonomy must pause: Cedar **soft-deny** rules become approval gates; **hard-deny** rules still fail closed; **`--pre-approve`** scopes let trusted work proceed without repeated gates. See [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md) and [INTERACTIVE_AGENTS.md](./INTERACTIVE_AGENTS.md).
- Real-time steering (**nudge**, **watch**) is for **operator intervention**, not the primary product shape.
- **In review:** Do not conflate “background agent” with “no human ever.” Ask whether the change preserves fire-and-forget for the submitter while making escalation **reachable, attributable, and policy-gated** when risk warrants it.

### 2. Graduated autonomy — customers evolve with the platform

**The same deployment should support different autonomy postures** so teams can adopt incrementally: tight gates early, broader pre-approval and fewer interrupts later — without forking the platform.

- Autonomy is expressed through **configuration and policy** (Blueprint, Cedar policies, submit-time `--pre-approve`, per-repo overrides) — not hard-coded per customer in core orchestrator logic.
- A repo can run **fully gated** (many soft-deny rules, narrow pre-approve), **mostly autonomous** (`all_session` pre-approve with hard-deny still enforced), or anywhere between; platform maturity moves along the [ROADMAP.md](../guides/ROADMAP.md) scorecard, not a single global on/off switch.
- **Merge and release authority** stay human regardless of autonomy level; raising autonomy means fewer *in-run* interruptions, not unsupervised production promotion.
- **In review:** Prefer knobs that let operators tighten or loosen autonomy per repo/task; flag designs that lock everyone to one posture or that bypass policy to “make demos easier.”

### 3. Platform owns the control plane; agent owns reasoning

**Deterministic, cheap platform steps and expensive, flexible agent steps stay separated.**

- The orchestrator enforces invariants: admission, hydration, pre-flight, polling, finalization, concurrency, and terminal status — even when the agent crashes or misbehaves.
- The agent does not bypass platform policy (tokens, tool allowlists, budgets, Cedar gates).
- **In review:** Push non-LLM bookkeeping out of the agent runtime; push LLM-only work out of hot-path Lambdas unless there is a strong, documented reason.

### 4. Fail closed on risk; fail open only where safety allows

**When security, policy, or validation cannot be enforced, we stop or reject — we do not silently proceed with unscreened or unauthenticated input.**

- Pre-flight, guardrails, Cedar defaults, and auth failures reject work with clear reasons.
- Memory and other **learning subsystems** may fail open so a task still completes, but never at the expense of **exfiltration or cross-tenant leakage** — learning must not become a covert channel.
- **In review:** Treat “degrade to unauthenticated / unscreened / unbounded” as a red flag unless an ADR documents the threat model.

### 5. Isolation and least privilege are non-negotiable

**Every task gets a fresh, bounded blast radius: one session, scoped credentials, no shared agent state between tasks.**

- Compute is sandboxed; egress and tools are allowlisted; secrets never enter model context.
- Human **merge** remains outside the agent’s authority.
- **In review:** Question any change that widens tool surface, shares state across tasks, or merges orchestrator privileges into the agent without a security design update.

### 6. Cost and capacity are first-class

**Inference and compute dominate spend; the platform must meter, cap, and attribute them.**

- Per-task turns and USD budget, per-user concurrency, and efficient orchestration are product features, not ops afterthoughts.
- Expensive paths (extra model calls, redundant hydration, blocking polls) need justification.
- **In review:** Ask “what does this cost at 500 tasks/month?” and “what happens when the cap is hit?”

### 7. Observable, attributable, replayable

**Operators and reviewers must answer: what happened, why, with which prompt, model, policy, and memory?**

- Task lifecycle, tool use, guardrail blocks, and model invocations leave an audit-friendly trail.
- Prompt and policy versions are tied to runs so regressions can be diagnosed.
- **In review:** Favor changes that add structured events, spans, or version stamps over ad-hoc logging only visible in one runtime.

### 8. Extensible without forking the core

**Teams adopt ABCA by deploying and configuring (Blueprint, policies, channels), or by implementing swappable interfaces — not by patching the orchestrator for every repo.**

- Compute, memory, and optional steps plug in behind stable internal contracts.
- Per-repo behavior lives in configuration and repo-local agent guidance (`AGENTS.md`, rules), not hard-coded repo names in platform code.
- **In review:** Prefer construct/config extension over one-off conditionals; flag changes that would force every consumer to merge upstream for a single tenant.

### 9. Measurable improvement over time

**The platform should get better with use: memory, review feedback, and evaluation — not just execute one-off tasks.**

- Learnings are scoped, provenance-tracked, and subject to integrity and (roadmap) trust controls.
- Outcomes (merge, revision cycles, CI pass rate) are the feedback signal, not vanity task counts.
- **In review:** Connect features to learning or evaluation loops; avoid “write once, never read” memory paths.

### 10. Sample, not shrink-wrapped product

**ABCA is an AWS sample and reference architecture — experimental, fork-friendly, honest about gaps.**

- We document what is **roadmap** versus **shipped**; we do not imply production completeness we have not built.
- Breaking changes and operational burden are acceptable when they serve clarity for builders studying the pattern.
- **In review:** Avoid scope that turns the repo into a generic SaaS control plane; keep the narrative “deployable reference for dark-factory patterns on AWS.”

## How to use this in review

When reviewing a PR or RFC, walk through:

1. **Vision fit** — Does the change move an attribute of the dark factory (intake, isolation, orchestration, evaluation, memory, observability, metering, release governance) forward, or only add local convenience?
2. **Tenet tradeoffs** — Which tenets does it strengthen or weaken? If two tenets conflict, is the tradeoff explicit (ADR/RFC section)?
3. **Boundaries** — Does it keep merge authority, blast radius, and fail-closed behavior intact?
4. **Evidence** — Will operators still be able to attribute behavior after the change (events, tests, docs)?

A change can be valuable while only addressing one tenet; it should not **systematically** erode several tenets without a deliberate, recorded decision.

## Anti-goals

These are out of scope for the project vision. Proposals that primarily serve them should be rejected or redirected.

| Anti-goal | Why |
|-----------|-----|
| **In-IDE copilot replacement** | ABCA is background and repo-scoped, not latency-sensitive inline completion. |
| **Unsupervised production deploy** | Release authority stays human- and policy-gated; the agent opens PRs, it does not own production. |
| **Published construct library / stable public API** | Consumers deploy and fork the app; we do not optimize for npm-style versioning of internal interfaces. |
| **Single-tenant hard-coding** | One organization’s repos, channels, or policies should not become the default code path for everyone. |
| **Autonomy without attribution** | “The agent did something” without task id, prompt version, and trace is insufficient for this vision. |

## Relationship to other documents

| Document | Role |
|----------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Component design and design principles for the current system |
| [ROADMAP.md](../guides/ROADMAP.md) | Sequenced delivery and maturity scorecard |
| [SECURITY.md](./SECURITY.md) | Threat model and controls (tenets 4–5 in depth) |
| [CEDAR_HITL_GATES.md](./CEDAR_HITL_GATES.md) | HITL approval gates, pre-approve scopes, graduated in-run autonomy |
| [INTERACTIVE_AGENTS.md](./INTERACTIVE_AGENTS.md) | Async UX, watch/nudge, notification plane, approval state machine |
| [docs/decisions/](../decisions/) | Recorded choices when tenets conflict or ambiguity is resolved |
| [docs/src/content/docs/index.md](../src/content/docs/index.md) (synced intro) | Public-facing narrative including dark-factory attribute table |

When tenets and architecture principles overlap, **tenets win for review judgment**; **architecture and ADRs win for implementation detail** once a direction is chosen.
