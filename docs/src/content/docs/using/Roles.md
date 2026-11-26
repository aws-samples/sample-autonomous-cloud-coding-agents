---
title: "Roles"
---

ABCA is a **shared-stack-per-organization** platform. Everyone on the team uses one CDK deployment. As with a self-hosted GitLab or Linear instance, one company has one stack, and the stack has many users. You generally do **not** run your own deployment to use someone else's. You join theirs as a Cognito user.

There are four lifecycle roles. Early on, one person often holds all of them, but each role performs different operations:

| Role | What they do | Frequency |
|------|--------------|-----------|
| **Stack admin** | Runs `cdk deploy` for the stack, rotates platform-level secrets, and runs `bgagent admin invite-user` to onboard teammates | Once, then occasionally |
| **Integration admin** | Installs Linear/Slack OAuth apps or the Jira 3LO and Forge apps once per workspace or site | One time per workspace or site |
| **Repo onboarder** | Runs `bgagent linear onboard-project`, or registers a Blueprint through CDK, to connect a repo to the platform | As needed, by any authenticated user |
| **Teammate** | Runs `bgagent configure` once, then uses `bgagent submit`, a Linear or Jira label, or a Slack mention | Daily user |

If you're a teammate joining an existing deployment, go to [Joining an existing deployment](/sample-autonomous-cloud-coding-agents/using/authentication#joining-an-existing-deployment).

If you're creating a new deployment, read the [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction) first, then return here for the [admin onboarding flow](/sample-autonomous-cloud-coding-agents/using/authentication#get-stack-outputs).