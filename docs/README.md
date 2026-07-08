# ABCA documentation site

Astro + [Starlight](https://starlight.astro.build/) site for **ABCA (Autonomous Background Coding Agents on AWS)**. Source guides live in git; mirrors under `src/content/docs/` are generated.

## Commands

From repo root:

```bash
mise //docs:sync      # regenerate Starlight mirrors
mise //docs:build     # sync + production build
mise //docs:check     # sync + astro check
mise //docs:link-check
```

From `docs/`:

```bash
mise run sync
mise run build
```

## Where to edit

| Write here | Published as |
|------------|--------------|
| `docs/guides/` | Getting Started, Using, Use cases, Concepts, … |
| `docs/design/` | `/architecture/` on the site |
| `docs/decisions/` | `/decisions/` |
| `CONTRIBUTING.md` (repo root) | Developer guide / Contributing |
| `docs/src/content/docs/index.mdx` | Splash landing only (hand-maintained) |

**Do not** edit other files under `src/content/docs/` by hand — CI rejects drift.

## Add a page

1. Add source under `docs/guides/` (copy a template from `docs/guides/_templates/`).
2. Set `diataxis:` in frontmatter (`tutorial`, `how-to`, `explanation`, `reference`).
3. Run `mise //docs:sync`.
4. Add the slug to `docs/sidebar.yaml` and `docs/astro.config.mjs` (or run `mise //docs:validate-sidebar`).
5. Commit source **and** generated mirrors.

## Authoring help

- [ADR-004 tabula rasa](../docs/decisions/ADR-004-tabula-rasa-documentation.md)
- [Docs site revamp design](./design/DOCS_SITE_REVAMP.md)
- `/write_docs` command or Claude Code `/write-docs` skill (`docs/abca-plugin/`)

## Navigation manifest

`docs/sidebar.yaml` lists every published slug. `scripts/validate-sidebar.mjs` fails CI if mirrors orphan or nav drifts.
