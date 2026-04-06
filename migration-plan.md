# Migration plan: Projen → mise monorepo (`cdk/`, per-package `scripts/`)

This document describes moving the repository from **Projen + mise** to **mise-only** orchestration, with the CDK application in **`cdk/`**, optional **`scripts/`** at the repo root and in each package, and [mise monorepo tasks](https://mise.jdx.dev/tasks/monorepo.html).

### Phase 1 (done)

- **`cdk/src/`** and **`cdk/test/`** hold the CDK app and tests (moved from repo root).
- **Yarn workspaces**: root **`package.json`** includes **`"workspaces": ["cdk", "cli", "docs"]`** and **`"private": true`** (required by Yarn).
- **Projen** still orchestrates the repo; **`.projenrc.ts`** sets **`srcdir` / `testdir` / `libdir`** under **`cdk/`**, **`cdkout: 'cdk/cdk.out'`**, and **`tsconfig` `types`** so hoisted docs **`@types`** do not break **`tsc`**.
- **`cdk/package.json`** (**`@abca/cdk`**) and **`cdk/mise.toml`** support package-scoped scripts; **`cdk/cdk.json`** allows **`cd cdk && npx cdk synth`** using **`cdk/cdk.out`**.
- **Retire** root task scans **`cdk/`** instead of removed root **`src/`**.
- **`AGENTS.md`** / **`CLAUDE.md`** updated for the new layout.

### Phase 2 (done)

- **Root `mise.toml`**: monorepo mode (`experimental` + `experimental_monorepo_root`), **`[monorepo].config_roots`**, Node 22, tasks **`install`**, **`build`**, **`default`**, **`security:retire`**.
- **`cli/mise.toml`** and **`docs/mise.toml`**: package-local Projen-backed tasks for independent **`mise run`** from each directory.
- **`scripts/`** at repo root (placeholder for cross-package automation).
- **CI**: **`MISE_EXPERIMENTAL=1`** added to the build workflow env via **`.projenrc.ts`**.
- **CONTRIBUTING** / **README**: document **`MISE_EXPERIMENTAL`** for monorepo task names (`//cdk:build`, etc.).

---

## Goals

- Remove **Projen**; use **mise** for tool versions and tasks everywhere contributors and CI need a single entrypoint.
- Treat the repo as a **mise monorepo** with explicit **`[monorepo].config_roots`** for: **`cdk`**, **`agent`**, **`cli`**, **`docs`**.
- Each package has its own **`mise.toml`** so it can be used independently (e.g. `cd cdk && mise run build`).
- Put **CDK** under **`cdk/`** (not repo root).
- Use **`scripts/`** per package for package-specific automation; use **root `scripts/`** only for logic that **coordinates multiple packages**.

---

## Current state (summary)

- **`.projenrc.ts`** defines: root AwsCdkTypeScriptApp, **`cli/`** TypeScript subproject, **`docs/`** Astro/Starlight subproject, ESLint setup, docs mirroring into **`docs/src/content/docs/`**, generated **`docs/astro.config.mjs`**, GitHub workflows, Mergify, and Projen tasks.
- **`agent/mise.toml`** already defines Python/**`uv`** tasks (`install`, `quality`, `security`, etc.).
- CI installs mise but runs **`npx projen build`** (see **`.github/workflows/build.yml`**).
- Typical full build (Projen): regenerate via **`ts-node .projenrc.ts`** → compile → post-compile (**`cdk synth -q`**, CLI build, docs build, agent mise checks, Retire) → Jest + ESLint → package.

---

## Target layout

```text
repo/
├── mise.toml                 # monorepo root: experimental_monorepo_root, config_roots, orchestration tasks
├── scripts/                  # cross-package automation only (thin wrappers; prefer mise tasks)
├── package.json              # optional: Yarn workspaces + minimal meta for unified install
├── yarn.lock
├── agent/
│   ├── mise.toml
│   └── scripts/              # optional
├── cdk/
│   ├── mise.toml
│   ├── package.json
│   ├── cdk.json
│   ├── tsconfig.json
│   ├── src/                  # moved from repo root src/
│   ├── test/                 # moved from repo root test/
│   └── scripts/              # e.g. cdk.json build / bundle helpers
├── cli/
│   ├── mise.toml
│   └── scripts/              # optional
└── docs/
    ├── mise.toml
    └── scripts/              # Starlight sync (ex–projen mirroring + link rewrites)
```

---

## Mise monorepo configuration

- Root **`mise.toml`**: set **`experimental_monorepo_root = true`** at the **top level** of the file (not under **`[settings]`** — current mise versions reject it there), **`[settings].experimental = true`**, and **`[monorepo].config_roots = ["cdk", "agent", "cli", "docs"]`** (adjust if you add packages).
- Monorepo task discovery requires **`MISE_EXPERIMENTAL=1`** — set in CI and document for local development.
- Run tasks as **`mise //cdk:build`**, or from inside **`cdk/`**: **`mise :build`**.
- Optional: [task templates](https://mise.jdx.dev/tasks/templates.html) at root for repeated patterns.

---

## `scripts/` conventions

| Location | Purpose |
|----------|---------|
| **`scripts/`** (root) | Orchestration spanning **multiple** packages (e.g. one CI entry script that invokes mise across packages). Prefer **`mise run`** / **`mise //pkg:task`**; keep root scripts thin. |
| **`cdk/scripts/`** | CDK-specific: **`cdk.json` `build`**, esbuild or other asset bundling. |
| **`docs/scripts/`** | Sync markdown from **`docs/guides/`**, **`docs/design/`**, **`CONTRIBUTING.md`** into **`docs/src/content/docs/`** (replaces Projen **`TextFile`** / **`splitGuide`** / **`mirrorDirectory`** logic). |
| **`cli/scripts/`**, **`agent/scripts/`** | Optional helpers beyond what **`mise` tasks** already express. |

---

## What moves into `cdk/`

Move CDK-only assets from repo root:

- **`src/`** → **`cdk/src/`**
- **`test/`** → **`cdk/test/`**
- CDK-related **`dependencies`** and **`devDependencies`** from root **`package.json`** → **`cdk/package.json`**
- **`cdk.json`**, **`tsconfig.json`**, **`tsconfig.dev.json`**, CDK **`.eslintrc.json`**, **`header.js`** (if used only for CDK ESLint)

**Stay at repo root** (or existing paths): **README**, **CONTRIBUTING**, **AGENTS.md**, **`.github/`**, **`docs/guides/`**, **`docs/design/`**, **`agent/`**, **`cli/`**, **`docs/`** (site tree).

### Path fix after the move

**`cdk/src/stacks/agent.ts`** (and any similar code) resolves the agent runtime asset from compiled **`cdk/lib/`**:

- Today (from repo root): **`path.join(__dirname, '..', '..', 'agent')`** from **`lib/stacks/`** reaches repo **`agent/`**.
- After move: from **`cdk/lib/stacks/`**, use **`path.join(__dirname, '..', '..', '..', 'agent')`** to reach repo-root **`agent/`**.

**Handlers** under **`cdk/src/handlers`** keep working with **`path.join(__dirname, '..', 'handlers')`** from **`constructs/`** once **`__dirname`** is under **`cdk/lib/constructs/`**.

Search **`cdk/`** and tests for any other cwd or repo-root assumptions.

---

## Replacing Projen responsibilities

| Area | Today | After migration |
|------|--------|------------------|
| Tasks / CI | **`npx projen build`**, subproject **`npx projen *`** | **`mise run build`** and per-package tasks |
| **`default` / codegen** | **`ts-node .projenrc.ts`** on build | **Removed**; explicit **`docs/scripts/`** sync when needed |
| ESLint / TS / Jest | Projen-generated configs | **Hand-maintained** (snapshot current output, then own files) |
| **`package.json` scripts** | Projen-managed | Plain **`yarn`/`npm`** or mise-wrapped commands; remove **`projen`** dependency |
| Docs → Starlight | Logic in **`.projenrc.ts`** | **`docs/scripts/`** + **`mise run sync`** (then **`astro check && astro build`**) |
| **`docs/astro.config.mjs`** | Generated | **Committed source** under **`docs/`** |
| CDK CLI | Projen tasks | **`mise`** tasks in **`cdk/mise.toml`** wrapping **`cdk synth`**, **`cdk deploy`**, etc. |
| Upgrades | **`upgrade.yml`** + **`npx projen upgrade`** | Dependabot/Renovate or documented **`yarn`/`ncu`**; no Projen sync |
| PR self-mutation | Projen build commits changes | **Remove** with Projen |

**`cdk.json`**: today **`build`** may reference **`npx projen bundle`** — replace with a real bundle command or a **`cdk/scripts/`** helper invoked from **`cdk/mise.toml`**.

---

## Yarn workspaces (recommended)

- Root **`package.json`** with **`"workspaces": ["cdk", "cli", "docs"]`** for one **`yarn install`** at repo root.
- **`agent`** remains Python via **`uv`** in **`agent/mise.toml`**.
- Root **`mise.toml`** **`install`** task: e.g. **`yarn install`** (frozen in CI) + **`mise run //agent:install`** (or equivalent).

---

## CI and automation updates

- **Build workflow**: checkout → **`jdx/mise-action`** → **`MISE_EXPERIMENTAL=1`** → **`yarn install --frozen-lockfile`** → **`mise run build`**. Remove Projen self-mutation job and **`PROJEN_GITHUB_TOKEN`** usage tied only to Projen.
- **Docs workflow**: trigger on **`docs/**`**, **`docs/scripts/**`**, **`docs/guides/**`**, **`CONTRIBUTING.md`**, **`docs/design/**`** — remove **`.projenrc.ts`** from paths.
- **Upgrade workflow**: replace or delete; use Dependabot/Renovate if desired.
- **Mergify / PR lint**: keep as static YAML; align required check names with new CI job names.

---

## Documentation and repo meta

Update references to **`npx projen`**, root **`src/`**, and “CDK at root” in:

- **README.md**, **CONTRIBUTING.md**, **AGENTS.md**, **CLAUDE.md**
- **`docs/guides/DEVELOPER_GUIDE.md`** and mirrored/generated docs under **`docs/src/content/docs/`** after sync
- **`.github/ISSUE_TEMPLATE/**`**
- Any agent/container docs that describe repo layout

---

## Risks and notes

- Mise monorepo tasks are **experimental** — pin **`min_version`** in **`mise.toml`** and document **`MISE_EXPERIMENTAL=1`**.
- **Docs sync** is the largest **logic** migration; add a check that **`mise run sync`** + **`docs` build** passes in CI.
- **`test/`** and Jest paths move with **`cdk/`**; update **`jest.config`** / **`package.json` `jest`** block accordingly inside **`cdk/package.json`**.

---

## Ordered task list (execution sequence)

Complete phases in order; within a phase, steps can be parallelized where safe.

### Phase 1 — Create `cdk/` package and move the CDK app

1. [x] Create directory **`cdk/`**.
2. [x] Move **`src/`** → **`cdk/src/`** and **`test/`** → **`cdk/test/`**.
3. [x] Create **`cdk/package.json`** with CDK-related dependencies and devDependencies (split from current root **`package.json`**).
4. [x] Repo-root **`cdk.json`** / **`tsconfig.*`** / **`.eslintrc.json`** remain Projen-generated for the CDK app; **`cdk/cdk.json`** supports synth from **`cdk/`**; **`cdk/header.js`** for license-header.
5. [x] Root **`cdk.json`** **`app`** entry runs **`cdk/src/main.ts`**; **`cdk/cdk.json`** for in-dir **`cdk`** runs.
6. [x] Fix **`cdk/src/stacks/agent.ts`** **`runnerPath`** (**`../../../agent`** from **`lib/stacks/`**).
7. [x] Grep **`cdk/`** for path assumptions; tests updated as needed.
8. [x] Add **`cdk/mise.toml`** with **`install`**, **`compile`**, **`test`**, **`eslint`**, **`synth`**, **`deploy`**, **`bundle`**, **`build`**.
9. [x] Verify **`yarn`**, **`tsc`**, **`jest`**, **`cdk synth`** (workspace + standalone **`cd cdk`**).

### Phase 2 — Root monorepo + Yarn workspaces

10. [x] Root **`package.json`** **`workspaces`: `["cdk", "cli", "docs"]`** and **`private: true`** (via **`.projenrc.ts`**).
11. [x] **`cli/`** and **`docs/`** work as workspace packages; **CDK deps stay duplicated** at root (Projen) and **`cdk/package.json`** until Phase 4 removes Projen — intentional for now.
12. [ ] **Deferred (Phase 5)** — Further slim root **`package.json`** / move CDK-only deps off root if/when dependency ownership is split more aggressively.
13. [x] Root **`mise.toml`**: **`experimental_monorepo_root`**, **`[settings].experimental`**, **`[monorepo].config_roots`**, **`min_version`**, **`node`**, tasks **`install`**, **`build`**, **`default`**, **`security:retire`**; **`cli/mise.toml`** and **`docs/mise.toml`** added so **`config_roots`** resolve.
14. [x] Document **`MISE_EXPERIMENTAL=1`** in **CONTRIBUTING** and **README**; set in **`.github/workflows/build.yml`** for future **`mise`** use.

### Phase 3 — Wire CLI and docs to mise (still can keep Projen briefly)

15. [x] Add **`cli/mise.toml`** with package-native commands using **`yarn`** / local binaries (**`compile`**, **`test`**, **`eslint`**, **`build`**).
16. [x] Add **`docs/mise.toml`** with **`sync`**, **`build`** (**`astro check && astro build`**), **`dev`**, and **`check`**.
17. [x] Implement **`docs/scripts/sync-starlight.mjs`** porting mirror/split/link-rewrite behavior; wire **`docs`** **`sync`** as a dependency of **`build`** / **`check`**.
18. [x] `docs/astro.config.mjs` is now hand-owned with docs build/sync driven by `docs/package.json` + `docs/mise.toml` + `docs/scripts/sync-starlight.mjs`.
19. [x] Update root **`mise`** **`build`** to depend on **`//cdk:build`**, **`//cli:build`**, **`//docs:build`**, **`//agent:quality`**, and root retire scan.

### Phase 4 — Remove Projen

20. [x] Delete **`.projenrc.ts`** and **`.projen/`** trees (**root**, **`cli/`**, **`docs/`** if present).
21. [x] Remove **`projen`** from all **`package.json`** files; replace **`scripts`** with direct **`yarn`**/**`mise`** commands.
22. [x] Hand-own **`.eslintrc.json`** / **Jest** config in **`cdk/`**, **`cli/`** as needed (frozen from generated baseline and edited manually).
23. [x] Update **`.github/workflows/build.yml`**: **`mise run build`**, no self-mutation; Node/yarn/mise steps aligned.
24. [x] Update **`.github/workflows/docs.yml`**, remove **`upgrade.yml`**, and clean **`pull-request-lint.yml`** of Projen metadata/secrets.
25. [x] Update **`.mergify.yml`** (status check remains `build`; removed Projen metadata banner).
26. [x] Run full **`mise run build`** locally; regressions fixed (ESLint v9 rc mode + CLI TypeScript types + cdk eslint working directory).

### Phase 5 — Root `scripts/` and cleanup

27. [x] Add **root `scripts/`** only for cross-package wrappers if mise alone is awkward for a specific integration (keep minimal). **`scripts/ci-build.sh`** runs **`MISE_EXPERIMENTAL=1 mise run build`** (CI-equivalent).
28. [x] **`docs/scripts/sync-starlight.mjs`** (existing); **`cdk/scripts/README.md`** (notes); optional **`cli/scripts/`**, **`agent/scripts/`** (placeholders).
29. [x] Global search for **`projen`**, **`npx projen`**, **`.projenrc`**, and outdated paths; fix guides (**`docs/guides/`**), **CLI README**, test fixture; **README**/**AGENTS**/**CLAUDE** already aligned. Historical mentions remain in **`migration-plan.md`** baseline sections by design.
30. [x] This migration is **complete** for Phases 1–5; keep this file for history or delete after merge per team preference.

**Phase 5 completed** (repository state as of migration close-out).

---

## Quick reference: commands after migration (illustrative)

| Intent | Example |
|--------|--------|
| Install all (JS + agent) | **`mise run install`** (from repo root) |
| Full CI-equivalent build | **`./scripts/ci-build.sh`** or **`MISE_EXPERIMENTAL=1 mise run build`** |
| CDK only | **`cd cdk && mise run build`** or **`mise //cdk:build`** |
| Docs with sync | **`mise //docs:sync`** then **`mise //docs:build`** or a single docs **`build`** that depends on **`sync`** |
| Agent checks | **`mise //agent:quality`** (and security tasks as today) |

Task names match each package **`mise.toml`**; use **`MISE_EXPERIMENTAL=1`** for **`mise //pkg:task`** from the repo root.
