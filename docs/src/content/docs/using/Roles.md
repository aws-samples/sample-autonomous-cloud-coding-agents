---
title: Roles
---

ABCA is a **shared-stack-per-organization** platform — one CDK deployment, used by everyone on the team. Like a self-hosted GitLab or Linear instance: one company → one stack → many users. You generally do **not** run your own deployment to use someone else's; you join theirs as a Cognito user.

There are four lifecycle roles. They are often the same person early on, but the operations they perform are distinct:

| Role | What they do | Frequency |
|------|--------------|-----------|
| **Stack admin** | `cdk deploy` the stack; rotates platform-level secrets; runs `bgagent admin invite-user` to onboard teammates | Once + occasional |
| **Linear / Slack workspace admin** | Runs `bgagent linear setup` (or `bgagent slack setup`) once per workspace to install the OAuth app | One-time per workspace |
| **Repo onboarder** | Runs `bgagent linear onboard-project` (or registers a Blueprint via CDK) to wire a repo into the platform | As needed; any authenticated user |
| **Teammate** | Runs `bgagent configure` once + `bgagent submit` / Linear-label / Slack mention from then on | Daily user |

If you're a teammate joining an existing deployment, jump to [Joining an existing deployment](#joining-an-existing-deployment) below.

If you're standing up a new deployment from scratch, see the [Developer guide](/developer-guide/introduction) first, then come back here for the [admin onboarding flow](#get-stack-outputs).