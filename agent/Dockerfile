ARG TARGETPLATFORM=linux/arm64

FROM --platform=$TARGETPLATFORM jdxcode/mise:latest AS mise

FROM --platform=$TARGETPLATFORM python:3.13-slim

# Install mise (polyglot dev tool manager)
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

# Install system dependencies in a single layer:
#   - Node.js 20 (required by Claude Code CLI)
#   - git (repo operations)
#   - gh (GitHub CLI for PR creation)
#   - build-essential (native compilation for some repos)
#   - curl (downloads)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        git \
        build-essential \
        ca-certificates \
        gnupg && \
    # Node.js 20
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    # GitHub CLI
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    # Cleanup
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (the Python SDK requires this binary)
# Then update known vulnerable transitive packages where fixed versions exist.
RUN npm install -g npm@latest && \
    npm install -g @anthropic-ai/claude-code@2.1.87 && \
    CLAUDE_NPM_ROOT="$(npm root -g)/@anthropic-ai/claude-code" && \
    npm --prefix "${CLAUDE_NPM_ROOT}" update tar minimatch glob cross-spawn picomatch

# Install uv (fast Python package manager)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

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
