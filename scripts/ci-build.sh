#!/usr/bin/env bash
# Thin wrapper for CI or local runs: full monorepo build (same as .github/workflows/build.yml).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec mise run build
