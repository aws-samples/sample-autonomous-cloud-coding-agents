# AGENTS.md

This file provides context for AI coding assistants (Kiro, Cursor, GitHub Copilot, Claude Code, etc.) working with this repository.

## Your role

You are an **AWS CDK (Cloud Development Kit) and TypeScript** expert. This project is **ABCA (Autonomous Background Coding Agents on AWS)**: a self-hosted platform where users create background coding agents, submit coding tasks, and the agents work autonomously in isolated cloud environments — cloning repos, writing code, running tests, and opening pull requests for review. The codebase is CDK infrastructure (TypeScript) plus Python agent code that runs inside the compute environment.

## Project knowledge

To get started and understand the developer flow, follow the [Developer guide](./docs/guides/DEVELOPER_GUIDE.md). For architecture and design, see [docs/design/](./docs/design/ARCHITECTURE.md). Task lifecycle and handler contracts are summarized in [Orchestrator design](./docs/design/ORCHESTRATOR.md) (including **API and agent contracts**).

### Where to make changes

Use this routing before editing so the right package and tests get updated:

| Change | Primary location | Also update |
|--------|------------------|-------------|
| REST API, Lambdas, task validation, orchestration | `cdk/src/handlers/`, `cdk/src/stacks/`, `cdk/src/constructs/` | Matching tests under `cdk/test/` |
| Shared API request/response shapes | `cdk/src/handlers/shared/types.ts` | **`cli/src/types.ts`** (must stay in sync) |
| `bgagent` CLI commands and HTTP client | `cli/src/`, `cli/test/` | `cli/src/types.ts` if API types change |
| Agent runtime (clone, tools, prompts, container) | `agent/src/` (`pipeline.py`, `runner.py`, `config.py`, `hooks.py`, `policy.py`, `prompts/`, Dockerfile, etc.) | `agent/tests/`, `agent/README.md` for env/PAT |
| Agent progress events (written to `TaskEventsTable` from the MicroVM; read by `bgagent watch`) | `agent/src/progress_writer.py`, `agent/src/pipeline.py` and `agent/src/runner.py` (integration points) | `agent/tests/test_progress_writer.py`; `cli/src/commands/watch.ts` for the consumer side |
| User-facing or design prose | `docs/guides/`, `docs/design/` | Run **`mise //docs:sync`** or **`mise //docs:build`** (do not edit `docs/src/content/docs/` by hand) |
| Monorepo tasks, CI glue | Root `mise.toml`, `scripts/`, `.github/workflows/` | — |

### CDK handler tests (quick map)

Colocated tests under `cdk/test/handlers/shared/` cover most shared logic:

- `validation.test.ts` — request validation
- `preflight.test.ts` — preflight / admission checks
- `create-task-core.test.ts` — task creation core path
- `context-hydration.test.ts` — prompt / context assembly
- `repo-config.test.ts`, `memory.test.ts`, `gateway.test.ts`, `response.test.ts`, `prompt-version.test.ts` — respective modules

Handler entry tests: `cdk/test/handlers/orchestrate-task.test.ts`, `create-task.test.ts`, `webhook-create-task.test.ts`. Construct wiring: `cdk/test/constructs/task-orchestrator.test.ts`, `task-api.test.ts`.

### Common mistakes

- Editing **`docs/src/content/docs/`** instead of **`docs/guides/`** or **`docs/design/`** — content is generated; sync from sources.
- Adding or editing files in **`docs/design/`** or **`docs/guides/`** without running **`cd docs && node scripts/sync-starlight.mjs`** — CI will reject ("Fail build on mutation") because the Starlight mirror files in `docs/src/content/docs/` are stale. Always commit the regenerated mirrors alongside source changes.
- Changing **`cdk/.../types.ts`** without updating **`cli/src/types.ts`** — CLI and API drift.
- Running raw **`jest`/`tsc`/`cdk`** from muscle memory — prefer **`mise //cdk:test`**, **`mise //cdk:compile`**, **`mise //cdk:synth`** (see [Commands you can use](#commands-you-can-use)).
- **`MISE_EXPERIMENTAL=1`** — required for namespaced tasks like **`mise //cdk:build`** (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
- **`mise run build`** runs **`//agent:quality`** before CDK — the deployed image bundles **`agent/`**; agent changes belong in that tree.
- **`prek install`** fails if Git **`core.hooksPath`** is set — another hook manager owns hooks; see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Tech stack

- **Language / runtime** — TypeScript (Node 20.x–24.x), Python 3.9+ (agent code in `agent/`)
- **Infrastructure** — AWS CDK v2 (awscdk), CDK constructs v10.x
- **CDK / AWS** — `@aws-cdk/aws-bedrock-alpha`, `@aws-cdk/aws-bedrock-agentcore-alpha`, `cdk-nag`
- **Tooling** — [mise](https://mise.jdx.dev/) for monorepo task orchestration and tool versions; Yarn workspaces; ESLint (with cdklabs, jsdoc, jest, license-header plugins); Jest for tests
- **Generated files** — Docs site content under `docs/src/content/docs/` is synced from source guides/design files via `docs/scripts/sync-starlight.mjs`

### Repository structure

- **`mise.toml`** (root) — Monorepo mise config: **`config_roots`** `cdk`, `agent`, `cli`, `docs`; tasks **`install`**, **`build`**, etc. Package-level **`mise.toml`** files live under those directories.
- **`scripts/`** (root) — Optional cross-package helpers; **`scripts/ci-build.sh`** runs the full monorepo build (same as CI).
- **`cdk/`** — CDK app package (`@abca/cdk`): `cdk/src/`, `cdk/test/`, `cdk/cdk.json`, `cdk/tsconfig.json`, `cdk/tsconfig.dev.json`, and `cdk/.eslintrc.json`.
- **`cli/`** — `@backgroundagent/cli` — CLI tool for interacting with the deployed REST API (see below).
- **`agent/`** — Python code that runs inside the agent compute environment (entrypoint, server, system prompt, Dockerfile, requirements). The system prompt is refactored into `agent/prompts/` with a shared base template and per-task-type workflow variants (`new_task`, `pr_iteration`, `pr_review`).
- **`docs/`** — Authoritative Markdown in `guides/` (developer, user, roadmap, prompt) and `design/`; assets in `diagrams/`, `imgs/`. The Starlight docs site lives here (`astro.config.mjs`, `package.json`); `src/content/docs/` is refreshed via `docs/scripts/sync-starlight.mjs`.
- **`CONTRIBUTING.md`** — Contribution guidelines at the repository root.
- **`package.json`** (root), **`yarn.lock`** — Yarn workspace root (minimal manifest); dependencies live in **`cdk/`**, **`cli/`**, and **`docs/`** package manifests.

### CLI package (`cli/`)

The `@backgroundagent/cli` package provides the `bgagent` executable for submitting and managing tasks through the deployed REST API with Cognito authentication.

**Structure:**

- `src/bin/bgagent.ts` — Entry point (`#!/usr/bin/env node`, commander program setup)
- `src/commands/` — One file per command: `configure`, `login`, `submit`, `list`, `status`, `cancel`, `events`
- `src/api-client.ts` — HTTP client wrapping `fetch` with auth header injection
- `src/auth.ts` — Cognito login, token caching (`~/.bgagent/credentials.json`), auto-refresh
- `src/config.ts` — Read/write `~/.bgagent/config.json`
- `src/types.ts` — API request/response types (mirrored from `cdk/src/handlers/shared/types.ts`), including `TaskType` (`new_task` | `pr_iteration` | `pr_review`)
- `src/format.ts` — Output formatting (table, detail view, JSON)
- `src/debug.ts` — Verbose/debug logging (`--verbose` flag)
- `src/errors.ts` — `CliError` and `ApiError` classes
- `test/` — Jest tests for all modules

**Key conventions:**

- The `no-console` ESLint rule is disabled for CLI source files (console output is the product).
- Runtime deps (`commander`, `@aws-sdk/client-cognito-identity-provider`) are declared in `cli/package.json`.
- The CLI build is run via `mise //cli:build` (or `cd cli && mise run build`), and included in root `mise run build`.
- The API URL from the `ApiUrl` stack output already includes the stage name (`/v1/`), so the CLI appends only resource paths (`/tasks`, `/tasks/{id}`, etc.).

## Commands you can use

Run `mise tasks --all` (with `MISE_EXPERIMENTAL=1`) for the full list. Common commands:

- **`mise run install`** — One **`yarn install`** at the repo root for all Yarn workspaces (**`cdk`**, **`cli`**, **`docs`**), then **`mise run install`** in **`agent/`** for Python (uv).
- **`mise run build`** — Runs **`//agent:quality`** first (agent is bundled by CDK), then **`//cdk:build`**, **`//cli:build`**, and **`//docs:build`** in order.
- **`mise //cdk:compile`** — Compile CDK TypeScript.
- **`mise //cdk:test`** — Run CDK Jest tests.
- **`mise //cdk:synth`** — Synthesize CDK app to `cdk/cdk.out/`.
- **`mise //cdk:deploy`** — Deploy the CDK stack to the current AWS account.
- **`mise //cdk:destroy`** — Destroy the deployed CDK stack.
- **`mise //cdk:diff`** — Diff deployed stack vs. current code.
- **`mise //cli:build`** — Build CLI package.
- **`mise //docs:build`** — Sync and build docs site.
- **`mise run security:secrets`** — Gitleaks at repo root.
- **`mise run security:sast`** — Semgrep on the repo (root; includes **`agent/`** Python among paths).
- **`mise run security:deps`** — OSV Scanner on **`yarn.lock`** (all JS workspaces) and **`agent/uv.lock`**.
- **`mise run security`** — Runs **`security:secrets`**, **`security:deps`**, **`security:sast`**, **`security:grype`**, **`security:retire`**, **`security:gh-actions`**, and **`//agent:security`**.
- **`mise run security:retire`** — Retire.js on CDK, CLI, and docs packages.
- **`mise run security:gh-actions`** — Static analysis of GitHub Actions under **`.github/`** ([zizmor](https://github.com/zizmorcore/zizmor)).
- **`mise run hooks:install`** — Re-install **[prek](https://github.com/j178/prek)** git hooks (also run automatically at the end of **`mise run install`** inside a Git checkout). See [CONTRIBUTING.md](./CONTRIBUTING.md) if `core.hooksPath` blocks install.
- **`mise run hooks:run`** — Run the same **pre-commit** and **pre-push** hook stages on all files (local verification).

Use these instead of running `tsc`, `jest`, or `cdk` directly when possible, so the project's scripts and config stay consistent.

To build or test only the CLI subproject:

- **`cd cli && mise run build`** — Full CLI build (compile, test, lint).
- **`cd cli && mise run test`** — Run CLI tests only.
- **`cd cli && mise run compile`** — Compile CLI TypeScript only.

## Boundaries

- **Generated docs (CI will reject if stale)** — Editing files in `docs/guides/`, `docs/design/`, or `CONTRIBUTING.md` requires regenerating Starlight mirrors under `docs/src/content/docs/`. Run **`cd docs && node scripts/sync-starlight.mjs`** (fast, <1 s) or **`mise //docs:sync`**, then commit the updated mirrors alongside your source changes. The pre-commit hook `docs-sync` does this automatically when prek hooks are installed, but if you bypass hooks (e.g. `--no-verify`), CI's "Fail build on mutation" step will catch it.
- **Dependencies** — Add dependencies to the owning package `package.json` (`cdk/`, `cli/`, or `docs/`), then install via workspace/root install.
- **Build before commit** — Run a full build (`mise run build`) when done so tests/synth/docs/security checks stay in sync. This is especially critical for docs changes — the build includes `//docs:sync` which regenerates Starlight mirrors, and CI will fail if the committed mirrors don't match what the build produces.
- **Major changes** — Before modifying existing files in a major way (large refactors, new stacks, changing the agent contract), ask first.
