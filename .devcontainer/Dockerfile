FROM jdxcode/mise:2026.10.25@sha256:91417f41840316b7c5da6854bef393eccea4546ae70f8baf0803e0e94287b68d AS mise
FROM mcr.microsoft.com/devcontainers/base:bookworm@sha256:85a349062e4ccc4755304f1264183e604391697608765e72765340b7cb7e2438

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential gnupg python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

USER vscode
# Match the OAuth callback listener to Node clients on IPv4-only Docker networks.
ENV NODE_OPTIONS=--dns-result-order=ipv4first \
    PATH="/home/vscode/.local/share/mise/shims:${PATH}" \
    COREPACK_ENABLE_AUTO_PIN=0
