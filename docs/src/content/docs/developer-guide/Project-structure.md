---
title: Project structure
---

Top-level layout:

| Path | Purpose |
| --- | --- |
| `src/` | CDK app (`main.ts`, `stacks/`, `constructs/`, `handlers/`) |
| `cli/` | `@backgroundagent/cli` — `bgagent` CLI (Projen `TypeScriptProject` subproject) |
| `agent/` | Python agent — Docker image, server, prompts |
| `test/` | Jest tests for the CDK app (mirrors `src/`) |
| `docs/guides/` | Source Markdown: developer, user, roadmap, prompt guides |
| `docs/design/` | Architecture and design documents (source Markdown) |
| `docs/imgs/`, `docs/diagrams/` | Documentation assets |
| `docs/` (Starlight) | Docs site: `astro.config.mjs`, `package.json`; `src/content/docs/` is **generated** from `.projenrc.ts` on `npx projen` |
| `CONTRIBUTING.md` | Contribution guidelines (**repo root**) |
| `.projenrc.ts` | Root + `cli/` + `docs/` site definition; run `npx projen` after edits |

CDK source tree:

```
src/
├── main.ts                          # CDK app entry point
├── stacks/
│   └── agent.ts                     # Main CDK stack
├── constructs/
│   ├── task-table.ts                # TaskTable DynamoDB construct
│   ├── task-events-table.ts         # TaskEventsTable DynamoDB construct
│   ├── user-concurrency-table.ts    # UserConcurrencyTable DynamoDB construct
│   ├── webhook-table.ts             # WebhookTable DynamoDB construct
│   ├── repo-table.ts                # RepoTable DynamoDB construct (per-repo config)
│   ├── blueprint.ts                 # Blueprint construct (repo onboarding via custom resource)
│   ├── task-api.ts                  # Task API construct (API Gateway, Cognito, Lambdas)
│   ├── task-orchestrator.ts         # Durable orchestrator Lambda construct
│   └── task-status.ts               # Task status constants and state machine
├── handlers/
│   ├── create-task.ts               # POST /tasks Lambda (Cognito)
│   ├── get-task.ts                  # GET /tasks/{task_id} Lambda
│   ├── list-tasks.ts                # GET /tasks Lambda
│   ├── cancel-task.ts               # DELETE /tasks/{task_id} Lambda
│   ├── orchestrate-task.ts          # Durable orchestrator handler
│   ├── get-task-events.ts           # GET /tasks/{task_id}/events Lambda
│   ├── create-webhook.ts            # POST /webhooks Lambda (Cognito)
│   ├── list-webhooks.ts             # GET /webhooks Lambda (Cognito)
│   ├── delete-webhook.ts            # DELETE /webhooks/{webhook_id} Lambda (Cognito)
│   ├── webhook-authorizer.ts        # REQUEST authorizer (webhook lookup)
│   ├── webhook-create-task.ts       # POST /webhooks/tasks Lambda (HMAC-SHA256 verification)
│   └── shared/
│       ├── create-task-core.ts      # Shared task creation logic (Cognito + webhook)
│       ├── context-hydration.ts     # GitHub issue fetching, prompt assembly, token budget
│       ├── gateway.ts               # User extraction, webhook context, branch naming
│       ├── logger.ts                # Structured logger
│       ├── orchestrator.ts          # Orchestrator step helpers (DDB, AgentCore, concurrency)
│       ├── repo-config.ts           # RepoConfig types, onboarding gate, config loader
│       ├── response.ts              # API response helpers
│       ├── types.ts                 # Shared TypeScript interfaces
│       └── validation.ts            # Input validation utilities
```

```
test/
├── stacks/
│   └── agent.test.ts
├── constructs/
│   ├── task-table.test.ts
│   ├── task-events-table.test.ts
│   ├── user-concurrency-table.test.ts
│   ├── webhook-table.test.ts
│   ├── repo-table.test.ts
│   ├── blueprint.test.ts
│   ├── task-api.test.ts
│   ├── task-orchestrator.test.ts
│   └── task-status.test.ts
└── handlers/
    ├── create-task.test.ts
    ├── get-task.test.ts
    ├── list-tasks.test.ts
    ├── cancel-task.test.ts
    ├── orchestrate-task.test.ts
    ├── get-task-events.test.ts
    ├── create-webhook.test.ts
    ├── list-webhooks.test.ts
    ├── delete-webhook.test.ts
    ├── webhook-authorizer.test.ts
    ├── webhook-create-task.test.ts
    └── shared/
        ├── create-task-core.test.ts
        ├── context-hydration.test.ts
        ├── gateway.test.ts
        ├── repo-config.test.ts
        ├── response.test.ts
        └── validation.test.ts
```