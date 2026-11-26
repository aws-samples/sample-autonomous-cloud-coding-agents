---
title: "What the agent does"
---

The agent is the part of the platform that writes code. When the orchestrator finishes preparing a task (admission, context hydration, and pre-flight checks), it hands the task to an agent that runs inside an isolated compute environment. Today the platform supports **Amazon Bedrock AgentCore Runtime** as the default compute backend. Each agent session runs in a Firecracker MicroVM with session-scoped storage and automatic cleanup. The architecture is designed to support additional compute backends (ECS on Fargate and ECS on EC2) for repositories that need more resources or custom toolchains beyond the AgentCore 2 GB image limit. See the [Compute design](/sample-autonomous-cloud-coding-agents/architecture/compute) for the full comparison.

Inside the compute environment, the agent has access to the repository, a foundation model (Claude), and a set of developer tools (file editing, terminal, and GitHub CLI). It works autonomously until the task is done or a limit is reached. It reads code, makes changes, runs builds, and interacts with GitHub.

Every agent session starts the same way. The agent clones the repo, installs dependencies, loads project configuration (`CLAUDE.md`, `.claude/` settings, agents, and rules), and reads the codebase to understand it. What happens next depends on the task type.

### New task

The agent creates a branch (`bgagent/<task-id>/<short-description>`), reads the codebase to understand the project structure, and implements the requested changes. It runs the build and tests throughout, commits incrementally so progress is never lost, and opens a pull request when done. The PR includes a summary of changes, build results, and key decisions.

### PR iteration

The agent checks out the existing PR branch and reads all review feedback. The feedback is the inline comments, the conversation comments, and the current diff. The agent makes focused changes to address the feedback, runs the build and tests, and pushes to the same branch. It does not create a new PR. It updates the existing one and posts a comment that summarizes what it addressed.

### PR review

The agent checks out the PR branch in read-only mode. File editing and writing tools are disabled. The agent analyzes the diff, the description, and the existing comments, and can use repository memory (codebase patterns from past tasks) for additional context. It composes structured findings, each with a severity level (minor, medium, major, or critical), and posts them as a single batch review through the GitHub Reviews API, followed by a summary comment.