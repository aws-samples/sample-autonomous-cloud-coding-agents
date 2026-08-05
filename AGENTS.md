# AGENTS.md

Context for AI coding assistants (Cursor, Claude Code, GitHub Copilot, etc.) working in this repository.

**Progressive disclosure:** Read this file first, then the package guide for the tree you are editing — [`cdk/AGENTS.md`](./cdk/AGENTS.md), [`cli/AGENTS.md`](./cli/AGENTS.md), [`agent/AGENTS.md`](./agent/AGENTS.md), or [`docs/AGENTS.md`](./docs/AGENTS.md).

## Your role

You are an **ABCA (Autonomous Background Coding Agents on AWS)** contributor: AWS CDK (TypeScript), Python agent runtime, CLI, and docs. Users submit coding tasks; agents work autonomously in isolated cloud environments and open pull requests for review.

Deeper design: [Developer guide](./docs/guides/DEVELOPER_GUIDE.md), [Architecture](./docs/design/ARCHITECTURE.md), [Orchestrator](./docs/design/ORCHESTRATOR.md).

## Commands (run these)

```bash
mise run install          # yarn workspaces + agent Python (uv)
mise run build            # agent quality + cdk + cli + docs (parallel)
mise run security         # secrets, deps, sast, grype, retire, gh-actions, agent
mise run hooks:install    # prek git hooks (also runs at end of install)
mise run hooks:run        # pre-commit + pre-push locally
```

Security subtasks: `mise run security:secrets`, `security:sast`, `security:sast:masking`, `security:deps`, `security:retire`, `security:gh-actions`. For `security:sast:masking` allowlist intentional fallbacks with an inline `nosemgrep: <rule-id> -- <reason>` comment.

Package commands: [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md), [agent/AGENTS.md](./agent/AGENTS.md), [docs/AGENTS.md](./docs/AGENTS.md).

Run `mise tasks --all` with `MISE_EXPERIMENTAL=1` for the full list. Prefer mise tasks over raw `jest`, `tsc`, or `cdk` for full suites; package guides show targeted `npx jest` / `uv run pytest` for single files.

## Git workflow

```
approved issue → git fetch origin main → worktree → branch → implement → local checks → PR
```

Branch names: `(feat|fix|chore|docs)/<issue-number>-short-description` (e.g. `docs/191-agents-md-split`).

**After merging `main` into your branch:**

1. `mise //cdk:eslint` and `mise //cli:eslint` (both use `--fix`)
2. Commit any auto-fixes (CI "Fail build on mutation" rejects uncommitted lint output)
3. `mise run build`

**Worktrees:** `node_modules/` and `agent/.venv/` are per-tree. Run `mise run install` in each new worktree.

## Where to make changes

| Change | Primary location | Also update | Package guide |
|--------|------------------|-------------|---------------|
| REST API, Lambdas, orchestration | `cdk/src/handlers/`, `cdk/src/stacks/`, `cdk/src/constructs/` | `cdk/test/` | [cdk/AGENTS.md](./cdk/AGENTS.md) |
| Shared API types | `cdk/src/handlers/shared/types.ts` | **`cli/src/types.ts`** | [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| `bgagent` CLI | `cli/src/`, `cli/test/` | `cli/src/types.ts` if API changes | [cli/AGENTS.md](./cli/AGENTS.md) |
| Agent runtime | `agent/src/` | `agent/tests/`, `agent/README.md` | [agent/AGENTS.md](./agent/AGENTS.md) |
| Progress events | `agent/src/progress_writer.py`, `agent/src/pipeline.py`, `agent/src/runner.py` | `agent/tests/test_progress_writer.py`; `cli/src/commands/watch.ts` | [agent/AGENTS.md](./agent/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| User-facing / design prose | `docs/guides/`, `docs/design/` | `mise //docs:sync` | [docs/AGENTS.md](./docs/AGENTS.md) |
| ADRs | `docs/decisions/` | `mise //docs:sync` | [docs/AGENTS.md](./docs/AGENTS.md) |
| Monorepo CI / tasks | `mise.toml`, `scripts/`, `.github/workflows/` | — | — |

## Boundaries

- ✅ **Always:** Use an approved GitHub issue before implementing ([ADR-003](./docs/decisions/ADR-003-contribution-governance.md)); branch from `main` via worktree; run `mise run build` before opening a PR; regenerate Starlight mirrors when editing `docs/guides/`, `docs/design/`, or `CONTRIBUTING.md`; add dependencies to the owning package `package.json` (`cdk/`, `cli/`, or `docs/`)
- ⚠️ **Ask first:** New CDK stacks or constructs, agent contract changes, new dependencies, major refactors, CI workflow edits
- 🚫 **Never:** Edit on `main`; edit `docs/src/content/docs/` by hand; commit secrets; implement without an `approved` issue (conversational "go ahead" is not approval); run raw `jest`/`tsc`/`cdk` when a mise task exists

## Common mistakes

- **No approved issue** — Create issue → `approved` label → self-assign → comment "Starting implementation". See [ADR-003](./docs/decisions/ADR-003-contribution-governance.md).
- **Branch without issue number** — Unauthorized work.
- **`MISE_EXPERIMENTAL=1`** — Required for `mise //cdk:build` and other namespaced tasks ([CONTRIBUTING.md](./CONTRIBUTING.md)).
- **`prek install` fails** — Another hook manager owns `core.hooksPath`; see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Dropping solution UA on a new AWS client (#319)** — every outbound AWS call carries `md/uksb-wt64nei4u6#{component}` (the `app/` segment is SDK-native via `AWS_SDK_UA_APP_ID`, set by `SolutionUaAspect`). Construct clients through the attributed factory: `cdk/src/` and `cli/src/` via `makeClient(Ctor, cfg)` / `makeDocClient(cfg)` (`cdk/src/handlers/shared/ua.ts`, `cli/src/ua.ts`); `agent/src/` via `aws_session.tenant_client`/`tenant_resource` (tenant-scoped) or `aws_session.platform_client` (unscoped, still attributed). A naked `new XxxClient({})` / `boto3.client(...)` silently loses solution attribution. Keep the three `ua` modules (`agent/src/ua.py`, `cdk/src/handlers/shared/ua.ts`, `cli/src/ua.ts`) identical in id/wire-format/sanitization.
- **Transitive npm pin applied in only one place** — `integrations/jira-forge-app` is a standalone npm project *outside* the yarn workspaces, so a root `package.json` `resolutions` bump does **not** reach it. Mirror the pin into `integrations/jira-forge-app/package.json` `overrides` and re-lock (`npm install --package-lock-only`). `mise run drift-prevention` (`check:transitive-pin-sync`) fails locally if they drift. See [#712](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/712).
- **Package-specific pitfalls** — API type drift, CDK test bundling, Cedar parity, generated docs: see package `AGENTS.md` files.

## Tech stack

- **Node** 22 (mise) · **TypeScript** 6.x · **Python** ≥3.13 (agent, uv)
- **AWS CDK** `aws-cdk-lib` 2.x · `@aws-cdk/aws-bedrock-alpha`, `@aws-cdk/aws-bedrock-agentcore-alpha`, `cdk-nag`
- **Test / lint** — Jest 30, ESLint flat config (`cdk/eslint.config.mjs`, `cli/eslint.config.mjs`), Ruff (agent)
- **Cedar** — `@cedar-policy/cedar-wasm` 4.8.2 (cdk) + `cedarpy==4.8.4` (agent); must bump together
- **Tooling** — mise, Yarn workspaces, prek hooks, Starlight docs sync

## Repository structure

| Path | Role |
|------|------|
| `cdk/` | CDK app (`@abca/cdk`) — [cdk/AGENTS.md](./cdk/AGENTS.md) |
| `cli/` | `bgagent` CLI — [cli/AGENTS.md](./cli/AGENTS.md) |
| `agent/` | Python runtime (bundled into CDK image) — [agent/AGENTS.md](./agent/AGENTS.md) |
| `docs/` | Guides, design, Starlight site — [docs/AGENTS.md](./docs/AGENTS.md) |
| `mise.toml` | Monorepo tasks; `config_roots`: cdk, agent, cli, docs |
| `CONTRIBUTING.md` | Contribution guidelines |
