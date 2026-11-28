---
title: "Repository onboarding"
---

Before submitting tasks against a repository, the repository must be **onboarded** to the platform. A platform administrator onboards it with `bgagent repo onboard <owner/repo>`, which needs no deploy, or with a `Blueprint` in the CDK app, which is checked in and applied by a deploy. Both write the repository's configuration record to the `RepoTable` DynamoDB table.

If you submit a task against a repository that has not been onboarded, the API returns a `422` error with code `REPO_NOT_ONBOARDED`:

```json
{
  "error": {
    "code": "REPO_NOT_ONBOARDED",
    "message": "Repository 'owner/repo' is not onboarded. Register it with 'bgagent repo onboard' or a Blueprint before submitting tasks."
  }
}
```

Contact your platform administrator to onboard a new repository. For details on how administrators register repositories, see the [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/repository-preparation).