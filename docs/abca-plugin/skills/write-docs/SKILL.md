---
name: write-docs
description: >-
  Add or update ABCA documentation (guides, design docs, ADRs) following Diátaxis,
  ADR-004 tabula rasa, and docs-as-code sync. Use when the user says "write docs",
  "add documentation", "document this feature", "new tutorial", "update the docs",
  "docs page", or is contributing prose to docs/guides, docs/design, or docs/decisions.
---

# Write documentation

You are helping a contributor add or update **source** documentation for the ABCA docs
site (Astro + Starlight). Work through the phases below in order. Read
[docs/AGENTS.md](../../../AGENTS.md) and [docs/design/DOCS_SITE_REVAMP.md](../../../design/DOCS_SITE_REVAMP.md)
when you need package boundaries or IA context.

**Cursor / Claude Code (repo commands):** the same workflow is available as
[`.abca/commands/write_docs.md`](../../../../.abca/commands/write_docs.md) (`/write_docs` in
Cursor when project commands are enabled).

> **Docs-as-code:** Edit sources under `docs/guides/`, `docs/design/`, or
> `docs/decisions/` — then run `mise //docs:sync` so `docs/src/content/docs/` mirrors
> regenerate. **Never** edit generated mirrors by hand (except hand-maintained
> `docs/src/content/docs/index.mdx` splash landing).

## Phase 1: Classify with Diátaxis

Every page has **one** primary type ([Diátaxis](https://diataxis.fr/)). If the user
wants multiple types, split into separate pages and cross-link.

| Type | Reader need | When to use | ABCA home (target IA) |
|------|-------------|-------------|------------------------|
| `tutorial` | Learning by doing | Safe path to first success | `docs/guides/use-cases/`, Quick Start |
| `how-to` | Solve a specific problem | Reader knows basics | `docs/guides/` (setup, using, customizing) |
| `explanation` | Understand why/how | Mental model, context | `docs/guides/concepts/`, `docs/design/` |
| `reference` | Look up facts | Complete, accurate tables | `docs/design/API_CONTRACT.md`, ADRs, glossary |

Use AskUserQuestion if the type is unclear. **Do not** mix tutorial steps with reference
tables on the same page.

## Phase 2: Pick source path and filename

| Content | Write here | Also update |
|---------|------------|-------------|
| User guide, tutorial, how-to, troubleshooting | `docs/guides/` or subdirs (`concepts/`, `use-cases/`) | Sidebar in `docs/astro.config.mjs` when adding a new top-level slug |
| Architecture / design | `docs/design/` | Mirrors to `architecture/` on sync |
| ADR | `docs/decisions/ADR-NNN-short-title.md` | Follow existing ADR naming |
| Contributing | Root `CONTRIBUTING.md` | Mirrors to developer-guide |
| Splash landing only | `docs/src/content/docs/index.mdx` | Exception — not sync-generated |

**Do not** edit `docs/src/content/docs/` except `index.mdx`.

For new guide files under subdirectories (`concepts/level-100/`, `use-cases/`), ensure
`sync-starlight.mjs` mirrors the path or add an explicit mirror rule in the same PR
(ask the user before changing sync logic).

## Phase 3: Copy template and draft

Templates live in `docs/guides/_templates/` (not published to the site):

| Diátaxis type | Template |
|---------------|----------|
| `tutorial` | `_templates/tutorial.md` |
| `how-to` | `_templates/how-to.md` |
| `explanation` (Level 100) | `_templates/explanation-100.md` |
| `explanation` (Level 200) | `_templates/explanation-200.md` |
| `reference` | `_templates/reference.md` |

Copy the template to the target path. Fill frontmatter:

```yaml
---
title: Human-readable title
description: One sentence for search and SEO (optional but recommended)
diataxis: how-to   # tutorial | how-to | explanation | reference
---
```

## Phase 4: ADR-004 tabula rasa checklist

Before sync, verify the draft passes
[ADR-004](../../../decisions/ADR-004-tabula-rasa-documentation.md):

- [ ] First paragraph answers: **What does this help me do?**
- [ ] **Prerequisites** at the top (with links — what each prereq is for)
- [ ] Numbered steps are self-contained; directory context on commands (`cd` or repo root)
- [ ] **Expected output** after non-trivial commands
- [ ] **Error states**: "If you see X, it means Y. Fix: Z"
- [ ] Acronyms expanded on first use; platform terms **bold** and linked to Concepts when they exist
- [ ] Further reading links say what the reader gets from each target
- [ ] Passes the tabula rasa test (zero prior project knowledge)

## Phase 5: Code snippets

Follow the snippet contract in [DOCS_SITE_REVAMP.md](../../../design/DOCS_SITE_REVAMP.md):

- Language-tagged fences (`bash`, `json`, `typescript`, `python`).
- Placeholders: `YOUR_API_BASE_URL`, `YOUR_JWT`, `YOUR_ORG/YOUR_REPO` — never `foo`/`xxx`.
- One line below each block: how to obtain each `YOUR_*` value (link to auth/deploy docs).
- REST: show `curl` first; add TypeScript `fetch` or JSON body only when it helps.
- CLI: use `bgagent` / `mise` commands that match `bgagent --help` (verify flags if unsure).

## Phase 6: Navigation

When the page is a **new** published route:

1. Add an entry to the `sidebar` array in `docs/astro.config.mjs` (correct section and slug).
2. If the page is split from `USER_GUIDE.md` / `DEVELOPER_GUIDE.md`, check whether
   `sync-starlight.mjs` needs an anchor rewrite — prefer a dedicated source file instead.

Orphan mirror pages (file exists under `src/content/docs/` but not in sidebar) are bugs.

## Phase 7: Sync, build, and diff

From the **repository root**:

```bash
mise //docs:sync
mise //docs:build
```

If sync or build fails, fix errors before finishing.

Show the user:

```bash
git diff docs/guides/ docs/design/ docs/decisions/ docs/src/content/docs/ docs/astro.config.mjs
```

Commit **source and generated mirrors together** in the same PR. CI rejects stale mirrors.

Optional stricter check:

```bash
mise //docs:check
```

## Phase 8: PR hygiene and governance

- **Doc-only PR:** No ADR-003 feature issue required unless repo policy says otherwise.
- **Docs shipping with a feature:** Reference the feature issue in the PR; keep API types
  and docs in sync (`cdk/src/handlers/shared/types.ts` ↔ `cli/src/types.ts` ↔ guides).
- Mention `diataxis:` in the PR description.
- Use relative links in sources (`../design/ARCHITECTURE.md`); sync rewrites for the site.

## Quick reference — commands

```bash
mise //docs:sync            # regenerate Starlight mirrors
mise //docs:build           # sync + production build
mise //docs:check           # sync + astro check
mise run hooks:run          # pre-commit docs-sync + lint (if prek installed)
```

## Related skills

- `/setup` — operator deploy path (link from tutorials)
- `/troubleshoot` — error content for troubleshooting hub cross-links
- `/onboard-repo` — repo onboarding how-tos
