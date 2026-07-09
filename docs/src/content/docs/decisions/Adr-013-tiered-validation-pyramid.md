---
title: Adr 013 tiered validation pyramid
---

# ADR-013: Tiered validation pyramid for agentic-first development

**Status:** proposed
**Date:** 2026-05-19

## Context

The current validation architecture has two operational tiers:

- **Pre-commit hooks** (< 5s) — formatting, secrets scan, file-level linting
- **Remote CI** (5–20 min) — full build, test, synth, security scans, deploy verification

The gap between these tiers is significant. When an agent (or human) makes a change that passes pre-commit but fails in CI, the feedback loop is:

```
Write code → commit → push → wait 5-20 min → CI fails →
  read failure → fix → commit → push → wait 5-20 min → ...
```

For a human, this is annoying. For an autonomous agent, this is catastrophic:

- **Compute waste** — the agent idles or context-switches while waiting for remote results
- **Context loss** — by the time CI reports back, the agent may have compacted context or moved on
- **Cascade failures** — in a stacked PR chain (ADR-001), a CI failure on PR 1 blocks PRs 2–N, multiplying the wait
- **Cost amplification** — each round-trip costs inference tokens for the agent to re-read the failure, re-analyze, and re-attempt

The root cause: there is no **Tier 2** — a local, fast, high-fidelity validation layer that catches integration-level issues *before* pushing to remote.

### What exists today

| Tier | Time | What it catches | Gap |
|------|------|-----------------|-----|
| Pre-commit (Tier 0) | < 5s | Formatting, secrets, trailing whitespace | None — works well |
| mise build (Tier 1) | 30–90s | Compile, unit tests, CDK synth, docs sync, linting | Wired as a pre-push gate (prek `pre-push` hooks run tests + security); the `mise run build` superset is available on demand |
| Remote CI (Tier 3) | 5–20 min | Full matrix, security, E2E, deploy | Authoritative but slow |
| **Local integration (Tier 2)** | — | **Does not exist** | Integration-level validation without remote round-trip |

### Agentic-first motivation

In a repo where agents run autonomously (ABCA's own design goal), validation speed directly determines:

- **Throughput** — an agent with 30s feedback loops delivers 10–20x more iterations per hour than one with 15-minute loops
- **Quality** — fast feedback enables test-driven approaches; slow feedback encourages "push and pray"
- **Cost** — fewer remote CI runs, fewer wasted inference tokens on retry cycles
- **Autonomy** — an agent that can self-validate locally needs fewer human interventions

## Decision

### The validation pyramid

```
                    ┌─────────┐
                    │ Tier 3  │  Remote CI (authoritative)
                    │ 5-20min │  Full matrix, deploy, E2E
                   ─┴─────────┴─
                  ┌─────────────┐
                  │   Tier 2    │  Local sandbox (high-fidelity)
                  │  1-5 min    │  Integration, ephemeral stack
                 ─┴─────────────┴─
                ┌─────────────────┐
                │     Tier 1      │  Local build (fast check)
                │    30-90s       │  Compile, unit test, synth
               ─┴─────────────────┴─
              ┌─────────────────────┐
              │       Tier 0        │  Pre-commit (gate)
              │       < 5s          │  Format, lint, secrets
              └─────────────────────┘
```

Each tier is **necessary but not sufficient** — passing a lower tier is required before attempting the next. Higher tiers never repeat work done by lower tiers.

### Tier definitions

**Tier 0 — Pre-commit (< 5s, gates every commit)**

- Trailing whitespace, end-of-file fix
- Merge conflict markers
- Secrets scan (gitleaks)
- ESLint (file-level, staged files only)
- Docs sync check (no stale mirrors)
- YAML/JSON syntax validation

Status: **Implemented** (prek hooks)

**Tier 1 — Local build (30–90s, gates push)**

- TypeScript compilation (all packages)
- Unit test suite (Jest)
- CDK synth (CloudFormation template generation)
- Agent quality checks (Python linting, type checking)
- Docs site build (astro check)
- Type sync drift (CDK ↔ CLI types in sync)
- Constants drift (cross-language contract check)

Status: **Implemented as a pre-push gate.** `.pre-commit-config.yaml` sets `default_install_hook_types: [pre-commit, pre-push]`, and the `monorepo-tests-pre-push` and `monorepo-security-pre-push` hooks (both `stages: [pre-push]`) run `mise run hooks:pre-push:tests` (→ `mise //cdk:test`, `mise //cli:test`, and the agent test suite) and `mise run hooks:pre-push:security` (→ `mise run security`) on every push. Note the shipped gate runs tests + security rather than the full `mise run build` superset (which additionally covers CDK synth, docs sync, and type/constants drift); those remain available on demand and are enforced authoritatively in Tier 3.

Remaining refinement: consider splitting into `mise run check:fast` (compile + lint, 30s) and `mise run check:full` (compile + test + synth, 90s), and folding synth/docs-sync/drift checks into the push gate for full Tier 1 coverage.

**Tier 2 — Local sandbox (1–5 min, on-demand before PR)**

This tier does not exist today. It should provide:

- Container-based integration tests against mocked AWS services (LocalStack or moto)
- CDK deploy to a local/ephemeral sandbox (validate IAM, resource creation without real cloud)
- Agent runtime smoke test (run the agent pipeline against a test repo in a local container)
- Cross-package integration (API → handler → agent contract verification)
- Policy validation (Cedar policy evaluation against test fixtures)

Status: **Gap — does not exist.** This is the primary investment needed.

Progressive build-out:

| Phase | Capability | Mechanism | Catches |
|-------|-----------|-----------|---------|
| 2a | Container integration tests | `mise run test:integration` → Docker Compose + LocalStack | AWS API call failures, DynamoDB schema issues, SQS message format |
| 2b | Agent pipeline smoke | `mise run test:agent-smoke` → build agent container, run against fixture repo | Agent crashes, tool failures, prompt regressions |
| 2c | Ephemeral stack deploy | `mise run deploy:ephemeral` → CDK deploy to a disposable environment with auto-destroy | IAM permission gaps (ADR-002 preflight), resource wiring, real API behavior |
| 2d | Full local sandbox | `mise run sandbox` → MicroVM matching prod topology | End-to-end flow in production-equivalent isolation |

**Tier 3 — Remote CI (5–20 min, authoritative, gates merge)**

- Full test matrix (multiple Node versions if applicable)
- Security scans (Semgrep SAST, OSV deps, Grype container, Retire.js, zizmor)
- CDK diff against deployed stack
- Multi-account deployment verification
- E2E tests against real AWS services
- Performance/cost regression checks
- Documentation mutation check (fail if Starlight mirrors are stale)

Status: **Implemented** (GitHub Actions). This remains the authoritative gate for merge.

> **Deployed runtime E2E — Phase 0 landed (issue #236).** `@aws-cdk/integ-tests-alpha` + `integ-runner` provide deploy-then-verify coverage: `mise //cdk:integ` deploys a trimmed Task API stack to a real account, asserts the create-and-persist happy path (task persists at `SUBMITTED`), then tears it down. In CI (`.github/workflows/integ.yml`) it is triggered per-PR via `workflow_run` only when the diff touches `cdk/**` or `agent/**` (docs/cli-only PRs get an immediate green skip), runs behind the reused `deploy` environment's admin-approval gate so it never assumes the deploy role unattended, and posts a required `integ-smoke` status that blocks merge. Because it is path-filtered and admin-gated it does not slow non-infra PRs. `workflow_dispatch` is retained for manual runs against `main`. Phase 1 (full lifecycle / real agent runs) and Phase 2 (channels) are follow-ups.

#### Residual risk acceptance — fork PR integ execution

The deployed E2E gate runs **fork-authored test code** (`cdk/test/integ/**`) against the shared AWS account. This is intentional: a fork `pull_request` job gets no secrets/OIDC, so the `workflow_run` trigger is the only way to give fork PRs the same deploy-verify coverage that branch PRs get. The accepted risk is that fork code executes with the shared `GitHub` deploy role (reused from `deploy.yml`), which is capable of CloudFormation operations in the shared account.

Mitigations layered against that risk:

- **Two human gates before fork code runs.** The `resolve` job requires a maintainer-applied `safe-to-test` label on fork PRs, and the `integ` job requires explicit approval of the `deploy` GitHub environment (required reviewers: `coding-agents-admin` / `coding-agents-maintainers`, self-review prevented). The approver MUST review `cdk/test/integ/**` changes before approving.
- **Environment reuse over a dedicated role.** Phase 0 reuses `deploy.yml`'s existing `deploy` environment and `GitHub` deploy role rather than provisioning a separate least-privilege role — the environment and its OIDC trust are already configured, so no account-side IAM change is needed to go live. The tradeoff is that integ (including approved fork code) runs with the full deploy role; the human gates above and forced teardown below are the compensating controls. Scoping a dedicated least-privilege integ role remains an option a maintainer can adopt later if the blast radius is judged too wide.
- **Status-only tokens and forced teardown.** Each job gets minimal `permissions`; the report path only posts commit statuses, and teardown runs `if: always()` with a fail-loud `wait` so a stranded stack surfaces rather than leaking billable resources.

Residual risk after these mitigations (a malicious fork PR that passes maintainer review and operates strictly within the scoped stacks) is **accepted** for Phase 0.

### Enforcement model

| Event | Required tier | Enforcement |
|-------|--------------|-------------|
| `git commit` | Tier 0 | Pre-commit hook (prek) |
| `git push` | Tier 1 | Pre-push hook |
| PR created/updated | Tier 3 | GitHub Actions required status checks |
| Agent self-validation (before PR) | Tier 1 + Tier 2 (when available) | Skill-driven (agent invokes `validate-locally`) |
| Merge | Tier 3 passed + reviewer approved | Branch protection |

### Agent interaction model

Agents interact with validation tiers through skills (depends on ADR-012 for the skill model):

```
Agent completes implementation
  → invokes `validate-locally` skill
    → skill runs Tier 1 (`mise run check:full`)
    → if Tier 2 available: runs Tier 2 (`mise run test:integration`)
    → reports: PASS (safe to push) / FAIL (fix before push, here's why)
  → agent fixes failures locally (fast loop)
  → pushes only when local validation passes
  → Tier 3 runs remotely (confirmatory, not exploratory)
```

The critical shift: **Tier 3 becomes confirmatory, not exploratory.** Agents should not discover failures in remote CI — they should confirm that locally-validated work passes the authoritative gate.

### Investment priority

The gap analysis dictates priority:

| Priority | Investment | Impact |
|----------|-----------|--------|
| P0 | ~~Enforce Tier 1 as pre-push gate~~ **(largely done)** — test + security push gate is wired (prek `pre-push` hooks); remaining work is folding synth/docs-sync/drift into the gate | Eliminates "pushed without building" class of CI failures |
| P1 | `mise run test:integration` (Tier 2a — LocalStack) | Eliminates 60%+ of CI-only failures (AWS API contract mismatches) |
| P2 | Agent smoke test (Tier 2b) | Catches agent runtime regressions before PR |
| P3 | Ephemeral stack deploy (Tier 2c) | Catches IAM/wiring issues that only surface in real deployment |
| P4 | Full local sandbox (Tier 2d) | Production-equivalent local validation (long-term target) |

### Design constraints

- **Tier 2 must not require cloud credentials for basic operation** — agents running in isolation (MicroVM, CI runner) need to validate without AWS access. LocalStack/moto fills this.
- **Tier 2 must be optional until stable** — a failing Tier 2 should warn, not block, during build-out. Once stable, it becomes a gate.
- **Tier 2 must be cacheable** — container images, LocalStack state, and fixture repos should be cached between runs. An agent shouldn't rebuild the world every time.
- **No tier should duplicate work from a lower tier** — if Tier 0 checks formatting, Tier 1 does not re-check it. If Tier 1 runs unit tests, Tier 3 does not re-run them (it may run *additional* tests but not the same ones).

### Escape hatches

| Situation | Allowed bypass |
|-----------|---------------|
| Hotfix with production down | Skip Tier 2, expedite Tier 3 review |
| Documentation-only change | Tier 0 + Tier 1 (synth not needed) |
| Dependency bump (Dependabot) | Tier 0 + Tier 3 (CI validates compatibility) |
| Agent cannot run Tier 2 (tooling unavailable) | Push with Tier 1 only, note in PR that Tier 2 was skipped |

Escape hatches must be explicit (noted in PR description, not silent).

## Consequences

- (+) Agent feedback loops drop from 15 minutes to 30–90 seconds for most issues
- (+) Remote CI failure rate drops — issues caught locally before push
- (+) Agents can self-validate autonomously without waiting for external systems
- (+) Investment is progressive — each tier delivers value independently
- (+) Clear ownership: Tier 0–2 are developer/agent responsibility; Tier 3 is platform responsibility
- (+) Cost reduction — fewer CI minutes wasted on obviously-broken pushes
- (-) Tier 2 infrastructure requires maintenance (LocalStack config, container images, fixtures)
- (-) Local machine requirements increase (Docker, disk space for containers)
- (-) Tier 2 may diverge from real AWS behavior — LocalStack is not 100% faithful
- (-) Pre-push gate adds 30–90s to every push (mitigation: `mise run check:fast` for safe paths)
- (!) LocalStack fidelity gaps must be documented — when Tier 2 passes but Tier 3 fails, document the divergence and add it to Tier 2's scope
- (!) Tier 2 "optional until stable" phase must have a defined graduation criteria, or it stays optional forever

## References

- Issue #149 — implementation tracking for this ADR
- ADR-002 — bootstrap policies (Tier 2c validates IAM preflight locally)
- ADR-008 — definition of done (tier requirements per DoD level)
- ADR-012 (prerequisite) — operational knowledge stack; this ADR depends on 012's skill model for agent interaction with validation tiers
- Current hooks: `.pre-commit-config.yaml` — the config file keeps the `pre-commit` name, but the runner is **prek** (pinned in `mise.toml` `[tools]`; `prek install --prepare-hooks` wires both `pre-commit` and `pre-push` stages). Implements Tier 0 (`pre-commit` stage) and the Tier 1 push gate (`pre-push` stage).
- Current build: `mise.toml` root + package-level configs (Tier 1 implementation)
- LocalStack: https://localstack.cloud (candidate for Tier 2a)
- Firecracker MicroVMs: https://firecracker-microvm.github.io (candidate for Tier 2d)
