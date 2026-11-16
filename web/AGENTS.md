# Web console package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md) · Human guide: [README.md](./README.md)

You maintain the **operator console** (`@abca/web`): React 19, Vite, React Router 7, Cloudscape, TanStack Query, Vitest + Testing Library, MSW.

## Commands (run these)

```bash
mise //web:build      # typecheck + test + lint + bundle
mise //web:test       # Vitest with coverage floors; a committed `.only` fails
mise //web:eslint     # ESLint --fix
mise //web:eslint:check  # ESLint without --fix: reports only; a warning fails too
mise //web:dev:mock   # local console on http://127.0.0.1:5173 against the mock API
```

The `web-eslint` pre-commit hook runs `mise //web:eslint` when a TypeScript or JavaScript file under `web/` is staged.

Single test file: `cd web && yarn vitest run test/domains/tasks/TaskListPage.test.tsx` (no coverage, no floors). The floors count every file under `src/`, tested or not; they live in `vite.config.ts` and are pinned in `contracts/coverage-thresholds.json`.

## Conventions

- **Layers:** `app/` (shell, providers, config) · `core/` (API client, wire types, shared components/utils; no pages) · `domains/<feature>/` (pages + hooks). `core/` must not import from `domains/` (ESLint enforces it, `import()` included).
- **Server state:** TanStack Query hooks colocated in `domains/<feature>/hooks.ts`. No other state library.
- **Cloudscape:** import components directly (`@cloudscape-design/components/<name>`; ESLint rejects the package root); no pass-through wrappers. Use `RouterLink`/`ExternalLink` from `core/components/RouterLink.tsx` for links.
- **Wire types:** `src/core/api/types.ts` mirrors `cli/src/types.ts`. Change both when the API changes. Drift fails `mise run check:types-sync`: an export may leave members out, but each member it declares must match the CDK declaration (the CLI one where the CDK has none), and a new export needs such a declaration or an entry in `WEB_ONLY_ALLOWLIST` in `scripts/check-types-sync.ts`.
- **Tests:** `test/` mirrors `src/`. Page tests render real routes through `test/helpers/render.tsx` against the MSW server in `test/helpers/server.ts`, which uses the same handlers as mock mode. Add a fixture in `src/mocks/fixtures.ts` for each new state the UI must handle.
- **Coverage:** ESLint (`no-warning-comments`) rejects a comment that contains `istanbul ignore`, `c8 ignore`, `v8 ignore` or `node:coverage`: vitest would leave that code out of the coverage report. Test the code, or leave it counted as uncovered and say why in a plain comment.
- **License header:** every `src/` and `test/` file starts with the MIT-0 header (`header.js`); ESLint enforces it.
- **Complexity:** ESLint (`complexity`) fails any function whose cyclomatic complexity is above 40, the ceiling shared with cdk and cli. Split the component or move logic into a hook or helper; do not add an `eslint-disable`.

## Boundaries

- 🚫 **Never** import from `src/mocks/` outside a `__MOCK__` guard (in `main.tsx`) or tests. Mock sign-in must never reach a production bundle. In `src/` ESLint accepts only `import()` inside `if (__MOCK__) { ... }`.
- 🚫 **Never** bind the dev or preview server beyond `127.0.0.1`.
- 🚫 **Never** put secrets in `/config.json` or the bundle; the Cognito app client is public (no secret).
- ⚠️ The console is a read projection of the API. Mutations (approve, deny, cancel, repo admin) go through the REST API with the same authorization as the CLI. Never add a privileged path that bypasses the API.
