---
title: Tips for being a good citizen
---

The platform is a shared resource - compute, model tokens, and GitHub API calls cost money and consume quotas. These practices help you get better results while keeping the platform healthy for everyone.

### Set up your repository for success

The agent is only as good as the context it receives. A well-prepared repository leads to faster, higher-quality results.

- **Onboard first** - Repositories must be registered via a Blueprint construct before tasks can target them. If you get a `REPO_NOT_ONBOARDED` error, contact your platform administrator.
- **Add a CLAUDE.md** - This is the single most impactful thing you can do. The agent loads project configuration from `CLAUDE.md`, `.claude/rules/*.md`, `.claude/settings.json`, and `.mcp.json` in your repository. Use these to document build commands, coding conventions, architecture decisions, and constraints. A good `CLAUDE.md` prevents the agent from guessing and reduces wasted turns. See the [Prompt guide](/customizing/prompt-engineering#repo-level-customization) for examples.
- **Keep your PAT aligned** - If tasks fail with `preflight_failed`, the GitHub PAT likely lacks the permissions the task type needs. Check the event's `reason` field and update the secret in Secrets Manager. See [Repository preparation](/developer-guide/repository-preparation) for the full permissions table.

### Write effective task descriptions

The quality of your task description directly affects the quality of the output. A vague description means more agent turns (higher cost) and less predictable results.

- **Prefer issues over free text** - When using `--issue` (CLI) or `issue_number` (API), the agent fetches the full issue body including labels, comments, and linked context. This is usually richer than a short text description and gives the agent more to work with.
- **Be specific about scope** - "Fix the auth bug" is expensive because the agent has to explore. "Fix the null pointer in `src/auth/validate.ts` when the token is expired" is cheap because the agent knows exactly where to look.
- **Mention acceptance criteria** - If you know what "done" looks like (tests pass, specific behavior changes, a file gets created), say so. The agent will use these as exit conditions.

### Control cost and resource usage

Every task consumes model tokens, compute time, and GitHub API calls. Setting limits upfront prevents runaway costs and keeps the platform available for your teammates.

- **Set turn limits** - Use `--max-turns` (CLI) or `max_turns` (API) to cap the number of agent iterations (1-500). If not specified, the per-repo Blueprint default applies, falling back to the platform default of 100. Start low for simple tasks and increase if needed.
- **Set cost budgets** - Use `--max-budget` (CLI) or `max_budget_usd` (API) to set a hard cost limit in USD ($0.01-$100). When the budget is reached, the agent stops regardless of remaining turns. If neither the task nor the Blueprint specifies a budget, no cost limit is applied - be intentional about this.
- **Check cost after completion** - The task status includes reported cost. Use this to calibrate your limits for future similar tasks.
- **Don't waste compute on doomed tasks** - If your PAT is wrong, the repo isn't onboarded, or the PR is closed, the task will fail at pre-flight. Fix the setup before retrying.

### Handle edge cases gracefully

- **Content screening** - Task descriptions and PR context are screened by Bedrock Guardrails for prompt injection. If your task is unexpectedly blocked, check the task events for a `guardrail_blocked` entry and revise your description.
- **Idempotency** - If you're creating tasks via the API and might retry on network errors, include an `Idempotency-Key` header to prevent duplicate tasks.
- **Concurrency** - You share a per-user concurrency limit (default: 3 tasks). If you hit the limit, wait for a task to finish or cancel one you no longer need before submitting more.