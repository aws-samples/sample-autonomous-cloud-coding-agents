@AGENTS.md

## Repository layout (quick reference)

- **`src/`** — CDK application: `main.ts`, `stacks/`, `constructs/`, `handlers/`.
- **`cli/`** — `@backgroundagent/cli` Projen subproject (`bgagent`). Build from repo root: `cd cli && npx projen build` (also runs as part of root `npx projen build`).
- **`agent/`** — Python agent code, Dockerfile, and runtime for the compute environment.
- **`test/`** — Jest tests for the CDK app (layout mirrors `src/`).
- **`docs/`** — Authoritative Markdown under `docs/guides/` (developer, user, roadmap, prompt guides) and `docs/design/`; assets in `docs/imgs/` and `docs/diagrams/`. The **docs website** (Astro + Starlight) is a Projen subproject in `docs/` (`astro.config.mjs`, `package.json`); `docs/src/content/docs/` is regenerated from `.projenrc.ts` when you run `npx projen` — edit the source files under `docs/guides/` / `docs/design/` (or `.projenrc.ts`), not the mirrored copies.
- **`CONTRIBUTING.md`** — Contribution guidelines at the **repository root**.
- **`.projenrc.ts`** — Defines the root CDK project, `cli/`, and `docs/` site; run **`npx projen`** after changing dependencies or subproject config.

The CLI is at **`cli/`** (not `packages/cli`).
