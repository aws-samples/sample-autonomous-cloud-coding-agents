@AGENTS.md

Root **`mise.toml`** configures a mise monorepo (`config_roots`: **`cdk`**, **`agent`**, **`cli`**, **`docs`**). Use **`MISE_EXPERIMENTAL=1`** for **`mise //pkg:task`**; run **`mise trust`** at the repo root after clone. **`scripts/`** is for cross-package helpers (often thin wrappers around **`mise run`**); **`scripts/ci-build.sh`** is the CI-equivalent full build.

## Repository layout (quick reference)

- **`cdk/`** — CDK application package: `cdk/src/main.ts`, `stacks/`, `constructs/`, `handlers/`.
- **`cli/`** — `@backgroundagent/cli` package (`bgagent`). Build from repo root: `mise //cli:build` (or `cd cli && mise run build`).
- **`agent/`** — Python agent code, Dockerfile, and runtime for the compute environment.
- **`cdk/test/`** — Jest tests for the CDK app (layout mirrors `cdk/src/`).
- **`docs/`** — Authoritative Markdown under `docs/guides/` (developer, user, roadmap, prompt guides) and `docs/design/`; assets in `docs/imgs/` and `docs/diagrams/`. The docs website (Astro + Starlight) lives in `docs/`; `docs/src/content/docs/` is synced via `docs/scripts/sync-starlight.mjs` (run through `mise //docs:sync` or `mise //docs:build`).
- **`CONTRIBUTING.md`** — Contribution guidelines at the **repository root**.

The CLI is at **`cli/`** (not `packages/cli`).
