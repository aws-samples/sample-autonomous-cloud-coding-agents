---
title: Adr 025 git provider abstraction
---

# ADR-025: Git provider abstraction

**Status:** proposed
**Date:** 2026-11-10
**Issue:** [#456](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/456)
**Amends:** ADR-016 (credential types), ADR-017 (custom token secrets), ADR-024 §1 (optional features)

Per the [ADR lifecycle](/sample-autonomous-cloud-coding-agents/architecture/readme#lifecycle), this decision remains proposed until its implementing PR merges.

## Context

ABCA reads source, pushes branches and opens pull requests only on GitHub. Issue #456 asks for GitLab (and optionally Bitbucket) through a `GitProvider` adapter with GitHub refactored as the reference implementation.

GitHub is wired into every layer, not a single client:

- **Agent runtime.** `repo.py` clones with `gh repo clone`, pins the remote to `github.com` and configures `!gh auth git-credential`. `post_hooks.py` finds, creates, retargets and comments on PRs with `gh pr …`. `context.py` reads issues from `api.github.com`. All four coding prompts (`new_task`, `pr_iteration`, `pr_review`, `restack`) tell the model to run `gh` itself, and `gh` is the only hosting CLI in the image.
- **Handlers.** Preflight calls `api.github.com` and GraphQL `viewerPermission`. Context hydration reads issues, PRs and review threads. Fanout upserts issue comments, and the console lists issues.
- **Identity.** `owner/repo` is the RepoTable partition key, the memory namespace (`agent/src/memory.py` has a looser copy of `isValidRepo`'s regex), the clone-guard match and part of `/v1/repos/{repo_id}/policies`. GitLab nested groups and Azure DevOps `org/project/repo` paths do not fit.
- **Credentials.** One `github_token_secret_arn` per repo, falling back to the platform secret. Per-repo overrides are not readable today:
  - the orchestrator's `additionalSecretArns` prop is never passed;
  - the payload never carries a per-repo ARN, though the ECS strategy reads one;
  - agent compute is granted only the platform secret.
- **Egress.** `dns-firewall.ts` hard-codes GitHub domains at synth time.
- **Payload hops.** The orchestrator payload reaches the agent three ways: AgentCore `/invocations` and MicroVM `/run` through `_extract_invocation_params` → `run_task`, and ECS through `run_task_from_payload` → `run_task`. Hand-written mappers on these hops have dropped fields before (`base_branch` and channel fields, fixed in #596).

[PR #824](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/824) by @Agsiegert proposed a Bitbucket provider. It established the layering this ADR adopts: a provider field on the repo row driving dispatch at each seam. Its review identified failure modes that any provider must avoid:

- dropped fields in hand-written mappers;
- interface members with no call site;
- cross-provider credential reuse;
- tokens persisted to `.git/config`;
- fail-open defaults.

§§1–5 and 8 turn these into rules. This phased plan supersedes #824. Its Bitbucket REST client, preflight probes and tests are the intended starting point for the Bitbucket phase, and @Agsiegert is invited to own it.

## Decision

### 1. The repo row is the only authority for `git_provider`

- `git_provider` is a repo attribute (identity, not a credential). It lives on `RepoConfig` (RepoTable), `BlueprintConfig`, the top level of the orchestrator → agent payload, and `TaskConfig`.
- The vocabulary is the existing ADR-014 `VcsProvider` (`github | gitlab | bitbucket | codecommit | generic_git`). `contracts/constants.json` gains `git_providers.implemented`, initially `["github"]`, and a test enforces that it is a subset of the vocabulary. CDK imports the list. The agent reads it through `shared_constants.py`, and the provider module is registered in `PYTHON_CONSUMERS` in `scripts/check-constants-sync.ts`. The CLI holds a hand-written mirror whose values `cli/test/constants-parity.test.ts` checks against the contract.
- **Absent on a RepoTable row means `github`.** Existing rows and checkpointed durable executions keep working. The orchestrator always emits a resolved, non-empty value from the first phase onward. On the agent side, a missing or JSON `null` value means `github`, because the ECS path drops `None` and AgentCore cannot tell `null` from absent. This exception covers only payloads from before the first phase.
- A workflow's `repo_config.provider` is a constraint, never a source. The CDK workflow descriptor mirror (`workflows.ts`) gains a provider field, which the parity test in `workflows.test.ts` checks against the workflow YAML. The orchestrator compares it with the resolved row value in `loadBlueprintConfig`, and the agent repeats the check in `build_config` as defence in depth. Validator rule 14 changes from "only github" to "member of the vocabulary". The change updates its corpus fixture `contracts/workflow-validation/rule14-gitlab-provider.json` and the inline rule-14 test. Whether the provider is implemented is checked when the task is admitted, not during workflow validation.
- No CLI `--git-provider` flag ships until a second provider is implemented. When it does ship, the flag has no commander default, so omitting it preserves the stored value. `bgagent repo show` displays the resolved value.

### 2. Interfaces sized to real call sites

- The agent runtime has a `GitProvider` Protocol. The handler side has an `ScmProvider` interface. Each method enters its interface in the PR that gives it a call site. The GitHub implementation delegates to the existing code instead of re-implementing it, so the existing tests keep pinning its behaviour. Module layout is left to the implementing PRs.
- Token resolution, `git push`, clone retry and blocker classification, and PR body composition stay outside the interfaces. They are provider-neutral.

### 3. Capabilities are declared, not assumed

Each provider declares what it supports. Callers branch on capabilities, not on provider ids. A capability enters the list with its first caller. Example: Bitbucket access tokens cannot answer an effective-permission query, and `generic_git` has no API. A missing capability never passes a check by omission (§9). The console's future Access column derives from the declared capabilities and the stored permission result.

### 4. Credentials: `ScmCredential`, bound per repo

- **New credential type.** A git-provider credential is a new ADR-016 credential type, `ScmCredential`. There is one per repo. In v1 it is a direct token in Secrets Manager. The AgentCore Token Vault ([#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249)) and GitHub App installation tokens ([#50](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/50)) are later resolvers for the same type.
- **Row field.** The row field is `scm_token_secret_arn`. For `github` only, `github_token_secret_arn` and then the platform secret are fallbacks. The platform GitHub secret is never a fallback for any other provider.
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
- **Payload key.** `scm_token_secret_arn` is a per-task payload key. The partition and account anchor check in `server.py` extends to cover it.
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
- **Consistency.** The row's `git_provider` must equal the key's provider prefix, or config load fails.
- **Character set.** Keys are limited to characters valid in STS session tag values and to at most 256 characters, so a key can travel as a tag without truncation or AssumeRole failure.
- **Deferred.** This shape is fixed now. Each provider's path grammar is fixed in the PR that adds that provider. The `isValidRepo` regex, the agent memory regex and the `/v1/repos/{repo_id}` routes change in that PR, before any row with the new key shape can be written.

### 7. Optional providers

Each non-GitHub provider is an optional `DeploymentFeatures` key ([ADR-024](/sample-autonomous-cloud-coding-agents/architecture/adr-024-deployment-profiles)), which amends ADR-024 §1. The key gates the provider's egress domains, webhook route and grants. The orchestrator accepts the intersection of implemented and enabled providers, so a resolver-valid row cannot fail late at the DNS firewall. GitHub stays core.

### 8. Inbound webhooks for non-GitHub providers

- **One receiver.** Non-GitHub providers share one webhook receiver, one dedup table and one processor, which dispatches on provider. This avoids adding a route, secret, table and two Lambdas per provider against the 490-resource application stack budget ([ADR-023](/sample-autonomous-cloud-coding-agents/architecture/adr-023-cloudformation-stack-boundaries)).
- **GitHub keeps its route.** GitHub keeps its existing route, because installed webhooks point at it.
- **Deferred.** The route path and the dedup key format are fixed in the implementing PR.

### 9. Normative requirements

- If a RepoTable `git_provider` value is present and is not an implemented, enabled provider id (exact match, no case folding or trimming), then the orchestrator shall fail the task at blueprint load with a message naming the value, before preflight, hydration or compute start.
- If a payload `git_provider` value is present, not `null`, and not an implemented provider id, then the agent shall fail the task before any clone or other repository side effect.
- If a workflow's `repo_config.provider` differs from the resolved repo provider, then the orchestrator shall reject the task at blueprint load.
- If the workflow's `repo_config.provider` differs from the payload's `git_provider`, then `build_config` shall raise before clone.
- The orchestrator shall include `git_provider` in every task payload.
- The orchestrator, AgentCore and MicroVM extraction, ECS payload, and `build_config` paths shall each have a test asserting that `git_provider` survives the hop.
- If a provider does not declare `effective_permission` and the workflow is read-only, then preflight shall record `permission: unverified` in the preflight event.
- If a provider does not declare `effective_permission`, the workflow writes, and the repo row has no `scm_write_attested` flag, then preflight shall reject the task with reason `SCM_PERMISSION_UNVERIFIABLE`.
- Only operator paths (Blueprint construct and operator CLI) shall set `scm_write_attested`.
- When a task targets a non-GitHub provider, the platform shall not send the platform GitHub secret, or any secret that is not tagged for that repo, to that provider's host.
- The agent shall not obtain a repository token through a binding that the agent itself selects.
- The agent shall not write a repository token to `.git/config`, to a remote URL or to any file in the workspace.
- When a redaction pattern is changed, the redaction tests shall still match every sample in the previous pattern's test corpus.
- If a webhook signing secret is missing, empty or unreadable, then the receiver shall return 401 and shall not dispatch.
- If a webhook dispatch fails after its dedup row is written, then the receiver shall delete that row.
- If the webhook route's provider segment is not an enabled provider, then the receiver shall return 404 before reading any secret.

### 10. Delivery and scope

| Phase | Scope | Behaviour change |
|---|---|---|
| 0 | This ADR | none |
| 1a | Contract: `constants.json` list, CDK and agent resolvers, payload key, round-trip tests on every hop | Rows with a malformed `git_provider` now fail with a named reason |
| 1b | Handlers: `ScmProvider` for preflight, with GitHub delegating to `preflight.ts` | none |
| 1c | Agent: `GitProvider` over `repo.py`, `post_hooks.py` and `context.py`, with GitHub delegating | none |
| 2 | `ScmCredential`: tagged secrets, session-role read, payload ARN. Also fixes per-repo GitHub secret readability | per-repo secrets start working |
| 3a | Provider-neutral agent tools and prompts, plus Cedar rules | GitHub-equivalent, verified by an end-to-end task |
| 3b | Hydration, comment upsert and issue listing behind `ScmProvider` | none |
| 4 | GitLab: path grammar, egress, redaction, `DeploymentFeatures` key, webhook receiver | new provider |
| 5 | Bitbucket Cloud, starting from #824 | new provider |

Accepting this ADR approves only the payload keys `git_provider` and `scm_token_secret_arn` as agent–orchestrator contract additions. Each of the following is still raised as ask-first in its own PR:

- the IAM grant changes in §4;
- the webhook receiver construct in §8;
- the Phase 3a prompt and tool refactor.

Repository CRUD over REST and the console connect flow ([#1021](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1021)) are out of scope until that issue is approved; that work needs an ADR-017 successor. Azure DevOps and `generic_git` each need their own approved issue.

Work in `orchestrator.ts`, `orchestrate-task.ts`, `server.py` and `hooks.py` stays additive (new fields and checks, no restructuring), because open PRs are rewriting those files.

## Consequences

- (+) GitHub behaviour is unchanged through Phase 1, except that a malformed `git_provider` value now stops the task with a named reason instead of acting against github.com.
- (+) Each new provider is an implementation plus a capability declaration, not edits at a dozen call sites.
- (+) Phase 2 also fixes today's broken per-repo GitHub token overrides.
- (+) An orchestrator-chosen binding keeps one repo's credential away from another repo's agent, which a prefix grant on compute roles would not.
- (!) Until Phase 2 lands, compute-role credentials remain reachable from the agent sandbox. This ADR does not change that, and the existing `task_id` table scoping has the same limit.
- (-) Two interfaces (Python and TypeScript) must stay aligned. The shared constants contract and the hop tests guard this.
- (-) Phase 3a changes what the model is told to do. It needs an end-to-end comparison on GitHub, not only unit tests.
- (-) Providers without review threads or permission APIs get coarser preflight and review behaviour, and the console has to say so.
- (!) ADR-017 is refined in place. CLI-onboarded repos can reference tagged `bgagent/scm/*` secrets without a redeploy.
- (!) Self-managed hosts need a configurable base URL, CA bundle, token-prefix regex and an egress entry. Egress is synth-time, so adding a host means a deploy.

## References

- Issue [#456](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/456): GitLab integration
- PR [#824](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/pull/824) and its review: Bitbucket provider
- Issues [#1021](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/1021) (repository onboarding API), [#50](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/50) (GitHub App), [#249](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/249) (Token Vault)
- [ADR-014](/sample-autonomous-cloud-coding-agents/architecture/adr-014-workflow-driven-tasks): workflow `repo_config.provider`
- [ADR-016](/sample-autonomous-cloud-coding-agents/architecture/adr-016-pluggable-identity-and-auth): credential taxonomy
- [ADR-017](/sample-autonomous-cloud-coding-agents/architecture/adr-017-operator-cli-repo-onboarding): operator CLI onboarding
- [ADR-020](/sample-autonomous-cloud-coding-agents/architecture/adr-020-ears-requirements-syntax): EARS requirements
- [ADR-023](/sample-autonomous-cloud-coding-agents/architecture/adr-023-cloudformation-stack-boundaries), [ADR-024](/sample-autonomous-cloud-coding-agents/architecture/adr-024-deployment-profiles): stack budget and optional features
