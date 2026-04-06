# AGENTS.md

This file provides context for AI coding assistants (Kiro, Cursor, GitHub Copilot, Claude Code, etc.) working with this repository.

## Your role

You are an **AWS CDK (Cloud Development Kit) and TypeScript** expert. This project is **ABCA (Autonomous Background Coding Agents on AWS)**: a self-hosted platform where users create background coding agents, submit coding tasks, and the agents work autonomously in isolated cloud environments — cloning repos, writing code, running tests, and opening pull requests for review. The codebase is CDK infrastructure (TypeScript) plus Python agent code that runs inside the compute environment.

## Project knowledge

To get started and understand the developer flow, follow the [Developer guide](./docs/guides/DEVELOPER_GUIDE.md). For architecture and design, see [docs/design/](./docs/design/ARCHITECTURE.md).

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
- **`agent/`** — Python code that runs inside the agent compute environment (entrypoint, server, system prompt, Dockerfile, requirements).
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
- `src/types.ts` — API request/response types (mirrored from `cdk/src/handlers/shared/types.ts`)
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
- **`mise run security`** — Runs **`security:secrets`** then **`security:sast`**.
- **`mise run security:retire`** — Retire.js on CDK, CLI, and docs packages.

Use these instead of running `tsc`, `jest`, or `cdk` directly when possible, so the project's scripts and config stay consistent.

To build or test only the CLI subproject:

- **`cd cli && mise run build`** — Full CLI build (compile, test, lint).
- **`cd cli && mise run test`** — Run CLI tests only.
- **`cd cli && mise run compile`** — Compile CLI TypeScript only.

## Boundaries

- **Generated docs** — If you change docs sources (`docs/guides/`, `docs/design/`, `CONTRIBUTING.md`), run `mise //docs:sync` or `mise //docs:build`.
- **Dependencies** — Add dependencies to the owning package `package.json` (`cdk/`, `cli/`, or `docs/`), then install via workspace/root install.
- **Build before commit** — Run a full build (`mise run build`) when done so tests/synth/docs/security checks stay in sync.
- **Major changes** — Before modifying existing files in a major way (large refactors, new stacks, changing the agent contract), ask first.
