---
title: What the agent does
---

When a task is submitted, the agent:

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