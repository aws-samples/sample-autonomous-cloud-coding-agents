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