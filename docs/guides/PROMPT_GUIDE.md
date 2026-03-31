# Prompt guide

Writing effective task descriptions for ABCA.

## Introduction

ABCA agents are **unattended** — once a task is submitted, the agent works autonomously from start to finish. It cannot ask clarifying questions, request additional context, or pause for feedback. Every decision is made based on what you provide upfront.

This means **prompt quality directly determines task success**. A well-written task description gives the agent everything it needs to produce a good pull request. A vague or overly prescriptive one leads to wasted turns, wrong assumptions, or partial results.

This guide covers how to write effective task descriptions, common anti-patterns to avoid, and tips for getting the most out of the platform. For submission mechanics (CLI flags, API fields, webhook setup), see the [User guide](./USER_GUIDE.md).

## How the agent sees your task

When you submit a task, the platform does not pass your input directly to the agent. Instead, it goes through a **context hydration** step — a distinct phase in the task lifecycle (you'll see the task status change to `HYDRATING`) where the platform fetches external data and assembles the full prompt on your behalf. During hydration:

- If you provided `--issue`, the platform calls the GitHub API to fetch the issue title, body, and comments.
- Your task description, the issue content, and task metadata are combined into a single **user prompt**.
- If the assembled prompt exceeds the token budget, older issue comments are trimmed to fit.

The hydrated prompt is then passed to the agent alongside a fixed **system prompt**. Understanding this assembly helps you write better descriptions — you control what goes in, but the platform decides the final shape.

### What the agent receives

The agent's input consists of two parts:

1. **System prompt** (platform default) — Defines the agent's behavioral contract: understand the codebase, make changes, test, commit, and create a PR. If your platform administrator has configured `system_prompt_overrides` in the Blueprint for your repository, those are appended to the platform default.
2. **Repo-level instructions** (from your repository) — If your repository contains a `CLAUDE.md`, `.claude/CLAUDE.md`, or `.claude/rules/*.md`, the agent automatically loads these as additional context alongside the system prompt. This is the primary way to customize agent behavior per repository (see [Repo-level instructions](#repo-level-instructions) below).
3. **User prompt** (assembled from your input) — Built from these fields, in order:

```
Task ID: bgagent-01HYX...
Repository: owner/repo

## GitHub Issue #42: Fix login timeout on slow connections
[issue body]

### Comments
**@alice**: I can reproduce this on 3G networks...
**@bob**: The timeout is hardcoded in auth.ts line 88...

## Task
[your task description, if provided]
```

The user prompt includes:
- **Task ID** and **Repository** — always present.
- **GitHub Issue** (title, body, and comments) — included when you use `--issue`.
- **Task description** — included when you use `--task`.

### Token budget

The user prompt has a budget of approximately **100,000 tokens** (~400,000 characters). If a GitHub issue has many comments and exceeds this budget, the **oldest comments are trimmed first**. The issue title, body, and your task description are preserved. Keep this in mind for issues with long comment threads — the most recent comments are the ones the agent will see.

## Repo-level customization

You can customize how the agent works on your repository by adding configuration files that the agent loads automatically when it starts a task. The agent uses the Claude Agent SDK with `setting_sources=["project"]`, which loads the **full project-level configuration scope** from the cloned repository.

### What gets loaded

| File / directory | Purpose | Recommended |
|------------------|---------|-------------|
| `CLAUDE.md` | Project-level instructions at the repo root | Yes |
| `.claude/CLAUDE.md` | Alternative location for project instructions | Yes |
| `.claude/rules/*.md` | Path-scoped rules (e.g. `.claude/rules/testing.md`) | Yes |
| `.claude/settings.json` | Project settings (permissions, hooks, env vars) | Use with caution |
| `.claude/agents/` | Custom subagent definitions | Supported |
| `.mcp.json` | MCP server configurations | Supported (see note) |

**Note on MCP servers:** MCP servers defined in `.mcp.json` will be loaded, but they require their dependencies (e.g. npm packages) to be installed in the container. The agent container has Node.js but not arbitrary npm packages, so most MCP server definitions will fail to start unless the repo's setup step installs them.

**Note on permissions:** The agent runs in `bypassPermissions` mode, so `permissions` settings in `.claude/settings.json` have no effect. However, `hooks` and `env` settings are active.

### CLAUDE.md instructions

These files use the same format as [Claude Code's CLAUDE.md](https://code.claude.com/docs/en/memory#claude-md-files) — plain Markdown with instructions for the agent.

### What to include

- **Build and test commands** — If your project uses something other than `mise run build` / `mise run lint`, tell the agent.
- **Conventions** — Commit message format, branch naming, code style, import ordering, test patterns.
- **Constraints** — Files or directories the agent should not modify, libraries to prefer or avoid, API versioning rules.
- **Architecture notes** — High-level description of the project structure, module boundaries, or design decisions that are not obvious from the code alone.

### Example

A `CLAUDE.md` at the repo root:

```markdown
# Project instructions

This is a TypeScript monorepo managed by Turborepo.

## Build
- `pnpm install` to install dependencies
- `pnpm build` to build all packages
- `pnpm test` to run tests

## Conventions
- Use conventional commits (feat:, fix:, chore:)
- All new code must have unit tests
- Do not modify files in `packages/shared/` without updating the changelog

## Architecture
- `packages/api/` — Express REST API
- `packages/web/` — Next.js frontend
- `packages/shared/` — Shared types and utilities
```

### How it works

The Claude Agent SDK's `setting_sources=["project"]` instructs the Claude Code CLI to discover and load all project-level configuration from the cloned repository's working directory. CLAUDE.md files are injected as additional context alongside (not replacing) the platform system prompt. Subagents, settings, and MCP servers are loaded through the CLI's native mechanisms. The agent logs which instruction files it found for observability.

The `"user"` source is intentionally excluded — the container has no meaningful user config at `~/.claude/`, and including it would be a no-op at best.

### Relationship to Blueprint `system_prompt_overrides`

There are two layers of customization:

1. **Blueprint `system_prompt_overrides`** — Set by the platform administrator in CDK. Appended to the system prompt after template substitution. Use for platform-level or organization-level instructions that should not live in the repo.
2. **Repo-level project configuration** — Maintained by the development team in the repository. Loaded by the CLI at runtime via `setting_sources=["project"]`. Use for project-specific instructions (`CLAUDE.md`), conventions (`.claude/rules/`), custom subagents (`.claude/agents/`), and project settings (`.claude/settings.json`).

Both are active simultaneously. Blueprint overrides are part of the system prompt; project configuration is loaded as separate context by the CLI.

## Choosing the right input mode

You must provide at least one of `--issue` or `--task` (or both).

| Mode | When to use | Example |
|---|---|---|
| `--issue` only | The GitHub issue is well-written with clear requirements, reproduction steps, and acceptance criteria. | `bgagent submit --repo owner/repo --issue 42` |
| `--task` only | Ad-hoc task not tied to an issue, or the issue doesn't exist yet. | `bgagent submit --repo owner/repo --task "Add rate limiting to the /search endpoint"` |
| `--issue` + `--task` | The issue exists but needs clarification, scope narrowing, or additional instructions. | `bgagent submit --repo owner/repo --issue 42 --task "Focus only on the timeout in the OAuth flow. Don't change the retry logic."` |

**When to combine both:** Use `--issue` + `--task` when you want the agent to see the full issue context (including comments from other contributors) but need to override or narrow the scope. Your `--task` text appears after the issue content, so it acts as the final instruction.

## Writing effective task descriptions

### Describe the end state, not the steps

The agent is skilled at navigating codebases, choosing implementation approaches, and making technical decisions. Tell it **what** the result should look like, not **how** to get there.

Instead of:
> Open `src/auth.ts`, find the `validateToken` function, add a check for token expiry before line 45, then open `src/middleware.ts` and add the middleware...

Write:
> The login flow should reject expired tokens and return a 401 with a clear error message. The token expiry check should happen in the auth middleware before the route handler runs.

### Be specific about scope

One task should represent **one logical change**. The agent works best with focused, well-bounded work.

- **Good scope:** "Add input validation to the `POST /users` endpoint."
- **Too broad:** "Improve the API." (Which endpoints? What kind of improvements?)
- **Too narrow to be its own task:** "Change the variable name on line 12." (This is a one-line fix; submit it yourself or include it as part of a larger logical change.)

### State preconditions and constraints

If there are constraints the agent should respect, say so explicitly. The agent starts fresh each time with no knowledge beyond the repository contents and your prompt.

- "This project uses React 18 — do not use React 19 features."
- "The database schema is managed by Flyway migrations. Add a new migration file; do not modify existing ones."
- "The CI pipeline runs `npm run lint && npm test`. Both must pass."

### Define verifiable goals

Give the agent concrete success criteria. The agent runs the build and tests as part of its workflow, so testable goals produce better outcomes.

- "Add unit tests for the `parseConfig` function covering: missing fields, invalid types, and empty input."
- "The endpoint should return 400 with `{ "error": "invalid_email" }` when the email format is wrong."
- "After this change, `npm run build` and `npm test` should pass with no new warnings."

### Include concrete examples when relevant

If the desired behavior has specific input/output expectations, include examples. The agent benefits from concrete illustrations.

> Add a `slugify` function that converts titles to URL-safe slugs. Examples:
> - `"Hello World"` → `"hello-world"`
> - `"  Foo & Bar! "` → `"foo-bar"`
> - `"Already-a-slug"` → `"already-a-slug"`

### Mention relevant files or modules if you know them

You don't need to specify exact line numbers, but pointing the agent to the right area of the codebase saves turns and reduces the chance of changes in the wrong place.

- "The rate limiting logic should go in `src/middleware/` alongside the existing auth middleware."
- "The bug is in the payment processing module (`src/payments/`). The `calculateTotal` function doesn't handle discount codes."

## Anti-patterns

### Too vague

The agent cannot infer intent from a one-line description with no context.

| Before | After |
|---|---|
| "Fix the bug." | "Fix the 500 error on `POST /api/users` when the email contains a plus sign (e.g. `user+tag@example.com`). The email validation regex rejects valid RFC 5321 addresses. Add a test case for emails with special characters." |
| "Make it faster." | "The `/search` endpoint takes >3 seconds for queries returning more than 100 results. Optimize the database query to use the existing `idx_search_term` index, or add pagination with a default page size of 20." |
| "Update the docs." | "Update the README to document the new `--dry-run` flag added in PR #87. Add it to the CLI usage section with a one-line description and an example." |

### Too prescriptive

Step-by-step instructions are fragile — they break if the file has changed, the line numbers have shifted, or the implementation differs from what you assumed.

| Before | After |
|---|---|
| "Open `src/auth.ts`, go to line 42, change `timeout: 5000` to `timeout: 10000`." | "The login flow times out on slow connections because the auth request timeout is too short. Increase it to 10 seconds. The timeout is configured in the auth module." |
| "In `package.json`, add `"lodash": "^4.17.21"` to dependencies. Then open `src/utils.ts` and add `import { debounce } from 'lodash'` at the top. Then find the `handleSearch` function and wrap the callback with `debounce(..., 300)`." | "Add debounce (300ms) to the search handler in `src/utils.ts` to avoid excessive API calls on rapid input. Use any suitable approach — a library or a simple implementation." |

### Kitchen sink

Asking for multiple unrelated changes in one task overloads the context and often produces partial results.

| Before | After |
|---|---|
| "Fix the login bug, add dark mode support, update the README, and upgrade React to v19." | Submit four separate tasks: (1) fix the login bug, (2) add dark mode support, (3) update the README, (4) upgrade React to v19. |

Related changes that form a single logical unit (e.g. "add an endpoint and its tests") are fine as one task. Unrelated changes should be separate tasks.

### Missing context

The agent only sees the repository contents and your prompt. References to external conversations, Slack threads, or prior tasks are invisible.

| Before | After |
|---|---|
| "Fix the issue we discussed yesterday." | "Fix the race condition in `src/queue/worker.ts` where two workers can pick up the same job. Add a DynamoDB conditional write to claim jobs atomically." |
| "Make it work like the other service." | "The `/health` endpoint should return `{ "status": "ok", "version": "1.2.3" }` matching the format used by our API gateway health checks." |

### Assuming agent state

The agent starts fresh for every task. It has no memory of previous tasks, conversations, or files you've shown it elsewhere.

| Before | After |
|---|---|
| "As we discussed, apply the same pattern." | Describe the pattern explicitly, or reference a file in the repo that demonstrates it: "Follow the same error handling pattern used in `src/handlers/users.ts`." |
| "Continue where we left off." | Describe the current state and what remains: "The `POST /orders` endpoint was added in PR #91 but is missing input validation. Add validation for required fields: `product_id` (string), `quantity` (positive integer), and `shipping_address` (non-empty string)." |

## Using `--max-turns` effectively

The `--max-turns` flag (API field: `max_turns`) controls how many agent turns (model invocations) a task is allowed. The default is **100**, with a range of **1–500**.

| Task type | Suggested range | Rationale |
|---|---|---|
| Typo fix, config change, small edit | 10–30 | The agent finds the file, makes the change, runs the build, and creates a PR. Few turns needed. |
| Bug fix with clear reproduction | 50–100 | The agent needs to understand the issue, find the root cause, implement the fix, add tests, and verify. |
| New feature (single module) | 100–200 | More exploration, implementation, and testing. Default of 100 is usually sufficient. |
| Large refactoring or multi-file feature | 200–500 | Extensive codebase exploration and many file changes. Consider whether the task should be split instead. |

If a task consistently times out or uses all turns without finishing, consider whether the task description is too broad. Splitting into smaller, focused tasks is usually more effective than increasing the turn limit.

## Tips for GitHub issues

When using `--issue`, the agent fetches the issue title, body, and all comments. Well-structured issues lead to better results.

### Writing agent-friendly issues

- **Clear title** — Summarize the problem or feature in one line: "Login fails when email contains a plus sign" rather than "Bug in login."
- **Reproduction steps** — For bugs, include steps to reproduce, expected behavior, and actual behavior.
- **Acceptance criteria** — State what "done" looks like: "The endpoint returns 200 with a valid JSON response. Tests pass."
- **Labels** — The agent does not currently see issue labels. Put any relevant context (e.g. "this is a bug" or "this is an enhancement") in the issue body or in your `--task` description.
- **Keep comments focused** — Since oldest comments are trimmed first when the token budget is exceeded, put essential information in the issue body rather than in early comments. Recent comments are more likely to be preserved.

### Comment trimming behavior

If the combined issue content exceeds the ~100K token budget:
1. The **oldest comments** are removed first (from the beginning of the thread).
2. The issue **title and body are always preserved**.
3. Your **`--task` description is always preserved**.
4. If the content is still over budget after removing all comments, the prompt is sent with a truncation warning but the issue body and task description are preserved in full.

For issues with long discussion threads, consider using `--task` to summarize the key conclusions so the agent doesn't depend on comments that might be trimmed.

## Examples

### Bug fix

```bash
bgagent submit --repo acme/api-server --task "
Fix the 500 error on POST /api/users when the email field contains
a plus sign (e.g. user+tag@example.com).

The email validation regex in src/validators/email.ts rejects valid
RFC 5321 addresses that contain + characters. Update the regex to
accept plus signs in the local part.

Add test cases for:
- Standard email (user@example.com)
- Plus-addressed email (user+tag@example.com)
- Email with dots (first.last@example.com)

npm test should pass after the change.
"
```

### New feature

```bash
bgagent submit --repo acme/web-app --task "
Add a /health endpoint to the Express server in src/server.ts.

The endpoint should:
- Respond to GET /health
- Return 200 with JSON body: { \"status\": \"ok\", \"uptime\": <seconds> }
- Not require authentication (exclude from auth middleware)
- Be documented in README.md under the API Endpoints section

Add an integration test that verifies the endpoint returns 200 and
the expected JSON structure.
"
```

### Refactoring

```bash
bgagent submit --repo acme/backend --task "
Refactor the database connection logic in src/db/ to use a connection
pool instead of creating a new connection per request.

Currently, each request handler calls createConnection() directly.
Replace this with a shared pool (using the pg-pool library already in
package.json) initialized at startup.

Constraints:
- Keep the same public API for src/db/index.ts exports
- The pool size should be configurable via DB_POOL_SIZE env var (default: 10)
- Existing tests in test/db/ should pass without modification
- Add a test for pool exhaustion behavior (all connections in use)
"
```

### Issue with scope narrowing

```bash
bgagent submit --repo acme/frontend --issue 128 --task "
Focus only on the mobile responsive layout issues described in the
issue. Ignore the desktop sidebar redesign mentioned in the comments —
that will be a separate task.

The fix should target screen widths below 768px. Use the existing
breakpoint variables in src/styles/variables.css.
"
```
