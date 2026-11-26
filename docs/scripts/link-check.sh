#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

filelist=$(mktemp)
trap 'rm -f "$filelist"' EXIT

# git still lists a tracked file that was deleted but not staged. With "./" in front the checker
# takes a path for a file whatever character its name starts with.
git ls-files -z --cached --others --exclude-standard -- '*.md' '*.mdx' ':!docs/src/content/docs' |
  while IFS= read -r -d '' file; do
    if [ -e "$file" ]; then printf './%s\0' "$file"; fi
  done > "$filelist"

count=$(tr '\0' '\n' < "$filelist" | grep -c . || true)
if [ "$count" -lt 10 ]; then
  echo "ERROR: expected ≥10 Markdown files but found $count — scan may be misconfigured" >&2
  exit 1
fi

xargs -0 -r ./docs/node_modules/.bin/markdown-link-check --config docs/.markdown-link-check.json < "$filelist"
