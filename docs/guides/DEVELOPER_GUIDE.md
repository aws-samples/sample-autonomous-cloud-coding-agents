# Developer guide

This project is built in TypeScript with [Yarn workspaces](https://classic.yarnpkg.com/lang/en/docs/workspaces/), [mise](https://mise.jdx.dev/) for tasks and tool versions, and AWS CDK for infrastructure. There is project-wide testing, code checks, and compilation. There is currently no dedicated development container, so you need to configure your local development environment by following the steps below.

![ABCA architecture](../imgs/abca-arch.png)

The repository is organized around four main pieces:

- **Agent runtime code** in Python under `agent/`  - runtime entrypoint, task execution loop, memory writes, observability hooks, and local container tooling.
- **Infrastructure as code** in AWS CDK under `cdk/src/`  - stacks, constructs, and handlers that define and deploy the platform on AWS.
- **Documentation site** under `docs/`  - source guides/design docs plus the generated Astro/Starlight documentation site.
- **CLI package** under `cli/`  - the `bgagent` command-line client used to authenticate, submit tasks, and inspect task status/events.
- **Claude Code plugin** under `docs/abca-plugin/`  - a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) with guided skills and agents for setup, deployment, task submission, and troubleshooting. See the [plugin README](../abca-plugin/README.md) for details.

> **Tip:** If you use Claude Code, run `claude --plugin-dir docs/abca-plugin` from the repo root. The plugin's `/setup` skill walks you through the entire setup process interactively.

## Where to make changes

Before editing, decide which part of the monorepo owns the behavior. This keeps API types, CLI, and docs in sync.

| Area | Paths | Notes |
|------|--------|--------|
| API & Lambdas | `cdk/src/handlers/`, `cdk/src/stacks/`, `cdk/src/constructs/` | Extend `cdk/test/` for the same feature. |
| API types | `cdk/src/handlers/shared/types.ts` and **`cli/src/types.ts`** | Update both when request/response shapes change. |
| CLI | `cli/src/`, `cli/test/` |  - |
| Agent runtime | `agent/` | Bundled into the image CDK deploys; run `mise run quality` in `agent/` or root build. |
| Docs (source) | `docs/guides/`, `docs/design/` | After edits, run **`mise //docs:sync`** or **`mise //docs:build`**. Do not edit `docs/src/content/docs/` directly. |

For a concise duplicate of this table, common pitfalls, and a CDK test file map, see **[AGENTS.md](../../AGENTS.md)** at the repo root (oriented toward automation-assisted contributors).

## Repository preparation

The [Quick Start](./QUICK_START.md) covers the basic setup: forking a sample repo, creating a PAT, registering a Blueprint, and storing the token in Secrets Manager. This section covers what you need beyond that.

### Pre-flight checks

After deployment, the orchestrator calls the GitHub API before starting each task to verify your token has enough privilege. This catches common mistakes (like a read-only PAT) before compute is consumed. If the check fails, the task transitions to `FAILED` with a clear reason like `INSUFFICIENT_GITHUB_REPO_PERMISSIONS` instead of failing deep inside the agent run.

Permission requirements vary by task type:

- `new_task` and `pr_iteration` require Contents (read/write) and Pull requests (read/write).
- `pr_review` only needs Triage or higher since it does not push branches.

Classic PATs with `repo` scope also work. See `agent/README.md` for edge cases.

### Multiple repositories

To onboard additional repositories, add more `Blueprint` constructs in `cdk/src/stacks/agent.ts` and append them to the `blueprints` array (used to aggregate DNS egress allowlists):

```typescript
new Blueprint(this, ‘MyServiceBlueprint’, {
  repo: ‘acme/my-service’,
  repoTable: repoTable.table,
});
```

Each Blueprint supports per-repo overrides: `runtimeArn`, `modelId`, `maxTurns`, `systemPromptOverrides`, `githubTokenSecretArn`, and `pollIntervalMs`. If you use a custom `runtimeArn` or secret, pass the ARNs to `TaskOrchestrator` via `additionalRuntimeArns` and `additionalSecretArns` so the Lambda has IAM permission. See [Repo onboarding](../design/REPO_ONBOARDING.md) for the full model.

Redeploy after changing Blueprints: `mise run //cdk:deploy`.

### Customizing the agent image

The default image (`agent/Dockerfile`) includes Python, Node 20, `git`, `gh`, Claude Code CLI, and `mise`. If your repositories need additional runtimes (Java, Go, native libs), extend the Dockerfile. A normal `cdk deploy` rebuilds the image asset.

### Other options

- **Stack name** - The default is `backgroundagent-dev` (set in `cdk/src/main.ts`). If you rename it, update all `--stack-name` references.
- **Making repos agent-friendly** - Add `CLAUDE.md`, `.claude/rules/`, and clear build commands. See the [Prompt guide](./PROMPT_GUIDE.md#repo-level-instructions) for details.

## Installation

Follow the [Quick Start](./QUICK_START.md) to clone, install, deploy, and submit your first task. It covers prerequisites, toolchain setup, deployment, PAT configuration, Cognito user creation, and a smoke test.

This section covers what the Quick Start does not: troubleshooting, local testing, and the development workflow.

### Troubleshooting mise

If `mise run install` fails or versions look wrong:

| Symptom | Fix |
|---------|-----|
| `yarn: command not found` | Activate mise in your shell (`eval "$(mise activate zsh)"`), then `corepack enable && corepack prepare yarn@1.22.22 --activate`. |
| `node` is not v22 | Activate mise in your shell, then `mise install` from the repo root. |
| Mise errors about untrusted config | `mise trust` from the repo root, then `mise install` again. |
| `MISE_EXPERIMENTAL` required | `export MISE_EXPERIMENTAL=1` for namespaced tasks like `mise //cdk:build`. |

Minimal recovery sequence:

```bash
eval "$(mise activate zsh)"   # or bash; add permanently to your shell rc file
cd /path/to/sample-autonomous-cloud-coding-agents
mise trust && mise install
corepack enable && corepack prepare yarn@1.22.22 --activate
export MISE_EXPERIMENTAL=1
mise run install
```

### Development workflow

Use this order to iterate quickly and catch issues early:

1. **Test Python agent code first** (fast feedback):

   ```bash
   cd agent && mise run quality && cd ..
   ```

2. **Test through the local Docker runtime** using `./agent/run.sh` (see Local testing below).
3. **Deploy with CDK** once local checks pass.

### Local testing

Before deploying, you can run the agent Docker container locally. The `agent/run.sh` script builds the image, resolves AWS credentials, and applies AgentCore-matching resource constraints (2 vCPU, 8 GB RAM) so the local environment mirrors production.

The script validates AWS credentials before starting the Docker build, so problems like an expired SSO session surface immediately.

#### Setup

The `owner/repo` you pass must match an onboarded Blueprint and be a repository your `GITHUB_TOKEN` can push to and open PRs on.

```bash
export GITHUB_TOKEN="ghp_..."     # Fine-grained PAT
export AWS_REGION="us-east-1"     # Region where Bedrock models are enabled
```

The script resolves AWS credentials in priority order:

1. **Environment variables** - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` for temporary credentials.
2. **AWS CLI** - Runs `aws configure export-credentials` from your active profile or SSO session. Set `AWS_PROFILE` to target a specific profile.
3. **`~/.aws` mount** - Bind-mounts the directory read-only. Works for static credentials but not SSO tokens.

If none succeeds, the container starts without AWS credentials and any AWS API call will fail at runtime.

#### Running tasks

```bash
# Run against a GitHub issue
./agent/run.sh "owner/repo" 42

# Run with a text description
./agent/run.sh "owner/repo" "Add input validation to the /users POST endpoint"

# Issue + additional instructions
./agent/run.sh "owner/repo" 42 "Focus on the backend validation only"

# Dry run - validate config, fetch issue, print prompt, then exit
DRY_RUN=1 ./agent/run.sh "owner/repo" 42
```

The second argument is auto-detected: numeric values are issue numbers, anything else is a task description.

#### Server mode

In production, the container runs as a FastAPI server. You can test this locally:

```bash
# Start the server
./agent/run.sh --server "owner/repo"

# In another terminal:
curl http://localhost:8080/ping

curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d ‘{"input":{"prompt":"Fix the login bug","repo_url":"owner/repo"}}’
```

#### Monitoring

The container runs with a fixed name (`bgagent-run`):

```bash
docker logs -f bgagent-run                        # live agent output
docker stats bgagent-run                          # CPU, memory usage
docker exec -it bgagent-run bash                  # shell into the container
```

#### Testing with progress events (DynamoDB Local)

By default, progress events and task state writes are silently skipped during local runs (the `TASK_EVENTS_TABLE_NAME` and `TASK_TABLE_NAME` env vars are not set). To enable them locally using DynamoDB Local:

```bash
# 1. Start DynamoDB Local and create tables
cd agent && mise run local:up

# 2. Run the agent with --local-events
./agent/run.sh --local-events "owner/repo" 42

# 4. In another terminal — query progress events
mise run local:events          # table format
mise run local:events:json     # JSON format

# 5. When done — tear down DynamoDB Local
mise run local:down
```

The `--local-events` flag connects the agent container to DynamoDB Local on the `agent-local` Docker network and sets the appropriate env vars. The agent code writes to DDB Local using the same code path as production — no mocks or alternate implementations.

#### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `us.anthropic.claude-sonnet-4-6` | Bedrock model ID |
| `MAX_TURNS` | `100` | Max agent turns before stopping |
| `MAX_BUDGET_USD` | | Cost ceiling for local batch runs only (production uses the API field) |
| `DRY_RUN` | | Set to `1` to validate and print prompt without running the agent |

For the full list, see `agent/README.md`.

#### Troubleshooting

| Symptom | Fix |
|---|---|
| `ERROR: Failed to resolve AWS credentials via AWS CLI` | Run `aws sso login` if using SSO, or export `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` directly. |
| `ERROR: GITHUB_TOKEN is not set` | Export `GITHUB_TOKEN` with the required scopes. |
| `WARNING: No AWS credentials detected` | Configure one of the three credential methods above. |
| `WARNING: Image exceeds AgentCore 2 GB limit!` | Reduce dependencies or use multi-stage Docker build. |

### Deployment

Follow the [Quick Start](./QUICK_START.md) steps 3-6 for first-time deployment. For subsequent deploys after code changes:

```bash
mise run build
mise run //cdk:deploy
```

A full deploy takes approximately 10 minutes. Expect variation by region and whether container layers are cached.

### Stack outputs

After deployment, the stack emits these outputs (retrieve with `aws cloudformation describe-stacks --stack-name backgroundagent-dev --query ‘Stacks[0].Outputs’ --output table`):

| Output | Description |
|---|---|
| `RuntimeArn` | AgentCore runtime ARN |
| `ApiUrl` | Task REST API base URL |
| `UserPoolId` / `AppClientId` | Cognito identifiers |
| `TaskTableName` | DynamoDB table for task state |
| `TaskEventsTableName` | DynamoDB table for audit events |
| `UserConcurrencyTableName` | DynamoDB table for per-user concurrency |
| `WebhookTableName` | DynamoDB table for webhook integrations |
| `RepoTableName` | DynamoDB table for per-repo Blueprint config |
| `GitHubTokenSecretArn` | Secrets Manager secret ARN for the GitHub PAT |

Use the same AWS Region as your deployment. If `--region` is omitted, the CLI uses your default from `aws configure`.

## Project structure

The repository is a monorepo with four packages. Each one owns a piece of the platform and has its own build, tests, and mise tasks.

```
sample-autonomous-cloud-coding-agents/
├── cdk/          # Infrastructure and API (TypeScript, AWS CDK)
├── agent/        # Agent runtime (Python, Docker)
├── cli/          # CLI client (TypeScript, commander)
├── docs/         # Documentation site (Astro/Starlight)
├── mise.toml     # Monorepo task runner config
└── package.json  # Yarn workspace root
```

A task flows through these packages in order: the **CLI** (or webhook) sends a request to the **CDK**-deployed API, the orchestrator Lambda prepares the task and launches an **agent** session in an isolated compute environment, and the agent works autonomously until it opens a PR or the task ends. The **docs** package is independent and only affects the documentation site.

```mermaid
flowchart LR
    CLI["cli/ or webhook"] -->|REST API| CDK["cdk/ (API + orchestrator)"]
    CDK -->|launches session| Agent["agent/ (in compute env)"]
    Agent -->|opens PR| GH[GitHub]
```

Below is a task-oriented guide for each package: "I want to change X - where do I look?"

### `cdk/` - Infrastructure and API (TypeScript)

Everything that runs on AWS: the CDK stack, Lambda handlers, and DynamoDB table definitions. This is where most backend changes happen.

| I want to... | Look at |
|---|---|
| Add or change an API endpoint | `cdk/src/handlers/` for the Lambda, `cdk/src/constructs/task-api.ts` for the API Gateway wiring |
| Change task validation or admission | `cdk/src/handlers/shared/validation.ts`, `cdk/src/handlers/shared/create-task-core.ts` |
| Modify the orchestration flow | `cdk/src/handlers/orchestrate-task.ts`, `cdk/src/handlers/shared/orchestrator.ts` |
| Change how context is assembled for the agent | `cdk/src/handlers/shared/context-hydration.ts` |
| Add a DynamoDB table or modify a schema | `cdk/src/constructs/` (one construct per table) |
| Onboard repos or change Blueprint behavior | `cdk/src/constructs/blueprint.ts`, `cdk/src/stacks/agent.ts` |
| Change webhook authentication | `cdk/src/handlers/webhook-authorizer.ts`, `cdk/src/handlers/webhook-create-task.ts` |
| Add or update tests | `cdk/test/` mirrors `cdk/src/` - each handler and construct has a colocated test file |

Key convention: API request/response types live in `cdk/src/handlers/shared/types.ts`. If you change them, also update `cli/src/types.ts` to keep the CLI in sync.

Build and test: `mise //cdk:build` (compile + lint + test + synth).

### `agent/` - Agent runtime (Python)

The code that runs inside the compute environment (AgentCore MicroVM). This is the agent itself: the execution loop, system prompts, tool configuration, memory writes, and the Docker image.

| I want to... | Look at |
|---|---|
| Change what the agent does during a task | `agent/src/pipeline.py` (execution flow), `agent/src/runner.py` (CLI invocation) |
| Modify system prompts | `agent/prompts/` - base template and per-task-type variants (`new_task`, `pr_iteration`, `pr_review`) |
| Change agent configuration or environment | `agent/src/config.py` |
| Add or modify hooks (pre/post execution) | `agent/src/hooks.py` |
| Change the Docker image (add runtimes, tools) | `agent/Dockerfile` |
| Run agent quality checks | `mise //agent:quality` (lint, type check, tests) |

Build and test: `mise //agent:quality`. The CDK build bundles the agent image, so agent changes are picked up by `mise run build`.

### `cli/` - CLI client (TypeScript)

The `bgagent` command-line tool. Authenticates via Cognito, calls the REST API, and formats output.

| I want to... | Look at |
|---|---|
| Add a new CLI command | `cli/src/commands/` (one file per command), `cli/src/bin/bgagent.ts` (program setup) |
| Change how the CLI calls the API | `cli/src/api-client.ts` |
| Modify authentication or token handling | `cli/src/auth.ts` |
| Update API types | `cli/src/types.ts` (must match `cdk/src/handlers/shared/types.ts`) |

Build and test: `mise //cli:build`.

### `docs/` - Documentation site (Astro/Starlight)

Source docs live in `docs/guides/` and `docs/design/`. The Starlight site under `docs/src/content/docs/` is generated - do not edit it directly.

| I want to... | Look at |
|---|---|
| Update a user-facing guide | `docs/guides/` (USER_GUIDE.md, DEVELOPER_GUIDE.md, QUICK_START.md, PROMPT_GUIDE.md, ROADMAP.md) |
| Update an architecture doc | `docs/design/` |
| Change the sidebar or site config | `docs/astro.config.mjs` |
| Change how docs are synced | `docs/scripts/sync-starlight.mjs` |

After editing source docs, run `mise //docs:sync` or `mise //docs:build` to regenerate the site.
