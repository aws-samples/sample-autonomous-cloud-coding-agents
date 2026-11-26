ARG TARGETPLATFORM=linux/arm64
ARG GH_VERSION=2.103.3
ARG GH_SHA256_AMD64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_SHA256_ARM64=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63

FROM --platform=$TARGETPLATFORM jdxcode/mise:2026.11.6@sha256:d4de1845114f6d73e90e15f7642885f74f3ca93074491038a2b9c43e4b897f21 AS mise

FROM --platform=$TARGETPLATFORM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends \
        curl \
        git \
        build-essential \
        ca-certificates \
        gnupg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# A build of gh from source needs proxy.golang.org: github.com/microsoft/dev-tunnels
# v0.2.0 has no Go tags left, and many corporate networks block the proxy (#1077).
ARG GH_VERSION
ARG GH_SHA256_AMD64
ARG GH_SHA256_ARM64
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-arm64}" in \
        amd64) arch=amd64; sum="${GH_SHA256_AMD64}" ;; \
        arm64) arch=arm64; sum="${GH_SHA256_ARM64}" ;; \
        *) echo "no pinned gh checksum for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLo "/tmp/${archive}" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}"; \
    echo "${sum}  /tmp/${archive}" | sha256sum -c -; \
    tar -xzf "/tmp/${archive}" -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf "/tmp/${archive}" "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
    gh --version

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN corepack enable && corepack prepare yarn@stable --activate || corepack enable

# pip of the base image (26.2.2) vendors urllib3 2.7.0 and msgpack 1.1.2, which
# the image scan reports as HIGH (CVE-2026-97687, CVE-2026-97689,
# CVE-2026-114613, GHSA-6v7p-g79w-8964); pip 26.3 vendors the fixed releases.
RUN python -m pip install --no-cache-dir --root-user-action=ignore pip==26.3

# claude-code@2.1.x ships an error-shim at bin/claude.exe that its postinstall
# (install.cjs) replaces with the platform-native ELF binary. That postinstall
# can silently fall back (leaving the shim in place) — the shim then dies at
# runtime with "Exec format error: 'claude'" even though the native binary is
# present as an optional dep, just never wired up.
RUN npm install -g npm@latest && \
    npm install -g @anthropic-ai/claude-code@2.1.319 && \
    CLAUDE_NPM_ROOT="$(npm root -g)/@anthropic-ai/claude-code" && \
    npm --prefix "${CLAUDE_NPM_ROOT}" update tar minimatch glob cross-spawn picomatch && \
    node "${CLAUDE_NPM_ROOT}/install.cjs" && \
    claude --version

COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /usr/local/bin/uv

COPY agent/pyproject.toml agent/uv.lock /app/
RUN uv sync --frozen --no-dev --directory /app

ARG CACHE_BUST=0
COPY agent/src/ /app/src/
COPY agent/policies/ /app/policies/
COPY contracts/ /app/contracts/
COPY agent/workflows/ /app/workflows/
COPY agent/prepare-commit-msg.sh /app/
# Claude Code managed settings (#215). The highest-precedence settings layer —
# loaded regardless of setting_sources and unoverridable by the untrusted cloned
# repo's project .claude/settings.json.
COPY agent/managed-settings.json /etc/claude-code/managed-settings.json

# Claude Code CLI refuses bypassPermissions as root.
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /workspace && \
    chown agent:agent /workspace /app

USER agent
ENV PATH="/app/.venv/bin:/home/agent/.local/share/mise/shims:/home/agent/.local/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    MISE_YES=1

# The server starts under `opentelemetry-instrument` (CMD below), which loads every
# installed OpenTelemetry instrumentation. Those of `requests` and `urllib3` copy
# the trace context and the baggage into the headers of every request they send,
# also to hosts outside the platform. The AWS distro switches the two off only in
# its agent observability mode (AGENT_OBSERVABILITY_ENABLED=true), and an explicit
# value replaces the list the distro applies in that mode.
ENV OTEL_PYTHON_DISABLED_INSTRUMENTATIONS="http,sqlalchemy,psycopg2,pymysql,sqlite3,aiopg,asyncpg,mysql_connector,urllib3,requests,system_metrics,google-genai,jinja2"

WORKDIR /workspace

EXPOSE 8080

CMD ["opentelemetry-instrument", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/app/src", "--loop", "asyncio"]
