<div align="center">
  <h1>ABCA</h1>
  <img alt="ABCA" width="350" src="docs/imgs/ABCA.png" />

  <br />
  <br />

  <strong>
    Autonomous Background Coding Agents on AWS
  </strong>

  <br />
  <br />
  <p align="center">
    <img alt="Stability" src="https://img.shields.io/badge/stability-Experimental-important.svg?style=for-the-badge" />
  </p>
  <br />
</div>

## What is ABCA

**ABCA (Autonomous Background Coding Agents on AWS)** is a sample of what a self-hosted background coding agents platform might look like on AWS. Users can create background coding agents, then submit coding tasks to them and the agents work autonomously in the cloud — cloning repos, writing code, running tests, and opening pull requests for review. No human interaction during execution.

The platform is built on AWS CDK with a modular architecture: an input gateway normalizes requests from any channel, a durable orchestrator executes each task according to a blueprint, and isolated compute environments run each agent. Agents learn from past interactions through a tiered memory system backed by AgentCore Memory, and a review feedback loop captures PR review comments to improve future runs.

## The Use Case

Users submit tasks through webhooks, CLI, or Slack. For each task, the orchestrator executes the blueprint: an isolated environment is provisioned, an agent clones the target GitHub repository, creates a branch, works on the task, and opens a pull request.

Key characteristics:

- **Ephemeral environments** — each task starts fresh, no in-process state carries over
- **Asynchronous** — no real-time conversation during execution
- **Repository-scoped** — each task targets a specific repo
- **Outcome-measurable** — the PR is either merged, revised, or rejected
- **Fire and forget** — submit, forget, review the outcome
- **Learns over time** — the more you use it, the more it self-improves

## How it works

Each task follows a **blueprint** — a hybrid workflow that mixes deterministic steps (no LLM, predictable, cheap) with agentic steps (LLM-driven, flexible, expensive):

1. **Admission** — the orchestrator validates the request, checks concurrency limits, and queues the task if needed.
2. **Context hydration** — the platform gathers context: task description, GitHub issue body, repo-intrinsic knowledge (CLAUDE.md, README), and memory from past tasks on the same repo.
3. **Pre-flight** — fail-closed readiness checks verify GitHub API reachability and repository access before consuming compute. Doomed tasks fail fast with a clear reason (`GITHUB_UNREACHABLE`, `REPO_NOT_FOUND_OR_NO_ACCESS`) instead of burning runtime.
4. **Agent execution** — the agent runs in an isolated MicroVM with persistent session storage for select caches: clones the repo, creates a branch, edits code, commits, runs tests and lint. The orchestrator polls for completion without blocking compute.
5. **Finalization** — the orchestrator infers the result (PR created or not), runs optional validation (lint, tests), extracts learnings into memory, and updates task status.

For the full architecture, see [ARCHITECTURE.md](./docs/design/ARCHITECTURE.md).

## Current status

ABCA is under active development. The platform ships iteratively — each iteration adds features and builds on the previous one.

| Iteration | Status | What it delivers |
|---|---|---|
| **1** | Done | Agent runs on AWS, CLI submit, branch + PR |
| **2** | Done | Production orchestrator, API contract, task management, observability, security, webhooks |
| **3a** | Done | Repo onboarding, per-repo credentials, turn caps, prompt guide |
| **3b** | Done | Memory Tier 1, insights, agent self-feedback, prompt versioning, commit attribution |
| **3bis** | Done | Hardening — reconciler error tracking, error serialization, test coverage gaps |
| **3c** | WIP | Pre-flight checks, persistent session storage, deterministic validation, PR review task type, multi-modal input, input guardrail screening |
| **3d** | Planned | Review feedback loop, PR outcome tracking, evaluation pipeline, memory input hardening |
| **4** | Planned | GitLab, visual proof, Slack, control panel, WebSocket streaming |
| **5** | Planned | Pre-warming, multi-user/team, cost management, output guardrails, alternate runtime |
| **6** | Planned | Skills learning, multi-repo, iterative feedback, multiplayer, CDK constructs |

See the full [ROADMAP](./docs/guides/ROADMAP.md) for details on each iteration.

## Getting started

### Claude Code plugin (recommended)

This repository ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that provides guided workflows for setup, deployment, task submission, and troubleshooting.

#### Installing the plugin

```bash
git clone https://github.com/aws-samples/sample-autonomous-cloud-coding-agents.git
cd sample-autonomous-cloud-coding-agents
claude --plugin-dir .claude-plugin
```

The `--plugin-dir` flag tells Claude Code to load the local plugin from the `.claude-plugin/` directory. The plugin's skills, commands, agents, and hooks will be available immediately.

> **Tip:** If you use Claude Code via VS Code or JetBrains, you can add `--plugin-dir .claude-plugin` to the extension's CLI arguments setting.

#### What the plugin provides

**Skills** (guided multi-step workflows — Claude activates these automatically based on your request):

| Skill | Triggers on | What it does |
|-------|------------|--------------|
| `setup` | "get started", "install", "first time setup" | Full guided setup: prerequisites, toolchain, deploy, smoke test |
| `deploy` | "deploy", "cdk diff", "destroy" | Deploy, diff, or destroy the CDK stack with pre-checks |
| `onboard-repo` | "add a repo", "onboard", 422 errors | Add a new GitHub repository via Blueprint construct |
| `submit-task` | "submit task", "run agent", "review PR" | Submit a coding task with prompt quality coaching |
| `troubleshoot` | "debug", "error", "not working", "failed" | Diagnose deployment, auth, or task execution issues |

**Commands** (slash commands for quick actions):

| Command | What it does |
|---------|-------------|
| `/abca-status` | Quick platform health check: stack status, running tasks, build health |
| `/abca-submit [repo] [description]` | Shortcut for task submission with auto-detected task type |

**Agents** (specialized subagents, spawned automatically or via the Agent tool):

| Agent | When it's used |
|-------|---------------|
| `cdk-expert` | CDK architecture, construct design, handler implementation, stack modifications |
| `agent-debugger` | Task failure investigation, CloudWatch log analysis, agent runtime debugging |

**Hook** (runs automatically):

A `SessionStart` hook injects ABCA project context (key directories, commands, conventions) into every Claude Code session.

#### Local plugin development

If you're modifying the plugin itself, here's the file layout:

```
.claude-plugin/
  plugin.json                    # Plugin manifest (name, version, description)
  skills/
    setup/SKILL.md               # First-time setup workflow
    deploy/SKILL.md              # CDK deployment workflow
    onboard-repo/SKILL.md        # Repository onboarding workflow
    submit-task/SKILL.md         # Task submission with prompt coaching
    troubleshoot/SKILL.md        # Diagnostic workflow
  agents/
    cdk-expert.md                # CDK infrastructure specialist
    agent-debugger.md            # Task failure debugger
  commands/
    abca-status.md               # /abca-status command
    abca-submit.md               # /abca-submit command
  hooks/
    hooks.json                   # SessionStart hook configuration
```

**Key conventions:**
- All plugin components live inside `.claude-plugin/` alongside the manifest
- Skills live in subdirectories with a `SKILL.md` file (not flat `.md` files)
- Agents and commands are flat `.md` files with YAML frontmatter
- Hooks use JSON configuration in `hooks/hooks.json`

**After editing plugin files**, restart Claude Code with `claude --plugin-dir .claude-plugin` to pick up changes.

### Manual installation and deployment

Install [mise](https://mise.jdx.dev/getting-started.html) if you want to use repo tasks (`mise run install`, `mise run build`). For monorepo-prefixed tasks (`mise //cdk:build`, etc.), set **`MISE_EXPERIMENTAL=1`** — see [CONTRIBUTING.md](./CONTRIBUTING.md).

Follow the [Developer Guide](./docs/guides/DEVELOPER_GUIDE.md) to set up your environment and deploy the application to your AWS account.
Then, follow the [User Guide](./docs/guides/USER_GUIDE.md) to learn how to use the system.

## Documentation

A documentation site is available containing all design documents, roadmap and guides to deploy and use the platform. You can access it [here](https://aws-samples.github.io/sample-autonomous-cloud-coding-agents/).

## Disclaimer

The example provided in this repository is for experimental and educational purposes only. It demonstrates concepts and techniques but is not intended for direct use in production environments.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](./LICENSE) file.
