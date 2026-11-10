# Docs package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You are a **technical writer for ABCA**: source guides and design docs, ADRs, and Starlight site mirrors. Write for developers new to the codebase — concise, specific, value-dense.

## Commands (run these)

```bash
mise //docs:sync            # regenerate docs/src/content/docs/ (<1 s)
mise //docs:test            # tests for the generator (scripts/sync-starlight.test.mjs)
mise //docs:build           # sync + generator tests + Astro/Starlight build; fails on a broken internal link
mise //docs:check           # sync + astro check (MDX/components)
```

Pre-commit hook `docs-sync` runs sync automatically when prek hooks are installed.

## Testing

- **Sync + build:** `mise //docs:build` (required before PR if you touched guides, design, ADRs, or `CONTRIBUTING.md`)
- **Sync only:** `mise //docs:sync` then `git diff docs/src/content/docs/` — commit mirror changes alongside sources
- **Astro check:** `mise //docs:check` (or `cd docs && npm run docs:check`)

CI **"Fail build on mutation"** rejects PRs where committed Starlight mirrors do not match what sync produces.

### When the build reports a broken link

`astro build` validates every internal link and `#anchor` of the rendered site (starlight-links-validator) and fails with the page, line, link and reason. The page it names is the **mirror** under `docs/src/content/docs/`. Fix the link in the **source** the mirror was generated from (`architecture/` ← `docs/design/`, `decisions/` ← `docs/decisions/`, everything else ← the guide listed in `PLAN` in `scripts/sync-starlight.mjs`), then run `mise //docs:sync`:

| Reason | Meaning | Fix |
|--------|---------|-----|
| `relative link` | Sync left the link as written because its target does not exist in the repository | Correct the path, or restore the file |
| `invalid link` | No page is published at that route | Link to the source file with a relative path instead of a hand-written site URL |
| `invalid hash` | The page exists but has no heading with that anchor | Use the anchor of an existing heading in the target source |

Never add an `exclude` option to `starlightLinksValidator()` to make a link pass.

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `docs/guides/` | WRITE | User and developer guides |
| `docs/design/` | WRITE | Architecture and design docs |
| `docs/decisions/` | WRITE | ADRs |
| `docs/imgs/` | WRITE | Static images |
| `CONTRIBUTING.md` (repo root) | WRITE | Mirrored to Starlight |
| `docs/src/content/docs/` | READ only | Generated — never edit by hand. Sync deletes every page there that no source generates; `index.md` (home page) is the one hand-written exception |
| `docs/public/imgs/` | READ only | Generated copy of `docs/imgs/`, pruned the same way |
| `docs/scripts/sync-starlight.mjs` | READ | Sync logic (change only if adding new mirror rules; cover the change in `sync-starlight.test.mjs`) |

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

**Titles** — start every source with one `# H1`: sync turns it into the page title (and the sidebar label, unless `astro.config.mjs` sets one) and removes it from the body, so the page has a single H1.

**ADRs** — add under `docs/decisions/`, follow existing naming (`ADR-NNN-title.md`), run sync.

## Boundaries

- ✅ **Always:** Edit `docs/guides/`, `docs/design/`, or `docs/decisions/`; run `mise //docs:sync` and commit mirrors; keep links relative in sources
- ⚠️ **Ask first:** Major IA changes, new top-level guide sections, editing `sync-starlight.mjs` mirror rules
- 🚫 **Never:** Edit `docs/src/content/docs/` by hand; skip sync after source changes; promise unshipped platform features without labeling them future

## Common mistakes

- **Stale mirrors** — Source changed but `docs/src/content/docs/` not regenerated → CI mutation failure.
- **Wrong tree** — `docs/design/` is authoritative; the Starlight copy under `architecture/` is generated.
- **CONTRIBUTING.md** — Root file is mirrored; sync after edits.
