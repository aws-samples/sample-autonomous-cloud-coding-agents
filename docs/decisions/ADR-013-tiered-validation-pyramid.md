# ADR-013: Tiered validation pyramid for agentic-first development

**Status:** proposed
**Date:** 2026-05-19
**Last-updated:** 2026-11-24

## Context

The current validation architecture has two operational tiers:

- **Pre-commit hooks.** Formatting, secrets scan, and the lint and drift checks of the staged files.
- **Remote CI (5 to 20 min).** Full build, test, synth, security scans, and deploy verification (CI no longer deploys, as the note under Tier 3 explains).

The gap between these two tiers is large. When an agent (or human) makes a change that passes pre-commit but fails in CI, the feedback loop is:

```
Write code → commit → push → wait 5-20 min → CI fails →
  read failure → fix → commit → push → wait 5-20 min → ...
```

For a human, this loop is annoying. For an autonomous agent, it is catastrophic:

- **Compute waste.** The agent idles or context-switches while it waits for remote results.
- **Context loss.** By the time CI reports back, the agent may have compacted context or moved on.
- **Cascade failures.** In a stacked PR chain (ADR-001), a CI failure on PR 1 blocks PRs 2 to N, which multiplies the wait.
- **Cost amplification.** Each round-trip costs inference tokens for the agent to re-read the failure, re-analyze, and re-attempt.

The root cause is that there is no **Tier 2**, a local, fast, high-fidelity validation layer that catches integration-level issues *before* a push to the remote. (Phase 2a of Tier 2 now exists, as the table below shows.)

### What exists today

| Tier | Time | What it catches | Gap |
|------|------|-----------------|-----|
| Pre-commit (Tier 0) | No fixed budget: by what is staged (measured times under Tier 0 below) | Formatting, secrets, lint and drift checks of the staged files | None. Works well |
| mise build (Tier 1) | 30–90s | Compile, unit tests, CDK synth, docs sync, linting | Wired as a pre-push gate (prek `pre-push` hooks run tests + security). The `mise run build` superset is available on demand |
| Remote CI (Tier 3) | 5–20 min | The full build (lint, type checks, tests, synth, docs) and the security scans. The Tier 2a tests as an advisory check | Authoritative but slow. Makes no AWS call, so nothing is deployed or verified in a real account |
| **Local integration (Tier 2)** | About half a minute for phase 2a, on a laptop | Phase 2a only: how real handler, CLI and agent code behaves against emulated DynamoDB, S3, Secrets Manager, Cognito, STS and CloudWatch Logs | Phase 2a is an advisory check, not a required one. Phases 2b to 2d do not exist |

### Agentic-first motivation

In a repo where agents run autonomously (ABCA's own design goal), validation speed determines four things:

- **Throughput.** An agent with 30s feedback loops delivers 10 to 20x more iterations per hour than one with 15-minute loops.
- **Quality.** Fast feedback enables test-driven approaches. Slow feedback encourages "push and pray".
- **Cost.** Fewer remote CI runs, and fewer inference tokens wasted on retry cycles.
- **Autonomy.** An agent that can self-validate locally needs fewer human interventions.

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

Each tier is **necessary but not sufficient**. A change must pass a lower tier before it attempts the next. Higher tiers never repeat work done by lower tiers.

### Tier definitions

**Tier 0, Pre-commit (gates every commit)**

- Trailing whitespace, end-of-file fix
- Merge conflict markers
- Secrets scan (gitleaks)
- ESLint for cdk, cli and web, each when one of its source files is staged
- Type check (`tsc --noEmit`) of cdk, cli and web, each when one of its TypeScript files is staged
- Agent quality task, when a Python file under `agent/` is staged
- Shell script lint (shellcheck), when a `*.sh` file is staged
- Docs sync and `astro check`, the Markdown structure lint when a Markdown file is staged, and the docs script tests when the docs scripts are staged
- Drift checks for API types and shared constants when one of their inputs is staged, and the coverage contract check on every commit
- YAML and JSON syntax validation

Status: **Implemented** (prek hooks). A commit runs the hooks that match what is staged, so there is no single duration. Measured when the newer hooks were added, the coverage contract check takes about 1 s on every commit, the Markdown structure lint about 3 s on a commit with Markdown, and web ESLint 6 to 13 s on a commit with web sources. The type checks take about 9 s (cdk), 5 s (cli) and 2 s (web) on a commit with TypeScript files of that package.

**Tier 1, Local build (30 to 90s, gates push)**

- TypeScript compilation (all packages)
- Unit test suite (Jest)
- CDK synth (CloudFormation template generation)
- Agent quality checks (Python linting, type checking)
- Docs site build (astro check)
- Type sync drift (CDK and CLI types in sync)
- Constants drift (cross-language contract check)

Status: **Implemented as a pre-push gate.** `.pre-commit-config.yaml` sets `default_install_hook_types: [pre-commit, pre-push]`. On every push, the `monorepo-tests-pre-push` and `monorepo-security-pre-push` hooks (both `stages: [pre-push]`) run two tasks. `mise run hooks:pre-push:tests` runs `mise //cdk:test`, `mise //cli:test`, `mise //web:test`, and the agent test suite. `mise run hooks:pre-push:security` runs `mise run security`. The shipped gate runs tests + security, not the full `mise run build` superset, which also covers CDK synth, docs sync, and type and constants drift. Those checks remain available on demand, and Tier 3 enforces them authoritatively.

`mise run check:fast` runs the `lint` and `drift-prevention` tasks: lint, type checks, the agent's dead-code check, and the drift and file-hygiene checks. It runs no tests, and it was measured at about 30 s on a laptop. It is run on demand. The push gate does not use it. Two refinements remain to consider: `mise run check:full` (compile + test + synth, 90s), and folding the synth, docs-sync, and drift checks into the push gate for full Tier 1 coverage.

**Tier 2, Local sandbox (1 to 5 min, on-demand before PR)**

Phase 2a exists. The rest of this tier does not. The tier should provide:

- Container-based integration tests against emulated AWS services (phase 2a uses the AWS Emulator, and LocalStack and moto were the candidates when this ADR was written)
- CDK deploy to an ephemeral sandbox (validate IAM and resource creation). This part needs a real AWS account, because the emulator does not evaluate IAM the way AWS does, and a missing `Allow` never fails a deployment there
- Agent runtime smoke test (run the agent pipeline against a test repo in a local container)
- Cross-package integration (contract verification from API to handler to agent)
- Policy validation (Cedar policy evaluation against test fixtures)

Status: **Phase 2a implemented as an advisory check. Phases 2b to 2d are a gap.** `mise run test:integration` starts a pinned AWS Emulator in a container and runs ABCA's real handler, CLI and agent code against it, with no AWS account. The `emulator` workflow runs it on every pull request and is not a required check. ABCA's own agents cannot run it inside their container yet, because the agent image has no Docker. What a green run shows and does not show, and the rules for tests in this tier, are in `scripts/aws-emulator/README.md`.

Progressive build-out:

| Phase | Capability | Mechanism | Catches |
|-------|-----------|-----------|---------|
| 2a | Container integration tests | `mise run test:integration` → the AWS Emulator in a container, version pinned in `scripts/aws-emulator/Dockerfile` | DynamoDB conditions, update expressions, transactions, index keys and `Limit` applied before a filter; S3 object and presigned GET behavior; Secrets Manager, Cognito sign-in, STS `AssumeRole` and CloudWatch Logs behavior; state shared between the Python agent and the TypeScript handlers. Not permissions, deployment or the AgentCore runtime |
| 2b | Agent pipeline smoke | `mise run test:agent-smoke` → build agent container, run against fixture repo | Agent crashes, tool failures, prompt regressions |
| 2c | Ephemeral stack deploy | `mise run deploy:ephemeral` → CDK deploy to a disposable environment in a real AWS account, with auto-destroy (not the emulator, which cannot show a missing permission) | IAM permission gaps (ADR-002 preflight), resource wiring, real API behavior |
| 2d | Full local sandbox | `mise run sandbox` → MicroVM matching prod topology | End-to-end flow in production-equivalent isolation |

**Tier 3, Remote CI (5 to 20 min, authoritative, gates merge)**

- Full test matrix (multiple Node versions if applicable)
- Security scans. The required job `Secrets, deps, and workflow scan` (`.github/workflows/security-pr.yml`) runs on every pull request and merge-queue entry. It runs gitleaks over the commits of the change, the silent-success-masking rules over the whole repository, the Semgrep registry packs for the findings the change adds, OSV deps and zizmor. It builds the agent image when `agent/Dockerfile`, `.dockerignore` or a file the Dockerfile copies by name (`agent/pyproject.toml`, `agent/uv.lock`, `agent/prepare-commit-msg.sh`, `agent/managed-settings.json`) changed, or when a file under a directory it copies whole (`agent/src`, `agent/policies`, `agent/workflows`, `contracts`) was deleted or renamed. The weekly suite (`.github/workflows/security.yml`) runs every scanner even when an earlier one fails, adds the full Semgrep SAST, Grype, Retire.js, shellcheck (which the build also runs), Bandit and the Trivy image scan, and reports to one rolling issue
- CDK diff against deployed stack
- Multi-account deployment verification
- E2E tests against real AWS services
- Performance/cost regression checks
- Documentation mutation check (fail if Starlight mirrors are stale)
- The Tier 0 file checks (whitespace, end of file, conflict markers, YAML and JSON syntax) over all tracked files (`mise run check:hygiene`, part of `mise run build`) and shellcheck over every shell script (`mise run check:shell`, also part of `mise run build`), because a commit made without the hooks skips Tier 0

Status: **Implemented** (GitHub Actions), except the items that need an AWS account (see the note below). Tier 3 remains the authoritative gate for merge.

> **Nothing is deployed to AWS from CI.** No workflow uses an AWS account, so the items of this list that need one (CDK diff against deployed stack, multi-account deployment verification, E2E tests against real AWS services) do not run in CI. The ruleset for `main` requires `build (agentcore)` and `Secrets, deps, and workflow scan`. The `emulator` workflow runs the Tier 2a tests beside them as an advisory check. No automated test of a deployed stack exists. The Phase 0 smoke of deployed runtime E2E (issue #236, `mise //cdk:integ`, a trimmed Task API stack deployed to a real account, asserted and torn down) was removed with the workflow that ran it. A deployed stack is checked by hand only, with the live acceptance of the Lambda MicroVM backend (`scripts/microvm-acceptance.sh`) and with `bgagent platform doctor`. Deployed runtime E2E, from Phase 0 on, is a follow-up.

### Enforcement model

| Event | Required tier | Enforcement |
|-------|--------------|-------------|
| `git commit` | Tier 0 | Pre-commit hook (prek) |
| `git push` | Tier 1 | Pre-push hook |
| PR created/updated | Tier 3 | GitHub Actions required status checks |
| Agent self-validation (before PR) | Tier 1 + Tier 2 (when available) | Skill-driven (agent invokes `validate-locally`) |
| Merge | Tier 3 passed + reviewer approved | Branch protection |

### Agent interaction model

Agents interact with validation tiers through skills (the interaction depends on ADR-012 for the skill model). The `validate-locally` skill and `mise run check:full` in the flow below are proposed here and do not exist yet. `mise run test:integration` exists (phase 2a):

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

The critical shift is the following. **Tier 3 becomes confirmatory, not exploratory.** Agents should not discover failures in remote CI. They should confirm that locally-validated work passes the authoritative gate.

### Investment priority

The gap analysis dictates priority:

| Priority | Investment | Impact |
|----------|-----------|--------|
| P0 | ~~Enforce Tier 1 as pre-push gate~~ **(largely done).** The test + security push gate is wired (prek `pre-push` hooks). Remaining work is folding synth, docs-sync, and drift into the gate | Eliminates "pushed without building" class of CI failures |
| P1 | ~~`mise run test:integration` (Tier 2a)~~ **(done as an advisory check).** Built on the AWS Emulator. Remaining work is graduation to a required check (criteria under Design constraints) | Catches data-plane defects and defects in state shared between the agent and the handlers without a deployment. Those are about one in twelve (10 of 120) of the recorded defects that passed unit tests and were found on a deployed stack. More than half of those 120 need real AWS and still do. It does not reduce CI-only failures, because `build.yml` makes no AWS call |
| P2 | Agent smoke test (Tier 2b) | Catches agent runtime regressions before PR |
| P3 | Ephemeral stack deploy (Tier 2c) | Catches IAM and wiring issues that surface only in a real deployment |
| P4 | Full local sandbox (Tier 2d) | Production-equivalent local validation (long-term target) |

### Design constraints

- **Tier 2 must not require cloud credentials for basic operation.** Agents that run in isolation (MicroVM, CI runner) need to validate without AWS access. For phase 2a the AWS Emulator meets this constraint, because it needs Docker and no AWS account. Phase 2c is the exception and needs a real account.
- **Tier 2 must be optional until stable.** A failing Tier 2 should warn, not block, during build-out. Once stable, it becomes a gate. For phase 2a, stable means the following, measured over 30 days: every red run triaged; none of the last 100 pull-request and merge-queue runs red because of the emulator or the runner; p95 job duration under 5 minutes; at least one test per service in scope; the emulator pin never more than 14 days behind upstream. Then the job is added to the required checks of the `main` ruleset.
- **Tier 2 must be cacheable.** Container images and fixture repos should be cached between runs (emulated state is in memory and is discarded on purpose). An agent should not rebuild everything on every run.
- **No tier should duplicate work from a lower tier.** If Tier 0 checks formatting, Tier 1 does not re-check it. If Tier 1 runs unit tests, Tier 3 does not re-run them (it may run *additional* tests but not the same ones).

### Escape hatches

| Situation | Allowed bypass |
|-----------|---------------|
| Hotfix with production down | Skip Tier 2, expedite Tier 3 review |
| Documentation-only change | Tier 0 + Tier 1 (synth not needed) |
| Dependency bump (Dependabot) | Tier 0 + Tier 3 (CI validates compatibility) |
| Agent cannot run Tier 2 (tooling unavailable) | Push with Tier 1 only, note in PR that Tier 2 was skipped |

Escape hatches must be explicit (noted in the PR description, not silent).

## Consequences

- (+) Agent feedback loops drop from 15 minutes to 30 to 90 seconds for most issues
- (+) The remote CI failure rate drops, because issues are caught locally before the push
- (+) Agents can self-validate autonomously without waiting for external systems
- (+) Investment is progressive, and each tier delivers value independently
- (+) Ownership is clear. Tiers 0 to 2 are the responsibility of the developer or agent, and Tier 3 is the responsibility of the platform
- (+) Cost drops, because fewer CI minutes are wasted on obviously-broken pushes
- (-) Tier 2 infrastructure requires maintenance (LocalStack config, container images, fixtures)
- (-) Local machine requirements increase (Docker, disk space for containers)
- (-) Tier 2 may diverge from real AWS behavior, because LocalStack is not 100% faithful
- (-) Pre-push gate adds 30 to 90s to every push (proposed mitigation: `mise run check:fast` alone for safe paths)
- (!) LocalStack fidelity gaps must be documented. When Tier 2 passes but Tier 3 fails, document the divergence and add it to Tier 2's scope
- (!) Tier 2 "optional until stable" phase must have defined graduation criteria, or it stays optional forever
- (!) Phase 2a was built on the AWS Emulator, not LocalStack. The three LocalStack consequences above apply to it as written. Its known differences from AWS are kept in `scripts/aws-emulator/README.md`, and the graduation criteria asked for above are under Design constraints

## References

- Issue #149, implementation tracking for this ADR
- ADR-002, bootstrap policies (Tier 2c validates the IAM preflight before a pull request, in a real AWS account)
- ADR-008, definition of done (tier requirements per DoD level)
- ADR-012 (prerequisite), the operational knowledge stack. This ADR depends on the skill model of ADR-012 for agent interaction with validation tiers
- Current hooks: `.pre-commit-config.yaml`. The config file keeps the `pre-commit` name, but the runner is **prek**. prek is pinned in `mise.toml` `[tools]`, and `prek install --prepare-hooks` wires both the `pre-commit` and `pre-push` stages. The config file implements Tier 0 (`pre-commit` stage) and the Tier 1 push gate (`pre-push` stage).
- Current build: the root `mise.toml` and the package-level configs (Tier 1 implementation)
- AWS Emulator: https://github.com/aws/aws-emulator (adopted for Tier 2a, with the version pinned in `scripts/aws-emulator/Dockerfile`)
- LocalStack: https://localstack.cloud (the candidate for Tier 2a when this ADR was written, not adopted and not evaluated in depth)
- `docs/research/aws-emulator-local-tests.md`, the investigation behind phase 2a. It records what was built and measured, and what was not verified
- Firecracker MicroVMs: https://firecracker-microvm.github.io (candidate for Tier 2d)

## Changelog

- 2026-11-15 — Phase 2a is implemented, on the AWS Emulator instead of LocalStack, as an advisory check (`mise run test:integration` and the `emulator` workflow). Replaced the estimate that it would eliminate "60%+ of CI-only failures" with what was measured, added the graduation criteria this ADR asks for, and stated that phase 2c needs a real AWS account because the emulator cannot show a missing permission (decision otherwise unchanged).
- 2026-11-20 — Tier 0 also runs the type check of cdk, cli and web when one of their TypeScript files is staged (#260). The build runs the same checks and stays the gate (decision unchanged).
- 2026-11-21 — Tier 0 also runs shellcheck when a shell script is staged (#278). The build and the security suite run the same check over every shell script (decision unchanged).
- 2026-11-24 — The `deploy` and `integ` workflows were removed as unused; the Tier 2a tests are the integration check that CI runs. CI now makes no AWS call: Tier 3 no longer deploys, compares against a deployed stack or tests in a real account. The manual task `mise //cdk:integ` and its smoke test went with the `integ` workflow: nothing ran it any more, and no run of it in CI had completed since the workflow's call of it was repaired (#1048). Removed the section "Residual risk acceptance — fork PR integ execution": the risk it accepted, fork-authored test code running with the deploy role, ended with the `integ` workflow (decision unchanged).
