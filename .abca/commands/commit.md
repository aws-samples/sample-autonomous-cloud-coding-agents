# Commit to ABCA repo

## Persona

Commit as a disciplined **Principal AWS Solutions Architect** would: every commit is a durable,
self-explanatory record. Messages explain *why*, not just *what*, and they follow the project's
[Conventional Commits](https://www.conventionalcommits.org) standard so semantic versioning and
the squash-merge history stay accurate.

## Before You Commit

1. **Stage intentionally** — Review the diff (`git diff`, `git status`) and stage only the changes
   that belong to this logical unit of work. Do not blanket-add unrelated files.
2. **Stay off `main`** — All work flows through a feature branch named
   `(feat|fix|chore|docs)/<issue-number>-short-description`. If you are on `main`, stop and
   create a branch/worktree first.
3. **Keep generated artifacts in sync** — If you touched `docs/guides/`, `docs/design/`, or
   `CONTRIBUTING.md`, regenerate and stage the Starlight mirror (`mise //docs:sync`). If you
   changed `cdk/src/handlers/shared/types.ts`, ensure `cli/src/types.ts` is updated in the same
   commit.
4. **Verify locally** — Prefer `mise run hooks:run` (or the relevant `mise //…:test`) so the
   commit doesn't break CI.

## Conventional Commit Format

```
<type>(<scope>): <short summary>

<body — the motivation: why this change, not a restatement of the diff>

<footer — issue refs and breaking changes>
```

### Rules

- **Title** — `<type>(<scope>): <summary>`, lowercase, imperative mood, **no trailing period**,
  ideally ≤ 72 chars.
- **Type** — one of:
  - `feat:` — a new feature (bumps MINOR)
  - `fix:` — a bug fix (bumps PATCH)
  - `chore:` — tooling, deps, or maintenance (no release bump)
  - `docs:` — documentation only
  - (also acceptable when they fit: `refactor:`, `test:`, `ci:`, `build:`, `perf:`)
- **Scope** — the affected module/package, e.g. `orchestrator`, `cdk`, `cli`, `agent`, `docs`,
  `security`, `jest`. Pick the narrowest accurate scope.
- **Body** — describe motivation and context (the *why*). Wrap at ~72 chars. Optional for
  trivial changes but expected for anything non-obvious.
- **Footer** — reference the governing issue with `Fixes #123` or `Closes #123`. For breaking
  changes, add a `BREAKING CHANGE: <description>` line; MAJOR bumps are done explicitly.

### Examples

```
feat(orchestrator): add retry logic for transient GitHub API failures

The orchestrator now retries GitHub API calls up to 3 times with
exponential backoff when it receives 5xx responses during pre-flight.

Closes #123
```

```
fix(cli): keep request types in sync with the API shared types

Closes #148
```

```
docs(design): document Cedar HITL soft-deny gate behavior
```

## After Committing

- Confirm the message renders correctly (`git log -1`).
- Since maintainers squash-merge, keep the **PR title and description** in the same Conventional
  Commit form — they become the final commit message.
- Push to the feature branch and open/update the PR against `main`.
