---
title: "Developer guide introduction"
---

ABCA uses [Yarn workspaces](https://classic.yarnpkg.com/lang/en/docs/workspaces/) for its TypeScript packages, [mise](https://mise.jdx.dev/) for tools and tasks, and AWS CDK for infrastructure. To build and test the project, [open the contributor dev container](/sample-autonomous-cloud-coding-agents/developer-guide/installation#open-the-contributor-dev-container) or follow the [Quick Start](/sample-autonomous-cloud-coding-agents/getting-started/quick-start) to set up your own machine.

![ABCA architecture](/sample-autonomous-cloud-coding-agents/imgs/abca-arch.png)

The repository is organized around these main pieces:

- **Agent runtime code** in Python under `agent/`. It holds the runtime entrypoint, the task execution loop, memory writes, observability hooks, and local container tooling.
- **Infrastructure as code** in AWS CDK under `cdk/src/`. The stacks, constructs, and handlers define and deploy the platform on AWS.
- **Documentation site** under `docs/`. It holds the source guides and design docs, plus the generated Astro/Starlight documentation site.
- **CLI package** under `cli/`. It is the `bgagent` command-line client, which you use to authenticate, submit tasks, and inspect task status and events.
- **Operator console** under `web/`. It is a single-page React app for the people who run a deployment. It shows what agents are working on, what is stuck, and what is waiting for a human. It talks only to the REST API.
- **Claude Code plugin** under `docs/abca-plugin/`. It is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) with guided skills and agents for setup, deployment, task submission, and troubleshooting. See the [plugin README](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/docs/abca-plugin/README.md) for details.

> **Tip:** If you use Claude Code, run `claude --plugin-dir docs/abca-plugin` from the repo root. The plugin's `/setup` skill guides you through the whole setup interactively.