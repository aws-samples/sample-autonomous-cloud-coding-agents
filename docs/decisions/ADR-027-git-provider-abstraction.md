# ADR-027: Git provider abstraction

**Status:** proposed
**Date:** 2026-11-10

Per the [ADR lifecycle](./README.md#lifecycle), this decision remains proposed until its first implementing PR merges, which is Phase 1a in §10. That merge moves the status to accepted. Later phases implement an accepted decision, and each ask-first item in §10 is still raised in its own PR.

## Context

ABCA reads source, pushes branches and opens pull requests only on GitHub. Issue #456 asks for GitLab (and optionally Bitbucket) through a `GitProvider` adapter with GitHub refactored as the reference implementation.

GitHub is wired into every layer, not a single client:

- **Agent runtime.** `repo.py` clones with `gh repo clone`, pins the remote to `github.com` and configures `!gh auth git-credential`. `post_hooks.py` finds, creates, retargets and comments on PRs with `gh pr …`. `context.py` reads issues from `api.github.com`. All four coding prompts (`new_task`, `pr_iteration`, `pr_review`, `restack`) tell the model to run `gh` itself, and `gh` is the only hosting CLI in the image.
- **Handlers.** Preflight calls `api.github.com` and GraphQL `viewerPermission`. Context hydration reads issues, PRs and review threads. Fanout upserts issue comments, and the console lists issues.
- **Identity.** `owner/repo` is the RepoTable partition key, the memory namespace (`agent/src/memory.py` has a looser copy of `isValidRepo`'s regex), the clone-guard match and part of `/v1/repos/{repo_id}/policies`. GitLab nested groups and Azure DevOps `org/project/repo` paths do not fit. The repo key is also the AgentCore Memory `actorId` (`cdk/src/constructs/agent-memory.ts`). The `CreateEvent` API reference gives the `actorId` pattern as `[a-zA-Z0-9][a-zA-Z0-9-_/]*(?::[a-zA-Z0-9-_/]+)*[a-zA-Z0-9-_/]*`, which has no period. A key such as `gitlab:gitlab.com/group/project` does not match it, and neither does a GitHub key such as `acme/site.js`, which `isValidRepo` accepts. Memory writes are fail-open, so a rejected write would not stop a task.
- **Workflows pin the provider.** All four bundled coding workflows (`agent/workflows/coding/*.yaml`) set `repo_config.provider: github`, so a GitLab repo cannot run them without a copy of the YAML.
- **Pull request numbers.** `prNumberFromTask` in `cdk/src/handlers/shared/task-pr-number.ts` falls back to matching `/pull/<n>` in `pr_url` when `pr_number` is missing. A GitLab merge request URL contains `/-/merge_requests/<n>`, so follow-up tasks would report that the merge request does not exist.
- **Credentials.** One `github_token_secret_arn` per repo, falling back to the platform secret. Per-repo overrides are not readable today:
  - the orchestrator's `additionalSecretArns` prop is never passed;
  - the payload never carries a per-repo ARN, though the ECS strategy reads one;
  - agent compute is granted only the platform secret.
- **Egress.** `dns-firewall.ts` hard-codes GitHub domains at synth time.
- **Payload hops.** The orchestrator payload reaches the agent three ways: AgentCore `/invocations` and MicroVM `/run` through `_extract_invocation_params` → `run_task`, and ECS through `run_task_from_payload` → `run_task`. Hand-written mappers on these hops have dropped fields before (`base_branch` and channel fields, fixed in #596). The ECS and MicroVM backends can deliver the payload through S3, and each compute role can read the shared payload bucket (`payloadBucket.grantRead(taskRole)` in `ecs-agent-cluster.ts`), so any task can read any other task's payload.

**Effect on other ADRs.** This ADR does not edit any other ADR. It changes four of them in ways that are refinements under the README's boundary test, because a reader following the older text for a GitHub repo acts the same way:

- ADR-014: validator rule 14 changes from "only `github`" to "a member of the vocabulary", and an omitted `repo_config.provider` means the repo's provider.
- ADR-016: `ScmCredential` is a new credential type.
- ADR-017: CLI-onboarded repos may reference tagged `bgagent/scm/*` secrets.
- ADR-024 §1: each non-GitHub provider is an optional `DeploymentFeatures` key.

The PR that implements each change adds a dated Changelog entry to that ADR.

[PR #824](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/824) by @Agsiegert proposed a Bitbucket provider. It established the layering this ADR adopts: a per-repo provider driving dispatch at each seam. Its review identified failure modes that any provider must avoid:

- dropped fields in hand-written mappers;
- interface members with no call site;
- cross-provider credential reuse;
- tokens persisted to `.git/config`;
- fail-open defaults.

§§1 to 5 and 9 turn these into rules. This phased plan supersedes #824. Its Bitbucket REST client, preflight probes and tests are the intended starting point for the Bitbucket phase, and @Agsiegert is invited to own it.

## Decision

### 1. The repo key is the only source of the provider

- **Derived, not stored.** The provider is a function of the repo key (§6). There is no `git_provider` attribute on `RepoConfig`, `BlueprintConfig`, the orchestrator → agent payload or `TaskConfig`. The key already travels on every hop, so there is no second field to drop, to disagree with the key or to default.
- **One function, three copies.** `providerOfRepoKey(key)` returns a provider id from the existing ADR-014 `VcsProvider` vocabulary (`github | gitlab | bitbucket | codecommit | generic_git`). It is implemented in CDK, in the agent and in the CLI. One shared corpus of keys and expected results (`contracts/repo-keys.json`) is run by all three test suites, so the copies cannot drift.
- **Constants.** `contracts/constants.json` gains `git_providers.implemented`, initially `["github"]`, and a test enforces that it is a subset of the vocabulary. CDK imports the list. The agent reads it through `shared_constants.py`, and the provider module is registered in `PYTHON_CONSUMERS` in `scripts/check-constants-sync.ts`. The CLI holds a hand-written mirror that `cli/test/constants-parity.test.ts` checks against the contract.
- **A bare `owner/repo` means github.com.** Existing rows and checkpointed durable executions keep working without migration. Any key with a `<provider>:` prefix must name an implemented, enabled provider, or the task fails (§9). Until Phase 2, every prefixed key is rejected, including `github:<host>/...`, because the credential rules that make a second GitHub host safe arrive in Phase 2.
- **Vocabulary additions.** The vocabulary is closed (§11). Azure DevOps has no id in it, so supporting it means adding one, which changes ADR-014 and needs its own approved issue.
- **Workflows do not name a provider by default.** The four bundled coding workflows drop `repo_config.provider`, and an omitted value means "use the repo's provider". A workflow that sets `repo_config.provider` still constrains it: the value must equal the provider derived from the key. The CDK workflow descriptor mirror (`workflows.ts`) gains an optional provider field, and the parity test in `workflows.test.ts` checks it against the workflow YAML. Validator rule 14 changes from "only github" to "member of the vocabulary". The change updates its corpus fixture `contracts/workflow-validation/rule14-gitlab-provider.json` and the inline rule-14 test. Whether the provider is implemented is checked when the task is admitted, not during workflow validation.
- **No CLI flag.** Onboarding takes the repo key, so there is no `--git-provider` flag. `bgagent repo show` displays the derived provider.

### 2. Interfaces sized to real call sites

- The agent runtime has a `GitProvider` Protocol. The handler side has an `ScmProvider` interface. Each method enters its interface in the PR that gives it a call site. The GitHub implementation delegates to the existing code instead of re-implementing it, so the existing tests keep pinning its behaviour. Module layout is left to the implementing PRs.
- Token resolution, `git push`, clone retry and blocker classification, and PR body composition stay outside the interfaces. They are provider-neutral.

### 3. Capabilities are declared, not assumed

Each provider declares what it supports. Callers branch on capabilities, not on provider ids. A capability enters the list with its first caller. Example: Bitbucket access tokens cannot answer an effective-permission query, and `generic_git` has no API. A missing capability never passes a check by omission (§9). The console's future Access column derives from the declared capabilities and the stored permission result.

### 4. Credentials: `ScmCredential`, bound to the repo

- **New credential type.** A git-provider credential is a new ADR-016 credential type, `ScmCredential`. In v1 it binds at repo scope: a task uses the one credential of its own repo key. Wider scopes (a namespace or a host) and tasks that span several repos are outside this ADR (§10), and the reference shape below leaves room for them.
- **An opaque reference, not an ARN.** The repo row and the orchestrator-to-agent payload carry two fields, `scm_credential_kind` and `scm_credential_ref`. Only the resolver of the given kind interprets the reference. `secrets_manager` is the only kind in v1, and its reference is a secret ARN. The AgentCore Token Vault ([#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)) and GitHub App installation tokens ([#50](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/50)) would be further kinds, so each adds a kind and does not change the contract this ADR approves.
- **Fallbacks.** For `github.com` repos only, a row with no `scm_credential_ref` falls back to `github_token_secret_arn` and then to the platform secret. The platform GitHub secret is never a fallback for any other provider, and never for a GitHub Enterprise Server key. A GitHub Enterprise Server repo with no credential of its own fails at blueprint load, before any request to that host. A row that names a credential the platform cannot read fails the task, and the platform secret is not substituted.
- **Bound to the repo, by something the agent cannot choose.**
  - Per-repo SCM secrets are named `bgagent/scm/<provider>/<random-id>`. Names never embed the repo key.
  - Each secret carries a `bgagent:repo` tag equal to the repo key.
  - Trusted Lambdas (orchestrator, fanout, console) get `GetSecretValue` and `DescribeSecret` on `bgagent/scm/*`. The tag comparison reads the tag through `DescribeSecret`.
  - Agent compute roles get no `bgagent/scm/*` grant. A prefix grant there would let a prompt-injected task read every repo's token.
  - The agent receives only its own repo's credential. The binding comes from the orchestrator, not from the agent. Today's `AgentSessionRole` `repo` session tag does not qualify: the agent sets it from its own config, and it drives only cost attribution.
- **Orchestrator check.** The orchestrator rejects a `scm_credential_ref` whose secret is outside the prefix or whose tag does not equal the task's repo key. The check applies to `scm_credential_ref` only. Legacy `github_token_secret_arn` secrets are arbitrarily named and untagged, so they are outside it. For github.com repos they keep a read path granted on the exact ARN, and the Phase 2 PR states whether they are instead migrated to tagged SCM secrets.
- **Delivery channel.** The ECS and MicroVM payload can sit in S3, where every task's role can read it today (Context). Therefore:
  - The payload carries the reference, which is not a secret.
  - A token or a session credential shall never travel through the shared payload bucket, or through any other channel that a different task's role can read.
  - The credential reaches the agent only through a channel that just that task can read. Phase 2 cannot ship on a backend until it has one. For ECS and MicroVM that means payload reads become per-task first ([#1015](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1015) adds signed per-task payload references), or the Phase 2 PR names another channel and shows that no other task's role can read it. For AgentCore the invocation request carries the payload, and the Phase 2 PR confirms that this channel is private to the session.
  - Two candidate mechanisms use that channel. Phase 2 chooses between them:
    - orchestrator-minted session credentials whose `repo` tag the orchestrator sets, with the secret grant conditioned on `secretsmanager:ResourceTag/bgagent:repo` equal to `${aws:PrincipalTag/repo}`, so the agent reads its token itself;
    - the orchestrator resolving the token and delivering the token itself.
  - Token resolution moves from the compute role (`platform_client`, before session setup) to that per-task path.
  - Review of the candidates and of the channel requirement is requested on #1032.
- **Payload keys.** `scm_credential_kind` and `scm_credential_ref` are per-task payload keys. For `secrets_manager`, the partition and account anchor check in `server.py` extends to cover the ARN. Holding the reference grants nothing.
- **Tokens never touch disk, and may expire.** Git authenticates through a credential helper that asks a resolver for the token at each git operation, so a resolver that refreshes can replace one that returns a fixed value. The `secrets_manager` resolver in v1 returns the token the agent holds, which is today's contract in `repo.py`. A later kind whose tokens expire during a task (a GitHub App installation token lasts one hour) therefore needs no change to the helper contract. `.git/config` holds only the helper command. In v1 each provider supplies an HTTPS username (§11).
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
- **One spelling per repo.** A key whose prefix is not in the vocabulary fails config load. The host must already be in canonical form, and `providerOfRepoKey` rejects a host that is not, without normalising it. Canonical means ASCII, lower case, no trailing dot, no port, no empty label, and no `www.` prefix. For `github` the host is never `github.com` or one of its aliases, because the bare form is the only spelling for github.com. Without this rule `github:GitHub.com/acme/app` or `github:github.com./acme/app` would be treated as an Enterprise Server key beside the bare `acme/app`, with its own row, memory identity and credential binding. `contracts/repo-keys.json` includes those cases and a key with a port.
- **Memory identity.** The repo key is not used directly as an AgentCore Memory `actorId`. One function, `memoryActorId(key)`, maps a key to a stable ID that matches the `actorId` pattern in Context:
  - A key that already matches the pattern maps to itself, so existing memory records stay reachable. This covers every bare GitHub key made of letters, digits, `-`, `_` and `/`.
  - Any other key maps to `<provider>_<first 32 hex characters of SHA-256(key)>`. This covers every prefixed key and every bare GitHub key with a character outside the pattern, such as the period in `acme/site.js`.
  - The pattern rejects a period, so no event can have been stored under the plain key of such a repo. The Phase 1a PR confirms that against the service. If records do exist under the plain key, the read path also reads that key for a stated window.
  - The CDK handlers and the agent both call the function for every read and write. The Phase 1a PR checks every `memory_actor_id` in the corpus against the pattern, bare keys with periods included, so the constraint is tested in the phase that ships the function.
- **Pull request identity.** The task record stores `pr_number` whenever a PR or MR is created, next to `pr_url`. Callers read `pr_number`. The `/pull/<n>` match on `pr_url` stays only as a fallback for legacy GitHub rows and is never used for another provider. User-facing text uses the provider's own word ("pull request" or "merge request").
- **Character set.** Keys are limited to characters valid in STS session tag values and to at most 256 characters, so a key can travel as a tag without truncation or AssumeRole failure.
- **Deferred.** This shape is fixed now. Each provider's path grammar is fixed in the PR that adds that provider. The `isValidRepo` regex, the agent memory regex and the `/v1/repos/{repo_id}` routes change in that PR, before any row with the new key shape can be written. Until then no prefixed key can be admitted, so the rejection rules in §9 are covered by unit tests only.

### 7. Optional providers

Each non-GitHub provider is an optional `DeploymentFeatures` key ([ADR-024](./ADR-024-deployment-profiles.md)), which amends ADR-024 §1. The key gates the provider's egress domains, webhook route and grants. The orchestrator accepts the intersection of implemented and enabled providers, so a resolver-valid key cannot fail late at the DNS firewall. GitHub stays core.

### 8. Inbound webhooks for non-GitHub providers

- **GitLab pipeline webhook is in scope for #456.** The first GitLab phase (§10) includes the inbound webhook for pipeline events.
- **Receiver sharing is deferred.** Whether GitLab and a later Bitbucket provider share one receiver, dedup table and processor is decided in the PR that adds the second provider, with both implementations in view. The stack budget still applies ([ADR-023](./ADR-023-cloudformation-stack-boundaries.md): 490 resources), so the GitLab receiver is built so that it can become the shared one.
- **GitHub keeps its route.** GitHub keeps its existing route, because installed webhooks point at it.
- **Deferred.** The route path and the dedup key format are fixed in the implementing PR.

### 9. Normative requirements

- If a repo key has a provider prefix that is not an implemented, enabled provider id (exact match, no case folding or trimming), then the orchestrator shall fail the task at blueprint load with a message naming the prefix, before preflight, hydration or compute start.
- Until Phase 2 ships, if a repo key has any provider prefix, including `github:<host>/...`, then the orchestrator shall fail the task at blueprint load.
- If a repo key's host is not in canonical form (§6), then `providerOfRepoKey` shall reject the key, and shall not normalise it.
- If the repo key's provider is not an implemented provider id, then the agent shall fail the task before any clone or other repository side effect.
- If a workflow's `repo_config.provider` is set and differs from the provider derived from the repo key, then the orchestrator shall reject the task at blueprint load, and `build_config` shall raise before clone.
- The CDK, agent and CLI implementations of `providerOfRepoKey` and `memoryActorId` shall each pass every case in `contracts/repo-keys.json`.
- Every `memory_actor_id` in `contracts/repo-keys.json` shall match the AgentCore `actorId` pattern.
- If a GitHub Enterprise Server repo has no credential of its own, then the orchestrator shall fail the task at blueprint load, before any request to that host.
- The platform GitHub secret shall be used only for requests to `github.com`.
- If a repo row names a credential that the platform cannot read, then the orchestrator shall fail the task, and shall not substitute the platform secret.
- If a provider does not declare `effective_permission` and the workflow is read-only, then preflight shall record `permission: unverified` in the preflight event.
- If a provider does not declare `effective_permission`, the workflow writes, and the repo row has no `scm_write_attested` flag, then preflight shall reject the task with reason `SCM_PERMISSION_UNVERIFIABLE`.
- Only operator paths (Blueprint construct and operator CLI) shall set `scm_write_attested`.
- When a task targets a non-GitHub provider, the platform shall not send the platform GitHub secret, or any secret that is not tagged for that repo, to that provider's host.
- The payload shall carry a credential reference and shall not carry a repository token.
- A repository token or session credential shall not travel through the shared payload bucket, or through any other channel that a different task's role can read.
- The agent shall not obtain a repository token through a binding that the agent itself selects.
- The agent shall not write a repository token to `.git/config`, to a remote URL or to any file in the workspace.
- The credential helper shall obtain the token from the resolver at each git operation.
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
| 1a | Key-derived provider: `providerOfRepoKey` (every prefixed key rejected), `memoryActorId`, `contracts/repo-keys.json`, `git_providers.implemented`, pins removed from the four coding workflows, `pr_number` stored on every PR | none: no prefixed key can be admitted yet, so the new rejection paths have unit tests only |
| 1b | Handlers: `ScmProvider` for preflight, with GitHub delegating to `preflight.ts` | none |
| 2 | `ScmCredential`: tagged secrets, per-task channel and grant, reference-only payload, `github.com` scoping of the platform secret, legacy `github_token_secret_arn` read path. Lifts the rejection of `github:<host>/...` keys. Also fixes per-repo GitHub secret readability | per-repo secrets start working; a GitHub Enterprise Server repo with no credential fails early |
| 3 | First GitLab task on GitLab.com: onboard a project, run `coding/new-task-v1`, open an MR, send a follow-up to that MR. Includes the agent `GitProvider`, the provider-neutral tools and prompts with Cedar rules, GitLab egress and redaction, the `DeploymentFeatures` key and the pipeline webhook. The same workflow runs on GitHub as the comparison | new provider |
| 4 | GitLab remainder: hydration, comment upsert and issue listing behind `ScmProvider`; path grammar edge cases | new provider capabilities |
| 5 | Bitbucket Cloud, starting from #824, and the decision on a shared webhook receiver | new provider |

Accepting this ADR approves only the payload keys `scm_credential_kind` and `scm_credential_ref` as an orchestrator-to-agent contract addition. Each of the following is still raised as ask-first in its own PR:

- the IAM grant changes in §4;
- the webhook receiver construct in §8;
- the prompt and tool refactor in Phase 3.

Out of scope for this ADR:

- Repository CRUD over REST and the console connect flow ([#1021](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1021)), until that issue is approved. That work needs an ADR-017 successor.
- Azure DevOps and `generic_git`, which each need their own approved issue.
- OAuth, GitHub App and Token Vault resolvers. They are further `scm_credential_kind` values (§4) and are raised with #50 and #249.
- Tasks that span several repos. Every rule here assumes one repo key per task. A multi-repo task would need a list of repo keys, one credential binding per key and a list of PR records on the task record. The orchestrator can already grant several tagged secrets to one task, so the per-repo binding extends to it, and a list of opaque references carries it where a single ARN key could not.

Work in `orchestrator.ts`, `orchestrate-task.ts`, `server.py` and `hooks.py` stays additive (new fields and checks, no restructuring), because open PRs are rewriting those files.

### 11. Known limits

The abstraction is sized for providers that work like GitHub, GitLab and Bitbucket Cloud: HTTPS plus a token, numeric review ids, and a branch that is pushed and then reviewed. What it does not cover:

- **Closed vocabulary.** A new provider means a vocabulary entry, a `providerOfRepoKey` case in each of the three copies, an implementation of each of the two interfaces, a `DeploymentFeatures` key and synth-time egress. Out-of-tree or internal providers are not supported by this ADR. Supporting them would need a registration mechanism and is a separate decision.
- **Authentication other than an HTTPS token.** `codecommit` is in the vocabulary and authenticates with SigV4. Self-hosted tools often use SSH or mutual TLS. `codecommit` and `generic_git` each need a revision of §4 before they are implemented.
- **Push and review identity.** `git push` is treated as provider-neutral, and `pr_number` is a number. A host that pushes to a review ref, or whose review ids are not numeric, does not fit.
- **One prefix per product.** Bitbucket Cloud and Bitbucket Data Center have different APIs under one `bitbucket:` prefix. The key carries the host, so the provider module can dispatch on it. If the two differ enough, Data Center gets its own vocabulary id.
- **Issues.** Issue listing sits in `ScmProvider` (Phase 4) as a capability a provider may decline. Teams that keep issues in a separate tracker are served by the existing tracker integrations, which this ADR does not change.
- **Network reachability.** A private host needs a network path in both directions: from agent compute to the host, and from the host to the webhook receiver. A DNS allowlist entry covers neither. The Phase 3 PR documents what a self-managed host needs.

## Consequences

- (+) GitHub behaviour is unchanged through Phase 1. No prefixed key can be admitted before Phase 3, so the new rejection rules have unit tests only until then.
- (+) No stored provider field means no second source of truth and no new field for a hand-written mapper to drop.
- (+) Each new provider is an implementation plus a capability declaration, not edits at a dozen call sites.
- (+) Phase 2 also fixes today's broken per-repo GitHub token overrides.
- (+) An orchestrator-chosen binding keeps one repo's credential away from another repo's agent, which a prefix grant on compute roles would not.
- (!) Until Phase 2 lands, compute-role credentials remain reachable from the agent sandbox. This ADR does not change that, and the existing `task_id` table scoping has the same limit.
- (-) Two interfaces (Python and TypeScript) must stay aligned. The shared constants contract and the key corpus guard this.
- (-) The key shape is load-bearing: moving a repo to another provider means a new key, not an edit to a field.
- (-) Phase 3 changes what the model is told to do. It needs the end-to-end GitHub comparison run, not only unit tests.
- (-) Providers without review threads or permission APIs get coarser preflight and review behaviour, and the console has to say so.
- (!) The Phase 2 PR refines ADR-017 in place with a Changelog entry. CLI-onboarded repos can then reference tagged `bgagent/scm/*` secrets without a redeploy.
- (!) Phase 2 depends on a per-task credential channel that does not exist yet on ECS and MicroVM (§4).
- (!) Memory writes are fail-open, so a GitHub repo whose key contains a period may have no stored memory today. `memoryActorId` fixes that for new records.
- (!) Self-managed hosts need a configurable base URL, CA bundle, token-prefix regex and an egress entry. Egress is synth-time, so adding a host means a deploy.

## References

- Issue [#456](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/456): GitLab integration
- PR [#824](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/824) and its review: Bitbucket provider
- Issues [#1021](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1021) (repository onboarding API), [#50](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/50) (GitHub App), [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249) (Token Vault)
- PR [#1015](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/1015): signed per-task payload references
- [ADR-014](./ADR-014-workflow-driven-tasks.md): workflow `repo_config.provider`
- [ADR-016](./ADR-016-pluggable-identity-and-auth.md): credential taxonomy
- [ADR-017](./ADR-017-operator-cli-repo-onboarding.md): operator CLI onboarding
- [ADR-020](./ADR-020-ears-requirements-syntax.md): EARS requirements
- [ADR-023](./ADR-023-cloudformation-stack-boundaries.md), [ADR-024](./ADR-024-deployment-profiles.md): stack budget and optional features
