---
title: Prompt guide
---

# Prompt guide

Writing effective task descriptions for ABCA.

## Why prompts matter

ABCA agents are unattended - once a task is submitted, the agent works autonomously from start to finish. It cannot ask clarifying questions or pause for feedback. Every decision is made based on what you provide upfront, so prompt quality directly determines task success.

This guide covers how to write descriptions that lead to good pull requests. For submission mechanics (CLI flags, API fields, webhook setup), see the [User guide](/using/overview).

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

The agent is skilled at navigating codebases and choosing implementation approaches. Tell it what the result should look like, not how to get there.

**Avoid:** "Open `src/auth.ts`, find `validateToken`, add a check for token expiry before line 45..."

**Better:** "The login flow should reject expired tokens and return a 401 with a clear error message. The token expiry check should happen in the auth middleware before the route handler runs."

Step-by-step instructions are fragile - they break if files have changed, line numbers have shifted, or the implementation differs from your assumptions.

### Be specific about scope

One task should represent one logical change. The agent works best with focused, well-bounded work.

- "Add input validation to the `POST /users` endpoint." - good scope
- "Improve the API." - too broad, which endpoints? what improvements?
- "Change the variable name on line 12." - too narrow, do this yourself

### State constraints and define success

The agent starts fresh each time with no knowledge beyond the repo contents and your prompt. If there are constraints it should respect or concrete success criteria, say so explicitly:

- "This project uses React 18 - do not use React 19 features."
- "The database schema is managed by Flyway. Add a new migration; do not modify existing ones."
- "After this change, `npm run build` and `npm test` should pass with no new warnings."
- "Add unit tests covering: missing fields, invalid types, and empty input."

### Point to the right area

You don't need exact line numbers, but mentioning relevant files saves turns and reduces misplaced changes:

- "The rate limiting logic should go in `src/middleware/` alongside the existing auth middleware."
- "The bug is in `src/payments/calculateTotal` - it doesn't handle discount codes."

### Include examples when relevant

If the desired behavior has specific input/output expectations, concrete examples help the agent:

> Add a `slugify` function. Examples:
> - `"Hello World"` -> `"hello-world"`
> - `"  Foo & Bar! "` -> `"foo-bar"`

## Common mistakes

| Mistake | Problem | Fix |
|---|---|---|
| Too vague: "Fix the bug." | The agent can't infer which bug or where. | Describe the symptom, location, and expected behavior. |
| Kitchen sink: "Fix login, add dark mode, update README, upgrade React." | Multiple unrelated changes overload context and produce partial results. | Submit one task per logical change. |
| Missing context: "Fix the issue we discussed yesterday." | The agent only sees the repo and your prompt. External conversations are invisible. | Describe the problem inline or reference a GitHub issue. |
| Assuming state: "Continue where we left off." | The agent starts fresh every task with no memory of prior runs. | Describe the current state and what remains. |

## Calibrating `--max-turns`

The `--max-turns` flag controls how many model invocations a task is allowed. Default is 100, range is 1-500.

| Task complexity | Suggested range |
|---|---|
| Typo fix, config change, small edit | 10-30 |
| Bug fix with clear reproduction | 50-100 |
| New feature (single module) | 100-200 |
| Large refactoring or multi-file feature | 200-500 |
| PR iteration (address review feedback) | 30-100 |
| PR review (code review) | 30-80 |

If a task consistently uses all turns without finishing, the description is probably too broad. Splitting into smaller tasks is more effective than increasing the limit.

## Tips for GitHub issues

When using `--issue`, the agent fetches the issue title, body, and all comments. Well-structured issues lead to better results:

- Write a clear title that summarizes the problem: "Login fails when email contains a plus sign" not "Bug in login."
- Include reproduction steps, expected behavior, and actual behavior for bugs.
- State acceptance criteria in the issue body, not in comments.
- Put essential information in the issue body rather than early comments - if the combined content exceeds the ~100K token budget, oldest comments are trimmed first. The title, body, and your `--task` description are always preserved.

## Repo-level instructions

Beyond per-task descriptions, you can customize how the agent works on your repository by adding configuration files it loads automatically at the start of every task.

| File / directory | Purpose |
|---|---|
| `CLAUDE.md` or `.claude/CLAUDE.md` | Project-level instructions (build commands, conventions, constraints, architecture) |
| `.claude/rules/*.md` | Path-scoped rules (e.g. `testing.md`, `api-conventions.md`) |
| `.claude/settings.json` | Project settings (hooks, env vars). Permissions have no effect since the agent runs in `bypassPermissions` mode. |
| `.claude/agents/` | Custom subagent definitions |
| `.mcp.json` | MCP server configurations (requires dependencies installed in the container) |

These files use the same format as [Claude Code's CLAUDE.md](https://code.claude.com/docs/en/memory#claude-md-files). A good `CLAUDE.md` is the single most impactful thing you can add - it prevents the agent from guessing and reduces wasted turns.

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

If your platform administrator has configured `system_prompt_overrides` in the Blueprint for your repository, those are appended to the platform system prompt separately. Both layers (Blueprint overrides + repo-level files) are active simultaneously.

## How the agent assembles your prompt

Understanding the prompt assembly helps you write better descriptions. When you submit a task, the platform goes through a context hydration step (you'll see the task status change to `HYDRATING`):

1. If you provided `--issue`, the platform fetches the issue title, body, and comments from GitHub.
2. If you provided `--pr` or `--review-pr`, it fetches the PR metadata, diff, conversation comments, and inline review comments. Resolved review threads are filtered out.
3. Your task description, the fetched content, and task metadata are combined into a single user prompt.
4. If the assembled prompt exceeds ~100K tokens, oldest comments are trimmed first. The title, body, and your task description are always preserved.

The agent receives this user prompt alongside a system prompt selected by task type and any repo-level instructions from your repository. You control the input, but the platform decides the final shape.

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
