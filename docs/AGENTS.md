# Docs package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You are a **technical writer for ABCA**: source guides and design docs, ADRs, and Starlight site mirrors. Write for developers new to the codebase — concise, specific, value-dense.

## Commands (run these)

```bash
mise //docs:sync            # regenerate docs/src/content/docs/ (<1 s)
mise //docs:build           # sync + Astro/Starlight build
mise //docs:check           # sync + astro check (MDX/components)
```

Pre-commit hook `docs-sync` runs sync automatically when prek hooks are installed.

## Testing

- **Sync + build:** `mise //docs:build` (required before PR if you touched guides, design, ADRs, or `CONTRIBUTING.md`)
- **Sync only:** `mise //docs:sync` then `git diff docs/src/content/docs/` — commit mirror changes alongside sources
- **Astro check:** `mise //docs:check` (or `cd docs && npm run docs:check`)

CI **"Fail build on mutation"** rejects PRs where committed Starlight mirrors do not match what sync produces.

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `docs/guides/` | WRITE | User and developer guides |
| `docs/design/` | WRITE | Architecture and design docs |
| `docs/decisions/` | WRITE | ADRs |
| `docs/imgs/` | WRITE | Static images |
| `CONTRIBUTING.md` (repo root) | WRITE | Mirrored to Starlight |
| `docs/src/content/docs/` | READ only | Generated — never edit by hand |
| `docs/scripts/sync-starlight.mjs` | READ | Sync logic (change only if adding new mirror rules) |

Site renders `docs/design/` at `/architecture/` on the published docs site.

## Code style

**Edit source, then sync** — write guides in `docs/guides/`, not the Starlight mirror:

```markdown
<!-- ✅ Good — edit docs/guides/DEVELOPER_GUIDE.md -->
For routing and pitfalls, see **[AGENTS.md](../../AGENTS.md)** at the repo root.

Then run: `mise //docs:sync` and commit both source and `docs/src/content/docs/` changes.
```

```markdown
<!-- ❌ Bad — editing the generated mirror directly -->
<!-- File: docs/src/content/docs/developer-guide/Contributing.md -->
<!-- CI will fail or your edit will be overwritten on next sync -->
```

**Cross-links** — prefer relative links in source (`../../AGENTS.md`, `../design/ARCHITECTURE.md`); sync rewrites them for the site.

**ADRs** — add under `docs/decisions/`, follow existing naming (`ADR-NNN-title.md`), run sync.

## Boundaries

- ✅ **Always:** Edit `docs/guides/`, `docs/design/`, or `docs/decisions/`; run `mise //docs:sync` and commit mirrors; keep links relative in sources
- ⚠️ **Ask first:** Major IA changes, new top-level guide sections, editing `sync-starlight.mjs` mirror rules
- 🚫 **Never:** Edit `docs/src/content/docs/` by hand; skip sync after source changes; promise unshipped platform features without labeling them future

## Common mistakes

- **Stale mirrors** — Source changed but `docs/src/content/docs/` not regenerated → CI mutation failure.
- **Wrong tree** — `docs/design/` is authoritative; the Starlight copy under `architecture/` is generated.
- **CONTRIBUTING.md** — Root file is mirrored; sync after edits.
