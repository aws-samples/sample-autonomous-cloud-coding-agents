# ABCA operator console (`web/`)

A browser console for the people running an ABCA deployment: what agents are
working on, what is stuck, and what is waiting for a human. It is a single-page
React app using the [Cloudscape](https://cloudscape.design/) design system and
talks only to the existing REST API (`docs/design/API_CONTRACT.md`).

Deployed by the opt-in `<stack>-console` CDK stack (CloudFront + private S3 +
Cognito managed login); see "Optional operator console" in
`docs/guides/DEPLOYMENT_GUIDE.md`.

## Run it locally (no AWS account needed)

```bash
mise run install                       # once, from the repo root
MISE_EXPERIMENTAL=1 mise //web:dev:mock
# open http://127.0.0.1:5173
```

Mock mode serves a built-in fake API from a service worker (MSW) with one task
in every interesting state: running, stale heartbeat, awaiting approval, queued,
completed with a PR, failed with a classified error, and so on. You are signed
in as `operator@example.com`; "Sign out" returns you to the sign-in screen.

The dev server binds to `127.0.0.1` only.

## Run it locally against your deployment

For UI work with real data and real sign-in, without redeploying: the dev server
reloads on every save and talks to your deployed API.

```bash
# once: allow sign-in redirects to http://localhost:5173 on the console's app client
bash scripts/abca-onboard.sh --local-dev        # or: cdk deploy ... -c operatorConsoleDevOrigins=http://localhost:5173

export AWS_PROFILE=<your profile> AWS_REGION=<region>
MISE_EXPERIMENTAL=1 mise //web:dev:live
# open http://localhost:5173 (use "localhost", not 127.0.0.1: it must match the redirect)
```

`dev:live` downloads your console's `config.json` (public identifiers only: API
URL, user pool and app client ids, login domain) into the git-ignored
`web/.config.local.json`, and the dev server serves it as `/config.json`. The
server still binds to `127.0.0.1` only.

## Pages

| Page | Source | Data |
|------|--------|------|
| Overview: counts and a "needs attention" list | `src/domains/overview/` | `GET /v1/tasks`, `GET /v1/pending` |
| Tasks: filterable list | `src/domains/tasks/TaskListPage.tsx` | `GET /v1/tasks` |
| Task detail: summary, error remedy, event timeline | `src/domains/tasks/TaskDetailPage.tsx` | `GET /v1/tasks/{id}`, `GET /v1/tasks/{id}/events` |
| Approvals: pending Cedar HITL gates | `src/domains/approvals/` | `GET /v1/pending` |

Views poll (10-15 s); the API has no browser push channel yet. "Needs
attention" uses the orchestrator's heartbeat thresholds
(`src/core/util/task-health.ts`), so the console flags what the platform's
reconciler would act on.

The API scopes tasks to the signed-in user, so today the console shows **your**
tasks. A fleet-wide operator view needs admin-scoped endpoints (next increments).

## Commands

```bash
MISE_EXPERIMENTAL=1 mise //web:build      # typecheck + test + lint + bundle (part of `mise run build`)
MISE_EXPERIMENTAL=1 mise //web:test       # Vitest + Testing Library against the same MSW handlers
MISE_EXPERIMENTAL=1 mise //web:eslint     # ESLint --fix
MISE_EXPERIMENTAL=1 mise //web:dev:mock   # local mock mode
MISE_EXPERIMENTAL=1 mise //web:dev:live   # local dev server against your deployment
```

## How mock code stays out of production

* Mock data, mock API and mock sign-in are imported only behind the compile-time
  `__MOCK__` flag (true only for `vite --mode mock`), so the bundler removes them.
* `vite build --mode mock` is refused.
* `/config.json` with `"auth": {"mode": "mock"}` is rejected outside mock mode.

## Runtime configuration

A deployed console reads `/config.json`, written next to the bundle by the CDK
stack, so one prebuilt bundle serves every deployment:

```json
{
  "apiBaseUrl": "https://abc123.execute-api.us-east-1.amazonaws.com/v1",
  "region": "us-east-1",
  "auth": {
    "mode": "cognito",
    "userPoolId": "us-east-1_AbCdEf",
    "userPoolClientId": "public-client-id",
    "domain": "https://my-factory.auth.us-east-1.amazoncognito.com"
  }
}
```

None of these values are secrets. Validation fails closed
(`src/app/config/runtime-config.ts`): https is required, and unknown modes or
missing fields are rejected.

## Layout

```
src/
  app/        shell: App (session gate), layout, providers (auth, api), config, app-level pages
  core/       shared: API client + wire types, components, utils (no pages)
  domains/    features with pages: overview, tasks, approvals
  mocks/      fixtures + MSW handlers (mock mode and tests only)
test/         mirrors src/; helpers/ holds the MSW server and render helper
```

Dependencies flow `domains/ -> core/ -> app/config`. API wire types in
`src/core/api/types.ts` mirror `cli/src/types.ts`; keep them identical.
