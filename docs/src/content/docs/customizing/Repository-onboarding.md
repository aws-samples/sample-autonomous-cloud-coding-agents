---
title: Repository onboarding
---

Before submitting tasks against a repository, the repository must be **onboarded** to the platform. Onboarding is managed by the platform administrator through CDK  - each repository is registered as a `Blueprint` construct in the CDK stack, which writes a configuration record to the `RepoTable` DynamoDB table.

If you submit a task against a repository that has not been onboarded, the API returns a `422` error with code `REPO_NOT_ONBOARDED`:

```json
{
  "error": {
    "code": "REPO_NOT_ONBOARDED",
    "message": "Repository 'owner/repo' is not onboarded. Register it with a Blueprint before submitting tasks."
  }
}
```

Contact your platform administrator to onboard a new repository. For details on how administrators register repositories, see the [Developer guide](/developer-guide/introduction#repository-onboarding).