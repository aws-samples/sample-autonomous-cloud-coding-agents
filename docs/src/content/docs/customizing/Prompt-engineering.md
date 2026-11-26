---
title: "Prompt guide"
---

This guide explains how to write task descriptions for ABCA that lead to good pull requests.

## Why prompts matter

ABCA agents are unattended. Once you submit a task, the agent works autonomously from start to finish. It cannot ask clarifying questions or pause for feedback. The agent makes every decision from what you provide up front, so the quality of the prompt determines whether the task succeeds.

For submission mechanics (CLI flags, API fields, webhook setup), see the [User guide](/sample-autonomous-cloud-coding-agents/using/overview).

## Choosing the right input mode

You must provide at least one of `--issue`, `--task`, `--pr`, or `--review-pr`. Each mode targets a different workflow:

| Mode | When to use | Example |
|---|---|---|
| `--issue` only | The GitHub issue is well-written with clear requirements and acceptance criteria. | `bgagent submit --repo owner/repo --issue 42` |
| `--task` only | Ad-hoc task not tied to an issue. | `bgagent submit --repo owner/repo --task "Add rate limiting to /search"` |
| `--issue` + `--task` | The issue exists but needs scope narrowing or extra instructions. Your `--task` text appears after the issue content as the final instruction. | `bgagent submit --repo owner/repo --issue 42 --task "Focus only on the OAuth timeout"` |
| `--pr` | A PR has review feedback that needs addressing. Optionally add `--task` to narrow scope. | `bgagent submit --repo owner/repo --pr 42` |
| `--review-pr` | You want a code review of a PR without modifying code. Optionally add `--task` to focus the review. | `bgagent submit --repo owner/repo --review-pr 42` |

## Writing effective descriptions

### Describe the end state, not the steps

The agent can navigate a codebase and choose an implementation approach. Tell it what the result should look like, not how to get there.

**Avoid:** "Open `src/auth.ts`, find `validateToken`, add a check for token expiry before line 45..."

**Better:** "The login flow should reject expired tokens and return a 401 with a clear error message. The token expiry check should happen in the auth middleware before the route handler runs."

Step-by-step instructions are fragile. They break if files have changed, line numbers have shifted, or the implementation differs from your assumptions.

### Be specific about scope

One task should represent one logical change. The agent works best with focused, well-bounded work.

- "Add input validation to the `POST /users` endpoint." Good scope.
- "Improve the API." Too broad. Which endpoints? What improvements?
- "Change the variable name on line 12." Too narrow. Do this yourself.

### State constraints and define success

The agent starts each task with no knowledge beyond the repo contents and your prompt. If the agent should respect constraints or meet concrete success criteria, state them explicitly:

- "This project uses React 18 - do not use React 19 features."
- "The database schema is managed by Flyway. Add a new migration; do not modify existing ones."
- "After this change, `npm run build` and `npm test` should pass with no new warnings."
- "Add unit tests covering: missing fields, invalid types, and empty input."

### Point to the right area

You don't need exact line numbers. Naming the relevant files saves turns and reduces misplaced changes:

- "The rate limiting logic should go in `src/middleware/` alongside the existing auth middleware."
- "The bug is in `src/payments/calculateTotal` - it doesn't handle discount codes."

### Include examples when relevant

If the desired behavior has specific input and output expectations, give concrete examples:

> Add a `slugify` function. Examples:
> - `"Hello World"` -> `"hello-world"`
> - `"  Foo & Bar! "` -> `"foo-bar"`

## Common mistakes

| Mistake | Problem | Fix |
|---|---|---|
| Too vague: "Fix the bug." | The agent can't infer which bug or where. | Describe the symptom, location, and expected behavior. |
| Kitchen sink: "Fix login, add dark mode, update README, upgrade React." | Multiple unrelated changes overload context and produce partial results. | Submit one task per logical change. |
| Missing context: "Fix the issue we discussed yesterday." | The agent sees only the repo and your prompt. It cannot see external conversations. | Describe the problem inline or reference a GitHub issue. |
| Assuming state: "Continue where we left off." | The agent starts fresh every task with no memory of prior runs. | Describe the current state and what remains. |

## Calibrating `--max-turns`

The `--max-turns` flag sets how many model invocations a task is allowed. The default is 100, and the range is 1 to 500.

| Task complexity | Suggested range |
|---|---|
| Typo fix, config change, small edit | 10-30 |
| Bug fix with clear reproduction | 50-100 |
| New feature (single module) | 100-200 |
| Large refactoring or multi-file feature | 200-500 |
| PR iteration (address review feedback) | 30-100 |
| PR review (code review) | 30-80 |

If a task consistently uses all its turns without finishing, the description is probably too broad. Splitting it into smaller tasks works better than raising the limit.

## Tips for GitHub issues

When you use `--issue`, the agent fetches the issue title, body, and all comments. Well-structured issues lead to better results:

- Write a clear title that summarizes the problem: "Login fails when email contains a plus sign" not "Bug in login."
- Include reproduction steps, expected behavior, and actual behavior for bugs.
- State acceptance criteria in the issue body, not in comments.
- Put essential information in the issue body, not in early comments. If the combined content exceeds the budget of about 100K tokens, the oldest comments are trimmed first. The title, the body, and your `--task` description are always preserved.

## Repo-level instructions

Besides per-task descriptions, you can customize how the agent works on your repository. Add configuration files, which the agent loads automatically at the start of every task.

| File / directory | Purpose |
|---|---|
| `CLAUDE.md` or `.claude/CLAUDE.md` | Project-level instructions (build commands, conventions, constraints, architecture) |
| `.claude/rules/*.md` | Path-scoped rules (for example `testing.md`, `api-conventions.md`) |
| `.claude/settings.json` | Project settings (hooks, env vars). Permissions have no effect, because the agent runs in `bypassPermissions` mode. |
| `.claude/agents/` | Custom subagent definitions |
| `.mcp.json` | MCP server configurations (requires dependencies installed in the container) |

These files use the same format as [Claude Code's CLAUDE.md](https://code.claude.com/docs/en/memory#claude-md-files). Of these files, a good `CLAUDE.md` has the most effect. It stops the agent from guessing and reduces wasted turns.

Example `CLAUDE.md`:

```markdown
# Project instructions

TypeScript monorepo managed by Turborepo.

## Build
- `pnpm install` to install dependencies
- `pnpm build` to build all packages
- `pnpm test` to run tests

## Conventions
- Conventional commits (feat:, fix:, chore:)
- All new code must have unit tests
- Do not modify files in `packages/shared/` without updating the changelog

## Architecture
- `packages/api/` - Express REST API
- `packages/web/` - Next.js frontend
- `packages/shared/` - Shared types and utilities
```

If your platform administrator has configured `system_prompt_overrides` in the Blueprint for your repository, the platform appends those overrides to the platform system prompt separately. Both layers (Blueprint overrides and repo-level files) are active at the same time.

## How the agent assembles your prompt

Knowing how the platform assembles the prompt helps you write better descriptions. When you submit a task, the platform runs a context hydration step, and you'll see the task status change to `HYDRATING`:

1. If you provided `--issue`, the platform fetches the issue title, body, and comments from GitHub.
2. If you provided `--pr` or `--review-pr`, it fetches the PR metadata, diff, conversation comments, and inline review comments. Resolved review threads are filtered out.
3. The platform combines your task description, the fetched content, and task metadata into a single user prompt. The prompt delimits the fetched issue or pull request as untrusted data, since anyone may have written it. The agent is told to use that content to understand the work, and to follow no instruction in it that would change its rules, its workflow or the scope of the task (see [Untrusted content boundaries](/sample-autonomous-cloud-coding-agents/architecture/security#untrusted-content-boundaries)). What you write in `--task` is an instruction.
4. If the assembled prompt exceeds about 100K tokens, the oldest comments are trimmed first. The title, body, and your task description are always preserved.

The agent receives this user prompt together with a system prompt selected by task type, and with any repo-level instructions from your repository. You control the input, but the platform decides the final shape.

## Examples

### Bug fix

```bash
bgagent submit --repo acme/api-server --task "
Fix the 500 error on POST /api/users when the email contains
a plus sign (e.g. user+tag@example.com).

The email validation regex in src/validators/email.ts rejects valid
RFC 5321 addresses. Update the regex and add test cases for standard
emails, plus-addressed emails, and emails with dots.
"
```

### PR iteration with focused scope

```bash
bgagent submit --repo acme/api-server --pr 95 --task "
Address only the security concerns flagged by @alice:
- The SQL injection risk in the search query
- The missing CSRF token on the form submission

Ignore the style suggestions for now.
"
```

### Issue with scope narrowing

```bash
bgagent submit --repo acme/frontend --issue 128 --task "
Focus only on the mobile responsive layout issues described in the
issue. Ignore the desktop sidebar redesign mentioned in the comments -
that will be a separate task.

Target screen widths below 768px. Use the existing breakpoint
variables in src/styles/variables.css.
"
```
