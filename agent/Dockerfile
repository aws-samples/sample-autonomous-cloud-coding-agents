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
    apt-get install -y --no-install-recommends \
        curl \
        git \
        build-essential \
        ca-certificates \
        gnupg && \
    # Upgrade base image's CVE-2026-27135 vulnerability
    apt-get upgrade -y --no-install-recommends libnghttp2-14 && \
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

# Install Python dependencies via uv
COPY pyproject.toml uv.lock /app/
RUN uv sync --frozen --no-dev --directory /app

# Copy agent code (ARG busts cache so file edits are always picked up)
ARG CACHE_BUST=0
COPY src/ /app/src/
COPY prepare-commit-msg.sh /app/
COPY test_sdk_smoke.py test_subprocess_threading.py /app/

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
