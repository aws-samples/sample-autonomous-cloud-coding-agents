# Docs package — agent context

Parent guide: [../AGENTS.md](../AGENTS.md)

You are a **technical writer for ABCA**. Your scope is the source guides and design docs, the ADRs, and the Starlight site mirrors. Write for developers who are new to the codebase. Keep the text concise, specific, and value-dense.

## Commands (run these)

```bash
mise //docs:sync            # regenerate docs/src/content/docs/ (<1 s)
mise //docs:test            # tests for the generator and for the Markdown lint (scripts/*.test.mjs)
mise //docs:markdown-lint   # structure of every tracked Markdown file: tables, headings, image alt text
mise //docs:build           # sync + tests + Markdown lint + astro check + Astro/Starlight build; fails on a broken internal link
mise //docs:check           # sync + astro check alone (MDX/components)
mise //docs:link-check      # relative links in every Markdown file of the repository, tracked or new
```

With prek hooks installed, the pre-commit hook `docs-sync` runs sync when a `.md` file under `docs/guides/` or `docs/design/`, or `CONTRIBUTING.md`, is staged. It does not run for an ADR or for `QUICK_START.mdx`. After you edit one of those, run `mise //docs:sync` yourself. Three more hooks run at commit time. `docs-astro-check` runs `astro check` when a file under `docs/` is staged. `docs-markdown-lint` runs `mise //docs:markdown-lint` when a Markdown file is staged. `docs-script-tests` runs `mise //docs:test` when a file under `docs/scripts/` is staged.

## Testing

- **Sync + build.** Run `mise //docs:build`. It is required before a PR if you touched guides, design docs, ADRs, or `CONTRIBUTING.md`.
- **Sync only.** Run `mise //docs:sync`, then `git diff docs/src/content/docs/`. Commit the mirror changes alongside the sources.
- **Astro check.** It is part of `mise //docs:build`. To run it on its own, use `mise //docs:check` or `cd docs && npm run docs:check`.
- **Structure.** `mise //docs:markdown-lint`, which is part of `mise //docs:build`, lints all tracked Markdown sources, repository-wide.
- **Links.** `mise //docs:link-check` checks relative links in all Markdown sources, repository-wide. That covers the tracked files and the new files that are not ignored. It reports the source file. It does not check an `#anchor` into another file. `mise //docs:build` checks links and anchors on the rendered site.

CI **"Fail build on mutation"** rejects PRs where committed Starlight mirrors do not match what sync produces.

### When the build reports a broken link

`astro build` validates every internal link and `#anchor` of the rendered site with starlight-links-validator, and fails with the page, line, link and reason. The page it names is the **mirror** under `docs/src/content/docs/`. The source of a mirror is `docs/design/` for a page under `architecture/`, `docs/decisions/` for a page under `decisions/`, and for every other page the guide listed in `PLAN` in `scripts/sync-starlight.mjs`. Fix the link in the **source** that the mirror was generated from, then run `mise //docs:sync`:

| Reason | Meaning | Fix |
|--------|---------|-----|
| `relative link` | Sync left the link as written. Either its target does not exist in the repository, or the link is written in a form that sync does not rewrite. Those forms are a path in angle brackets (`[label](<path>)`), a title in single quotes or parentheses, a reference definition (`[label]: path`), a link around an image (`[![alt](image)](path)`), and a label that contains brackets | Correct the path, or restore the file. For the other forms, write the link inline as `[label](path)` or `[label](path "title")`. The label may wrap over lines. Link an image with `<a href="path"><img src="../imgs/name.png" alt="..."></a>` |
| `invalid link` | No page is published at that route | Link to the source file with a relative path instead of a hand-written site URL |
| `invalid hash` | The page exists but has no heading with that anchor | Use the anchor of an existing heading in the target source |

Never add an `exclude` option to `starlightLinksValidator()` to make a link pass.

### When the Markdown lint fails

`mise //docs:markdown-lint` checks the structure of every tracked Markdown file with five markdownlint rules, which are set in `docs/scripts/markdown-lint.mjs`. It prints the file, the line and the rule. The generated mirrors are not linted. Fix the source.

| Rule | Meaning | Fix |
|------|---------|-----|
| `MD056/table-column-count` | A table row has more or fewer cells than the header. Renderers drop the extra cells | Give the row the header's number of cells, and escape a pipe that belongs to a cell's text (see below) |
| `MD045/no-alt-text` | An image has no alternative text | `![what the image shows](path)` |
| `MD025/single-h1` | A second top-level heading. A front matter `title` counts as the first. Reported only in a file that has such a `title` or opens with its `# H1` (blank lines and HTML comments may come first). A file that opens with anything else is not checked. For example, the root `README.md` opens with an HTML block, and a `# H1` added to it passes | Keep one `# H1` (none in a source with front matter) and make the others `##` |
| `MD024/no-duplicate-heading` | Two headings with the same text under the same parent heading, so their anchors collide | Rename one, or delete the repeated section |
| `MD001/heading-increment` | A heading level is skipped (`##` followed by `####`) | Use the next level down |

Inside a table cell, write a literal pipe as `\|`, also in a code span. An unescaped pipe ends the cell.

Never silence a finding. `<!-- markdownlint-disable -->` comments are ignored, and the lint reads no configuration file, so a `.markdownlint*` file changes nothing. `mise //docs:test` fails when someone switches off one of the five rules in `docs/scripts/markdown-lint.mjs`, or the `noInlineConfig` option that makes the lint ignore those comments.

## Primary locations

| Path | Access | Purpose |
|------|--------|---------|
| `docs/guides/` | WRITE | User and developer guides |
| `docs/design/` | WRITE | Architecture and design docs |
| `docs/decisions/` | WRITE | ADRs |
| `docs/imgs/` | WRITE | Static images |
| `CONTRIBUTING.md` (repo root) | WRITE | Mirrored to Starlight |
| `docs/src/content/docs/` | READ only | Generated. Never edit by hand. Sync deletes every page there that no source generates. `index.md` (home page) is the one hand-written exception |
| `docs/public/imgs/` | READ only | Generated copy of `docs/imgs/`, pruned the same way |
| `docs/scripts/sync-starlight.mjs` | READ | Sync logic. Change it only to add new mirror rules, and cover the change in `sync-starlight.test.mjs` |

The published docs site renders `docs/design/` at `/architecture/`.

## Code style

**Edit source, then sync.** Write guides in `docs/guides/`, not in the Starlight mirror:

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

**Cross-links.** Prefer relative links in source (`../../AGENTS.md`, `../design/ARCHITECTURE.md`). Sync rewrites them for the site.

**Images.** Keep them in `docs/imgs/` and reference them with a relative path: `![what it shows](../imgs/name.png)`, or `<img src="../imgs/name.png" alt="what it shows" width="400">` when the image needs a size. The site serves that directory only, so sync fails on an image that is anywhere else or does not exist, and names the source file and the path.

**Titles.** Start every source with one `# H1`. Sync turns it into the page title, and into the sidebar label unless `astro.config.mjs` sets one. Sync also removes it from the body, so the page has a single H1. A source that brings its own front matter (`QUICK_START.mdx`) sets `title:` there instead and has no `# H1`.

**ADRs.** Add them under `docs/decisions/`, follow the existing naming (`ADR-NNN-title.md`), and run sync.

## Boundaries

- ✅ **Always:** Edit `docs/guides/`, `docs/design/`, or `docs/decisions/`; run `mise //docs:sync` and commit mirrors; keep links relative in sources
- ⚠️ **Ask first:** Major IA changes, new top-level guide sections, editing `sync-starlight.mjs` mirror rules
- 🚫 **Never:** Edit `docs/src/content/docs/` by hand; skip sync after source changes; promise unshipped platform features without labeling them future

## Common mistakes

- **Stale mirrors.** The source changed but `docs/src/content/docs/` was not regenerated, which causes a CI mutation failure.
- **Wrong tree.** `docs/design/` is authoritative. The Starlight copy under `architecture/` is generated.
- **CONTRIBUTING.md.** The root file is mirrored. Run sync after you edit it.
