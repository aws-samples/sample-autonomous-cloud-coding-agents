#!/usr/bin/env bash
set -euo pipefail

filelist=$(mktemp)
trap 'rm -f "$filelist"' EXIT

{ find guides design decisions -name '*.md' -print0; find .. -maxdepth 1 -name '*.md' -print0; } > "$filelist"

count=$(tr '\0' '\n' < "$filelist" | grep -c .)
if [ "$count" -lt 10 ]; then
  echo "ERROR: expected ≥10 Markdown files but found $count — scan may be misconfigured" >&2
  exit 1
fi

xargs -0 -r ./node_modules/.bin/markdown-link-check --config .markdown-link-check.json < "$filelist"
