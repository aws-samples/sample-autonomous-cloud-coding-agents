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
MISE_EXPERIMENTAL=1 mise //cdk:deploy -- --all -c operatorConsole=true -c operatorConsoleDevOrigins=http://localhost:5173

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
| Repositories: where your agents worked; per repository, the open issues not started yet and its tasks | `src/domains/repos/` | `GET /v1/tasks`; console API `GET /repos/{repo}/issues`, `GET /repos/{repo}/linear-issues` |
| Scoreboard: speed, quality, leverage and trust of your finished tasks, up to the pull request | `src/domains/scoreboard/` | `GET /v1/tasks?view=scoreboard` |
| Costs: spend per day by repository, outcome or source, the most expensive tasks, your monthly limit | `src/domains/costs/` | `GET /v1/tasks`, `GET /v1/tasks?view=budget` |

Views poll (10-15 s; Costs every minute; the Scoreboard every five minutes); the
API has no browser push channel yet. The Scoreboard also reloads when you open
it or return to its tab. Creating, cancelling or deciding a task happens on
other pages: it marks the Scoreboard stale, and the next visit reads it again.
"Needs attention" uses the orchestrator's heartbeat thresholds
(`src/core/util/task-health.ts`), so the console flags what the platform's
reconciler would act on.

The API defines every Scoreboard number (`cdk/src/handlers/shared/scoreboard.ts`);
the page formats them and divides the two figures per verified pull request.
Its sections and tiles are a list in `src/core/util/scoreboard.ts`, where a
number is added to the page with one entry. In mock mode the Scoreboard numbers
are fixed samples that do not follow the mock tasks: "Last 30 days" is a busy
month, "Last 7 days" a week without a verified pull request, so the two ranges
show the page with and without numbers.

The tiles and the parts of the outcome bar on the Scoreboard, the four tiles on
Costs and the six counters on the Overview explain themselves in a bubble: what
it is, why it matters, how it is computed. The bubble opens when the pointer
rests on the number, and from the "i" beside its label for a keyboard or a
finger (`src/core/components/Explain.tsx`); a part of the bar takes the focus
itself. The Spend per day chart explains itself from the "i" in its header
only, because its bars show their amounts on hover. The monthly limit meter and
the numbers of the task and repository pages have no bubble: those pages keep
the click "i" (`InfoTip`). The three texts are data beside the label they
explain: `Tile` requires them, and `test/explanations.test.ts` holds each one
to the length a bubble can carry.

The API scopes tasks to the signed-in user, so today the console shows **your**
tasks. A fleet-wide operator view needs admin-scoped endpoints (next increments).

## Commands

```bash
MISE_EXPERIMENTAL=1 mise //web:build      # typecheck + test + lint + bundle (part of `mise run build`)
MISE_EXPERIMENTAL=1 mise //web:test       # Vitest + Testing Library against the same MSW handlers
MISE_EXPERIMENTAL=1 mise //web:eslint     # ESLint --fix
MISE_EXPERIMENTAL=1 mise //web:eslint:check  # ESLint without --fix: reports only; a warning fails too
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
  domains/    features with pages: overview, tasks, approvals, repos, scoreboard, costs
  mocks/      fixtures + MSW handlers (mock mode and tests only)
test/         mirrors src/; helpers/ holds the MSW server and render helper
```

Dependencies flow `domains/ -> core/ -> app/config`. API wire types in
`src/core/api/types.ts` mirror the API's types (`cdk/src/handlers/shared/types.ts`,
and `cli/src/types.ts` for the envelopes) as a subset: a type may leave members
out, and `mise run check:types-sync` fails when a declared member differs.
