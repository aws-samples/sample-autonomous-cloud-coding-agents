---
title: What the agent does
---

The agent is the part of the platform that actually writes code. When the orchestrator finishes preparing a task (admission, context hydration, pre-flight checks), it hands off to an agent running inside an isolated compute environment. Today the platform supports **Amazon Bedrock AgentCore Runtime** as the default compute backend - each agent session runs in a Firecracker MicroVM with session-scoped storage and automatic cleanup. The architecture is designed to support additional compute backends (ECS on Fargate, ECS on EC2) for repositories that need more resources or custom toolchains beyond the AgentCore 2 GB image limit. See the [Compute design](/sample-autonomous-cloud-coding-agents/architecture/compute) for the full comparison.

Inside the compute environment, the agent has access to the repository, a foundation model (Claude), and a set of developer tools (file editing, terminal, GitHub CLI). It works autonomously - reading code, making changes, running builds, and interacting with GitHub - until the task is done or a limit is reached.

Every agent session starts the same way: clone the repo, install dependencies, load project configuration (`CLAUDE.md`, `.claude/` settings, agents, rules), and understand the codebase. What happens next depends on the task type.

### New task

The agent creates a branch (`bgagent/<task-id>/<short-description>`), reads the codebase to understand the project structure, and implements the requested changes. It runs the build and tests throughout, commits incrementally so progress is never lost, and opens a pull request when done. The PR includes a summary of changes, build results, and key decisions.

### PR iteration

The agent checks out the existing PR branch and reads all review feedback - inline comments, conversation comments, and the current diff. It makes focused changes to address the feedback, runs the build and tests, and pushes to the same branch. It does not create a new PR; it updates the existing one and posts a comment summarizing what was addressed.

### PR review

The agent checks out the PR branch in read-only mode - file editing and writing tools are disabled. It analyzes the diff, description, and existing comments, optionally using repository memory (codebase patterns from past tasks) for additional context. It composes structured findings with a severity level (minor, medium, major, critical) and posts them as a single batch review via the GitHub Reviews API, followed by a summary comment.