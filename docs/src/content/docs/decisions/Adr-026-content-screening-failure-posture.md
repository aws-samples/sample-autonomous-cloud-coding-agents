---
title: "ADR-026: Content-screening failure posture for webhook enrichment"
---

**Status:** accepted
**Date:** 2026-11-20
**Issue:** [#793](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/793)

## Context

A task that starts from a Jira or Linear issue is built from more than the issue's title and description. Before the webhook processor creates the task, it fetches further context and hands it to the agent with the task, because the agent has no Jira or Linear tools to read it at run time:

- the recent human comments on the issue (Jira and Linear);
- the documents of the issue's project (Linear);
- in a Linear epic, the files attached to a single sub-issue.

People other than the reporter can write this content, so the processor screens it through the Bedrock Guardrail before it can reach the agent, like every other input ([SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security#input-validation-and-guardrails)). Screening does not always end in a pass: the guardrail blocks the content, the screening call fails, or the processor has no guardrail configured.

[Vision tenet 4](/sample-autonomous-cloud-coding-agents/architecture/vision#4-fail-closed-on-risk-fail-open-only-where-safety-allows) has the platform fail closed on risk and fail open only where safety allows, and wants a path that degrades to be backed by an ADR that documents the threat model. The processors already draw that line. For comments and project documents the review of [#788](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/788) confirmed it; the code applies the same rule to a sub-issue's files, a path that review did not look at. The reasoning was written out again at each call site. This record states it once.

## Decision

1. **Content that specifies the task fails closed.** The issue's title and description, the attachments of the triggering issue (for an epic, its shared specification) and the files attached to an `@bgagent` comment (Linear) say what the work is. If the guardrail blocks one of them, or its screening fails, the task is rejected and the reason is posted on the issue ([ATTACHMENTS.md](/sample-autonomous-cloud-coding-agents/architecture/attachments#design-principles), principle 3). A task that runs without its specification does the wrong work.
2. **Advisory enrichment fails open, by being dropped.** The three kinds of content listed under Context add to a task that is complete without them. If the guardrail blocks one of them, its screening call fails, or there is no guardrail to screen it with, the processor drops that content and creates the task without it. The failure does not reject the task, and the content is never passed on unscreened. For a sub-issue's own files this is an exception to principle 3 of ATTACHMENTS.md, under which a file that fails screening fails the task and is never silently dropped; the principle holds for every other file these processors screen.
3. **Scope.** This record covers what the Jira and Linear webhook processors add when they admit a task. It is about a failure to screen content that a processor holds; a failure to fetch content is outside it. Whatever a processor writes into the task description besides advisory enrichment is part of that description and fails closed with it. GitHub issue and pull request content is screened as a whole during hydration and stays fail-closed ([SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security#hydration-time-screening)).
4. **Extending the list.** Content joins the advisory class only when the task is complete without it and every failure to screen it drops it.

Normative requirements (EARS, per [ADR-020](/sample-autonomous-cloud-coding-agents/decisions/adr-020-ears-requirements-syntax)):

- If the guardrail blocks content that specifies the task, or the call that screens it fails, then the webhook processor shall not create the task.
- When the webhook processor rejects a trigger label or an `@bgagent` comment because content that specifies the task was blocked or could not be screened, the webhook processor shall post the reason on the issue.
- If the guardrail blocks advisory enrichment, the call that screens it fails, or no guardrail is configured to screen it, then the webhook processor shall drop that enrichment and shall not reject the task for it.
- The webhook processor shall hand advisory enrichment to the agent only after the guardrail has passed it.
- If a task is not complete without a kind of content, then the author of a change shall not make that content advisory enrichment.
- When a change makes a further kind of content advisory enrichment, the author of the change shall add that kind to the list under Context in the same change.
- When a change places a suppression of the silent-success-masking rule on a path that drops advisory enrichment because it could not be screened, the author of the change shall cite this record in the reason of the suppression.

### Threat model

"Fail open" describes the task, never the content: the task is not blocked, and the content is removed.

- **Rejecting would give third parties a veto.** Anyone who can comment on an issue or edit a project document could stop every task on that issue with one text that trips the content policy, and the reporter cannot always remove what another person wrote. Dropping takes that lever away and gives up none of the guardrail's protection: the text that is dropped is the text that was blocked or could not be screened. For a sub-issue's own files the unit is the epic: a sub-issue with a file that cannot be screened is released without its own files, and the epic still runs.
- **Dropping cannot admit hostile text.** Dropped content is absent from what the agent receives. The task description that the processor submits, with the comments and documents that passed, is screened again by `createTaskCore`, which fails closed.
- **The cost is context, not safety.** The agent may work without a clarification that a comment, a document or a sub-issue's file carried.

## Consequences

- (+) A comment, a project document or a sub-issue's file that is blocked or cannot be screened is dropped, and the task is not rejected for it.
- (+) The rule is stated once. A new call site cites it, and a reviewer checks a path against one list.
- (-) The agent can run without context that a person expected it to read, and nobody is told on the issue.
- (!) Only a failed screening call on comments or project documents is counted: it adds to `ABCA/Webhooks:WebhookScreeningFailed`, and the alarm on that metric notifies the shared alerts topic ([OBSERVABILITY.md](/sample-autonomous-cloud-coding-agents/architecture/observability#alarms), [#794](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/794)). A sub-issue's own files dropped for the same reason are not counted, and a drop for any other reason leaves no trace outside the processor's log.
- (!) A guardrail outage still rejects the task, because the task description fails closed. Dropping decides the outcome when only the enrichment is blocked, or only its screening call fails.

## References

- [#793](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/793); [#756](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/756) and [#788](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/788), the suppressions that restated this reasoning and the review that confirmed the boundary for comments and project documents
- [#619](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/619) (Jira comments) and [#695](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/695) (Linear comments, project documents and sub-issue files), which introduced these paths
- [SECURITY.md](/sample-autonomous-cloud-coding-agents/architecture/security#input-validation-and-guardrails), [ATTACHMENTS.md](/sample-autonomous-cloud-coding-agents/architecture/attachments), [VISION.md](/sample-autonomous-cloud-coding-agents/architecture/vision)
- [ADR-020](/sample-autonomous-cloud-coding-agents/decisions/adr-020-ears-requirements-syntax), the EARS syntax of the normative requirements above
- `screenCommentsOrDrop` in [`jira-webhook-processor.ts`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/cdk/src/handlers/jira-webhook-processor.ts); `screenCommentsOrDrop`, `screenProjectDocsOrDrop` and `hydrateChildrenOwnAttachments` in [`linear-webhook-processor.ts`](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/cdk/src/handlers/linear-webhook-processor.ts)
