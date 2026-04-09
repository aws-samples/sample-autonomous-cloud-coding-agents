---
title: Contributing
---

# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check [existing open](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues), or [recently closed](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues?q=is%3Aissue%20state%3Aclosed), issues to make sure somebody else hasn't already reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests

### Pull Request Checklist

When planning edits, use **[AGENTS.md](/design/agents)** at the repo root for **where to change code** (CDK vs CLI vs agent vs docs), **which tests to extend**, and **common pitfalls** (generated docs, mirrored API types, `mise` tasks).

* [ ] Testing
  - Unit test added (prefer not to modify an existing test, otherwise, it's probably a breaking change)
  - Integration test added (if adding a new pattern or making a significant update to an existing pattern)
* [ ] Docs
  - __README__: README and/or documentation topic updated
  - __Design__: For significant features, design document added to `design` folder
* [ ] Title and Description
  - __Change type__: title prefixed with **fix**, **feat** or **chore** and module name in parenthesis, which will appear in changelog
  - __Title__: use lower-case and doesn't end with a period
  - __Breaking?__: last paragraph: "BREAKING CHANGE: <describe what changed + link for details>"
  - __Issues__: Indicate issues fixed via: "**Fixes #xxx**" or "**Closes #xxx**"

---

## mise (monorepo)

This repository uses [mise](https://mise.jdx.dev/) for tool versions and tasks. The root **`mise.toml`** enables [monorepo tasks](https://mise.jdx.dev/tasks/monorepo.html) with **`[monorepo].config_roots`** for **`cdk`**, **`agent`**, **`cli`**, and **`docs`**.

- After cloning, run **`mise trust`** in the repository root (and in **`agent/`** if you use tasks there in isolation) so mise will load **`mise.toml`** files. See [mise trust](https://mise.jdx.dev/cli/trust.html).
- Set **`export MISE_EXPERIMENTAL=1`** in your shell (or add it to your environment) when using **namespaced tasks** such as **`mise //cdk:build`** or **`mise run //agent:install`**. Root tasks like **`mise run install`** and **`mise run build`** work without cross-package references and are enough for most workflows.
- From the repo root: **`mise run install`** runs **`yarn install`** and **`mise run install`** in **`agent/`**. **`mise run build`** runs **`//agent:quality`** first (the CDK stack bundles the agent image), then **`//cdk:build`**, **`//cli:build`**, and **`//docs:build`** in order.

---

Project configuration is hand-owned in this repository. Prefer `mise` tasks from the repo root (`mise run install`, `mise run build`) or package-level tasks (`mise //cdk:build`, `mise //cli:build`, `mise //docs:build`).

### Git hooks ([prek](https://github.com/j178/prek))

**`mise run install`** already runs **`prek install --prepare-hooks`** when the current directory is inside a **Git** working tree (it is skipped if there is no `.git`, e.g. a source tarball). [`prek`](https://github.com/j178/prek) is pinned in the root **`mise.toml`** and reads **`.pre-commit-config.yaml`**.

Re-apply hook shims after you change hook config or if install was skipped:

```bash
mise run hooks:install
```

| Stage | What runs |
|-------|-----------|
| **pre-commit** | Trailing whitespace / EOF / merge-conflict / YAML+JSON checks; **gitleaks** on **staged** changes only; **eslint** (cdk, cli), **ruff** (agent), **astro check** (docs) when matching paths are touched. |
| **pre-push** | Two pre-push hooks run in order:
1. **`mise run hooks:pre-push:security`** — root security scans.
2. **`mise run hooks:pre-push:tests`** — tests in `cdk`, `cli`, and `agent` packages.

For convenience, **`mise run hooks:pre-push`** runs both steps sequentially. |

Dry-run or reproduce locally without committing:

```bash
mise run hooks:run
```

If **`prek install`** exits with *refusing to install hooks with `core.hooksPath` set* — another tool owns your hooks. Either unset it (`git config --unset-all core.hooksPath` for **local** and/or **global**) or integrate these checks into that hook manager instead.

### Step 1: Open Issue

If there isn't one already, open an issue describing what you intend to contribute. It's useful to communicate in advance, because sometimes, someone is already working in this space, so maybe it's worth collaborating with them instead of duplicating the efforts.

### Step 2: Design

If you are proposing modifications to the bgagent repo, the best way to do this is to create the full `README.md` document for the change in advance (defining all interfaces, the minimal deployment scenario, the architecture diagram, and so on). This gives us all the information we need to provide feedback, and the document can live on as documentation. You will want to follow our [roadmap](/roadmap/roadmap).

Once the design is finalized, you can re-purpose this PR for the implementation, or open a new PR to that end.

### Step 3: Work your Magic

Now it's time to work your magic. Here are some guidelines:

* Coding style (abbreviated):
  * In general, follow the style of the code around you. The linter will run on every PR and modify files.
* Every change requires a unit test
* If you change APIs, make sure to update the module's README file
* Try to maintain a single feature/bugfix per pull request. It's okay to introduce a little bit of housekeeping
   changes along the way, but try to avoid conflating multiple features. Eventually all these are going to go into a
   single commit, so you can use that to frame your scope.
* Feel free to start your contribution by copy&pasting files from that project,
  and then edit and rename them as appropriate -
  it might be easier to get started that way.

#### Integration Tests

If you are working on a new feature that is using previously unused CloudFormation resource types, or involves
configuring resource types across services, you need to write integration tests that use these resource types or
features.

To the extent possible, include a section (like below) in the integration test file that specifies how the successfully
deployed stack can be verified for correctness. Correctness here implies that the resources have been set up correctly.
The steps here are usually AWS CLI commands but they need not be.

```ts
/*
 * Stack verification steps:
 * * <step-1>
 * * <step-2>
 */
```

### Step 4: Commit

Create a commit with the proposed changes:

* Commit title and message (and PR title and description) must adhere to [Conventional Commits](https://www.conventionalcommits.org).
  * The title must begin with `feat(module): title`, `fix(module): title` or `chore(module): title`.
  * Title should be lowercase.
  * No period at the end of the title.

* Commit message should describe _motivation_. Think about your code reviewers and what information they need in
  order to understand what you did. If it's a big commit (hopefully not), try to provide some good entry points so
  it will be easier to follow.

* Commit message should indicate which issues are fixed: `fixes #<issue>` or `closes #<issue>`.

* Shout out to collaborators.

* If not obvious (i.e. from unit tests), describe how you verified that your change works.

* If this commit includes breaking changes, they must be listed at the end in the following format (notice how multiple breaking changes should be formatted):

```
BREAKING CHANGE: Description of what broke and how to achieve this behavior now
* **module-name:** Another breaking change
* **module-name:** Yet another breaking change
```

### Step 5: Pull Request

* Push to a GitHub fork
* Submit a pull request on GitHub.
* Please follow the PR checklist written above. We trust our contributors to self-check, and this helps that process!
* Discuss review comments and iterate until you get at least one “Approve”. When iterating, push new commits to the
  same branch. Usually all these are going to be squashed when you merge to main. The commit messages should be hints
  for you when you finalize your merge commit message.
* Make sure to update the PR title/description if things change. The PR title/description are going to be used as the
  commit title/message and will appear in the CHANGELOG, so maintain them all the way throughout the process.
* Make sure your PR builds successfully (we have GitHub Actions set up to automatically build all PRs)

#### Build steps

- The Build workflow runs on `pull_request` and `workflow_dispatch`, runs **`mise run install`** (Yarn workspaces + agent Python), then **`mise run build`**.
- Release/versioning is currently managed through conventional commits and repository automation (not Projen self-mutation).

Every commit to the default (main) branch marked as feat or fix will trigger a new version release (trunk-based development). This includes the following steps:

- Compile, lint and test the code.
- Determine the next minor/patch version based on [Conventional Commits](https://www.conventionalcommits.org). Major versions must be explicitly bumped to protect consumers against breaking changes.
- A changelog entry is generated based on commit history.
Packages are published to all target package managers.

> **Warning**
> Some docs files are synchronized from source guides/design files. When changing docs sources, run the docs sync/build tasks so generated docs content is up to date in your branch.

### Step 6: Merge

* Once approved and tested, a maintainer will squash-merge to main and will use your PR title/description as the
  commit message.

The project uses semantic versioning based on [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

For example:

- fix: bump PATCH version (v0.0.1)
- feat: bump MINOR version (v0.1.0)

MAJOR version bumps should be done explicitly through your release process configuration to protect users from critical changes.

GitHub provides additional documentation on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/blob/main/LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.

We may ask you to sign a [Contributor License Agreement (CLA)](http://en.wikipedia.org/wiki/Contributor_License_Agreement) for larger changes.

***
&copy; Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
