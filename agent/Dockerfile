ARG TARGETPLATFORM=linux/arm64
ARG GH_VERSION=2.93.0

FROM --platform=$TARGETPLATFORM jdxcode/mise:latest AS mise

# Build gh with a patched Go toolchain; upstream packages can lag Go CVE fixes.
FROM --platform=$TARGETPLATFORM golang:1.26.4-bookworm AS gh-builder
ARG GH_VERSION
RUN GOPROXY=direct GOBIN=/out go install "github.com/cli/cli/v2/cmd/gh@v${GH_VERSION}"

FROM --platform=$TARGETPLATFORM python:3.13-slim@sha256:dc1546eefcbe8caaa1f004f16ab76b204b5e1dbd58ff81b899f21cd40541232f

# Install mise (polyglot dev tool manager)
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
COPY --from=gh-builder /out/gh /usr/local/bin/gh

# Install system dependencies in multiple layers:
#   - Node.js 24 LTS (required by Claude Code CLI)
#   - git (repo operations)
#   - build-essential (native compilation for some repos)
#   - curl (downloads)
RUN apt-get update && \
    # Patch any base-image CVEs that have a fix available in the
    # current Debian point release. Without this, transitive system-
    # library CVEs (e.g. libnghttp2 CVE-2026-27135) ride the base
    # ``python:3.13-slim`` tag until upstream rebuilds, which can be
    # weeks. ``--no-install-recommends`` keeps the upgrade narrow and
    # reproducible — only already-installed packages get bumped.
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends \
        curl \
        git \
        build-essential \
        ca-certificates \
        gnupg && \
    # Cleanup early to keep peak disk usage low during builds.
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Node.js 24 LTS (https://nodejs.org/en/about/previous-releases)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Enable Corepack so ``yarn`` / ``pnpm`` resolve out of the box. Many target
# repos (including ABCA itself) drive installs with ``yarn install`` via their
# build command; without this, ``yarn`` is "command not found" (exit 127) and
# the build-verification GATE runs inert — a green build is reported for a repo
# we never actually built (live-caught 2026-06-29 dogfooding ABCA-on-ABCA: the
# agent had to hand-build a ``~/bin/yarn`` shim every run). Corepack ships with
# Node 24; ``enable`` installs the yarn/pnpm shims onto PATH.
RUN corepack enable && corepack prepare yarn@stable --activate || corepack enable

# Install Claude Code CLI (the Python SDK requires this binary)
# Then update known vulnerable transitive packages where fixed versions exist.
# Pinned 2.1.191 to match the CLI bundled by claude-agent-sdk 0.2.110 (see
# agent/pyproject.toml) — the SDK and the on-PATH CLI must agree on the control
# protocol. This version also has the awsCredentialExport behavior #215 needs:
# returned creds are cached until 5 min before the JSON's `Expiration`, so an
# 8 h task re-assumes the 1 h-capped SessionRole before expiry. Older builds
# only refreshed hourly on a timer, racing the role-chaining cap.
RUN npm install -g npm@latest && \
    npm install -g @anthropic-ai/claude-code@2.1.191 && \
    CLAUDE_NPM_ROOT="$(npm root -g)/@anthropic-ai/claude-code" && \
    npm --prefix "${CLAUDE_NPM_ROOT}" update tar minimatch glob cross-spawn picomatch

# Install uv (fast Python package manager) — pinned for reproducibility
COPY --from=ghcr.io/astral-sh/uv:0.11.14 /uv /usr/local/bin/uv

# Install Python dependencies via uv. Build context is repo root (set in
# ``cdk/src/stacks/agent.ts``) so source paths are prefixed with ``agent/``.
COPY agent/pyproject.toml agent/uv.lock /app/
RUN uv sync --frozen --no-dev --directory /app

# Copy agent code (ARG busts cache so file edits are always picked up)
ARG CACHE_BUST=0
COPY agent/src/ /app/src/
# Cedar HITL built-in policy files (hard_deny.cedar + soft_deny.cedar).
# ``agent/src/policy.py::_POLICIES_DIR`` resolves to ``/app/policies``
# at import time; without these files the PolicyEngine init raises
# ``missing built-in hard-deny policies`` and every task fails at 0
# turns before the agent even connects to the CLI. Discovered during
# Chunk 10 E2E T2.2 — the Dockerfile previously only copied ``src/``.
COPY agent/policies/ /app/policies/
# Cross-language constants (S9). ``agent/src/policy.py`` reads
# ``/app/contracts/constants.json`` at import; the same file is consumed
# by ``cdk/src/handlers/shared/types.ts`` at synth time. See
# ``contracts/README.md`` for the contract.
COPY contracts/ /app/contracts/
# First-party workflow files (#248). ``agent/src/workflow/loader.py`` resolves
# ``_WORKFLOWS_ROOT`` to ``/app/workflows`` (parents[2] of /app/src/workflow/)
# and loads ``<domain>/<name>-vN.yaml`` plus ``schema/workflow.schema.json`` at
# task time; without these files every workflow load fails with
# ``WorkflowValidationError: workflow '...' not found at /app/workflows/...``.
COPY agent/workflows/ /app/workflows/
COPY agent/prepare-commit-msg.sh /app/
# Claude Code managed settings (#215). The highest-precedence settings layer —
# loaded regardless of setting_sources and unoverridable by the untrusted cloned
# repo's project .claude/settings.json. Carries awsCredentialExport so Bedrock
# calls use session-tagged, refreshable credentials for cost attribution.
# Placing awsCredentialExport (an arbitrary command) anywhere the target repo
# can influence would be RCE with the compute role, so it lives ONLY here.
COPY agent/managed-settings.json /etc/claude-code/managed-settings.json

# Create non-root user (Claude Code CLI refuses bypassPermissions as root)
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /workspace && \
    chown agent:agent /workspace /app

USER agent
ENV PATH="/app/.venv/bin:/home/agent/.local/share/mise/shims:/home/agent/.local/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    MISE_YES=1

WORKDIR /workspace

EXPOSE 8080

CMD ["opentelemetry-instrument", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app/src", "--loop", "asyncio"]
