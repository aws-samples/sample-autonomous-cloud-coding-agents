# ABCA operator console (`web/`)

This package is a browser console for the people who run an ABCA deployment.
The console shows what agents are working on, what is stuck, and what is
waiting for a human. It is a single-page React app that uses the
[Cloudscape](https://cloudscape.design/) design system. It talks only to the
existing REST API (`docs/design/API_CONTRACT.md`).

The opt-in `<stack>-console` CDK stack deploys the console on CloudFront,
private S3, and Cognito managed login. See "Optional operator console" in
`docs/guides/DEPLOYMENT_GUIDE.md`.

## Run it locally (no AWS account needed)

```bash
mise run install   # once, from the repo root
mise //web:dev:mock
# open http://127.0.0.1:5173
```

Mock mode serves a built-in fake API from a service worker (MSW). The fake API
has one task in every interesting state, such as running, stale heartbeat,
awaiting approval, queued, completed with a PR, and failed with a classified
error. You are signed in as `operator@example.com`. "Sign out" returns you to
the sign-in screen.

The dev server binds only to `127.0.0.1`.

## Run it locally against your deployment

Use this setup for UI work with real data and real sign-in, without a
redeploy. The dev server reloads on every save and talks to your deployed API.

```bash
# once: allow sign-in redirects to http://localhost:5173 on the console's app client
mise //cdk:deploy -- --all -c operatorConsole=true -c operatorConsoleDevOrigins=http://localhost:5173

export AWS_PROFILE=<your profile> AWS_REGION=<region>
mise //web:dev:live
# open http://localhost:5173 (use "localhost", not 127.0.0.1: it must match the redirect)
```

`dev:live` downloads your console's `config.json` into the git-ignored
`web/.config.local.json`, and the dev server serves that file as
`/config.json`. The file holds only public identifiers: the API URL, the user
pool id, the app client id, and the login domain. The dev server still binds
only to `127.0.0.1`.

## Pages

| Page | Source | Data |
|------|--------|------|
| Overview: counts and a "needs attention" list | `src/domains/overview/` | `GET /v1/tasks`, `GET /v1/pending` |
| Tasks: filterable list | `src/domains/tasks/TaskListPage.tsx` | `GET /v1/tasks` |
| Task detail: summary, error remedy, event timeline | `src/domains/tasks/TaskDetailPage.tsx` | `GET /v1/tasks/{id}`, `GET /v1/tasks/{id}/events` |
| Approvals: pending Cedar human-in-the-loop (HITL) gates | `src/domains/approvals/` | `GET /v1/pending` |
| Repositories: where your agents worked. Per repository, the open issues not started yet and its tasks | `src/domains/repos/` | `GET /v1/tasks`. Console API: `GET /repos/{repo}/issues`, `GET /repos/{repo}/linear-issues` |
| Scoreboard: speed, quality, leverage and trust of your finished tasks, up to the merge of their pull requests | `src/domains/scoreboard/` | `GET /v1/tasks?view=scoreboard` |
| Costs: spend per day by repository, outcome or source, the most expensive tasks, and your monthly limit | `src/domains/costs/` | `GET /v1/tasks`, `GET /v1/tasks?view=budget` |

Views poll every 10 to 15 seconds. Costs polls every minute, and the Scoreboard
polls every five minutes. The API has no browser push channel yet. The
Scoreboard also reloads when you open it or return to its tab. You create,
cancel or decide a task on other pages. Each of those actions marks the
Scoreboard stale, and your next visit to the Scoreboard reads it again.
"Needs attention" uses the orchestrator's heartbeat thresholds
(`src/core/util/task-health.ts`), so the console flags the tasks that the
platform's reconciler would act on. Like the orchestrator, the console does not
apply the thresholds to a task on ECS (`compute_type`), where the agent writes
its heartbeat once, at its start. The console never flags such a task as
quiet.

The API defines every Scoreboard number
(`cdk/src/handlers/shared/scoreboard.ts`), and the page formats the numbers.
The page's only arithmetic is presentation:

* a percentage from a fraction
* the merged share of the pull requests read
* a sum per verified pull request and per merged pull request
* the pull requests that ABCA does not follow, computed as a period's new pull
  requests minus the four states
* the six outcomes folded into the three parts of the bar

The page's sections and tiles are a list in `src/core/util/scoreboard.ts`,
where one entry adds a number to the page. In mock mode the Scoreboard numbers
are fixed samples that do not follow the mock tasks. "Last 30 days" is a busy
month with most of its pull requests merged. "Last 7 days" is two weeks without
a verified pull request in a repository whose pull requests ABCA has not read.
The two ranges therefore show the page with numbers and without numbers.

A bubble explains each of these numbers: the tiles and the parts of the outcome
bar on the Scoreboard, the four tiles on Costs, and the six counters on the
Overview. The bubble says what the number is, why it matters, and how it is
computed. The bubble opens when the pointer rests on the number. For a keyboard
or a finger, the bubble opens from the "i" beside the number's label
(`src/core/components/Explain.tsx`). A part of the bar takes the focus itself.
The Spend per day chart has a bubble only from the "i" in its header, because
its bars show their amounts on hover. The monthly limit meter and the numbers
of the task and repository pages have no bubble. Those pages keep the click "i"
(`InfoTip`). The three texts are data beside the label that they explain.
`Tile` requires the three texts, and `test/explanations.test.ts` limits each
text to the length that a bubble can carry.

The API scopes tasks to the signed-in user, so today the console shows **your**
tasks. A fleet-wide operator view needs admin-scoped endpoints (next increments).

## Commands

```bash
mise //web:build      # typecheck + test + lint + bundle (part of `mise run build`)
mise //web:test       # Vitest + Testing Library against the same MSW handlers
mise //web:eslint     # ESLint --fix
mise //web:eslint:check  # ESLint without --fix: reports only; a warning fails too
mise //web:dev:mock   # local mock mode
mise //web:dev:live   # local dev server against your deployment
```

## How mock code stays out of production

* The app imports the mock data, the mock API and the mock sign-in only behind
  the compile-time `__MOCK__` flag, which is true only for `vite --mode mock`,
  so the bundler removes them.
* The Vite config refuses `vite build --mode mock`.
* Outside mock mode, the console rejects a `/config.json` with
  `"auth": {"mode": "mock"}`.

## Runtime configuration

A deployed console reads `/config.json`. The CDK stack writes that file next to
the bundle, so one prebuilt bundle serves every deployment. For example:

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
(`src/app/config/runtime-config.ts`). It requires https, and it rejects an
unknown mode or a missing field.

## Layout

```
src/
  app/        shell: App (session gate), layout, providers (auth, api), config, app-level pages
  core/       shared: API client + wire types, components, utils (no pages)
  domains/    features with pages: overview, tasks, approvals, repos, scoreboard, costs
  mocks/      fixtures + MSW handlers (mock mode and tests only)
test/         mirrors src/; helpers/ holds the MSW server and render helper
```

Dependencies flow `domains/ -> core/ -> app/config`. The API wire types in
`src/core/api/types.ts` mirror the API's types
(`cdk/src/handlers/shared/types.ts`, and `cli/src/types.ts` for the envelopes)
as a subset. A wire type may leave members out, and
`mise run check:types-sync` fails when a declared member differs.
