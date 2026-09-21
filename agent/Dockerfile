ARG TARGETPLATFORM=linux/arm64
# ``gh`` is compiled from source below (``go install …@vX``), so its vendored module
# set is whatever this tag pins — there is no separate dep file to patch, and a
# version bump is the only lever. 2.101.0 clears the nine fixable HIGH/CRITICAL
# findings #897 recorded against 2.93.0: sigstore/rekor 1.5.3 (CVE-2026-48702),
# x/crypto 0.57.0, x/mod 0.41.0, x/net 0.58.0, x/text 0.42.0, grpc 1.83.2. Its
# ``go 1.27.0`` directive is satisfied by the pinned golang:1.27.1 builder below.
# When bumping, confirm by re-scanning the built image, not by reading a changelog.
ARG GH_VERSION=2.101.0

# Every external image is pinned by DIGEST, not by tag.
#
# A tag is a moving pointer. When one moves, the layer that copies from it changes,
# and so does every layer built after it — here that is the ~400 MB apt install, the
# node install, and the dependency sync. The image is then rebuilt and re-pushed in
# full for a commit that touched only, say, a doc. That is slow everywhere and
# painful on a modest uplink, and it also means two builds of the same commit can
# produce different images, which is the more serious half of the problem.
#
# `mise:latest` was the worst case: a tag with no version at all, republished
# whenever upstream feels like it. Pinning is what makes a rebuild depend on OUR
# changes rather than on upstream's release schedule.
#
# Each digest is a multi-platform index, so `--platform=$TARGETPLATFORM` still
# selects the right architecture — verified to include linux/arm64.
#
# To bump: `docker buildx imagetools inspect <image>:<tag>` and copy the Digest.
# Keep the tag alongside the digest; it documents what the digest is meant to be.
FROM --platform=$TARGETPLATFORM jdxcode/mise:latest@sha256:df5adf538c92d86f9807e738c7c7a9b32a1ae06edf441ede141333e3fe6a2cd9 AS mise

# Build gh with a patched Go toolchain; upstream packages can lag Go CVE fixes.
FROM --platform=$TARGETPLATFORM golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b AS gh-builder
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
# claude-code@2.1.x ships an error-shim at bin/claude.exe that its postinstall
# (install.cjs) replaces with the platform-native ELF binary. That postinstall
# can silently fall back (leaving the shim in place) — the shim then dies at
# runtime with "Exec format error: 'claude'" even though the native binary is
# present as an optional dep, just never wired up. Re-run install.cjs explicitly
# after the install so the native binary is placed at build time, and hard-verify
# it exec's (``claude --version`` fails the build if the shim is still on PATH).
RUN npm install -g npm@latest && \
    npm install -g @anthropic-ai/claude-code@2.1.191 && \
    CLAUDE_NPM_ROOT="$(npm root -g)/@anthropic-ai/claude-code" && \
    npm --prefix "${CLAUDE_NPM_ROOT}" update tar minimatch glob cross-spawn picomatch && \
    node "${CLAUDE_NPM_ROOT}/install.cjs" && \
    claude --version

# Patch npm's OWN bundled dependencies (#897).
#
# ``npm install -g npm@latest`` above does not fix these. npm 12.0.2 — the current
# latest — still ships brace-expansion 5.0.7 (CVE-2026-14257, CVE-2026-69152),
# ip-address 10.2.0 (CVE-2026-69192) and tar 7.5.19 (CVE-2026-73566), each with a
# published fix. So ``npm@latest`` is not a security control here; it was measured,
# not assumed.
#
# The approach used just above for the claude-code tree (``npm --prefix <tree>
# update …``) CANNOT be reused here. npm's published package.json declares
# ``@npmcli/docs@^1.0.0``, a workspace-internal package that is not on the
# registry, and Arborist resolves the whole declared graph before touching
# anything — so every npm-native operation inside npm's own tree dies with E404
# (verified for ``update``, ``update --omit=dev`` and ``install --no-save``).
# npm's bundled node_modules is a build artifact, not an installable project.
#
# Hence a direct tarball overlay. ``npm pack`` fetches through the registry's
# integrity check, and each package is pure JS at a patch/minor bump, so the new
# file set supersedes what it replaces.
#
# The pinned version is a FLOOR, not an assignment: ``npm@latest`` floats, so a
# later npm could bundle something newer, and overwriting blindly would silently
# walk it backwards. npm's own bundled ``semver`` does the comparison and the
# overlay is skipped when the shipped version already satisfies the floor.
#
# Both failure modes are hard-verified rather than left to degrade into a no-op:
# a package missing from the tree fails the build (the layout is npm's internal
# detail and may change), and the post-overlay version is asserted.
RUN NPM_TREE="$(npm root -g)/npm" && \
    SEMVER="${NPM_TREE}/node_modules/semver" && \
    mkdir -p /var/tmp/npm-cve && cd /var/tmp/npm-cve && \
    for pv in brace-expansion:5.0.9 ip-address:10.3.1 tar:7.5.21; do \
        name="${pv%:*}"; floor="${pv#*:}"; \
        pkg="${NPM_TREE}/node_modules/${name}/package.json"; \
        [ -f "${pkg}" ] || { echo "FATAL: ${name} absent from npm's bundled tree; layout changed, re-check #897"; exit 1; }; \
        cur="$(node -p "require('${pkg}').version")"; \
        if node -e "process.exit(require('${SEMVER}').gte('${cur}','${floor}')?0:1)"; then \
            echo "npm bundled dep ${name} ${cur} already satisfies floor ${floor}; left alone"; \
        else \
            tarball="$(npm pack "${name}@${floor}" --silent)"; \
            for dir in $(find "${NPM_TREE}/node_modules" -type d -name "${name}"); do \
                tar -xzf "/var/tmp/npm-cve/${tarball}" -C "${dir}" --strip-components=1; \
            done; \
            got="$(node -p "require('${pkg}').version")"; \
            [ "${got}" = "${floor}" ] || { echo "FATAL: ${name} is ${got} after overlay, expected ${floor}"; exit 1; }; \
            echo "npm bundled dep ${name} ${cur} -> ${got}"; \
        fi; \
    done && \
    cd / && rm -rf /var/tmp/npm-cve && \
    npm --version

# Install uv (fast Python package manager) — pinned by digest, not just version:
# a published tag can be re-pushed, and this COPY sits above the dependency sync,
# so a silent move here invalidates it. See the digest note at the top of the file.
# 0.12.17 vendors quinn-proto 0.11.18, clearing GHSA-4w2j-m93h-cj5j (#897). Read that
# advisory carefully: its "fixed in 0.11.15" is *quinn-proto's* version, not uv's —
# uv 0.11.14 happens to vendor quinn-proto 0.11.14, which makes the two look like one
# number. The floor is therefore a uv release that vendors ≥ 0.11.15, not uv 0.11.15.
COPY --from=ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc /uv /usr/local/bin/uv

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
