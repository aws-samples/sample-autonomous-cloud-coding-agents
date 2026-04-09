---
title: What the agent does
---

### New task (`new_task`)

When a `new_task` is submitted, the agent:

1. Clones the repository into an isolated workspace
2. Creates a branch named `bgagent/<task-id>/<short-description>`
3. Installs dependencies via `mise install` and runs an initial build
4. Loads repo-level project configuration (`CLAUDE.md`, `.claude/` settings, agents, rules, `.mcp.json`) if present
5. Reads the codebase to understand the project structure
6. Makes the requested changes
7. Runs the build and tests (`mise run build`)
8. Commits and pushes incrementally throughout
9. Creates a pull request with a summary of changes, build/test results, and decisions made

The PR title follows conventional commit format (e.g., `feat(auth): add OAuth2 login flow`).

### PR iteration (`pr_iteration`)

When a `pr_iteration` task is submitted, the agent:

1. Clones the repository into an isolated workspace
2. Checks out the existing PR branch (fetched from the remote)
3. Installs dependencies via `mise install` and runs an initial build
4. Loads repo-level project configuration if present
5. Reads the review feedback (inline comments, conversation comments, and the PR diff)
6. Addresses the feedback with focused changes
7. Runs the build and tests (`mise run build`)
8. Commits and pushes to the existing PR branch
9. Posts a summary comment on the PR describing what was addressed

The agent does **not** create a new PR — it updates the existing one in place. The PR's branch, title, and description remain unchanged; the agent adds commits and a comment summarizing its work.

### PR review (`pr_review`)

When a `pr_review` task is submitted, the agent:

1. Clones the repository into an isolated workspace
2. Checks out the existing PR branch (fetched from the remote)
3. Installs dependencies via `mise install` and runs an initial build (informational only — build failures do not block the review)
4. Loads repo-level project configuration if present
5. Reads the PR context (diff, description, existing comments) and analyzes the changes
6. Leverages repository memory context (codebase patterns, past episodes) when available
7. Composes structured findings using a defined comment format: type (comment / question / issue / good_point), severity for issues (minor / medium / major / critical), title, description, proposed fix, and a ready-to-use AI prompt for addressing each finding
8. Posts the review via the GitHub Reviews API (`gh api repos/{repo}/pulls/{pr_number}/reviews`) as a single batch review
9. Posts a summary conversation comment on the PR

The agent operates in **read-only mode** — it does not modify any files, create commits, or push changes. The `Write` and `Edit` tools are not available during `pr_review` tasks.