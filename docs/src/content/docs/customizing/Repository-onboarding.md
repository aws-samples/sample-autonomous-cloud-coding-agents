---
title: "Repository onboarding"
---

Before you submit tasks against a repository, the repository must be **onboarded** to the platform. The platform administrator manages onboarding through CDK. The administrator registers each repository as a `Blueprint` construct in the CDK stack, and the construct writes a configuration record to the `RepoTable` DynamoDB table.

If you submit a task against a repository that has not been onboarded, the API returns a `422` error with code `REPO_NOT_ONBOARDED`:

```json
{
  "error": {
    "code": "REPO_NOT_ONBOARDED",
    "message": "Repository 'owner/repo' is not onboarded. Register it with a Blueprint before submitting tasks."
  }
}
```

To onboard a new repository, contact your platform administrator. For details on how administrators register repositories, see the [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/repository-preparation).