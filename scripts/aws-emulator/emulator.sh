#!/usr/bin/env bash
# AWS Emulator lifecycle and guarded command runner for the local/CI integration tier
# (ADR-013 Tier 2a). Driven by the mise tasks emulator:up, emulator:down, emulator:run and
# test:integration. `mise run build` never runs this script, only the unit tests of the other guard files.
#
#   emulator.sh up              build the pinned image if missing, start a FRESH emulator, wait for health
#   emulator.sh down            stop it (all emulated state is in memory, so this is also "reset")
#   emulator.sh run <cmd...>    run <cmd> with the AWS environment replaced by the emulator's
#
# `run` is for programs that use an AWS SDK. Do not use it with AWS CLI v1: that CLI forces a real
# AWS endpoint for sqs, rds, docdb, neptune and health whatever AWS_ENDPOINT_URL says.
#
# Needs a container engine (see CDK_DOCKER below) and curl, which the health check uses.
#
# Environment:
#   ABCA_EMULATOR_PORT   port on 127.0.0.1. Default: derived from the checkout path, so two worktrees
#                        can run the tier at the same time without stopping each other's emulator.
#   ABCA_EMULATOR_HOME   where the emulator keeps its per-run credentials and certificate. Default is
#                        under the user cache directory. It is deliberately OUTSIDE the repository: the
#                        agent image asset fingerprints the repository root, and these files change on
#                        every start.
#   ABCA_EMULATOR_VERSION  try another emulator release for this invocation only (default: the pin).
#   CDK_DOCKER           container engine (default docker), same convention as cdk/mise.toml.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
ENGINE=${CDK_DOCKER:-docker}

# The single version pin lives in the Dockerfile (ARG AWS_EMULATOR_VERSION=...).
# ABCA_EMULATOR_VERSION overrides it for one invocation, which is how a newer upstream release is
# tried before the pin is moved: ABCA_EMULATOR_VERSION=<new> mise run test:integration
VERSION=${ABCA_EMULATOR_VERSION:-$(sed -n 's/^ARG AWS_EMULATOR_VERSION=//p' "$HERE/Dockerfile")}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "emulator: bad or missing emulator version '$VERSION' (pin: $HERE/Dockerfile)" >&2; exit 1; }

derive_port() { echo $((20000 + $(printf '%s' "$ROOT" | cksum | cut -d' ' -f1) % 10000)); }
PORT=${ABCA_EMULATOR_PORT:-$(derive_port)}
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "emulator: ABCA_EMULATOR_PORT must be a number (got '$PORT')" >&2; exit 1; }

STATE=${ABCA_EMULATOR_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/abca-aws-emulator}
FILES=$STATE/.aws/emulator/$PORT
# The tag carries the Dockerfile's checksum as well as the version, so a change to the Dockerfile
# that keeps the version (a base-image bump, the key fingerprint) is built, not silently skipped.
IMAGE=abca-aws-emulator:$VERSION-$(cksum < "$HERE/Dockerfile" | cut -d' ' -f1)
NAME=abca-aws-emulator-$PORT
ENDPOINT=https://127.0.0.1:$PORT

# --noproxy: a proxy configured in the shell must not be asked for a loopback address.
healthy() { curl -sf --max-time 2 --noproxy '*' --cacert "$FILES/ca.pem" "$ENDPOINT/__admin/health" >/dev/null 2>&1; }

up() {
  # Listed, not inspected: while Docker Desktop's engine sleeps (Resource Saver) it answers
  # `image inspect` with "No such image", which would re-run the build after every pause.
  if [ -z "$("$ENGINE" images -q "$IMAGE" 2>/dev/null)" ]; then
    echo "emulator: building $IMAGE (once per version; downloads and verifies the signed package)"
    # Dockerfile on stdin: no build context is sent.
    "$ENGINE" build --build-arg AWS_EMULATOR_VERSION="$VERSION" -t "$IMAGE" - < "$HERE/Dockerfile"
  fi
  # Pre-create the shared directory; otherwise Docker on Linux creates it root-owned and the emulator,
  # which runs as the caller, cannot write its files there.
  mkdir -p "$STATE/.aws/emulator"
  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  # On Linux the files must belong to the caller; Docker Desktop (macOS) maps ownership itself.
  local user=()
  if [ "$(uname -s)" = Linux ]; then user=(--user "$(id -u):$(id -g)"); fi
  # -e HOME makes the emulator write the same paths inside the container as on the host.
  # 127.0.0.1 on the publish side keeps the emulator off the host's network interfaces (it binds
  # 0.0.0.0 in the container). Other containers on the same engine can still reach it.
  # ${user[@]+...}: an empty array is "unbound" under `set -u` on the bash 3.2 that macOS ships.
  "$ENGINE" run -d --name "$NAME" ${user[@]+"${user[@]}"} --memory=2g --memory-swap=2g \
    -p "127.0.0.1:$PORT:$PORT" -e HOME="$STATE" \
    -v "$STATE/.aws/emulator:$STATE/.aws/emulator" \
    "$IMAGE" -p "$PORT" --idle-timeout 3600 >/dev/null
  for _ in $(seq 120); do
    if healthy; then echo "emulator: $VERSION ready on $ENDPOINT"; return 0; fi
    sleep 0.25
  done
  echo "emulator: did not become healthy on $ENDPOINT" >&2
  "$ENGINE" logs "$NAME" 2>&1 | tail -20 >&2
  exit 1
}

down() {
  # SIGTERM first so the emulator deletes its credentials and certificate; then remove the container.
  "$ENGINE" stop -t 5 "$NAME" >/dev/null 2>&1 || true
  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  echo "emulator: stopped ($NAME)"
}

# Replace the AWS environment of this shell with the emulator's. EVERY AWS_* variable goes, not a
# hand-picked list: that also covers AWS_ENDPOINT_URL_<SERVICE>, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS,
# AWS_ROLE_ARN / AWS_WEB_IDENTITY_TOKEN_FILE and the container-credential variables an agent runtime
# sets. Everything outside that namespace is inherited, apart from the tokens removed below.
emulator_env() {
  local name
  while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep -E '^AWS_' || true)
  # Real credentials for other services have no business in a run that only talks to loopback.
  unset GITHUB_TOKEN GH_TOKEN BGAGENT_API_KEY
  export AWS_ENDPOINT_URL=$ENDPOINT
  export AWS_SHARED_CREDENTIALS_FILE=$FILES/emulator_credentials
  export AWS_CONFIG_FILE=$FILES/config
  export AWS_CA_BUNDLE=$FILES/ca.pem
  export NODE_EXTRA_CA_CERTS=$FILES/ca.pem
  export AWS_EC2_METADATA_DISABLED=true
  export AWS_DISABLE_HOST_PREFIX_INJECTION=true
  export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
  # A proxy configured in the shell must not be asked for a loopback address.
  export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
  export no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"
  # Not an AWS variable, but the same hazard: without this the CLI reads ~/.bgagent, which holds
  # the API URL and tokens of the developer's REAL deployment.
  export BGAGENT_CONFIG_DIR=$STATE/bgagent
  # The variables above only say where AWS SDK calls go. This makes every Node process started
  # from here refuse any connection that would leave the machine (see loopback-only.cjs); the
  # Python suite installs the same rule itself (agent/tests_emulator/conftest.py).
  export NODE_OPTIONS="--require \"$HERE/loopback-only.cjs\"${NODE_OPTIONS:+ $NODE_OPTIONS}"
}

# Refuse to run anything unless an emulator started by `up` is answering on this port.
guard() {
  { [ -r "$AWS_SHARED_CREDENTIALS_FILE" ] && healthy; } \
    || { echo "emulator: refusing to run: no healthy emulator on $ENDPOINT (run: mise run emulator:up)" >&2; exit 1; }
}

# Without curl the health check fails silently and a running emulator is reported as unhealthy.
need_curl() {
  command -v curl >/dev/null || { echo "emulator: curl is required (the health check uses it)" >&2; exit 1; }
}

case "${1:-}" in
  up) need_curl; up ;;
  down) down ;;
  run)
    shift
    [ $# -gt 0 ] || { echo "usage: emulator.sh run <command...>" >&2; exit 2; }
    need_curl
    emulator_env
    guard
    exec "$@"
    ;;
  *) echo "usage: emulator.sh up | down | run <command...>" >&2; exit 2 ;;
esac
