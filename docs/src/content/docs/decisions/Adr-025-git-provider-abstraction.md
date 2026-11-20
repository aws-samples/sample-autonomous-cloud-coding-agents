---
title: "ADR-025: Git provider abstraction"
---

**Status:** proposed
**Date:** 2026-11-10
**Issue:** [#456](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/456)
**Revision:** 2 (responds to review on #1032)
**Amends:** ADR-016 (credential types), ADR-017 (custom token secrets), ADR-024 §1 (optional features)

Per the [ADR lifecycle](/sample-autonomous-cloud-coding-agents/decisions/readme#lifecycle), this decision remains proposed until its implementing PR merges.

## Context

ABCA reads source, pushes branches and opens pull requests only on GitHub. Issue #456 asks for GitLab (and optionally Bitbucket) through a `GitProvider` adapter with GitHub refactored as the reference implementation.

GitHub is wired into every layer, not a single client:

- **Agent runtime.** `repo.py` clones with `gh repo clone`, pins the remote to `github.com` and configures `!gh auth git-credential`. `post_hooks.py` finds, creates, retargets and comments on PRs with `gh pr …`. `context.py` reads issues from `api.github.com`. All four coding prompts (`new_task`, `pr_iteration`, `pr_review`, `restack`) tell the model to run `gh` itself, and `gh` is the only hosting CLI in the image.
- **Handlers.** Preflight calls `api.github.com` and GraphQL `viewerPermission`. Context hydration reads issues, PRs and review threads. Fanout upserts issue comments, and the console lists issues.
- **Identity.** `owner/repo` is the RepoTable partition key, the memory namespace (`agent/src/memory.py` has a looser copy of `isValidRepo`'s regex), the clone-guard match and part of `/v1/repos/{repo_id}/policies`. GitLab nested groups and Azure DevOps `org/project/repo` paths do not fit. The repo key is also the AgentCore Memory `actorId` (`cdk/src/constructs/agent-memory.ts`), and a key such as `gitlab:gitlab.com/group/project` contains a period that the review reports is not a valid `actorId`.
- **Workflows pin the provider.** All four bundled coding workflows (`agent/workflows/coding/*.yaml`) set `repo_config.provider: github`, so a GitLab repo cannot run them without a copy of the YAML.
- **Pull request numbers.** `prNumberFromTask` in `cdk/src/handlers/shared/task-pr-number.ts` falls back to matching `/pull/<n>` in `pr_url` when `pr_number` is missing. A GitLab merge request URL contains `/-/merge_requests/<n>`, so follow-up tasks would report that the merge request does not exist.
- **Credentials.** One `github_token_secret_arn` per repo, falling back to the platform secret. Per-repo overrides are not readable today:
  - the orchestrator's `additionalSecretArns` prop is never passed;
  - the payload never carries a per-repo ARN, though the ECS strategy reads one;
  - agent compute is granted only the platform secret.
- **Egress.** `dns-firewall.ts` hard-codes GitHub domains at synth time.
- **Payload hops.** The orchestrator payload reaches the agent three ways: AgentCore `/invocations` and MicroVM `/run` through `_extract_invocation_params` → `run_task`, and ECS through `run_task_from_payload` → `run_task`. Hand-written mappers on these hops have dropped fields before (`base_branch` and channel fields, fixed in #596). The ECS and MicroVM backends can deliver the payload through S3, and each compute role can read the shared payload bucket (`payloadBucket.grantRead(taskRole)` in `ecs-agent-cluster.ts`), so any task can read any other task's payload.

[PR #824](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/824) by @Agsiegert proposed a Bitbucket provider. It established the layering this ADR adopts: a per-repo provider driving dispatch at each seam. Its review identified failure modes that any provider must avoid:

- dropped fields in hand-written mappers;
- interface members with no call site;
- cross-provider credential reuse;
- tokens persisted to `.git/config`;
- fail-open defaults.

§§1 to 5 and 8 turn these into rules. This phased plan supersedes #824. Its Bitbucket REST client, preflight probes and tests are the intended starting point for the Bitbucket phase, and @Agsiegert is invited to own it.

## Decision

### 1. The repo key is the only source of the provider

- **Derived, not stored.** The provider is a function of the repo key (§6). There is no `git_provider` attribute on `RepoConfig`, `BlueprintConfig`, the orchestrator → agent payload or `TaskConfig`. The key already travels on every hop, so there is no second field to drop, to disagree with the key or to default.
- **One function, three copies.** `providerOfRepoKey(key)` returns a provider id from the existing ADR-014 `VcsProvider` vocabulary (`github | gitlab | bitbucket | codecommit | generic_git`). It is implemented in CDK, in the agent and in the CLI. One shared corpus of keys and expected results (`contracts/repo-keys.json`) is run by all three test suites, so the copies cannot drift.
- **Constants.** `contracts/constants.json` gains `git_providers.implemented`, initially `["github"]`, and a test enforces that it is a subset of the vocabulary. CDK imports the list. The agent reads it through `shared_constants.py`, and the provider module is registered in `PYTHON_CONSUMERS` in `scripts/check-constants-sync.ts`. The CLI holds a hand-written mirror that `cli/test/constants-parity.test.ts` checks against the contract.
- **A bare `owner/repo` means github.com.** Existing rows and checkpointed durable executions keep working without migration. Any key with a `<provider>:` prefix must name an implemented, enabled provider, or the task fails (§9).
- **Workflows do not name a provider by default.** The four bundled coding workflows drop `repo_config.provider`, and an omitted value means "use the repo's provider". A workflow that sets `repo_config.provider` still constrains it: the value must equal the provider derived from the key. The CDK workflow descriptor mirror (`workflows.ts`) gains an optional provider field, and the parity test in `workflows.test.ts` checks it against the workflow YAML. Validator rule 14 changes from "only github" to "member of the vocabulary". The change updates its corpus fixture `contracts/workflow-validation/rule14-gitlab-provider.json` and the inline rule-14 test. Whether the provider is implemented is checked when the task is admitted, not during workflow validation.
- **No CLI flag.** Onboarding takes the repo key, so there is no `--git-provider` flag. `bgagent repo show` displays the derived provider.

### 2. Interfaces sized to real call sites

- The agent runtime has a `GitProvider` Protocol. The handler side has an `ScmProvider` interface. Each method enters its interface in the PR that gives it a call site. The GitHub implementation delegates to the existing code instead of re-implementing it, so the existing tests keep pinning its behaviour. Module layout is left to the implementing PRs.
- Token resolution, `git push`, clone retry and blocker classification, and PR body composition stay outside the interfaces. They are provider-neutral.

### 3. Capabilities are declared, not assumed

Each provider declares what it supports. Callers branch on capabilities, not on provider ids. A capability enters the list with its first caller. Example: Bitbucket access tokens cannot answer an effective-permission query, and `generic_git` has no API. A missing capability never passes a check by omission (§9). The console's future Access column derives from the declared capabilities and the stored permission result.

### 4. Credentials: `ScmCredential`, bound per repo

- **New credential type.** A git-provider credential is a new ADR-016 credential type, `ScmCredential`. There is one per repo. In v1 it is a direct token in Secrets Manager. The AgentCore Token Vault ([#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)) and GitHub App installation tokens ([#50](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/50)) are later resolvers for the same type.
- **Row field.** The row field is `scm_token_secret_arn`. For `github.com` repos only, `github_token_secret_arn` and then the platform secret are fallbacks. The platform GitHub secret is never a fallback for any other provider, and never for a GitHub Enterprise Server key. A GitHub Enterprise Server repo with no credential of its own fails at blueprint load, before any request to that host.
- **The payload carries a reference, never a token.** The ECS and MicroVM payload can sit in S3 where other tasks' compute roles can read it, so the payload holds at most the secret ARN. The ARN is not a credential. No token and no session credential travels in any channel that another task's role can read.
- **Bound to the repo, by something the agent cannot choose.**
  - Per-repo SCM secrets are named `bgagent/scm/<provider>/<random-id>`. Names never embed the repo key.
  - Each secret carries a `bgagent:repo` tag equal to the repo key.
  - Trusted Lambdas (orchestrator, fanout, console) get prefix-scoped `GetSecretValue`.
  - Agent compute roles get no `bgagent/scm/*` grant. A prefix grant there would let a prompt-injected task read every repo's token.
  - The agent receives only its own repo's token. The binding comes from the orchestrator, not from the agent. Today's `AgentSessionRole` `repo` session tag does not qualify: the agent sets it from its own config, and it drives only cost attribution. Phase 2 chooses between two mechanisms:
    - orchestrator-minted session credentials whose `repo` tag the orchestrator sets, with the grant conditioned on `secretsmanager:ResourceTag/bgagent:repo` equal to `${aws:PrincipalTag/repo}`;
    - the orchestrator resolving the token and delivering it through the per-task payload channel.
  - Token resolution moves from the compute role (`platform_client`, before session setup) to that per-task path.
  - Legacy `github_token_secret_arn` secrets are arbitrarily named and untagged. The Phase 2 PR states whether they are migrated to tagged SCM secrets or keep a compute-role read path.
- **Orchestrator check.** The orchestrator rejects a row whose secret is outside the prefix, or whose tag does not equal the task's repo key.
- **Payload key.** `scm_token_secret_arn` is a per-task payload key. The partition and account anchor check in `server.py` extends to cover it. Holding the ARN does not grant access to the secret: access comes from the per-task binding above.
- **Open for Phase 2.** The delivery mechanism for the per-task grant on ECS, MicroVM and AgentCore is chosen in the Phase 2 PR. It must satisfy the requirement above on each backend, and the PR states how each backend meets it. Review of the two candidate mechanisms is requested on #1032.
- **Tokens never touch disk.** Git authenticates through a credential helper that reads the token from an environment variable at call time. `.git/config` holds only the helper command. This is the existing GitHub contract in `repo.py`. Each provider supplies only its HTTPS username.
- **Redaction only widens.** New token and URL-credential formats are added to `output_scanner.py` and `shell.py`, and existing patterns are not narrowed. Value-based scrubbing in `server.py` covers every provider's token env var. `GIT_TRACE*` and `GIT_CURL_VERBOSE` are unset in the agent environment.

### 5. The model uses provider-neutral tools

- **Tools replace `gh`.** Prompts stop instructing `gh …`. The agent gets in-process tools backed by the active `GitProvider`, for commenting, replying to review threads and submitting a structured review. Reasons:
  - Bitbucket has no official CLI.
  - Each extra CLI is another binary to build and scan.
  - Review-thread models differ: GitHub reviews, GitLab discussions anchored by SHA, Azure DevOps threads, Bitbucket inline comments. A structured findings list is the only shape every provider can implement.
- **Same Cedar hook.** The tools go through the same PreToolUse Cedar hook as other tools. Cedar rules keep read-only tasks from calling mutating SCM tools other than review and comment.
- **PR creation stays deterministic.** The `ensure_pr` step keeps creating the PR, and the model gets no create tool.
- **Deferred details.** Tool names and shapes are fixed in the implementing PR. `gh` and the `gh` guards in `hooks.py` stay until the tools reach parity on GitHub.

### 6. Repository identity

- **GitHub.** A bare `owner/repo` key means github.com, so existing rows need no migration. GitHub Enterprise Server uses `github:<host>/<owner>/<repo>`.
- **Other providers.** Every other repo uses `<provider>:<host>/<path>`, for example `gitlab:gitlab.com/group/sub/project`.
- **Consistency.** A key whose prefix is not in the vocabulary, or is `github:` with the host `github.com` (the bare form is the only spelling for github.com), fails config load.
- **Memory identity.** The repo key is not used as an AgentCore Memory `actorId`. One function, `memoryActorId(key)`, maps a key to a stable ID that is valid as an `actorId`. A bare GitHub key maps to itself, so existing memory records stay reachable. Any other key maps to `<provider>_<first 32 hex characters of SHA-256(key)>`. The CDK handlers and the agent both call it for every read and write, and the shared corpus in `contracts/repo-keys.json` covers it. The Phase 3 PR checks the output against the service's `actorId` constraints before any non-GitHub key is written.
- **Pull request identity.** The task record stores `pr_number` whenever a PR or MR is created, next to `pr_url`. Callers read `pr_number`. The `/pull/<n>` match on `pr_url` stays only as a fallback for legacy GitHub rows and is never used for another provider. User-facing text uses the provider's own word ("pull request" or "merge request").
- **Character set.** Keys are limited to characters valid in STS session tag values and to at most 256 characters, so a key can travel as a tag without truncation or AssumeRole failure.
- **Deferred.** This shape is fixed now. Each provider's path grammar is fixed in the PR that adds that provider. The `isValidRepo` regex, the agent memory regex and the `/v1/repos/{repo_id}` routes change in that PR, before any row with the new key shape can be written.

### 7. Optional providers

Each non-GitHub provider is an optional `DeploymentFeatures` key ([ADR-024](/sample-autonomous-cloud-coding-agents/decisions/adr-024-deployment-profiles)), which amends ADR-024 §1. The key gates the provider's egress domains, webhook route and grants. The orchestrator accepts the intersection of implemented and enabled providers, so a resolver-valid key cannot fail late at the DNS firewall. GitHub stays core.

### 8. Inbound webhooks for non-GitHub providers

- **GitLab pipeline webhook is in scope for #456.** The first GitLab phase (§10) includes the inbound webhook for pipeline events.
- **Receiver sharing is deferred.** Whether GitLab and a later Bitbucket provider share one receiver, dedup table and processor is decided in the PR that adds the second provider, with both implementations in view. The stack budget still applies ([ADR-023](/sample-autonomous-cloud-coding-agents/decisions/adr-023-cloudformation-stack-boundaries): 490 resources), so the GitLab receiver is built so that it can become the shared one.
- **GitHub keeps its route.** GitHub keeps its existing route, because installed webhooks point at it.
- **Deferred.** The route path and the dedup key format are fixed in the implementing PR.

### 9. Normative requirements

- If a repo key has a provider prefix that is not an implemented, enabled provider id (exact match, no case folding or trimming), then the orchestrator shall fail the task at blueprint load with a message naming the prefix, before preflight, hydration or compute start.
- If the repo key's provider is not an implemented provider id, then the agent shall fail the task before any clone or other repository side effect.
- If a workflow's `repo_config.provider` is set and differs from the provider derived from the repo key, then the orchestrator shall reject the task at blueprint load, and `build_config` shall raise before clone.
- The CDK, agent and CLI implementations of `providerOfRepoKey` and `memoryActorId` shall each pass every case in `contracts/repo-keys.json`.
- If a GitHub Enterprise Server repo has no credential of its own, then the orchestrator shall fail the task at blueprint load, before any request to that host.
- The platform GitHub secret shall be used only for requests to `github.com`.
- If a provider does not declare `effective_permission` and the workflow is read-only, then preflight shall record `permission: unverified` in the preflight event.
- If a provider does not declare `effective_permission`, the workflow writes, and the repo row has no `scm_write_attested` flag, then preflight shall reject the task with reason `SCM_PERMISSION_UNVERIFIABLE`.
- Only operator paths (Blueprint construct and operator CLI) shall set `scm_write_attested`.
- When a task targets a non-GitHub provider, the platform shall not send the platform GitHub secret, or any secret that is not tagged for that repo, to that provider's host.
- The task payload shall not contain a repository token or a session credential.
- The agent shall not obtain a repository token through a binding that the agent itself selects.
- The agent shall not write a repository token to `.git/config`, to a remote URL or to any file in the workspace.
- When a PR or MR is created, the task record shall store its number in `pr_number`.
- When a redaction pattern is changed, the redaction tests shall still match every sample in the previous pattern's test corpus.
- If a webhook signing secret is missing, empty or unreadable, then the receiver shall return 401 and shall not dispatch.
- If a webhook dispatch fails after its dedup row is written, then the receiver shall delete that row.
- If the webhook route's provider segment is not an enabled provider, then the receiver shall return 404 before reading any secret.

### 10. Delivery and scope

The first GitLab task comes early, so that the interfaces are shaped by what GitLab and GitHub both need rather than by GitHub alone.

| Phase | Scope | Behaviour change |
|---|---|---|
| 0 | This ADR | none |
| 1a | Key-derived provider: `providerOfRepoKey`, `memoryActorId`, `contracts/repo-keys.json`, `git_providers.implemented`, pins removed from the four coding workflows, `pr_number` stored on every PR | A key with an unknown provider prefix fails with a named reason |
| 1b | Handlers: `ScmProvider` for preflight, with GitHub delegating to `preflight.ts` | none |
| 2 | `ScmCredential`: tagged secrets, per-task grant, reference-only payload, `github.com` scoping of the platform secret. Also fixes per-repo GitHub secret readability | per-repo secrets start working; a GitHub Enterprise Server repo with no credential fails early |
| 3 | First GitLab task on GitLab.com: onboard a project, run `coding/new-task-v1`, open an MR, send a follow-up to that MR. Includes the agent `GitProvider`, the provider-neutral tools and prompts with Cedar rules, GitLab egress and redaction, the `DeploymentFeatures` key and the pipeline webhook. The same workflow runs on GitHub as the comparison | new provider |
| 4 | GitLab remainder: hydration, comment upsert and issue listing behind `ScmProvider`; path grammar edge cases | new provider capabilities |
| 5 | Bitbucket Cloud, starting from #824, and the decision on a shared webhook receiver | new provider |

Accepting this ADR approves only the payload key `scm_token_secret_arn` as an agent-to-orchestrator contract addition. Each of the following is still raised as ask-first in its own PR:

- the IAM grant changes in §4;
- the webhook receiver construct in §8;
- the prompt and tool refactor in Phase 3.

Repository CRUD over REST and the console connect flow ([#1021](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1021)) are out of scope until that issue is approved; that work needs an ADR-017 successor. Azure DevOps and `generic_git` each need their own approved issue.

Work in `orchestrator.ts`, `orchestrate-task.ts`, `server.py` and `hooks.py` stays additive (new fields and checks, no restructuring), because open PRs are rewriting those files.

## Consequences

- (+) GitHub behaviour is unchanged through Phase 1, except that a key with an unknown provider prefix now stops the task with a named reason instead of acting against github.com.
- (+) No stored provider field means no second source of truth and no new field for a hand-written mapper to drop.
- (+) Each new provider is an implementation plus a capability declaration, not edits at a dozen call sites.
- (+) Phase 2 also fixes today's broken per-repo GitHub token overrides.
- (+) An orchestrator-chosen binding keeps one repo's credential away from another repo's agent, which a prefix grant on compute roles would not.
- (!) Until Phase 2 lands, compute-role credentials remain reachable from the agent sandbox. This ADR does not change that, and the existing `task_id` table scoping has the same limit.
- (-) Two interfaces (Python and TypeScript) must stay aligned. The shared constants contract and the key corpus guard this.
- (-) The key shape is load-bearing: moving a repo to another provider means a new key, not an edit to a field.
- (-) Phase 3 changes what the model is told to do. It needs the end-to-end GitHub comparison run, not only unit tests.
- (-) Providers without review threads or permission APIs get coarser preflight and review behaviour, and the console has to say so.
- (!) ADR-017 is refined in place. CLI-onboarded repos can reference tagged `bgagent/scm/*` secrets without a redeploy.
- (!) Self-managed hosts need a configurable base URL, CA bundle, token-prefix regex and an egress entry. Egress is synth-time, so adding a host means a deploy.

## References

- Issue [#456](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/456): GitLab integration
- PR [#824](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/824) and its review: Bitbucket provider
- Issues [#1021](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1021) (repository onboarding API), [#50](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/50) (GitHub App), [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249) (Token Vault)
- [ADR-014](/sample-autonomous-cloud-coding-agents/decisions/adr-014-workflow-driven-tasks): workflow `repo_config.provider`
- [ADR-016](/sample-autonomous-cloud-coding-agents/decisions/adr-016-pluggable-identity-and-auth): credential taxonomy
- [ADR-017](/sample-autonomous-cloud-coding-agents/decisions/adr-017-operator-cli-repo-onboarding): operator CLI onboarding
- [ADR-020](/sample-autonomous-cloud-coding-agents/decisions/adr-020-ears-requirements-syntax): EARS requirements
- [ADR-023](/sample-autonomous-cloud-coding-agents/decisions/adr-023-cloudformation-stack-boundaries), [ADR-024](/sample-autonomous-cloud-coding-agents/decisions/adr-024-deployment-profiles): stack budget and optional features
