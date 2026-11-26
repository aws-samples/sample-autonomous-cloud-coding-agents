# AGENTS.md

Context for AI coding assistants, such as Cursor, Claude Code, and GitHub Copilot, that work in this repository.

**Progressive disclosure.** Read this file first. Then read the package guide for the tree you are editing, which is [`cdk/AGENTS.md`](./cdk/AGENTS.md), [`cli/AGENTS.md`](./cli/AGENTS.md), [`web/AGENTS.md`](./web/AGENTS.md), [`agent/AGENTS.md`](./agent/AGENTS.md), or [`docs/AGENTS.md`](./docs/AGENTS.md).

## Your role

You are an **ABCA (Autonomous Background Coding Agents on AWS)** contributor. You work on AWS CDK (TypeScript), the Python agent runtime, the CLI, and the docs. Users submit coding tasks. Agents work autonomously in isolated cloud environments and open pull requests for review.

For the deeper design, see the [Developer guide](./docs/guides/DEVELOPER_GUIDE.md), [Architecture](./docs/design/ARCHITECTURE.md), and [Orchestrator](./docs/design/ORCHESTRATOR.md).

## Commands (run these)

```bash
mise run install          # yarn workspaces + agent Python (uv)
mise run build            # agent quality + cdk, cli, web and docs builds + Forge tests + drift and file-hygiene checks (parallel)
mise run lint             # lint + type checks of agent, cdk, cli and web, plus the agent's dead-code check; rewrites nothing (what ABCA agents run by default)
mise run check:fast       # lint + drift-prevention (drift and file-hygiene checks), no test run; not check-only: it fixes trailing whitespace and final newlines and regenerates the command stubs
mise run security         # secrets, deps, sast, grype, retire, gh-actions, shell scripts (check:shell), agent
mise run hooks:install    # prek git hooks (also runs at end of install)
mise run hooks:run        # pre-commit + pre-push locally
mise run test:integration # emulator-backed tests of cdk, cli and agent (needs Docker, no AWS account; not part of build)
```

The security subtasks are `mise run security:secrets`, `security:sast`, `security:sast:range`, `security:sast:masking`, `security:deps`, `security:retire`, and `security:gh-actions`. `security:sast:range` runs the same rule packs as `security:sast` and reports only the findings that a branch adds. It is the per-PR check. The secret scans print the rule, file, and line of each finding. A 12-digit number that reads as an AWS account id fails the secret scans, in tests and workflows too. Two cases are exempt. In the first, the number is an AWS-published placeholder (`123456789012`, `111122223333`, `444455556666`, `000000000000`). In the second, the number is not an account id and its line carries `gitleaks:allow -- <reason>`. Use that marker only on a line that holds no identifier, key, or token. The marker exempts the whole line from every rule of the secret scan, not only the number. For `security:sast:masking`, allowlist intentional fallbacks with an inline `nosemgrep: <rule-id> -- <reason>` comment on the flagged `return` line or on the line immediately above it. The rule anchors on the `return`, so a token placed higher does not bind.

`security:sast:masking` also checks the suppression comments themselves, in every tracked file that is not Markdown and not under `.semgrep/`. That covers workflows, Dockerfiles, shell scripts, and configuration as well as source files. A line that contains the word `nosemgrep` at all must be exactly one suppression of the form `nosemgrep: <rule-id> -- <reason>`. The check applies in any letter case, in a comment or in code, and for any rule. A comment that merely mentions suppressions has to use another word. A suppression of a masking rule must also sit on a finding of that rule, or on the line directly above it. One that suppresses nothing fails the task, so delete it when the code no longer needs it.

Accepting a dependency or image finding that cannot be fixed yet is a maintainer's decision. Ask first. An accepted finding carries a reason and an expiry date.

- For the dependency scan (`security:deps`), add an `[[IgnoredVulns]]` entry with `id`, `effectiveUntil = YYYY-MM-DD` and `reason` to the `osv-scanner.toml` in the directory of the lockfile the finding is reported for.
- For the image scan (`mise //agent:security:image`), add a line `<id> exp:YYYY-MM-DD` to `agent/.trivyignore`, with the reason in a comment above it. A finding without a fixed version needs no entry, because the scan hides it (`--ignore-unfixed`) until a fix is published.

Say in the reason what was checked and what has to happen before the entry can go.

The date is the first day on which the entry no longer applies. From that day the scan fails again in the pre-push hook and in the weekly Security workflow, and the dependency scan also fails on every pull request. From 21 days before that day the weekly workflow lists the entry in its rolling issue, `Security suite needs attention`. Remove an entry as soon as the fix can be taken. Renew an entry only with a reason that is still true.

For package commands, see [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md), [web/AGENTS.md](./web/AGENTS.md), [agent/AGENTS.md](./agent/AGENTS.md), and [docs/AGENTS.md](./docs/AGENTS.md).

Run `mise tasks --all` for the full list. Prefer mise tasks over raw `jest`, `tsc`, or `cdk` for full suites. The package guides show targeted `npx jest` and `uv run pytest` commands for single files.

## Git workflow

```
approved issue → git fetch origin main → worktree → branch → implement → local checks → PR
```

Name a branch `(feat|fix|chore|docs)/<issue-number>-short-description`, for example `docs/191-agents-md-split`.

**After merging `main` into your branch:**

1. Run `mise //cdk:eslint`, `mise //cli:eslint`, and `mise //web:eslint`. All three use `--fix`.
2. Commit any auto-fixes. CI "Fail build on mutation" rejects uncommitted lint output.
3. Run `mise run build`.

**Worktrees.** `node_modules/` and `agent/.venv/` are per-tree. Run `mise run install` in each new worktree.

## Where to make changes

| Change | Primary location | Also update | Package guide |
|--------|------------------|-------------|---------------|
| REST API, Lambdas, orchestration | `cdk/src/handlers/`, `cdk/src/stacks/`, `cdk/src/constructs/` | `cdk/test/` | [cdk/AGENTS.md](./cdk/AGENTS.md) |
| Shared API types | `cdk/src/handlers/shared/types.ts` | **`cli/src/types.ts`**, `web/src/core/api/types.ts`. `mise run check:types-sync` fails when either mirror drifts | [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md), [web/AGENTS.md](./web/AGENTS.md) |
| `bgagent` CLI | `cli/src/`, `cli/test/` | `cli/src/types.ts` if API changes | [cli/AGENTS.md](./cli/AGENTS.md) |
| Operator web console | `web/src/`, `web/test/` | `web/src/core/api/types.ts` if API changes | [web/AGENTS.md](./web/AGENTS.md) |
| Agent runtime | `agent/src/` | `agent/tests/`, `agent/README.md` | [agent/AGENTS.md](./agent/AGENTS.md) |
| Progress events | `agent/src/progress_writer.py`, `agent/src/pipeline.py`, `agent/src/runner.py` | `agent/tests/test_progress_writer.py`, `cli/src/commands/watch.ts` | [agent/AGENTS.md](./agent/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| Scoreboard numbers | `cdk/src/handlers/shared/scoreboard.ts` | `cdk/src/handlers/shared/types.ts` and its mirrors `web/src/core/api/types.ts` and `cli/src/types.ts` (`ScoreboardPeriod`), `web/src/core/util/scoreboard.ts` (the page's tiles), `cli/src/scoreboard.ts` (the rows of `bgagent stats`), `docs/design/OBSERVABILITY.md` (the definitions table), `docs/design/API_CONTRACT.md` (the field table and the example) | [cdk/AGENTS.md](./cdk/AGENTS.md), [web/AGENTS.md](./web/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| Pull-request outcomes (the hourly read of GitHub) | `cdk/src/handlers/shared/pr-outcome.ts` (the read, the candidates, the writes), `cdk/src/handlers/sweep-pr-outcomes.ts` (the run, its stops, the `pr_outcome_recorded` event), `cdk/src/constructs/pr-outcome-sweep.ts` | `cdk/src/handlers/shared/scoreboard.ts` (`prFollowed`: who is followed, and the facts of a followed pull request), plus the row above when a number changes, `web/src/core/util/activity.ts` (`pullRequestEnd`: the event in a task's activity and banner), `docs/design/OBSERVABILITY.md` ("Pull-request outcomes": the stops, the summary line and the log lines) | [cdk/AGENTS.md](./cdk/AGENTS.md), [web/AGENTS.md](./web/AGENTS.md) |
| Emulator-backed integration tests (ADR-013 Tier 2a) | `cdk/test/emulator/`, `cli/test/emulator/`, `agent/tests_emulator/`, with tooling in `scripts/aws-emulator/` | [scripts/aws-emulator/README.md](./scripts/aws-emulator/README.md) when a rule or a known difference from AWS changes. Run with `mise run test:integration` | [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md), [agent/AGENTS.md](./agent/AGENTS.md) |
| User-facing and design prose | `docs/guides/`, `docs/design/` | `mise //docs:sync` | [docs/AGENTS.md](./docs/AGENTS.md) |
| ADRs | `docs/decisions/` | `mise //docs:sync` | [docs/AGENTS.md](./docs/AGENTS.md) |
| Deployment profiles and regional capabilities | `cdk/src/deployment/`, `contracts/deployment-capabilities.json` | **`cli/src/deployment-capabilities.ts`**, `cli/src/deployment-profile.ts`, `docs/guides/DEPLOYMENT_GUIDE.md#deployment-profiles`, and `contracts/deployment-profile-vectors/`, the profile cases that the cdk and cli test suites both run | [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| Bootstrap policies (CloudFormation execution role), bootstrap preflight | `cdk/src/bootstrap/` | `cdk/bootstrap/`, which is generated. Run `mise //cdk:bootstrap:generate` and never edit it by hand. Also the golden JSON in `docs/design/DEPLOYMENT_ROLES.md`, the hash snapshot `cdk/test/bootstrap/__snapshots__/version.test.ts.snap`, and, when the bundle version moves, `REQUIRED_BOOTSTRAP_VERSION` in `cli/src/setup-account.ts` | [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| Solution User-Agent (#319) | `agent/src/ua.py`, `cdk/src/handlers/shared/ua.ts`, `cli/src/ua.ts` (keep the three identical) | `contracts/ua-vectors.json`, the solution id and the sanitizer vectors that all three test suites load | [agent/AGENTS.md](./agent/AGENTS.md), [cdk/AGENTS.md](./cdk/AGENTS.md), [cli/AGENTS.md](./cli/AGENTS.md) |
| Monorepo CI and tasks | `mise.toml`, `scripts/`, `.github/workflows/` | `cdk/test/scripts/`, the jest suites of the gate scripts. `mise run check:scripts` type-checks the `.ts` ones | — |

## Boundaries

- ✅ **Always:** Use an approved GitHub issue before implementing ([ADR-003](./docs/decisions/ADR-003-contribution-governance.md)); branch from `main` via worktree; run `mise run build` before opening a PR; regenerate Starlight mirrors when editing `docs/guides/`, `docs/design/`, `docs/decisions/`, or `CONTRIBUTING.md`; add dependencies to the owning package `package.json` (`cdk/`, `cli/`, `web/`, or `docs/`)
- ⚠️ **Ask first:** New CDK stacks or constructs, agent contract changes, new dependencies, major refactors, CI workflow edits
- 🚫 **Never:** Edit on `main`; edit `docs/src/content/docs/` by hand; commit secrets; implement without an `approved` issue (conversational "go ahead" is not approval); run raw `jest`, `tsc` or `cdk` when a mise task exists

## Common mistakes

- **No approved issue.** Create the issue, have it labeled `approved`, assign it to yourself, and comment "Starting implementation". See [ADR-003](./docs/decisions/ADR-003-contribution-governance.md).
- **Branch without issue number.** This is unauthorized work.
- **Trailing whitespace, missing final newline, conflict markers, unparseable YAML or JSON.** The build checks these as well as the commit hook. `mise run check:hygiene`, which is part of `mise run drift-prevention`, runs the hooks `trailing-whitespace`, `end-of-file-fixer`, `check-merge-conflict`, `check-yaml` and `check-json` over all tracked files, with the exclusions of `.pre-commit-config.yaml`. The output names the failed hook and the file. The first two hooks correct the file and fail that run. Keep the change and run again. The other three hooks change nothing. They print the line of the marker, or the parser's message.
- **`prek install` fails.** Another hook manager owns `core.hooksPath`. See [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Dropping solution UA on a new AWS client (#319).** Every outbound AWS call carries `md/uksb-wt64nei4u6#{component}`. The `app/` segment is SDK-native via `AWS_SDK_UA_APP_ID`, which `SolutionUaAspect` sets. Construct clients through the attributed factory. In `cdk/src/` and `cli/src/`, use `makeClient(Ctor, cfg)` or `makeDocClient(cfg)` (`cdk/src/handlers/shared/ua.ts`, `cli/src/ua.ts`). In `agent/src/`, use `aws_session.tenant_client` or `tenant_resource` (tenant-scoped), or `aws_session.platform_client` (unscoped, still attributed). A client built directly with `new XxxClient({})` or `boto3.client(...)` silently loses solution attribution. In the agent, lint enforces the rule. Ruff `TID251` fails on `boto3.client`, `boto3.resource` and any boto3 or botocore session outside `agent/src/aws_session.py`. Tests are exempt. Keep the three `ua` modules (`agent/src/ua.py`, `cdk/src/handlers/shared/ua.ts`, `cli/src/ua.ts`) identical in id, wire format, and sanitization.
- **Transitive npm pin applied in only one place.** `integrations/jira-forge-app` is a standalone npm project *outside* the yarn workspaces, so a root `package.json` `resolutions` bump does **not** reach it. Mirror the pin into `integrations/jira-forge-app/package.json` `overrides` and re-lock (`npm install --package-lock-only`). `mise run drift-prevention` (`check:transitive-pin-sync`) fails locally if they drift. See [#712](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/712).
- **Unused export, file or dependency.** `mise run check:deadcode` runs knip over the TypeScript and JavaScript workspaces. It is part of `mise run drift-prevention`, so of the build. It fails on any finding, with zero tolerance and no baseline. Remove the unused code or dependency, drop `export` from a symbol that only its own file uses, or declare in `knip.json` a use that knip cannot see. Decide per symbol. Do not bulk-apply `knip --fix`.
- **Shell script that fails shellcheck.** `mise run check:shell` runs shellcheck over every `*.sh` file that git tracks or would add. The task is part of `mise run drift-prevention`, so of the build, and of `mise run security`, so of the push hook. The commit hook runs it when a `*.sh` file is staged. A new script that git does not ignore is checked before its first `git add`. A scratch script with a warning therefore fails the build and the push hook until it is fixed, removed or ignored. Errors and warnings fail (`--severity=warning`). `info` and `style` notes are not reported. The task reads no `.shellcheckrc` and no `SHELLCHECK_OPTS`. Fix the finding. For a false positive, put `# shellcheck disable=SC<code> # <reason>` on the line above the command.
- **Optional feature read from context, or catalog edited in one place.** New optional modules belong in `DeploymentFeatures` (`cdk/src/deployment/features.ts`) and are gated in `AgentStack` from that selection, not with a new `tryGetContext` call. Regional data is in `contracts/deployment-capabilities.json`. Mirror it into `cli/src/deployment-capabilities.ts`, which a parity test checks, and update `lastVerified` only when the AgentCore Regions page was checked again. The date records the last check of that page, not of the Lambda MicroVM Regions ([Regional availability](./docs/guides/DEPLOYMENT_GUIDE.md#regional-availability)). See [ADR-024](./docs/decisions/ADR-024-deployment-profiles.md).
- **Broken link or misplaced image in Markdown.** `mise //docs:link-check` checks the relative links of every Markdown file in the repository, tracked or new (READMEs, `AGENTS.md` files and plugin skills included), and `mise //docs:build` fails on a broken link or anchor of the rendered site. An image shown in a mirrored doc must be a file in `docs/imgs/`, or `mise //docs:sync` fails. See [docs/AGENTS.md](./docs/AGENTS.md).
- **Package-specific pitfalls.** For API type drift, CDK test bundling, Cedar parity, and generated docs, see the package `AGENTS.md` files.

## Tech stack

- **Node** 22 (mise), **TypeScript** 6.x, **Python** ≥3.13 (agent, uv)
- **TypeScript compiler checks.** In cdk, cli and web (`src/` and `test/`), the checks are `strict`, `noImplicitOverride` and `noFallthroughCasesInSwitch`. With `noImplicitOverride`, a member that overrides one of its base class needs the `override` modifier. Unreachable code and unused labels are errors.
- **AWS CDK.** `aws-cdk-lib` 2.x, `@aws-cdk/aws-bedrock-alpha`, `@aws-cdk/aws-bedrock-agentcore-alpha`, `cdk-nag`.
- **Test and lint.** Jest 30 (cdk, cli), Vitest (web), ESLint flat config (`cdk/eslint.config.mjs`, `cli/eslint.config.mjs`, `web/eslint.config.mjs`), Ruff (agent).
- **Cedar.** `@cedar-policy/cedar-wasm` 4.12.0 (cdk) and `cedarpy==4.12.2` (agent). The two must be bumped together, with `contracts/cedar-parity/engines/versions.json`, which names the pair. `cdk/test/constructs/cedar-wasm-layer.test.ts` fails on any other pin.
- **Tooling.** mise, Yarn workspaces, prek hooks, Starlight docs sync.

## Repository structure

| Path | Role |
|------|------|
| `cdk/` | CDK app (`@abca/cdk`). See [cdk/AGENTS.md](./cdk/AGENTS.md) |
| `cli/` | `bgagent` CLI. See [cli/AGENTS.md](./cli/AGENTS.md) |
| `web/` | Operator console (React + Cloudscape). See [web/AGENTS.md](./web/AGENTS.md) |
| `agent/` | Python runtime (bundled into CDK image). See [agent/AGENTS.md](./agent/AGENTS.md) |
| `docs/` | Guides, design, Starlight site. See [docs/AGENTS.md](./docs/AGENTS.md) |
| `mise.toml` | Monorepo tasks. `config_roots`: cdk, agent, cli, docs, web |
| `CONTRIBUTING.md` | Contribution guidelines |
