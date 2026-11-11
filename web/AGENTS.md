# Web console package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md) · Human guide: [README.md](./README.md)

You maintain the **operator console** (`@abca/web`): React 19, Vite, React Router 7, Cloudscape, TanStack Query, Vitest + Testing Library, MSW.

## Commands (run these)

```bash
mise //web:build      # typecheck + test + lint + bundle
mise //web:test       # Vitest only
mise //web:eslint     # ESLint --fix
mise //web:eslint:check  # ESLint without --fix: reports only; a warning fails too
mise //web:dev:mock   # local console on http://127.0.0.1:5173 against the mock API
```

Single test file: `cd web && yarn vitest run test/domains/tasks/TaskListPage.test.tsx`.

## Conventions

- **Layers:** `app/` (shell, providers, config) · `core/` (API client, wire types, shared components/utils; no pages) · `domains/<feature>/` (pages + hooks). `core/` must not import from `domains/`.
- **Server state:** TanStack Query hooks colocated in `domains/<feature>/hooks.ts`. No other state library.
- **Cloudscape:** import components directly (`@cloudscape-design/components/<name>`); no pass-through wrappers. Use `RouterLink`/`ExternalLink` from `core/components/RouterLink.tsx` for links.
- **Wire types:** `src/core/api/types.ts` mirrors `cli/src/types.ts`. Change both when the API changes.
- **Tests:** `test/` mirrors `src/`. Page tests render real routes through `test/helpers/render.tsx` against the MSW server in `test/helpers/server.ts`, which uses the same handlers as mock mode. Add a fixture in `src/mocks/fixtures.ts` for each new state the UI must handle.
- **License header:** every `src/` and `test/` file starts with the MIT-0 header (`header.js`); ESLint enforces it.

## Boundaries

- 🚫 **Never** import from `src/mocks/` outside a `__MOCK__` guard (in `main.tsx`) or tests. Mock sign-in must never reach a production bundle.
- 🚫 **Never** bind the dev or preview server beyond `127.0.0.1`.
- 🚫 **Never** put secrets in `/config.json` or the bundle; the Cognito app client is public (no secret).
- ⚠️ The console is a read projection of the API. Mutations (approve, deny, cancel, repo admin) go through the REST API with the same authorization as the CLI. Never add a privileged path that bypasses the API.
