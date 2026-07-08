# Write documentation for ABCA

## Persona

Write as a **technical writer** who treats docs as code: source in git, Diátaxis discipline,
ADR-004 tabula rasa quality, and automated sync so the published site never drifts from sources.

This is **ABCA (Autonomous Background Coding Agents on AWS)**. Documentation must work for
operators, teammates, contributors, and autonomous agents with zero implicit context.

## Canonical workflow

Follow the full phased workflow in
[`docs/abca-plugin/skills/write-docs/SKILL.md`](../../docs/abca-plugin/skills/write-docs/SKILL.md).
Claude Code users can also invoke `/write-docs` when the ABCA plugin is loaded
(`claude --plugin-dir docs/abca-plugin`).

## Before you edit

1. **Classify with [Diátaxis](https://diataxis.fr/)** — pick one type per page:
   - `tutorial` — learning by doing (use cases, Quick Start)
   - `how-to` — solve a specific problem (setup guides, troubleshooting)
   - `explanation` — mental model (`docs/guides/concepts/`, `docs/design/`)
   - `reference` — lookup facts (API contract, ADRs, glossary)
2. **Edit sources only** — `docs/guides/`, `docs/design/`, `docs/decisions/`, or root
   `CONTRIBUTING.md`. **Never** edit `docs/src/content/docs/` except hand-maintained
   `index.mdx` splash landing.
3. **Copy a template** from [`docs/guides/_templates/`](../../docs/guides/_templates/) and set
   `diataxis:` in frontmatter.
4. **Package context** — read [`docs/AGENTS.md`](../../docs/AGENTS.md) for sync commands and
   boundaries.

## Quality bar (ADR-004)

Every procedural page must pass the **tabula rasa test**: someone with zero project knowledge
can complete the outcome using only the page and linked prerequisites.

- Prerequisites at the top (with links and why each matters)
- Copy-pasteable commands; directory context when not repo root
- Expected output after non-trivial steps
- Error table: "If you see X → means Y → fix Z"
- **Bold** platform terms on first use; link to Concepts pages when they exist
- `YOUR_API_BASE_URL`, `YOUR_JWT`, `YOUR_ORG/YOUR_REPO` placeholders — never `foo`/`xxx`

See [ADR-004](../../docs/decisions/ADR-004-tabula-rasa-documentation.md) and
[DOCS_SITE_REVAMP](../../docs/design/DOCS_SITE_REVAMP.md) for IA and snippet rules.

## Snippet parity

| Surface | Show |
|---------|------|
| CLI / operators | `bash` + `bgagent` |
| REST API | `curl` first; JSON body or TypeScript `fetch` when helpful |
| Agent / CDK | `python` or `typescript` as appropriate |

## Navigation

New published pages need a sidebar entry in [`docs/astro.config.mjs`](../../docs/astro.config.mjs).
Orphan files under `docs/src/content/docs/` without nav entries are bugs.

## Sync and verify

From the **repository root**:

```bash
mise //docs:sync
mise //docs:build
```

Optional: `mise //docs:check` · `mise run hooks:run` before commit.

Stage **source and generated mirrors** in the same commit. CI rejects stale Starlight output.

## Governance

- **Docs-only PRs** — no ADR-003 feature issue required unless repo policy says otherwise.
- **Docs with a feature** — reference the governing issue; keep API types and guides aligned
  (`cdk/src/handlers/shared/types.ts` ↔ `cli/src/types.ts`).
- Use Conventional Commits: `docs(scope): summary` (see [`commit`](./commit.md) command).

## After writing

- Confirm `git diff` includes both `docs/guides/` (or design/decisions) and
  `docs/src/content/docs/` mirror changes when applicable.
- Cross-link related tutorials, Concepts, and architecture docs — one sentence per link on
  what the reader gets.
