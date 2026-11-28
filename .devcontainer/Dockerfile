# On a mise release bump, update the image digest and the CI version pins together.
FROM jdxcode/mise:2026.11.11@sha256:14a30b9945ea5c2fbae70d8b6be8f2c8b2456698f2a258f3f6315f7784c84676 AS mise
FROM mcr.microsoft.com/devcontainers/base:bookworm@sha256:06701e75787b0b948709e803f95b42cabf37607b1c308c57471d6f0252149d87

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential gnupg python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

USER vscode
# Match the OAuth callback listener to Node clients on IPv4-only Docker networks.
ENV NODE_OPTIONS=--dns-result-order=ipv4first \
    PATH="/home/vscode/.local/share/mise/shims:${PATH}" \
    COREPACK_ENABLE_AUTO_PIN=0
