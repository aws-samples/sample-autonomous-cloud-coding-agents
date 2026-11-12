---
title: "Project structure"
---

The repository is a monorepo with five packages. Each one owns a piece of the platform and has its own build, tests, and mise tasks.

```
sample-autonomous-cloud-coding-agents/
├── cdk/          # Infrastructure and API (TypeScript, AWS CDK)
├── agent/        # Agent runtime (Python, Docker)
├── cli/          # CLI client (TypeScript, commander)
├── web/          # Operator console (TypeScript, React)
├── docs/         # Documentation site (Astro/Starlight)
├── mise.toml     # Monorepo task runner config
└── package.json  # Yarn workspace root
```

A task flows through these packages in order: the **CLI** (or webhook) sends a request to the **CDK**-deployed API, the orchestrator Lambda prepares the task and launches an **agent** session in an isolated compute environment, and the agent works autonomously until it opens a PR or the task ends. The **web** console uses the same REST API and is deployed only with the opt-in console stack. The **docs** package is independent and only affects the documentation site.

```mermaid
flowchart LR
    CLI["cli/ or webhook"] -->|REST API| CDK["cdk/ (API + orchestrator)"]
    CDK -->|launches session| Agent["agent/ (in compute env)"]
    Agent -->|opens PR| GH[GitHub]
```

Below is a task-oriented guide for each package: "I want to change X - where do I look?" For the operator console, see [web/README.md](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/web/README.md).

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

Key convention: API request/response types live in `cdk/src/handlers/shared/types.ts`. If you change them, also update `cli/src/types.ts` to keep the CLI in sync, and `web/src/core/api/types.ts` where the console mirrors the type.

Build and test: `mise //cdk:build` (compile + lint + type-check + test + synth).

### `agent/` - Agent runtime (Python)

The code that runs inside the compute environment (AgentCore MicroVM). This is the agent itself: the execution loop, system prompts, tool configuration, memory writes, and the Docker image.

| I want to... | Look at |
|---|---|
| Change what the agent does during a task | `agent/src/pipeline.py` (execution flow), `agent/src/runner.py` (CLI invocation) |
| Modify system prompts | `agent/src/prompts/` - base template and per-workflow variants (`coding/new-task-v1`, `coding/pr-iteration-v1`, `coding/pr-review-v1`) |
| Change agent configuration or environment | `agent/src/config.py` |
| Add or modify hooks (pre/post execution) | `agent/src/hooks.py` |
| Change the Docker image (add runtimes, tools) | `agent/Dockerfile` |
| Run agent quality checks | `mise //agent:quality` (lint, format, type check, dead code, tests). When the lint step has fixed a file it fails once and lists the fixes: run the task again |

Build and test: `mise //agent:quality`. The unit tests run with the AWS credential sources removed and refuse every request that botocore tries to send; a refused request fails the run and is listed in the `AWS send guard` section at the end of the output (details in [agent/AGENTS.md](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/agent/AGENTS.md)). The CDK build bundles the agent image, so agent changes are picked up by `mise run build`.

### `cli/` - CLI client (TypeScript)

The `bgagent` command-line tool. Authenticates via Cognito, calls the REST API, and formats output.

| I want to... | Look at |
|---|---|
| Add a new CLI command | `cli/src/commands/` (one file per command), `cli/src/bin/bgagent.ts` (program setup) |
| Change how the CLI calls the API | `cli/src/api-client.ts` |
| Modify authentication or token handling | `cli/src/auth.ts` |
| Update API types | `cli/src/types.ts` (must match `cdk/src/handlers/shared/types.ts`; the console's subset mirror is `web/src/core/api/types.ts`) |

Build and test: `mise //cli:build`.

### `docs/` - Documentation site (Astro/Starlight)

Source docs live in `docs/guides/`, `docs/design/` and `docs/decisions/`; the root `CONTRIBUTING.md` is mirrored as well. The Starlight site under `docs/src/content/docs/` is generated - do not edit it directly.

| I want to... | Look at |
|---|---|
| Update a user-facing guide | `docs/guides/` (USER_GUIDE.md, DEVELOPER_GUIDE.md, QUICK_START.mdx, PROMPT_GUIDE.md) |
| Update an architecture doc | `docs/design/` |
| Change the sidebar or site config | `docs/astro.config.mjs` |
| Change how docs are synced | `docs/scripts/sync-starlight.mjs` |

After editing source docs, run `mise //docs:sync` or `mise //docs:build` to regenerate the site.

Two checks keep cross-references intact. Both run in CI on every pull request, as part of the required build:

- `mise //docs:link-check` checks the relative links of every Markdown file in the repository, tracked or new (a file that git ignores is not read): the sources in `docs/guides/`, `docs/design/` and `docs/decisions/`, and also package READMEs, `AGENTS.md` files, plugin skills and command files. It confirms that the target file exists and that an anchor within the same file exists; it does not check an anchor that points into another file.
- `mise //docs:build` validates every internal link and anchor of the rendered site, anchors into other pages included, and fails with the page, line and link.

External `http(s)` URLs are deliberately not checked, so that network or bot-block flakiness cannot fail an unrelated PR.

A third check, also part of the required build, keeps the structure of the sources intact. `mise //docs:markdown-lint`, which `mise //docs:build` also runs, lints every tracked Markdown file with five rules: a table row whose cells do not match the header (renderers drop the extra cells), an image without alt text, a second top-level heading, a heading repeated under the same parent, and a skipped heading level. It reports the file, the line and the rule; [docs/AGENTS.md](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/AGENTS.md) lists the fix for each. A `markdownlint-disable` comment does not silence it. With the git hooks installed, the same lint also runs at commit time when a Markdown file is staged, so a broken table fails the commit and not only the build.