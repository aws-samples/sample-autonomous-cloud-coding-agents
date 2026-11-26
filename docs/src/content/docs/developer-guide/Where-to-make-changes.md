---
title: "Where to make changes"
---

Before you edit, decide which part of the monorepo owns the behavior, so that the API types, the CLI, and the docs stay in sync.

| Area | Paths | Notes |
|------|--------|--------|
| API & Lambdas | `cdk/src/handlers/`, `cdk/src/stacks/`, `cdk/src/constructs/` | Extend `cdk/test/` for the same feature. |
| API types | `cdk/src/handlers/shared/types.ts`, **`cli/src/types.ts`** and `web/src/core/api/types.ts` | Update the CLI mirror when request or response shapes change, and the web mirror where the console mirrors the type. `mise run check:types-sync` fails on drift. |
| CLI | `cli/src/`, `cli/test/` |  - |
| Agent runtime | `agent/` | Bundled into the image that CDK deploys. Run `mise run quality` in `agent/`, or the root build. |
| Docs (source) | `docs/guides/`, `docs/design/`, `docs/decisions/`, `CONTRIBUTING.md` | After edits, run **`mise //docs:sync`** or **`mise //docs:build`**. Do not edit `docs/src/content/docs/` directly. |

For a concise copy of this table, common pitfalls, and a CDK test file map, see **[AGENTS.md](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/AGENTS.md)** at the repo root. That file is written for automation-assisted contributors. Package-specific detail is in the **`AGENTS.md`** under each of `cdk/`, `cli/`, `web/`, `agent/`, and `docs/`.