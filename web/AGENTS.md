# Web console package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md) · Human guide: [README.md](./README.md)

You maintain the **operator console** (`@abca/web`): React 19, Vite, React Router 8, Cloudscape, TanStack Query, Vitest + Testing Library, MSW.

## Commands (run these)

```bash
mise //web:build      # typecheck + test + lint + bundle
mise //web:test       # Vitest with coverage floors; a committed `.only` fails
mise //web:eslint     # ESLint --fix
mise //web:eslint:check  # ESLint without --fix: reports only; a warning fails too
mise //web:dev:mock   # local console on http://127.0.0.1:5173 against the mock API
```

The `web-eslint` pre-commit hook runs `mise //web:eslint` when a TypeScript or JavaScript file under `web/` is staged, and the `web-typecheck` hook runs `mise //web:typecheck` when a TypeScript file is.

To run a single test file, use `cd web && yarn vitest run test/domains/tasks/TaskListPage.test.tsx`. That run has no coverage and no floors. The floors count every file under `src/`, tested or not. They are set in `vite.config.ts` and pinned in `contracts/coverage-thresholds.json`.

## Conventions

- **Layers.** `app/` (shell, providers, config), `core/` (API client, wire types, shared components and utils, no pages), and `domains/<feature>/` (pages and hooks). `core/` must not import from `domains/`. ESLint enforces it, `import()` included.
- **Server state.** Use TanStack Query hooks colocated in `domains/<feature>/hooks.ts`. Use no other state library.
- **Cloudscape.** Import components directly (`@cloudscape-design/components/<name>`). ESLint rejects the package root. Do not add pass-through wrappers. Use `RouterLink` or `ExternalLink` from `core/components/RouterLink.tsx` for links.
- **Wire types.** `src/core/api/types.ts` mirrors the API's types (`cdk/src/handlers/shared/types.ts`, and `cli/src/types.ts` for the envelopes). Change them together when the API changes. Drift fails `mise run check:types-sync`. An export may leave members out, but each member it declares must match the CDK declaration (the CLI one where the CDK has none). A new export needs such a declaration or an entry in `WEB_ONLY_ALLOWLIST` in `scripts/check-types-sync.ts`.
- **Tests.** `test/` mirrors `src/`. Page tests render real routes through `test/helpers/render.tsx` against the MSW server in `test/helpers/server.ts`, which uses the same handlers as mock mode. Add a fixture in `src/mocks/fixtures.ts` for each new state the UI must handle.
- **Coverage.** ESLint (`no-warning-comments`) rejects a comment that contains `istanbul ignore`, `c8 ignore`, `v8 ignore` or `node:coverage`, because vitest would leave that code out of the coverage report. Test the code, or leave it counted as uncovered and say why in a plain comment.
- **License header.** Every `src/` and `test/` file starts with the MIT-0 header (`header.js`). ESLint enforces it.
- **Complexity.** ESLint (`complexity`) fails any function whose cyclomatic complexity is above 40, the ceiling shared with cdk and cli. Split the component or move logic into a hook or helper. Do not add an `eslint-disable`.
- **Scoreboard wording.** The page and `bgagent stats` say the same sentences. `cli/test/scoreboard.test.ts` loads `src/core/util/scoreboard.ts` and fails when they diverge. Keep that module's runtime imports to `./format` and types. The CLI suite has no JSX bundler, and another import fails the load before the comparison.

## Boundaries

- 🚫 **Never** import from `src/mocks/` outside a `__MOCK__` guard (in `main.tsx`) or tests. Mock sign-in must never reach a production bundle. In `src/` ESLint accepts only `import()` inside `if (__MOCK__) { ... }`.
- 🚫 **Never** bind the dev or preview server beyond `127.0.0.1`.
- 🚫 **Never** put secrets in `/config.json` or the bundle. The Cognito app client is public and has no secret.
- ⚠️ The console is a read projection of the API. Mutations (approve, deny, cancel, repo admin) go through the REST API with the same authorization as the CLI. Never add a privileged path that bypasses the API.
