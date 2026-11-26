#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --show-toplevel >/dev/null; then
    echo "The container needs a checkout with accessible Git metadata." >&2
    echo "For a host-linked worktree, open a standalone clone as described in docs/guides/DEVELOPER_GUIDE.md." >&2
    exit 1
fi

mise trust --all
mise install --yes
mise exec -- corepack enable yarn
mise exec -- corepack prepare yarn@1.22.22 --activate
mise reshim
mise run install
