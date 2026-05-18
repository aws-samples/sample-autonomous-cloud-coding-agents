ARG TARGETPLATFORM=linux/arm64
ARG GH_VERSION=2.92.0

FROM --platform=$TARGETPLATFORM jdxcode/mise:latest AS mise

# Build gh with a patched Go toolchain; upstream packages can lag Go CVE fixes.
FROM --platform=$TARGETPLATFORM golang:1.26.3-bookworm AS gh-builder
ARG GH_VERSION
RUN GOPROXY=direct GOBIN=/out go install "github.com/cli/cli/v2/cmd/gh@v${GH_VERSION}"

FROM --platform=$TARGETPLATFORM python:3.13-slim

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

# Install Claude Code CLI (the Python SDK requires this binary)
# Then update known vulnerable transitive packages where fixed versions exist.
RUN npm install -g npm@latest && \
    npm install -g @anthropic-ai/claude-code@2.1.142 && \
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
COPY agent/prepare-commit-msg.sh /app/
COPY agent/test_sdk_smoke.py agent/test_subprocess_threading.py /app/

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
