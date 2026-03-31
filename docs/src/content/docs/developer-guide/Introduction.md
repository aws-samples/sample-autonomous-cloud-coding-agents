---
title: Developer guide introduction
---

# Developer guide

This project is built in TypeScript using Projen ([projen.io](http://projen.io/)). This supports project-wide testing, code checks, and compilation. There is currently no dedicated development container, so you need to configure your local development environment by following the steps below.

![ABCA architecture](/imgs/abca-arch.png)

The repository is organized around four main pieces:

- **Agent runtime code** in Python under `agent/` — runtime entrypoint, task execution loop, memory writes, observability hooks, and local container tooling.
- **Infrastructure as code** in AWS CDK under `src/` — stacks, constructs, and handlers that define and deploy the platform on AWS.
- **Documentation site** under `docs/` — source guides/design docs plus the generated Astro/Starlight documentation site.
- **CLI package** under `cli/` — the `bgagent` command-line client used to authenticate, submit tasks, and inspect task status/events.