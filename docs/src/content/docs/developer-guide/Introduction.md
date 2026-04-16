---
title: Developer guide introduction
---

# Developer guide

This project is built in TypeScript with [Yarn workspaces](https://classic.yarnpkg.com/lang/en/docs/workspaces/), [mise](https://mise.jdx.dev/) for tasks and tool versions, and AWS CDK for infrastructure. There is project-wide testing, code checks, and compilation. There is currently no dedicated development container, so you need to configure your local development environment by following the steps below.

![ABCA architecture](/sample-autonomous-cloud-coding-agents/imgs/abca-arch.png)

The repository is organized around four main pieces:

- **Agent runtime code** in Python under `agent/` — runtime entrypoint, task execution loop, memory writes, observability hooks, and local container tooling.
- **Infrastructure as code** in AWS CDK under `cdk/src/` — stacks, constructs, and handlers that define and deploy the platform on AWS.
- **Documentation site** under `docs/` — source guides/design docs plus the generated Astro/Starlight documentation site.
- **CLI package** under `cli/` — the `bgagent` command-line client used to authenticate, submit tasks, and inspect task status/events.
- **Claude Code plugin** under `docs/abca-plugin/` — a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) with guided skills and agents for setup, deployment, task submission, and troubleshooting. See the [plugin README](/design/readme) for details.

> **Tip:** If you use Claude Code, run `claude --plugin-dir docs/abca-plugin` from the repo root. The plugin's `/setup` skill walks you through the entire setup process interactively.