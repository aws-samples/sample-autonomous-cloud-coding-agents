# Contributing Guidelines

Thank you for your interest in contributing. Whether it's a bug report, new feature, or documentation improvement, we value contributions from the community.

## Reporting bugs and requesting features

Use the [GitHub issue tracker](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) to report bugs or suggest features. Before filing, check [existing open](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues) and [recently closed](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues?q=is%3Aissue%20state%3Aclosed) issues. For bug reports, include reproduction steps, expected vs actual behavior, and your environment details.

## Contributing code

### 1. Open an issue first

Describe what you intend to contribute. This avoids duplicate work and gives maintainers a chance to provide early feedback on approach.

### 2. Set up your environment

Follow the [Quick Start](./docs/guides/QUICK_START.mdx) to clone, install, and build the project. See the [Developer guide](./docs/guides/DEVELOPER_GUIDE.md) for local testing and the development workflow.

Use **[AGENTS.md](./AGENTS.md)** to understand where to make changes (CDK vs CLI vs agent vs docs), which tests to extend, and common pitfalls (generated docs, mirrored API types, `mise` tasks). Package-specific detail lives in **`AGENTS.md`** under `cdk/`, `cli/`, `agent/`, and `docs/`.

### 3. Implement your change

Guidelines:

- One logical change per pull request. Related changes (e.g. a feature + its tests) are fine together; unrelated changes should be separate PRs.
- Every change requires a unit test. Tests live alongside the code they cover (`cdk/test/` mirrors `cdk/src/`, `agent/tests/`, `cli/test/`).
- Follow the code style around you. Linters run automatically on every PR (ESLint for TypeScript, Ruff for Python); an ESLint warning fails the build like an error. `mise //cdk:eslint:check`, `mise //cli:eslint:check` and `mise //web:eslint:check` report findings without rewriting files (the tasks without `:check` apply `--fix`), and `mise run lint` runs every package's lint and type checks the same way. ESLint also rejects coverage-ignore comments (`istanbul ignore`, `c8 ignore`, `v8 ignore`, `node:coverage`) in cdk, cli and web: test the code, or leave it counted as uncovered.
- If you change API types in `cdk/src/handlers/shared/types.ts`, update `cli/src/types.ts` to match.
- If you change docs sources (`docs/guides/`, `docs/design/`), run `mise //docs:sync` so generated content stays in sync.
- For significant features, add a design document to `docs/design/`.
- For cross-cutting or hard-to-reverse decisions, add an ADR to `docs/decisions/` (see [ADR README](./docs/decisions/README.md)).

### 4. Commit

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org):

```
feat(orchestrator): add retry logic for transient GitHub API failures

The orchestrator now retries GitHub API calls up to 3 times with
exponential backoff when it receives 5xx responses during pre-flight.

Closes #123
```

Rules:
- Title format: `feat(module):`, `fix(module):`, or `chore(module):` - lowercase, no period at the end.
- Body: describe the motivation (why, not what). Reference issues with `Fixes #xxx` or `Closes #xxx`.
- Breaking changes: add `BREAKING CHANGE: description` at the end of the body.

### 5. Pull request

- Push to a fork and open a PR against `main`.
- The PR title and description become the squash commit message, so keep them accurate throughout the review.
- The CI workflow runs `mise run install` then `mise run build` (compile + lint + test + synth + security scans for all packages).
- Iterate on review feedback by pushing new commits to the same branch. Maintainers squash-merge when approved.
- For structured reviews (human or agent), use the [`review_pr` command](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/.abca/commands/review_pr.md) — including the **human review heuristics** (Proportionality, Coherence, Clarity, Appropriateness) for smell dimensions automation cannot catch. To review a queue of PRs in one pass, use the [`review_prs` command](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/.abca/commands/review_prs.md), which derives a filtered work-list and runs `review_pr` across each.

### PR checklist

- [ ] Unit test added
- [ ] Integration test added (if introducing new CloudFormation resource types or cross-service configuration)
- [ ] Documentation updated (README, guides, or design docs as appropriate)
- [ ] Title follows conventional commits (`feat(module):`, `fix(module):`, `chore(module):`)
- [ ] Breaking changes documented in commit body

## Tooling

This repository uses [mise](https://mise.jdx.dev/) for tool versions and monorepo tasks. The root `mise.toml` defines config roots for `cdk`, `agent`, `cli`, and `docs`.

Common commands:

| Command | What it does |
|---|---|
| `mise run install` | Install all dependencies (Yarn workspaces + Python) |
| `mise run build` | Full build: agent quality, CDK compile/lint/test/synth, CLI build, docs build |
| `mise //cdk:build` | CDK only: compile + lint + type-check + test + synth |
| `mise //agent:quality` | Agent only: lint + format + type check + dead code + tests |
| `mise //cli:build` | CLI only: compile + type-check + test + lint |
| `mise //docs:build` | Docs only: sync sources, script tests, Markdown structure lint, `astro check`, Astro build (fails on a broken internal link or anchor) |
| `mise run hooks:run` | Run pre-commit and pre-push checks locally |
| `mise run upgrade` | Upgrade dependencies within declared ranges (Yarn workspaces + agent `uv.lock`) |

Set `export MISE_EXPERIMENTAL=1` for namespaced tasks like `mise //cdk:build`.

Keep settings for one machine out of the repository: mise reads an untracked `mise.local.toml` next to a `mise.toml`. Committing that file, or a `.mise.toml`, `.miserc.toml`, `.yarnrc`, `.yarnrc.yml` or `.npmrc`, in the repository root or a package directory fails `mise run check:coverage-thresholds-sync`, because such a file can change how a pinned test command runs without changing its text (the exact names and directories are `LAUNCHER_CONFIGS` in `scripts/check-coverage-thresholds-sync.ts`).

### Dependency upgrades

The `upgrade-main` GitHub workflow runs `mise run upgrade` daily and opens a PR labeled `auto-approve` when lockfiles change. Upgrades stay within the ranges declared in each manifest — exact pins are never rewritten, which keeps the Cedar engine parity pair (`cedarpy` / `@cedar-policy/cedar-wasm`) untouched; those move only together, by hand, with refreshed parity fixtures.

PRs labeled `auto-approve` are approved automatically by the `auto-approve` workflow; only apply the label to automated PRs whose changes are gated by the full build (e.g. the dependency-upgrade PRs).

The tools that the gates run are not part of that upgrade. `prek`, `gitleaks`, `uv`, `semgrep`, `osv-scanner`, `grype` and `zizmor` are pinned to exact versions in the root `mise.toml` (`uv` and `trivy` in `agent/mise.toml`), and every workflow that installs mise pins the mise version (`version:` under `jdx/mise-action`). Nothing bumps these pins automatically: bump them by pull request, to a release that is at least 7 days old, and keep `uv` the same in both files. After pulling a change to a pin, run `mise install`.

### Git hooks

`mise run install` automatically installs [prek](https://github.com/j178/prek) git hooks. These run on every commit and push:

- **pre-commit** - Whitespace/EOF checks, gitleaks on staged changes, and the checks that belong to the files you staged: ESLint for cdk, cli and web, the agent quality task for Python, the docs sync and `astro check`, the Markdown structure lint, the docs script tests, and the drift checks for API types and shared constants. The coverage contract check runs on every commit.
- **pre-push** - Security scans (`mise run hooks:pre-push:security`) and tests across all packages (`mise run hooks:pre-push:tests`).

If `prek install` fails with "refusing to install hooks with `core.hooksPath` set", another tool owns your hooks. Either unset it (`git config --unset-all core.hooksPath`) or integrate these checks into your hook manager.

## Versioning

The project uses semantic versioning based on [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

- `fix:` bumps PATCH (v0.0.1)
- `feat:` bumps MINOR (v0.1.0)
- MAJOR bumps are done explicitly to protect consumers from breaking changes.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct). For questions, contact opensource-codeofconduct@amazon.com.

## Security issue notifications

If you discover a potential security issue, notify AWS/Amazon Security via the [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Do **not** create a public GitHub issue.

## Licensing

See the [LICENSE](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/LICENSE) file. We will ask you to confirm the licensing of your contribution and may request a [Contributor License Agreement (CLA)](http://en.wikipedia.org/wiki/Contributor_License_Agreement) for larger changes.

***
&copy; Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
