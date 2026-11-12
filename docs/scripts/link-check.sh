#!/usr/bin/env bash
set -euo pipefail

# Checks the relative links of every Markdown file in the repository: guides, design docs,
# ADRs, package READMEs and AGENTS.md files, plugin skills, command files. The list comes
# from git, so a new file or directory is covered without touching this script: the files
# git tracks (--cached), and the new ones it would add (--others --exclude-standard: not
# yet added, not ignored), so that a document is checked before its first `git add`.
#
# Not scanned: the Starlight mirrors under docs/src/content/docs. They are generated from
# these sources, and `astro build` validates their links and anchors on the rendered site.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

filelist=$(mktemp)
trap 'rm -f "$filelist"' EXIT

# A tracked file that was deleted but not staged is still listed by git: skip it here, the
# links that point at it are reported from the files that contain them.
git ls-files -z --cached --others --exclude-standard -- '*.md' '*.mdx' ':!docs/src/content/docs' |
  while IFS= read -r -d '' file; do
    if [ -e "$file" ]; then printf '%s\0' "$file"; fi
  done > "$filelist"

count=$(tr '\0' '\n' < "$filelist" | grep -c . || true)
if [ "$count" -lt 10 ]; then
  echo "ERROR: expected ≥10 Markdown files but found $count — scan may be misconfigured" >&2
  exit 1
fi

xargs -0 -r ./docs/node_modules/.bin/markdown-link-check --config docs/.markdown-link-check.json < "$filelist"
