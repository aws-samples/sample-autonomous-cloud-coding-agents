# Architecture simplification: integrations, policies, Strands Box, runtime configuration

**Status:** investigation and implementation on a branch of 61 commits, described as it stood on 2026-11-27, before its first push. Nothing was deployed.
**Date:** 2026-11-27
**Base:** `main` at `114795e7`
**Strands Box version examined:** 0.3.2

## Summary

The owner found that the project had grown in complexity and asked four questions, to "improve the quality and clarity of it, improve the dev experience, and make it easier for people to extend the project", and for the findings to be implemented on a branch. One rule judged each proposal: delete before adding, and add an interface or a registry only where two implementations exist today and it makes the code or the next integration smaller.

| Question | Answer |
|---|---|
| 1. Integrations: would a factory, interfaces and adapters reduce duplication and ease the next integration? | No factory and no framework. Duplicated code is now shared functions, with a typed interface only where two or three implementations exist. The next issue tracker has a recipe and needs about 9% less code; the change that would make it clearly smaller is deferred. |
| 2. Policies are declared in the agent and in CDK: remove the CDK side? | The Cedar engine in CDK is removed, with the policy listing that was its only use: the route `GET /v1/repos/{repo_id}/policies` and the command `bgagent policies` ([ADR-028](../decisions/ADR-028-one-cedar-engine.md)). A repository's own rules stay: they are its data, not a copy of the built-in rules. The `Blueprint`, the CDK construct that registers a repository, writes them, and now the CLI too (question 4). |
| 3. Can Strands Box replace the agent's custom policies? | Not now ([ADR-029](../decisions/ADR-029-os-sandbox-deferred.md)). By its documentation, version 0.3.2 cannot hold a tool call for a person's approval, cannot start on ECS Fargate and does not see the Write and Edit tools, so no policy code could go. |
| 4. What else can be simplified or configured at runtime, without a deploy? | `bgagent repo onboard` writes every per-repository setting that is plain data, 16 of 17, without a deploy, and the guides name it first. The CLI and the `Blueprint`, the two writers of a repository's stored row, merge into it instead of replacing it. Platform-wide values stay in code. Code that nothing reaches is deleted. |

The 61 commits change 336 files (19 new, 50 deleted), add 6,632 lines and remove 13,652. Source (the `src` directories of cdk, cli, web and agent) shrinks by 4,957 lines, their tests by 1,631, and documentation, fixtures, lockfiles and tooling by 432. Two declared dependencies go: `@cedar-policy/cedar-wasm` from cdk and `bedrock-agentcore` from the agent, and with it `websockets` from the agent's lockfile. In the templates that `mise //cdk:census` synthesizes offline for its 142 named profiles (combinations of compute backends, optional features and network layouts), no stateful resource is added, removed or renamed. The application stack's own template (the root template) loses 12 resources and one output in every profile, and one more for each of the Linear, Jira and Slack integrations it deploys: the widest profile, with all three compute backends and every optional feature, goes from 483 resources to 468, under the project's limit of 490. What was not verified is listed under [Verification](#verification).

## Question 1: integrations

No factory and no framework: copies became shared functions, with a typed interface only where two or three implementations exist. The next issue tracker gets a recipe and needs about 9% less code.

Below, `shared/` stands for `cdk/src/handlers/shared/`. A *surface* is Linear, Jira, Slack or GitHub; a *tracker* is Linear or Jira. A surface's *receiver* is the API Lambda that verifies a delivery; its *processor* is the Lambda that creates tasks from it.

**On the base,** 72 files of `cdk/src` with 26,872 lines named a surface in their path. Each surface had its own family of files, and their common parts were copies:

| Copies on the base | Shared now |
|---|---|
| 9 table constructs | `integrationTable`, `webhookDedupTable` in `cdk/src/constructs/integration-parts.ts` |
| 4 modules that verify a webhook signature | `cachedSecrets`, `hmacSha256Equals`, `verifyWithRefetch` in `shared/webhook-hmac.ts` |
| the closing steps of 3 receivers (Linear, Jira, GitHub) | `dedupAndDispatch` in `shared/webhook-dispatch.ts` |
| 3 account-link handlers | `makeLinkHandler(spec)` in `shared/account-link.ts` |
| helpers of the 2 tracker processors | `buildCreateTaskFailureMessage`, `renderCommentSection`, `appendAdvisorySection`, `screenAdvisoryOrDrop` in `shared/tracker-intake.ts` |
| the screen-and-store steps of 2 attachment modules | `screenAndStore`, `deleteStoredObjects` in `shared/attachment-store.ts` |
| 6 blocks of the CLI that report missing stack outputs | `requireStackOutputs` in `cli/src/stack-outputs.ts` |
| 11 blocks that give a Lambda access to a tracker | `FeedbackTracker.grantFeedback` in `integration-parts.ts` |
| 3 blocks that wire task creation (Linear, Jira, Slack) | `taskCreationEnvironment`, `grantTaskCreation` in `cdk/src/constructs/task-creation.ts` |

Code that a deployed stack cannot reach, or that served a feature never built, is removed as well, and the Linear processor creates a task from a comment in one function instead of four places. On the branch, 62 files with 24,188 lines name a surface and the seven new shared modules of `cdk/src` add 885: 1,799 lines fewer, 7%.

**Why no factory and no inbound framework.** On the inbound path, from a webhook delivery to a task, nothing picks an implementation at run time: each surface has its own routes and Lambda entry points, fixed at deploy time, so a factory would have one product per call site. Nor does a pipeline with a hook per step pay: of the sixteen steps from a labelled issue to a task, four are the same code in Linear and Jira. Where functions replace copies, handlers keep their responses, log texts and exported names, and constructs keep their ids, so every logical ID stays; the construct classes and props that went are in the [decisions table](#decisions-made-on-the-owners-behalf). A change of behaviour or IAM is a commit of its own, with three exceptions, each named in its commit message: the account-link handlers of Linear and Slack now read the pending link code with DynamoDB's `ConsistentRead`, as Jira's did; four log lines of the receivers carry more fields; and the Linear processor reads the earlier task's description before it acknowledges a comment, one read more when the dispatch then stops at the comment's files.

**Where an interface is right.** Feedback on an orchestration, the run of an epic's sub-issues as tasks, is the one place where code picks a surface's implementation from stored data through a registry. It has the interface `Channel` (`shared/orchestration-channel.ts`), that registry and two adapters in production, Linear's and Jira's; they stay, and a Slack adapter that no caller could select is removed. A few handlers still branch on the stored surface by name (the queue notice, the heartbeat, the screenshot comment, the fan-out's dispatcher table); the recipe lists them. In CDK, the Linear and Jira constructs now implement `FeedbackTracker`: `grantFeedback(fn, { writeBack })` gives a Lambda outside them the access it needs to write to a tracker's issues. Six functions use it, and each call states with the required `writeBack` whether its function may store a rotated token. Introducing the interface changed no role's permissions.

**Adding a tracker.** `cdk/AGENTS.md` has a recipe, "Add a tracker integration". A new tracker calls the functions of the table, implements `Channel` and `FeedbackTracker`, and still writes its own verification order, event filter, API client, processor flow, OAuth resolver, CLI `setup` and the agent module that reports issue status (761 lines for Jira). Measured on Jira, a tracker is 786 lines or 9% smaller than on the base: its files in `cdk/src`, `cli/src` and `agent/src` went from 9,164 lines in 25 files to 8,378 in 22. What would make it clearly smaller is deferred ([Not done](#not-done-and-why)): once the platform writes issue status, a tracker needs no agent module. Room is the other limit: beside an existing tracker, one of Jira's shape adds 24 resources to the root template (25 on the base), whose limit is 490 (CloudFormation's is 500). On the base, 11 of the 142 profiles had fewer than 25 left, and the widest had 7. Now the widest has 22, and no other profile has fewer than 24.

**Rejected.**

- A `WebhookSource` contract with a driver for the receivers: 15 lines fewer than `dedupAndDispatch`, for a rewrite of about forty early returns.
- A base class for the Linear and Jira constructs: about 70 shared lines a side remain, and it reorders the Jira processor's IAM statements. Look again with a third tracker that uses OAuth.
- One OAuth refresh engine: the two resolvers differ in eight places, and ADR-016 plans to remove the step in which Linear's resolver stores a refreshed token.

## Question 2: policies declared in two places

Yes for the second Cedar engine, no for a repository's own rules.

**On the base,** the built-in Cedar rules were declared in two places and evaluated in one. The agent evaluates every tool call: `agent/src/policy.py`, on `cedarpy`, loads the 11 built-in rules of `agent/policies/` and the repository's own rules, and answers allow, deny or require approval. CDK held a second engine that never decided a request: a byte-identical copy of the built-in rules, a parser on `@cedar-policy/cedar-wasm`, a Lambda layer and ten fixtures that compared both engines. Its one consumer was the policy listing.

**Chosen** ([ADR-028](../decisions/ADR-028-one-cedar-engine.md)). One engine, the agent's, with `cedarpy` pinned to an exact version that a test names. The second engine and the listing are removed: three commits (`7ff776cb`, `c9a7faeb`, `ea09b5e7`) delete 3,179 lines and add 145. The price is the listing: a user without AWS credentials learns a repository's own rule ids from its approval requests, and an older CLI's `bgagent policies` prints `HTTP 403: Forbidden`. The user guide has a table of the 11 built-in rule ids, checked by an agent test.

**What stays.** A repository's own rules, which exist nowhere else: rule text, written by the `Blueprint` property `security.cedarPolicies` or by `bgagent repo onboard --cedar-policy-file`, and rule sets of the asset registry (kind `cedar_policy_module`) that the repository pins. The repository's row in RepoTable, the DynamoDB table of registered repositories, holds the text and the pins; the orchestrator sends both kinds of rule with each task, and the agent parses them when the task starts. Neither writer parses Cedar, so removing the CDK engine removes no check. The agent's workflow files declare rule sets too, in a field that the engine never reads ([Found and not changed](#found-and-not-changed)).

**Rejected.** Keeping the listing on a checked-in catalog of the built-in rules: the listing also shows a repository's own rules, which need a parser.

## Question 3: Strands Box

Not now, neither as a replacement for the agent's policy code nor as a layer under it. [ADR-029](../decisions/ADR-029-os-sandbox-deferred.md) records the decision and the four conditions for another look. No code changes.

[Strands Box](https://github.com/strands-agents/box) runs a coding agent in an operating-system sandbox and checks its shell commands, network requests and MCP calls against a default-deny policy. Version 0.3.2 (released 2026-11-25, pre-1.0, in preview) was read at its tag.

As a replacement for `agent/src/policy.py` and the approval gate, three reasons decide, each sufficient:

1. **No approval verdict.** A Box decision is allow or deny, made locally; pending decisions are an open issue (`strands-agents/box#646`). The agent's soft tier, which holds a tool call until a person approves it, would be lost.
2. **Backends.** By its documentation Box did not start under Docker's default configuration, and ECS Fargate has no setting to change that. For an AgentCore Runtime container and for Lambda MicroVM as configured here it records no tested configuration.
3. **File tools.** Claude Code's Write and Edit tools make their own system calls, which reach a granted path "with no decision and no record". The built-in rules on file paths would have no counterpart.

As a layer under the approval gate only reason 2 remains, but the code would grow: a generator of Box files per task, a second policy language and a qualification on each backend, for the removal of one guard of about 170 lines. Box decides egress and credentials per task and per request; without it both stay as documented ([ADR-029](../decisions/ADR-029-os-sandbox-deferred.md), Consequences).

## Question 4: simplification and runtime configuration

Yes for a repository's settings, all but one of which the CLI now writes without a deploy; no for platform-wide values, which stay in code.

**On the base,** a repository's row in RepoTable holds 17 settings (`shared/repo-config.ts`) and has two writers. The `Blueprint` construct sets any of them, at the price of a source edit and a deploy; `bgagent repo onboard` set six. Neither writer kept all that the other had written, and data was lost in three ways. The CLI replaced the whole row, so a run on an existing row deleted the five settings it did not model. The first deploy of a Blueprint replaced the row too. A later deploy left the expiry that an offboarding sets, so a repository that was offboarded and then re-activated by a deploy would be deleted when its 30 days were over.

**Chosen.** No new table, parameter, route or cache. The CLI writes every setting that is plain data, the Blueprint remains the checked-in declaration, and both send one merging `UpdateItem`: the CLI changes only the settings it names, and a Blueprint sets what it declares and removes a list of pinned registry assets only when it declares the list as `[]`. Readers apply the defaults, so removing a setting restores the platform default. The row is read when a task is submitted and when it starts, so a change applies to every task that starts after it; only the approval-gate cap is fixed when a task is submitted.

**Without a deploy.** One flag for each of 16 settings. Six existed; ten are new: `--max-budget`, `--memory-token-budget`, `--approval-gate-cap`, `--build-command`, `--lint-command`, `--system-prompt-file`, `--cedar-policy-file`, and `--mcp-server`, `--cedar-policy-module` and `--skill` for the registry assets that a repository pins. `--unset <column>` removes any of the 16. The four repeatable flags replace the stored list and say so. The CLI parses no Cedar: the agent does when a task starts, so a bad rule file fails that repository's tasks until it is corrected or unset.

**Still a deploy.** Egress domains, the 17th setting: the allowlist is one Route 53 Resolver domain list in the template for the whole VPC, and the row's `egress_allowlist` has no reader at run time. IAM: the CLI can store a runtime ARN or token secret, but the grant on it is made by a deploy. Platform-wide values, and everything behind a context key: features, compute backends, the network.

**Rejected.** A runtime store for platform-wide values: they are constants, and three of them changed in the 382 commits of `main`. A REST route for repository settings: it costs seven resources of the root template, all that the widest profile had left on the base, and ADR-017 defers it until an API design exists.

**Deleted,** because nothing reads or calls it: the agent's Python copy of the registry resolver (632 lines and 129 tests), five step handlers and the checkpoint of its workflow runner, the re-export shim of `agent/src/entrypoint.py`, the `bedrock-agentcore` SDK, and five functions of cdk that only tests called.

**For the next change.** cli, web and agent now have the focused test task that cdk had: `mise //<package>:testf -- <path>`. The package guides have recipes that list what has to change together: a REST endpoint, a scheduled job and a tracker integration in `cdk/AGENTS.md`, a command in `cli/AGENTS.md`, a workflow in `agent/AGENTS.md`. In the agent, whether a workflow works on an existing pull request is read from its file (`required_inputs` names `pr_number`), not from a table of ids, and the four writers that put one event into CloudWatch Logs call one function, `put_log_event`.

## Decisions made on the owner's behalf

Each row changes behaviour, IAM or a public surface in a way the request did not name. The hashes are those of the unmerged branch: they serve to review or revert a decision there, and a squash merge leaves none of them. A row says so when it needs more than a revert; some reverts will conflict with later commits.

| Decision | Commit |
|---|---|
| The policy listing is removed: a public removal inside `/v1`, for the owner to decide before a merge. To undo, revert the three commits and delete ADR-028; the contributor rules that name the removed fixtures then need one edit | `c9a7faeb`, `ea09b5e7`, `30617282` |
| An agent that cannot import `cedarpy` fails the task at the start; before, the task ran with every tool call denied | `b73d4fe5` |
| A task whose workflow file cannot be loaded fails while its configuration is built, before the clone and the agent; until now it ran on values derived from the workflow's id and failed in the agent step. The agent's server no longer answers `400 TASK_RECORD_INCOMPLETE` when the record of such a task also lacks a required field. No task that completes today is affected | `1f363da9`, `282eccb7` |
| A stored turn limit and budget are held to the API's ranges when a task starts; zero or less counts as not set | `ca0760b7` |
| An ECS task no longer gets the per-repository prompt as a container override, which nothing read; it counted against the 8,192 bytes that ECS allows for a task's overrides, so a prompt of a few kilobytes failed the task at dispatch | `5e10813c` |
| `bgagent repo onboard` needs `dynamodb:UpdateItem` on RepoTable instead of `PutItem`, prints `onboarded`, `updated` or `re-activated`, and puts the stored row into its JSON output. The Blueprint's custom resource, which merges too, loses `dynamodb:PutItem` | `e4c58ad0`, `548dcd8f` |
| The CLI refuses a `--max-turns` outside 1 to 500 (it was stored as given), a number with trailing text such as `12abc`, and an empty value of a setting flag (three flags ignored it) | `41a94127`, `93daeec3` |
| The CLI may write Cedar rules and Cedar module pins, which ADR-017 left to a deploy; the amendment of ADR-017 makes this a point of its own. To undo, remove the flags `--cedar-policy-file` and `--cedar-policy-module` | `c6ab1d1c`, `22c20e3f` |
| A Blueprint leaves a list of pinned registry assets alone unless it declares the list as `[]`. Undone, pins set by the CLI last until the next deploy | `ab30935a` |
| The guides, the CLI README, the plugin skills and `docs/design/REPO_ONBOARDING.md` present `bgagent repo onboard` as the default way to register a repository and a Blueprint as the checked-in alternative; [ADR-017](../decisions/ADR-017-operator-cli-repo-onboarding.md) is amended. The "not onboarded" errors, the platform doctor and the registry-disabled error name the command too | `22c20e3f`, `f7a567a3`, `b08dfb85`, `1ace7e6a`, `31fd0bfb` |
| A fork no longer compiles if it reads one of eight removed properties of `Blueprint`; builds a `TaskApi` without its repository table or guardrail, or with `cedarWasmLayer`; builds an integration construct without `linkAuthorizer`; passes the per-tracker props of `FanOutConsumer` or `GitHubScreenshotIntegration`, which take `trackers` now; or uses one of the nine table constructs or `CedarWasmLayer`, which are deleted | `abe7e8ae`, `7a83de2b`, `92695dd0`, `9d413b10`, `5b93fefa`, `c9a7faeb`, `ea09b5e7` |
| The account-link routes of Linear, Jira and Slack and Linear's workspace removal (`DELETE /linear/workspaces/{slug}`) use the API's own Cognito authorizer: a stack update removes each integration's own, which had the same configuration, and the routes share one result cache | `92695dd0` |
| IAM: `WebhookCreateTaskFn`, the function behind the generic webhook route, gains put and delete on the attachments bucket; it had the bucket's name and could not write to it, so an inline attachment failed | `6e775ec3` |
| IAM: the Jira processor's access to the attachments bucket narrows to put and delete, as Linear's | `66d1807a` |
| IAM: the sweep, the scheduled function that recovers stranded orchestrations, gains read access to Jira's workspace registry, get and put on Jira's OAuth secrets and, with the Linear identity vault, the vault's token grants. A Jira epic that it recovers now gets its panel, the status comment on the epic's issue, updated and its final state set. As it already does for Linear, the sweep rewrites that panel about six times in the hour after an epic ends, and its first run after the deploy sets the final state of every Jira epic left without one, however old | `6dbf12cc` |
| Four of the nine places that start an epic's ready sub-issues were incomplete: three now mark the dependents of a refused sub-issue as skipped at once, not at the sweep's next run, and Jira's path for an extended epic keeps to the user's free concurrency | `8a4f4375` |
| The Slack events route answers an absent signing secret with a 500, and a signing secret stays cached when its re-read fails | `67319f68`, `b83aa569` |
| Removed: per-task notification overrides and an email channel stub, designed and not built; the `jira-server` entry that the agent wrote into the `.mcp.json` of a Jira task's clone, which could not connect | `06670eb8`, `e6ce0062` |

One change to a gate: the check of suppression comments in `mise run security:sast:masking` stops on a tracked file name that is not valid UTF-8 (`74a8e415`).

## Not done, and why

**Open pull requests that overlap.** [#1086](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1086) (approvals and a new payload bootstrap) rewrites much of `agent/src/server.py` and `shared/orchestrator.ts`; this branch leaves the seat handling in `confirm-uploads.ts` to that work, which has moved to [#1101](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1101), and drops a small clean-up of the approval-gate hook in `agent/src/hooks.py`. The draft [#1092](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1092) (comments only; 1,138 files, about 50,000 lines fewer) has the same base and changes 250 of the 267 files this branch modifies. #1086 had 100 files when this work was planned and changed 37 of the branch's 336; on 2026-11-27 it had 62, of which the branch changes 25, and it removes the same ECS override as `5e10813c`. [#1093](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1093) corrects, for issue #1091, the loss of settings that `e4c58ad0` corrects, in the same three files of the CLI. Whichever merges second redoes its hunks in the shared files, so this branch prefers deleted and new files to edits in large files and defers every pure move of code. One commit, `08fe0a1e`, changes only comments and docstrings, most of which named code this branch removed, in 40 files; it can be dropped when rebasing over #1092. Another, `88e96085`, corrects one description string of the workflow schema.

| Deferred | Size | Look again when |
|---|---|---|
| The platform, not the agent, writes issue status to Linear and Jira; `agent/src/linear_reactions.py` and `jira_reactions.py` go | about 1,840 Python lines | first after this branch; it needs a single-writer rule, because the orchestration reconciler overrides the agent's result for a sub-issue, and it changes the agent contract |
| One workspace package for the API types, in place of two hand-kept mirrors and their sync check | about 2,500 lines | the owner agrees to change the build layout |
| One path from payload to task configuration in the agent | about 350 lines | #1086, which rewrites the code around that path, has merged |
| Moves in CDK: `TaskApi` built after the orchestrator, sections of `cdk/src/stacks/agent.ts` as functions, one helper for the 54 Lambda definitions | about 190 lines | the merge order of the open pull requests is decided |
| Delete the data props of `BlueprintProps` | about 440 of the construct's 779 lines on the base (625 now) | the owner decides that settings are written by the CLI only |
| One declaration of the task retention, in place of 35 constants, props, environment lines and reads in `cdk/src` | fewer than 70 lines, in about 35 files | #1086 and #1101, which change some of those files, have merged |

## Found and not changed

- The root `.dockerignore` keeps the sources of `cdk/` and `cli/` in the agent image's build context, so a TypeScript-only change makes the next deploy rebuild and push the image.
- `cdk/src/stacks/console.ts` holds one more hand-written feedback grant, and seven Secrets Manager ARN patterns in `cdk/src` could use `secretArnPattern`.
- `.github/dependabot.yml` still names `@cedar-policy/cedar-wasm`; the files under `.github/` were left to the owner.
- A Slack mention with a file cannot create a task: the processor has no attachments bucket, so task creation answers 503, and the bot's scopes lack `files:read`. Complete the path or remove it (about 165 source lines).
- In the agent's workflow files, `agent_config.cedar_policy_modules` and `limits.max_turns` have no effect, and a coding workflow may declare a `post_review` step that nothing runs. The workflow runner has handlers for three of the eight kinds of step.
- Texts left as they are: `bgagent repo show` labels a stored value `(per-blueprint override)`, whoever wrote it; the first note after `repo onboard` says "With no per-repo overrides" also when the command has just set some; `cli/README.md` describes offboarding by "Blueprint delete semantics"; and older lines of the user, developer and prompt guides name only the Blueprint.
- `docs/design/VISION.md` says that memory plugs in behind a stable contract; `docs/design/MEMORY.md` now says that there is no storage interface.
- A task that fails because its repository pins registry assets on a stack without the asset registry is classified as "Context hydration failed": retryable, with a remedy about GitHub and guardrails.
- The commit hook runs the agent's whole test suite (about three minutes in CI) when a Python file of the agent changes; running the static checks instead changes a gate and was left to the owner.

## Verification

**What ran,** on one macOS machine. On the last commit before this note, `mise run build` and `mise run security` end with exit 0: the builds of the packages and the docs site, the four suites within their coverage floors (cdk 9,586 tests, cli 1,785, web 555, agent 3,091), the cross-package checks and the security scans. The agent image builds from a clean export of that commit, and the agent's modules import inside it without `bedrock-agentcore`. On the same commit the emulator-backed tests pass (`mise run test:integration`: 33 cdk, 9 cli and 44 agent tests), among them two new suites that execute the merging `UpdateItem` of a Blueprint and of `bgagent repo onboard`. The census synthesizes 661 templates for the 142 profiles without bundling, so it sees templates, not handler code. Against the base, the resources named in the summary go and the API deployment is replaced; nothing else is added, removed or retyped. The 19 resources that differ in content follow from the changes described here; the tag of the agent image is among them, so the next deploy rebuilds the image. The five commits that change the receivers, the Slack routes and the account-link handlers were also run together, old code against new, on generated requests: no response of the Linear, Jira or GitHub receivers differs. That run was made on 2026-11-26, before the re-read of a signing secret changed (`b83aa569`).

**Not verified.**

- When this note was written the branch had not been pushed: no GitHub workflow of the repository had run on it, not the build, the security suite, CodeQL or the emulator tests.
- The census of all 142 profiles ran before the last edits of the branch (comments, one test, documents); a census of 13 profiles on the last commit before this note differs from the full one only in the tag of the agent image and in the synthesis time that a Blueprint's custom resource carries.
- Nothing was deployed and no call was made to AWS: what a stack update does is read from templates, the two merging writes ran against the emulator, not against DynamoDB, and the agent image was not started on a compute backend.
- Read from code or documentation and not tried: that DynamoDB deletes a re-activated repository after 30 days, that ECS refuses a task whose overrides exceed 8,192 bytes, what API Gateway answers for a removed route, and that Slack refuses to hand a file to a bot without the scope `files:read`.
- Not tried on a Jira site: whether Jira notifies an epic's watchers each time the sweep rewrites its panel. The update is sent without the option that switches the notification off.
- Whether a deployed repository row holds a turn limit or a budget outside the API's ranges is not known; such a row now runs with the bounded value.
- Whether each commit of the decisions table reverts without a conflict was computed with `git merge-tree`; no reverted tree was built or tested.
- Nothing of Strands Box was built or run, no compute backend was probed, and no merge with #1086 or #1092 was tried.
- #1086 and #1092 were read as they stood on 2026-11-26: #1086 from its patches of that morning; of #1092, the list of changed files, the diffs of the nine table constructs and the line counts of fifteen more files. Of #1086 as it stood a day later, of #1101 and of #1093, only the lists of changed files were read.

## Open questions for the owner

1. May the policy listing be removed? It is a public removal inside `/v1`, to decide before a merge.
2. Do the two IAM additions stand: put and delete on the attachments bucket for `WebhookCreateTaskFn`, and, for the sweep, Jira access and the token grants of the Linear identity vault?
3. [ADR-003](../decisions/ADR-003-contribution-governance.md) asks for an approved issue before implementation, and this work had none. Is it approved after the fact?
4. Which merges first: this branch, #1086 or #1092?
5. ADR-017 deferred structured audit records (who changed what, before and after) until the CLI is the primary way to write a repository's settings; its amendment says that they are now due. Build them?
