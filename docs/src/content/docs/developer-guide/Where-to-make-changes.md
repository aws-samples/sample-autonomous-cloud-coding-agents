---
title: "Where to make changes"
---

Before editing, decide which part of the monorepo owns the behavior. This keeps API types, CLI, and docs in sync.

| Area | Paths | Notes |
|------|--------|--------|
| API & Lambdas | `cdk/src/handlers/`, `cdk/src/stacks/`, `cdk/src/constructs/` | Extend `cdk/test/` for the same feature. |
| API types | `cdk/src/handlers/shared/types.ts`, **`cli/src/types.ts`** and `web/src/core/api/types.ts` | Update the CLI mirror when request/response shapes change, and the web mirror where the console mirrors the type. `mise run check:types-sync` fails on drift. |
| CLI | `cli/src/`, `cli/test/` |  - |
| Agent runtime | `agent/` | Bundled into the image CDK deploys; run `mise run quality` in `agent/` or root build. |
| Docs (source) | `docs/guides/`, `docs/design/`, `docs/decisions/`, `CONTRIBUTING.md` | After edits, run **`mise //docs:sync`** or **`mise //docs:build`**. Do not edit `docs/src/content/docs/` directly. |

For a concise duplicate of this table, common pitfalls, and a CDK test file map, see **[AGENTS.md](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/AGENTS.md)** at the repo root (oriented toward automation-assisted contributors). Package-specific detail lives in **`AGENTS.md`** under `cdk/`, `cli/`, `web/`, `agent/`, and `docs/`.