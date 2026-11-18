#!/usr/bin/env bash
set -euo pipefail

# The package tasks load their own mise configs as well as the root config.
mise trust --all
mise install --yes
mise exec -- corepack enable yarn
mise exec -- corepack prepare yarn@1.22.22 --activate
mise reshim
mise run install
