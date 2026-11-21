---
title: "ADR-013: Tiered validation pyramid for agentic-first development"
---

**Status:** proposed
**Date:** 2026-05-19
**Last-updated:** 2026-11-20

## Context

The current validation architecture has two operational tiers:

- **Pre-commit hooks** — formatting, secrets scan, and the lint and drift checks of the staged files
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

The root cause: there is no **Tier 2** — a local, fast, high-fidelity validation layer that catches integration-level issues *before* pushing to remote. (Phase 2a of it now exists; see the table below.)

### What exists today

| Tier | Time | What it catches | Gap |
|------|------|-----------------|-----|
| Pre-commit (Tier 0) | No fixed budget: by what is staged (measured times under Tier 0 below) | Formatting, secrets, lint and drift checks of the staged files | None — works well |
| mise build (Tier 1) | 30–90s | Compile, unit tests, CDK synth, docs sync, linting | Wired as a pre-push gate (prek `pre-push` hooks run tests + security); the `mise run build` superset is available on demand |
| Remote CI (Tier 3) | 5–20 min | Full matrix, security, E2E, deploy | Authoritative but slow |
| **Local integration (Tier 2)** | About half a minute for phase 2a, on a laptop | Phase 2a only: how real handler, CLI and agent code behaves against emulated DynamoDB, S3, Secrets Manager, Cognito, STS and CloudWatch Logs | Phase 2a is an advisory check, not a required one; phases 2b–2d do not exist |

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
              │  by what is staged  │  Format, lint, secrets
              └─────────────────────┘
```

Each tier is **necessary but not sufficient** — passing a lower tier is required before attempting the next. Higher tiers never repeat work done by lower tiers.

### Tier definitions

**Tier 0 — Pre-commit (gates every commit)**

- Trailing whitespace, end-of-file fix
- Merge conflict markers
- Secrets scan (gitleaks)
- ESLint for cdk, cli and web, each when one of its source files is staged
- Type check (`tsc --noEmit`) of cdk, cli and web, each when one of its TypeScript files is staged
- Agent quality task, when a Python file under `agent/` is staged
- Docs sync and `astro check`, the Markdown structure lint when a Markdown file is staged, and the docs script tests when the docs scripts are staged
- Drift checks for API types and shared constants when one of their inputs is staged, and the coverage contract check on every commit
- YAML/JSON syntax validation

Status: **Implemented** (prek hooks). A commit runs the hooks that match what is staged, so there is no single duration. Measured when the newer hooks were added: the coverage contract check takes about 1 s on every commit, the Markdown structure lint about 3 s on a commit with Markdown, and web ESLint 6 to 13 s on a commit with web sources. The type checks take about 9 s (cdk), 5 s (cli) and 2 s (web) on a commit with TypeScript files of that package.

**Tier 1 — Local build (30–90s, gates push)**

- TypeScript compilation (all packages)
- Unit test suite (Jest)
- CDK synth (CloudFormation template generation)
- Agent quality checks (Python linting, type checking)
- Docs site build (astro check)
- Type sync drift (CDK ↔ CLI types in sync)
- Constants drift (cross-language contract check)

Status: **Implemented as a pre-push gate.** `.pre-commit-config.yaml` sets `default_install_hook_types: [pre-commit, pre-push]`, and the `monorepo-tests-pre-push` and `monorepo-security-pre-push` hooks (both `stages: [pre-push]`) run `mise run hooks:pre-push:tests` (→ `mise //cdk:test`, `mise //cli:test`, `mise //web:test`, and the agent test suite) and `mise run hooks:pre-push:security` (→ `mise run security`) on every push. Note the shipped gate runs tests + security rather than the full `mise run build` superset (which additionally covers CDK synth, docs sync, and type/constants drift); those remain available on demand and are enforced authoritatively in Tier 3.

`mise run check:fast` runs the `lint` and `drift-prevention` tasks (lint, type checks, the agent's dead-code check, drift and file-hygiene checks; no test run; measured at about 30 s on a laptop). It is run on demand: the push gate does not use it. Remaining refinement: consider `mise run check:full` (compile + test + synth, 90s), and folding synth/docs-sync/drift checks into the push gate for full Tier 1 coverage.

**Tier 2 — Local sandbox (1–5 min, on-demand before PR)**

Phase 2a exists; the rest of this tier does not. It should provide:

- Container-based integration tests against emulated AWS services (phase 2a uses the AWS Emulator; LocalStack and moto were the candidates when this ADR was written)
- CDK deploy to an ephemeral sandbox (validate IAM and resource creation). This part needs a real AWS account: the emulator does not evaluate IAM the way AWS does, and a missing `Allow` never fails a deployment there
- Agent runtime smoke test (run the agent pipeline against a test repo in a local container)
- Cross-package integration (API → handler → agent contract verification)
- Policy validation (Cedar policy evaluation against test fixtures)

Status: **Phase 2a implemented as an advisory check; phases 2b–2d are a gap.** `mise run test:integration` starts a pinned AWS Emulator in a container and runs ABCA's real handler, CLI and agent code against it, with no AWS account. The `emulator` workflow runs it on every pull request and is not a required check. ABCA's own agents cannot run it inside their container yet: the agent image has no Docker. What a green run shows and does not show, and the rules for tests in this tier, are in `scripts/aws-emulator/README.md`.

Progressive build-out:

| Phase | Capability | Mechanism | Catches |
|-------|-----------|-----------|---------|
| 2a | Container integration tests | `mise run test:integration` → the AWS Emulator in a container, version pinned in `scripts/aws-emulator/Dockerfile` | DynamoDB conditions, update expressions, transactions, index keys and `Limit` applied before a filter; S3 object and presigned GET behavior; Secrets Manager, Cognito sign-in, STS `AssumeRole` and CloudWatch Logs behavior; state shared between the Python agent and the TypeScript handlers. Not permissions, deployment or the AgentCore runtime |
| 2b | Agent pipeline smoke | `mise run test:agent-smoke` → build agent container, run against fixture repo | Agent crashes, tool failures, prompt regressions |
| 2c | Ephemeral stack deploy | `mise run deploy:ephemeral` → CDK deploy to a disposable environment in a real AWS account, with auto-destroy (not the emulator, which cannot show a missing permission) | IAM permission gaps (ADR-002 preflight), resource wiring, real API behavior |
| 2d | Full local sandbox | `mise run sandbox` → MicroVM matching prod topology | End-to-end flow in production-equivalent isolation |

**Tier 3 — Remote CI (5–20 min, authoritative, gates merge)**

- Full test matrix (multiple Node versions if applicable)
- Security scans. The required job `Secrets, deps, and workflow scan` (`.github/workflows/security-pr.yml`) runs on every pull request and merge-queue entry: gitleaks over the commits of the change, the silent-success-masking rules over the whole repository, the Semgrep registry packs for the findings the change adds, OSV deps and zizmor, and it builds the agent image when `agent/Dockerfile`, `.dockerignore` or a file the Dockerfile copies by name (`agent/pyproject.toml`, `agent/uv.lock`, `agent/prepare-commit-msg.sh`, `agent/managed-settings.json`) changed, or when a file under a directory it copies whole (`agent/src`, `agent/policies`, `agent/workflows`, `contracts`) was deleted or renamed. The weekly suite (`.github/workflows/security.yml`) runs every scanner even when an earlier one fails, adds the full Semgrep SAST, Grype, Retire.js, Bandit and the Trivy image scan, and reports to one rolling issue
- CDK diff against deployed stack
- Multi-account deployment verification
- E2E tests against real AWS services
- Performance/cost regression checks
- Documentation mutation check (fail if Starlight mirrors are stale)
- The Tier 0 file checks (whitespace, end of file, conflict markers, YAML/JSON syntax) over all tracked files (`mise run check:hygiene`, part of `mise run build`): a commit made without the hooks skips Tier 0

Status: **Implemented** (GitHub Actions). This remains the authoritative gate for merge.

> **Deployed runtime E2E — Phase 0 landed (issue #236).** `@aws-cdk/integ-tests-alpha` + `integ-runner` provide deploy-then-verify coverage: `mise //cdk:integ` deploys a trimmed Task API stack to a real account, asserts the create-and-persist happy path (task persists at `SUBMITTED`), then tears it down. In CI (`.github/workflows/integ.yml`) it is triggered per-PR via `workflow_run` only when the diff touches `cdk/**` or `agent/**` (docs/cli-only PRs get an immediate green skip), runs behind the reused `deploy` environment's admin-approval gate so it never assumes the deploy role unattended, and posts an `integ-smoke` status that is not required: the ruleset for `main` requires only `build (agentcore)` and `Secrets, deps, and workflow scan`, so the status informs reviewers and does not block merge. Because it is path-filtered and admin-gated it does not slow non-infra PRs. `workflow_dispatch` is retained for manual runs against `main`. Phase 1 (full lifecycle / real agent runs) and Phase 2 (channels) are follow-ups.

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

Agents interact with validation tiers through skills (depends on ADR-012 for the skill model). The `validate-locally` skill and `mise run check:full` in the flow below are proposed here and do not exist yet; `mise run test:integration` exists (phase 2a):

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
| P1 | ~~`mise run test:integration` (Tier 2a)~~ **(done as an advisory check)** — built on the AWS Emulator; remaining work is graduation to a required check (criteria under Design constraints) | Catches data-plane defects and defects in state shared between the agent and the handlers without a deployment: about one in twelve (10 of 120) of the recorded defects that passed unit tests and were found on a deployed stack. More than half of those 120 need real AWS and still do. It does not reduce CI-only failures: `build.yml` makes no AWS call |
| P2 | Agent smoke test (Tier 2b) | Catches agent runtime regressions before PR |
| P3 | Ephemeral stack deploy (Tier 2c) | Catches IAM/wiring issues that only surface in real deployment |
| P4 | Full local sandbox (Tier 2d) | Production-equivalent local validation (long-term target) |

### Design constraints

- **Tier 2 must not require cloud credentials for basic operation** — agents running in isolation (MicroVM, CI runner) need to validate without AWS access. For phase 2a the AWS Emulator fills this: it needs Docker and no AWS account. Phase 2c is the exception and needs a real account.
- **Tier 2 must be optional until stable** — a failing Tier 2 should warn, not block, during build-out. Once stable, it becomes a gate. For phase 2a, stable means, measured over 30 days: every red run triaged; none of the last 100 pull-request and merge-queue runs red because of the emulator or the runner; p95 job duration under 5 minutes; at least one test per service in scope; the emulator pin never more than 14 days behind upstream. Then the job is added to the required checks of the `main` ruleset.
- **Tier 2 must be cacheable** — container images and fixture repos should be cached between runs (emulated state is in memory and is discarded on purpose). An agent shouldn't rebuild the world every time.
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
- (-) Pre-push gate adds 30–90s to every push (proposed mitigation: `mise run check:fast` alone for safe paths)
- (!) LocalStack fidelity gaps must be documented — when Tier 2 passes but Tier 3 fails, document the divergence and add it to Tier 2's scope
- (!) Tier 2 "optional until stable" phase must have a defined graduation criteria, or it stays optional forever
- (!) Phase 2a was built on the AWS Emulator, not LocalStack: the three LocalStack consequences above apply to it as written. Its known differences from AWS are kept in `scripts/aws-emulator/README.md`, and the graduation criteria asked for above are under Design constraints

## References

- Issue #149 — implementation tracking for this ADR
- ADR-002 — bootstrap policies (Tier 2c validates the IAM preflight before a pull request, in a real AWS account)
- ADR-008 — definition of done (tier requirements per DoD level)
- ADR-012 (prerequisite) — operational knowledge stack; this ADR depends on 012's skill model for agent interaction with validation tiers
- Current hooks: `.pre-commit-config.yaml` — the config file keeps the `pre-commit` name, but the runner is **prek** (pinned in `mise.toml` `[tools]`; `prek install --prepare-hooks` wires both `pre-commit` and `pre-push` stages). Implements Tier 0 (`pre-commit` stage) and the Tier 1 push gate (`pre-push` stage).
- Current build: `mise.toml` root + package-level configs (Tier 1 implementation)
- AWS Emulator: https://github.com/aws/aws-emulator (adopted for Tier 2a; the version is pinned in `scripts/aws-emulator/Dockerfile`)
- LocalStack: https://localstack.cloud (the candidate for Tier 2a when this ADR was written; not adopted, and not evaluated in depth)
- `docs/research/aws-emulator-local-tests.md` — the investigation behind phase 2a: what was built and measured, and what was not verified
- Firecracker MicroVMs: https://firecracker-microvm.github.io (candidate for Tier 2d)

## Changelog

- 2026-11-15 — Phase 2a is implemented, on the AWS Emulator instead of LocalStack, as an advisory check (`mise run test:integration` and the `emulator` workflow). Replaced the estimate that it would eliminate "60%+ of CI-only failures" with what was measured, added the graduation criteria this ADR asks for, and stated that phase 2c needs a real AWS account because the emulator cannot show a missing permission (decision otherwise unchanged).
- 2026-11-20 — Tier 0 also runs the type check of cdk, cli and web when one of their TypeScript files is staged (#260). The build runs the same checks and stays the gate (decision unchanged).
