#!/usr/bin/env bash
# abca-onboard.sh — guided onboarding for ABCA (aws-samples/sample-autonomous-cloud-coding-agents) on macOS.
#
# Usage:
#   ./abca-onboard.sh                 # full guided install (deps → build → optional AWS deploy → smoke test)
#   ./abca-onboard.sh --no-aws        # dependency checks + install + compile only; never touches AWS
#   ./abca-onboard.sh --dry-run       # run read-only checks, print every changing command instead of running it
#   ./abca-onboard.sh --teardown      # destroy a deployed stack (with confirmation)
#
# Options:
#   --dir PATH          checkout location (default: the ABCA checkout you run this from, else
#                       a new clone in ~/abca/sample-autonomous-cloud-coding-agents)
#   --profile NAME      AWS profile to use (default: ask — pick a profile or add a new account)
#   --region REGION     AWS Region (default: ask, suggesting us-east-1)
#   --stack-name NAME   CloudFormation stack name (default: backgroundagent-dev)
#   --repo OWNER/REPO   GitHub repo the agent may work on (default: ask; suggests a fork of awslabs/agent-plugins)
#   --email EMAIL       Cognito user to create for yourself (default: ask)
#   --container-engine finch|docker   builds the agent image (default: Finch if installed, else Docker)
#   --no-console        skip the operator web console stack (<stack-name>-console)
#   --yes               answer routine questions with their default so a re-run needs no typing (also
#                       ABCA_AUTO_YES=1). Still asks: warnings that something is wrong, a deploy to an
#                       account other than the last one, and anything with no remembered answer.
#                       Skips the smoke test. Every automatic answer is printed.
#   --local-dev         also allow console sign-in from a local dev server (http://localhost:5173,
#                       for `mise //web:dev:live`); remembered until --no-local-dev
#   --verbose           stream every step's full output live (and answer any prompt yourself)
#
# Safe to re-run: every step checks current state first, and your answers (profile, Region, repo, email) are
# remembered in ~/.abca-onboard/settings so a re-run only asks you to confirm them.
# Secrets are never printed or written by this script;
# the GitHub token is entered into the ABCA CLI's own prompt and stored in AWS Secrets Manager.
# Requires the macOS default bash (3.2) or newer.

set -euo pipefail

REPO_URL="https://github.com/aws-samples/sample-autonomous-cloud-coding-agents.git"
SAMPLE_REPO="awslabs/agent-plugins"
MIN_FREE_GB=25          # matches the threshold used by the repo's cdk clean:disk task
IDLE_COST="~\$140-150/month"

DIR=""                  # --dir; empty = current ABCA checkout, else DEFAULT_DIR
DEFAULT_DIR="$HOME/abca/sample-autonomous-cloud-coding-agents"
PROFILE=""
REGION=""
STACK_NAME="backgroundagent-dev"
TARGET_REPO=""
EMAIL=""
CONTAINER_ENGINE=""     # finch | docker; empty = auto-detect
VERBOSE=0
DRY_RUN=0
NO_AWS=0
TEARDOWN=0
CONSOLE=1               # --no-console; deploys the operator web console as <stack>-console
LOCAL_DEV=""            # --local-dev / --no-local-dev; empty = as last time (default off)
AUTO_YES="${ABCA_AUTO_YES:-0}"  # --yes

STATE_DIR="$HOME/.abca-onboard"
LOG_DIR="$STATE_DIR/logs"
SETTINGS_FILE="$STATE_DIR/settings"
PROGRESS_FILE="$STATE_DIR/progress"   # lines: step|code-fingerprint|epoch
SAVED_PROFILE=""; SAVED_REGION=""; SAVED_DEPLOY_DIR=""; SAVED_ACCOUNT_ID=""
RUN_ID="$(date +%Y%m%d-%H%M%S)"

# ---------- output helpers ----------
if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; R=""; G=""; Y=""; C=""; N=""
fi
step()  { printf '\n%s==> %s%s\n' "$B$C" "$*" "$N"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
fail()  { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
die()   { printf '\n%sERROR:%s %s\n' "$R$B" "$N" "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# action "Title" "step 1" "step 2" ... → a highlighted, numbered block for things only YOU can do.
# Lines starting with "$ " are commands to copy; they are shown indented and bold.
action() {
  local title="$1" i=1 line; shift
  printf '\n  %s┏━━ ACTION NEEDED: %s%s\n' "$Y$B" "$title" "$N"
  for line in "$@"; do
    case "$line" in
      '$ '*) printf '  %s┃%s        %s%s%s\n' "$Y" "$N" "$B" "${line#\$ }" "$N" ;;
      *)     printf '  %s┃%s  %s%d.%s %s\n' "$Y" "$N" "$B" "$i" "$N" "$line"; i=$((i + 1)) ;;
    esac
  done
  printf '  %s┗━━%s\n' "$Y" "$N"
}

TODO_FILE=""  # filled in once LOG_DIR exists; one line per queued to-do
todo() { [ -n "$TODO_FILE" ] && printf '%s\n' "$*" >>"$TODO_FILE"; }

auto_answer() {  # auto_answer "question" "answer" → prints what --yes chose
  printf '  %s %s(--yes: %s)%s\n' "$1" "$C" "$2" "$N"
}

confirm() {  # confirm "question" → 0 if yes
  local ans
  [ "$AUTO_YES" = 1 ] && { auto_answer "$1" yes; return 0; }
  read -r -p "  $1 [y/N] " ans </dev/tty || return 1
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

confirm_no() {  # default-no question where "no" is harmless; --yes takes the default (no)
  [ "$AUTO_YES" = 1 ] && { auto_answer "$1" no; return 1; }
  confirm "$@"
}

# A question asked because something is WRONG ("continue anyway?"). Never auto-answered.
confirm_warning() {
  local ans
  read -r -p "  $1 [y/N] " ans </dev/tty || return 1
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

confirm_yes() {  # like confirm, but Enter means yes — only for non-billable, reversible choices
  local ans
  [ "$AUTO_YES" = 1 ] && { auto_answer "$1" yes; return 0; }
  read -r -p "  $1 [Y/n] " ans </dev/tty || return 1
  case "$ans" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

ask() {  # ask "prompt" default → echoes answer
  local ans
  # --yes keeps a remembered/suggested answer; with no default there is nothing to assume.
  if [ "$AUTO_YES" = 1 ] && [ -n "${2:-}" ]; then auto_answer "$1" "$2" >&2; printf '%s' "$2"; return; fi
  read -r -p "  $1${2:+ [$2]}: " ans </dev/tty || true
  printf '%s' "${ans:-$2}"
}

run() {  # run a state-changing command (printed instead under --dry-run)
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry-run]%s %s\n' "$Y" "$N" "$*"
    return 0
  fi
  "$@"
}

run_logged() {  # run_logged name cmd... → full output to a log file, short summary on screen
  local name="$1"; shift
  local log="$LOG_DIR/$RUN_ID-$name.log"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry-run]%s %s\n' "$Y" "$N" "$*"
    return 0
  fi
  printf '  running: %s\n  log: %s\n' "$*" "$log"
  local status=0 start=$SECONDS
  if [ "$VERBOSE" = 1 ]; then
    # Full output on screen (and in the log); prompts reach you. pipefail keeps the command's exit status.
    printf '  %s──── %s output ────%s\n' "$C" "$name" "$N"
    "$@" </dev/tty 2>&1 | tee "$log" || status=$?
    printf '  %s──── end of %s output ────%s\n' "$C" "$name" "$N"
  elif [ -t 1 ]; then
    printf '  %sTo watch the full output, open a new terminal tab and run:  tail -f "%s"%s\n' "$Y" "$log" "$N"
    _live_progress "$name" "$log" "$@" || status=$?
  else
    "$@" </dev/null >"$log" 2>&1 || status=$?
  fi
  if [ "$status" = 0 ]; then
    ok "$name succeeded ($(( SECONDS - start ))s)"
  else
    fail "$name failed (exit $status). Last 30 log lines:"
    tail -n 30 "$log" | sed 's/^/    /'
    # Hidden steps get no keyboard input, so a step that stops to ask something fails instead of hanging.
    # The installer never answers those questions for you.
    warn "If the log ends with a question, re-run with --verbose to see it and answer it yourself."
    die "$name failed — see $log"
  fi
}

_live_progress() {  # _live_progress name log cmd... → runs cmd, showing one self-updating status line
  local name="$1" log="$2"; shift 2
  local frames='|/-\' i=0 width line esc pid status=0
  esc="$(printf '\033')"
  width=$(( $(tput cols 2>/dev/null || echo 100) - ${#name} - 16 ))
  [ "$width" -gt 20 ] || width=20
  "$@" </dev/null >"$log" 2>&1 &
  pid=$!
  # Ctrl-C stops the step too, not just this script.
  trap 'kill "$pid" 2>/dev/null; printf "\r%s[K\n" "$esc"; exit 130' INT TERM
  while kill -0 "$pid" 2>/dev/null; do
    # Last output line, without colour codes or carriage-return progress noise, cut to fit.
    line="$(tail -n 1 "$log" 2>/dev/null | tr '\r' '\n' | tail -n 1 | sed "s/${esc}\[[0-9;]*[A-Za-z]//g" | cut -c1-"$width" || true)"
    printf '\r%s[K  %s%s%s %s %ss  %s' "$esc" "$C" "${frames:$i:1}" "$N" "$name" "$(( SECONDS - ${start:-$SECONDS} ))" "$line"
    i=$(( (i + 1) % 4 ))
    sleep 0.2
  done
  wait "$pid" || status=$?
  trap - INT TERM
  printf '\r%s[K' "$esc"
  return "$status"
}

# ---------- argument parsing ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        DIR="$2"; shift 2 ;;
    --profile)    PROFILE="$2"; shift 2 ;;
    --region)     REGION="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --repo)       TARGET_REPO="$2"; shift 2 ;;
    --email)      EMAIL="$2"; shift 2 ;;
    --container-engine) CONTAINER_ENGINE="$2"; shift 2 ;;
    --verbose)    VERBOSE=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --no-aws)     NO_AWS=1; shift ;;
    --teardown)   TEARDOWN=1; shift ;;
    --no-console) CONSOLE=0; shift ;;
    --local-dev)  LOCAL_DEV=1; shift ;;
    --no-local-dev) LOCAL_DEV=0; shift ;;
    --yes|-y)     AUTO_YES=1; shift ;;
    -h|--help)    sed -n '2,25p' "$0"; exit 0 ;;
    *)            die "unknown option: $1 (see --help)" ;;
  esac
done
mkdir -p "$LOG_DIR"
# Every cdk command selects all stacks (app + console) with the same context, so they always agree.
CDK_ARGS=(--all)
[ "$CONSOLE" = 1 ] && CDK_ARGS+=(-c operatorConsole=true)
CONSOLE_STACK="$STACK_NAME-console"
TODO_FILE="$LOG_DIR/$RUN_ID-todo.txt"

# Default --dir: the ABCA checkout this is run from (works in git worktrees too), else a fresh clone.
if [ -z "$DIR" ]; then
  _top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$_top" ] && [ -f "$_top/cdk/cdk.json" ] && [ -d "$_top/agent" ]; then
    DIR="$_top"
  else
    DIR="$DEFAULT_DIR"
  fi
  unset _top
fi

# ---------- remembered answers ----------
load_settings() {  # parsed, not sourced: only known keys are read
  [ -f "$SETTINGS_FILE" ] || return 0
  local key val
  while IFS='=' read -r key val; do
    case "$key" in
      PROFILE)     SAVED_PROFILE="$val" ;;
      REGION)      SAVED_REGION="$val" ;;
      TARGET_REPO) [ -n "$TARGET_REPO" ] || TARGET_REPO="$val" ;;
      EMAIL)       [ -n "$EMAIL" ] || EMAIL="$val" ;;
      LOCAL_DEV)   [ -n "$LOCAL_DEV" ] || LOCAL_DEV="$val" ;;
      LAST_DEPLOY_DIR) SAVED_DEPLOY_DIR="$val" ;;
      LAST_ACCOUNT_ID) SAVED_ACCOUNT_ID="$val" ;;
    esac
  done <"$SETTINGS_FILE"
}

save_settings() {
  [ "$DRY_RUN" = 1 ] && return 0
  (umask 077; printf 'PROFILE=%s\nREGION=%s\nTARGET_REPO=%s\nEMAIL=%s\nLOCAL_DEV=%s\nLAST_DEPLOY_DIR=%s\nLAST_ACCOUNT_ID=%s\n' \
    "$PROFILE" "$REGION" "$TARGET_REPO" "$EMAIL" "$LOCAL_DEV" "$SAVED_DEPLOY_DIR" "$SAVED_ACCOUNT_ID" >"$SETTINGS_FILE")
}
load_settings

# ---------- resume: skip slow steps that already succeeded for exactly this code ----------
code_fingerprint() {  # commit + every local change (tracked and untracked); run inside the checkout
  { git rev-parse HEAD; git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null; } \
    | shasum -a 256 | cut -c1-16
}

step_fingerprint() {  # step_fingerprint [EXTRA] → code fingerprint, plus settings that change the step's result
  if [ -z "${1:-}" ]; then code_fingerprint; else printf '%s|%s' "$(code_fingerprint)" "$1" | shasum -a 256 | cut -c1-16; fi
}

resume_step() {  # resume_step NAME [EXTRA] → 0 (skip it) if NAME succeeded for this exact code (and EXTRA) and you agree
  [ "$DRY_RUN" = 1 ] && return 1
  local line when
  line="$(grep "^$1|$(step_fingerprint "${2:-}")|" "$PROGRESS_FILE" 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  when="$(date -r "${line##*|}" '+%Y-%m-%d %H:%M' 2>/dev/null || echo 'an earlier run')"
  confirm_yes "'$1' already succeeded for this exact code ($when). Skip it?"
}

mark_done() {  # mark_done NAME [EXTRA] → remember that NAME succeeded for the current code (and EXTRA)
  [ "$DRY_RUN" = 1 ] && return 0
  local fp; fp="$(step_fingerprint "${2:-}")"
  { grep -v "^$1|" "$PROGRESS_FILE" 2>/dev/null || true; printf '%s|%s|%s\n' "$1" "$fp" "$(date +%s)"; } >"$PROGRESS_FILE.tmp"
  mv "$PROGRESS_FILE.tmp" "$PROGRESS_FILE"
}

# ---------- 1. dependency checks ----------
check_platform() {
  step "Platform"
  [ "$(uname -s)" = "Darwin" ] || die "this script targets macOS (found $(uname -s))"
  ARCH="$(uname -m)"
  ok "macOS $(sw_vers -productVersion) on $ARCH"
}

ensure_brew() {
  if have brew; then ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"; return; fi
  warn "Homebrew not found (needed to install missing tools)"
  confirm "Install Homebrew from https://brew.sh ?" || die "Homebrew is required to install missing tools"
  run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
}

ensure_tool() {  # ensure_tool command brew-formula [--cask]
  local cmd="$1" formula="$2" cask="${3:-}"
  if have "$cmd"; then ok "$cmd found"; return; fi
  warn "$cmd not found"
  if confirm "Install $formula with Homebrew?"; then
    run brew install $cask "$formula"
  else
    die "$cmd is required"
  fi
}

# ---------- container engine ----------
# CDK builds the agent image locally with whatever Docker-compatible CLI $CDK_DOCKER names.
# Finch (Apache-2.0, from AWS) is preferred when installed: no licence or sign-in requirements.
finch_bin() {  # prints the Finch CLI path, if installed
  if [ -x /Applications/Finch/bin/finch ]; then printf '%s' /Applications/Finch/bin/finch
  elif have finch; then command -v finch
  fi
}

engine_usable() {  # `ps`, not `info`: a sign-in-enforced Docker Desktop answers `info` but refuses containers
  "$1" ps -q >/dev/null 2>&1
}

start_finch() {
  local finch="$1" status
  [ -n "$finch" ] || die "Finch is not installed. Install it with: brew install --cask finch"
  status="$("$finch" vm status 2>/dev/null | tail -n 1 || true)"
  case "$status" in
    Running) ;;
    Stopped) warn "Finch VM is stopped — starting it"; run "$finch" vm start ;;
    *)       warn "Finch VM does not exist yet — creating it (first run downloads the VM image, a few minutes)"
             run "$finch" vm init ;;
  esac
  if [ "$DRY_RUN" = 1 ] || engine_usable "$finch"; then
    ok "Finch ready ($finch)"
  else
    die "Finch is installed but cannot run containers. Try: $finch vm stop && $finch vm start"
  fi
}

start_docker() {
  if ! have docker && [ ! -d /Applications/Docker.app ]; then
    warn "Docker Desktop is not installed"
    confirm "Install Docker Desktop with Homebrew (brew install --cask docker)? Larger companies need a paid Docker subscription; Finch is a free alternative." \
      || die "a container engine is required. Install Finch instead with: brew install --cask finch"
    run brew install --cask docker
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon is not running — starting Docker Desktop"
    if [ "$DRY_RUN" = 1 ]; then
      printf '  %s[dry-run]%s open -a Docker (then wait up to 180s)\n' "$Y" "$N"
      return 0
    fi
    open -a Docker || die "could not start Docker Desktop; open it manually and re-run"
    local waited=0
    until docker info >/dev/null 2>&1; do
      [ "$waited" -ge 180 ] && die "Docker did not become ready within 180s. Open Docker Desktop, finish any first-run prompts, then re-run."
      sleep 5; waited=$((waited + 5)); printf '.'
    done
    printf '\n'
  fi
  if ! engine_usable docker; then
    fail "Docker is running but refuses to run containers: $(docker ps 2>&1 | tail -n 1)"
    [ -n "$(finch_bin)" ] && warn "Finch is installed: re-run with --container-engine finch"
    die "sign in to Docker Desktop (or use Finch), then re-run"
  fi
  ok "Docker ready ($(docker info --format '{{.ServerVersion}}' 2>/dev/null))"
}

check_container_engine() {
  step "Container engine (builds the agent image)"
  local engine="$CONTAINER_ENGINE" finch
  finch="$(finch_bin)"
  if [ -z "$engine" ]; then
    if [ -n "$finch" ]; then engine=finch
    elif have docker || [ -d /Applications/Docker.app ]; then engine=docker
    else
      warn "no container engine found (Finch or Docker)"
      confirm "Install Finch (free and open source, from AWS) with Homebrew (brew install --cask finch)?" \
        || die "a container engine is required to build the agent image"
      run brew install --cask finch
      finch="$(finch_bin)"; engine=finch
    fi
  fi
  case "$engine" in
    finch)  if [ "$DRY_RUN" = 1 ] && [ -z "$finch" ]; then finch=finch; fi
            start_finch "$finch"; CDK_DOCKER="$finch" ;;
    docker) start_docker; CDK_DOCKER=docker ;;
    *)      die "--container-engine must be 'finch' or 'docker' (got '$engine')" ;;
  esac
  # cdk deploy, and the repo's clean:disk task, read this to pick the engine.
  export CDK_DOCKER
  ok "CDK will build images with: $engine"

  # The agent image targets linux/arm64 (AgentCore runs on Graviton).
  if [ "$ARCH" = "arm64" ]; then
    ok "Apple Silicon: linux/arm64 images build natively"
  elif [ "$engine" = docker ] && docker buildx inspect --bootstrap 2>/dev/null | grep -q 'linux/arm64'; then
    warn "Intel Mac: arm64 emulation is available, but the image build will be slow"
  elif [ "$engine" = finch ]; then
    warn "Intel Mac: Finch builds linux/arm64 under emulation; the image build will be slow"
  else
    fail "Intel Mac without arm64 emulation: the agent image build will fail with 'exec format error'"
    warn "Fix: docker run --privileged --rm tonistiigi/binfmt --install arm64   (or use Finch, or build on Apple Silicon)"
    [ "$NO_AWS" = 1 ] || die "arm64 image builds are required to deploy"
  fi

  local free_gb
  free_gb="$(df -g / | awk 'NR==2 {print $4}')"
  if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
    warn "only ${free_gb}G free on / (recommend ≥${MIN_FREE_GB}G for the image build and CDK assets)"
    warn "the deploy task will prune container images and build cache when disk is low"
    confirm_warning "Continue anyway?" || die "free up disk space and re-run"
  else
    ok "${free_gb}G free disk"
  fi
}

check_deps() {
  check_platform
  step "Command-line tools"
  ensure_brew
  ensure_tool git git
  ensure_tool curl curl
  ensure_tool mise mise
  if [ "$NO_AWS" = 0 ]; then ensure_tool aws awscli; fi
  if have gh; then ok "gh found (used to fork the sample repo)"; else warn "gh not found — optional; you can fork on github.com instead"; fi
  # Make mise-managed tools (node, yarn, npx) visible to this non-interactive shell.
  export PATH="$HOME/.local/share/mise/shims:$PATH"
  export MISE_EXPERIMENTAL=1
  # Every repo task runs yarn through corepack; never let it write a packageManager field into package.json.
  export COREPACK_ENABLE_AUTO_PIN=0
  check_container_engine
}

# ---------- 2. checkout and install ----------
checkout() {
  step "Checkout"
  # rev-parse, not `-d .git`: in a git worktree .git is a file, not a directory.
  if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    [ -f "$DIR/cdk/cdk.json" ] && [ -d "$DIR/agent" ] \
      || die "$DIR is a git checkout, but not of ABCA (no cdk/cdk.json). Pass --dir with an ABCA checkout or a new folder; nothing was changed."
    ok "existing checkout: $DIR ($(git -C "$DIR" rev-parse --abbrev-ref HEAD) @ $(git -C "$DIR" rev-parse --short HEAD))"
    if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
      warn "checkout has local changes; not pulling updates"
    elif ! git -C "$DIR" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
      ok "branch has no upstream to pull from; deploying it as it is"
    elif confirm "Pull the latest upstream changes?"; then
      run git -C "$DIR" pull --ff-only
    fi
  elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR already exists and is not a git checkout. Pass --dir with a new or empty folder, or an existing ABCA checkout; nothing was changed."
  else
    run mkdir -p "$(dirname "$DIR")"
    run git clone "$REPO_URL" "$DIR"  # git clones into a missing or empty folder
  fi
  if [ "$DRY_RUN" = 0 ]; then cd "$DIR"; elif [ -d "$DIR" ]; then cd "$DIR"; fi
}

install_deps() {
  step "Install tools and dependencies"
  run mise trust
  run_logged mise-install mise install
  run_logged corepack mise exec -- sh -c 'corepack enable && corepack prepare yarn@1.22.22 --activate'
  # The dependency half of `mise run install`. Its last step installs contributor git hooks (prek),
  # which deploying does not need and which fails on machines with a managed global/system
  # core.hooksPath (for example corporate security hooks). Never change that setting here.
  run_logged yarn-install mise exec -- yarn install --check-files
  run_logged agent-install sh -c 'cd agent && mise run install'
}

# ---------- 3. AWS account checks ----------
add_aws_account() {  # creates a named profile for a new account → sets PROFILE
  local acct role
  acct="$(ask "AWS account ID (12 digits)" "")"
  printf '%s' "$acct" | grep -Eq '^[0-9]{12}$' || die "'$acct' is not a 12-digit AWS account ID"
  if have ada; then
    # Amazon-internal machines: ada vends Isengard credentials on demand, nothing stored on disk.
    role="$(ask "IAM role to use in $acct (needs CloudFormation/IAM/VPC permissions)" "Admin")"
    PROFILE="abca-$acct"
    run aws configure set credential_process \
      "ada credentials print --account $acct --role $role --provider isengard" --profile "$PROFILE"
    run aws configure set region "${REGION:-us-east-1}" --profile "$PROFILE"
    ok "added profile '$PROFILE' (ada → $acct/$role)"
  else
    PROFILE="$(ask "Name for the new profile" "abca")"
    printf '  Starting AWS IAM Identity Center (SSO) setup. Choose account %s when asked.\n' "$acct"
    run aws configure sso --profile "$PROFILE"
  fi
}

choose_aws_account() {  # sets PROFILE and REGION; never silently inherits $AWS_PROFILE
  step "AWS account"
  if [ -z "$PROFILE" ] && [ -n "$SAVED_PROFILE" ] && confirm_yes "Use profile '$SAVED_PROFILE' from last time?"; then
    PROFILE="$SAVED_PROFILE"
  fi
  if [ -z "$PROFILE" ]; then
    printf '  Which AWS account should ABCA deploy into? Use a dedicated sandbox/dev account,\n'
    printf '  never a shared or production one.\n'
    local profiles="" i=1 p choice suggested="n"
    profiles="$(aws configure list-profiles 2>/dev/null || true)"
    for p in $profiles; do
      printf '    %d) %s%s\n' "$i" "$p" "$([ "$p" = "${AWS_PROFILE:-}" ] && printf '  (current $AWS_PROFILE)')"
      [ "$p" = "${AWS_PROFILE:-}" ] && suggested="$i"
      i=$((i + 1))
    done
    printf '    n) Add a new AWS account\n'
    choice="$(ask "Choose" "$suggested")"
    case "$choice" in
      n|N) add_aws_account ;;
      *[!0-9]*|'') die "invalid choice '$choice'" ;;
      *)   PROFILE="$(printf '%s\n' $profiles | sed -n "${choice}p")"
           [ -n "$PROFILE" ] || die "invalid choice '$choice'" ;;
    esac
  fi

  if [ -z "$REGION" ]; then
    if [ -n "$SAVED_REGION" ] && [ "$PROFILE" = "$SAVED_PROFILE" ]; then
      REGION="$SAVED_REGION"
    else
      REGION="$(ask "AWS Region" "$(aws configure get region --profile "$PROFILE" 2>/dev/null || echo us-east-1)")"
    fi
  fi
  case "$REGION" in
    us-*) ;;
    *) warn "$REGION is outside the US, but the stack uses US inference profiles unless cdk.json sets bedrockGeoRegion." ;;
  esac
  export AWS_PROFILE="$PROFILE" AWS_REGION="$REGION"
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN  # make the chosen profile win
}

ensure_aws_session() {  # re-check before slow AWS steps: sessions can expire during a long run
  [ "$DRY_RUN" = 1 ] && return 0
  local err
  if err="$(aws sts get-caller-identity --query Account --output text 2>&1)"; then
    [ "$err" = "$ACCOUNT_ID" ] || die "profile '$PROFILE' now resolves to account $err, not $ACCOUNT_ID; stopping."
    return 0
  fi
  fail "your AWS session for profile '$PROFILE' is no longer valid: $(printf '%s' "$err" | tail -n 1)"
  if have ada; then warn "sign in again with 'mwinit', then re-run this script"
  else warn "sign in again (for example: aws sso login --profile $PROFILE), then re-run this script"; fi
  die "AWS credentials expired; your answers are saved, so re-running picks up where you left off"
}

aws_identity() {
  choose_aws_account
  local ident
  if ! ident="$(aws sts get-caller-identity --output text --query '[Account,Arn]' 2>&1)"; then
    [ "$DRY_RUN" = 1 ] && die "could not get credentials for '$PROFILE' (dry-run does not create profiles, so a new account can't be checked). Run without --dry-run, or use --no-aws."
    have ada && warn "if this is an ada/Isengard profile, run 'mwinit' first and make sure you can assume the role."
    die "no valid AWS credentials for profile '$PROFILE': $ident"
  fi
  ACCOUNT_ID="$(printf '%s' "$ident" | awk '{print $1}')"
  CALLER_ARN="$(printf '%s' "$ident" | awk '{print $2}')"
  ACCOUNT_ALIAS="$(aws iam list-account-aliases --query 'AccountAliases[0]' --output text 2>/dev/null || true)"
  [ "$ACCOUNT_ALIAS" = "None" ] && ACCOUNT_ALIAS=""

  printf '  Account : %s%s%s %s\n' "$B" "$ACCOUNT_ID" "$N" "${ACCOUNT_ALIAS:+($ACCOUNT_ALIAS)}"
  printf '  Caller  : %s\n' "$CALLER_ARN"
  printf '  Profile : %s\n' "$PROFILE"
  printf '  Region  : %s\n' "$REGION"

  local haystack
  haystack="$(printf '%s %s %s' "$ACCOUNT_ALIAS" "$CALLER_ARN" "${AWS_PROFILE:-}" | tr '[:upper:]' '[:lower:]')"
  case "$haystack" in
    *prod*|*prd*) die "this looks like a PRODUCTION account or role (matched 'prod'/'prd'). Use a dedicated sandbox account." ;;
  esac
  case "$haystack" in
    *dev*|*test*|*sandbox*|*beta*|*staging*|*alpha*) ok "account/role name suggests a non-production environment" ;;
    *) warn "cannot tell whether this account is non-production — treat it as production unless you are sure" ;;
  esac
  case "$CALLER_ARN" in
    *AdministratorAccess*|*Admin*) warn "you are using an admin role; deploys need broad IAM permissions, but use a sandbox account" ;;
  esac
}

stack_status() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NONE"
}

stack_output() {  # stack_output KEY [STACK]
  aws cloudformation describe-stacks --stack-name "${2:-$STACK_NAME}" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

cost_and_exposure_warning() {
  cat <<EOF

  ${B}${Y}COST WARNING${N}
    Deploying creates always-on resources in account ${B}$ACCOUNT_ID${N} ($REGION):
      NAT Gateway (~\$32/mo), 7 VPC interface endpoints (~\$102/mo), WAF, dashboards, alarms, secrets.
    Idle baseline: ${B}$IDLE_COST${N}, billed until you run: $0 --teardown
    Each task also bills Bedrock tokens and AgentCore compute.
    Set an AWS Budget alarm on this account.

  ${B}${Y}WHAT BECOMES REACHABLE${N}
    - A public API Gateway endpoint. Task routes require a Cognito login, and self-signup is disabled.
    - Webhook endpoints (e.g. for Jira, added later) are verified by HMAC signature instead of Cognito.
    - The agent receives your GitHub token and can push branches and open PRs on: ${B}${TARGET_REPO}${N}
    The script will check that the API rejects anonymous requests after deploy.

EOF
}

model_constant() {  # read a default model ID from the checkout so this check tracks upstream bumps
  sed -n "s/^export const $1 = '\(.*\)';/\1/p" cdk/src/handlers/shared/bedrock-model-constants.ts 2>/dev/null
}

check_bedrock() {
  step "Amazon Bedrock model access"
  local geo main aux model failed=0 err
  # Same geography the stack grants (cdk.json context bedrockGeoRegion, default "us").
  geo="$(node -e 'const c=require("./cdk/cdk.json");process.stdout.write((c.context||{}).bedrockGeoRegion||"us")' 2>/dev/null || echo us)"
  main="$(model_constant PLATFORM_DEFAULT_MODEL_ID)"; aux="$(model_constant DEFAULT_HAIKU_MODEL_ID)"
  [ -n "$main" ] && [ -n "$aux" ] || { warn "could not read the default model IDs from the checkout; skipping"; return; }
  printf '  Sending a 1-token test prompt to each default model (costs a fraction of a cent).\n'
  for model in "$geo.$main" "$geo.$aux"; do
    if [ "$DRY_RUN" = 1 ]; then printf '  %s[dry-run]%s would invoke %s\n' "$Y" "$N" "$model"; continue; fi
    if err="$(aws bedrock-runtime converse --region "$REGION" --model-id "$model" \
        --messages '[{"role":"user","content":[{"text":"Reply OK"}]}]' \
        --inference-config maxTokens=1 --output text --query 'stopReason' 2>&1)"; then
      ok "$model is invocable"
    else
      fail "$model: $(printf '%s' "$err" | tail -n 1)"; failed=1
    fi
  done
  if [ "$failed" = 1 ]; then
    warn "Tasks will fail at their first turn until this works. In the Bedrock console for $REGION,"
    warn "enable Anthropic Claude (Model catalog → first-time use form), then re-run this script."
    confirm_warning "Continue deploying anyway?" || die "fix Bedrock model access, then re-run (your answers are saved)"
  fi
}

# ---------- 4. target repository ----------
choose_repo() {
  step "GitHub repository for the agent"
  if [ -z "$TARGET_REPO" ]; then
    local gh_user=""
    if have gh && gh auth status >/dev/null 2>&1; then gh_user="$(gh api user --jq .login 2>/dev/null || true)"; fi
    printf '  The agent pushes branches and opens PRs on ONE repo you control. Do not use %s directly.\n' "$SAMPLE_REPO"
    TARGET_REPO="$(ask "owner/repo to use" "${gh_user:+$gh_user/agent-plugins}")"
  fi
  case "$TARGET_REPO" in */*) ;; *) die "repo must be owner/repo (got '$TARGET_REPO')" ;; esac
  [ "$TARGET_REPO" = "$SAMPLE_REPO" ] && die "fork $SAMPLE_REPO and use your fork; you most likely cannot push to the upstream repo"

  if have gh && gh repo view "$TARGET_REPO" >/dev/null 2>&1; then
    ok "$TARGET_REPO exists"
  elif have gh && [ "${TARGET_REPO##*/}" = "agent-plugins" ] && confirm "$TARGET_REPO not found. Fork $SAMPLE_REPO to your GitHub account now?"; then
    run gh repo fork "$SAMPLE_REPO" --clone=false
  else
    warn "could not verify $TARGET_REPO; make sure it exists and that you can push to it"
  fi

  # Persist in cdk/cdk.json (recommended by the quick start) so later manual deploys keep the same repo.
  local current
  current="$(node -e 'const c=require("./cdk/cdk.json");process.stdout.write((c.context||{}).blueprintRepo||"")' 2>/dev/null || true)"
  if [ "$current" = "$TARGET_REPO" ]; then
    ok "cdk/cdk.json already targets $TARGET_REPO"
  else
    run node -e '
      const fs=require("fs"),p="cdk/cdk.json",c=JSON.parse(fs.readFileSync(p,"utf8"));
      c.context=c.context||{}; c.context.blueprintRepo=process.argv[1];
      fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");' "$TARGET_REPO"
    ok "set blueprintRepo=$TARGET_REPO in cdk/cdk.json (a local change in your checkout)"
  fi
}

# ---------- 5. build, bootstrap, diff, deploy ----------
build_all() {
  step "Build (includes CDK synth against your account)"
  run_logged build mise run build
}

compile_only() {
  step "Compile without AWS (CDK app + CLI)"
  run_logged cdk-compile mise //cdk:compile
  run_logged cli-build mise //cli:build
  ok "compiled. Re-run without --no-aws when you have a sandbox account."
}

bootstrap() {
  step "CDK bootstrap"
  ensure_aws_session
  if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
    ok "account already bootstrapped in $REGION (CDKToolkit exists)"
    # An existing bootstrap can be older than this checkout needs; deploying would then fail with an
    # IAM AccessDenied only after every asset is uploaded. Checkouts that ship the check can tell us now.
    if [ -f cdk/scripts/preflight-bootstrap.ts ]; then
      local verdict
      if verdict="$(cd cdk && mise exec -- npx tsx scripts/preflight-bootstrap.ts 2>&1)"; then
        verdict="$(printf '%s' "$verdict" | sed -n 's/^bootstrap preflight: //p' | head -n 1)"
        case "$verdict" in WARN:*) warn "$verdict" ;; *) ok "$verdict" ;; esac
      else
        warn "$(printf '%s' "$verdict" | sed -n 's/^bootstrap preflight: //p' | head -n 1)"
        confirm "Update the CDKToolkit stack's bootstrap policies in $ACCOUNT_ID/$REGION now?" \
          || die "the existing bootstrap is out of date; deploying would fail. Re-run and accept the update."
        run_logged bootstrap mise //cdk:bootstrap
      fi
    fi
  else
    confirm "Bootstrap CDK in $ACCOUNT_ID/$REGION (creates the CDKToolkit stack: S3 bucket, ECR repo, IAM roles)?" \
      || die "bootstrap is required before deploying"
    run_logged bootstrap mise //cdk:bootstrap
  fi
}

# Local dev sign-in (`--local-dev`, remembered): lets `mise //web:dev:live` sign in at http://localhost:5173.
add_local_dev_args() {
  if [ "$LOCAL_DEV" = 1 ] && [ "$CONSOLE" = 1 ]; then
    CDK_ARGS+=(-c operatorConsoleDevOrigins=http://localhost:5173)
    ok "console sign-in also allowed from a local dev server (http://localhost:5173); turn off with --no-local-dev"
  fi
  save_settings
}

# The deploy ships whatever this checkout contains. Deploying a different checkout than last
# time (another clone, worktree or branch) can silently remove stacks or features.
confirm_deploy_source() {
  local branch commit
  branch="$(git -C "$DIR" branch --show-current 2>/dev/null || echo '?')"
  commit="$(git -C "$DIR" log -1 --format='%h %s' 2>/dev/null | cut -c1-70 || echo '?')"
  printf '  Deploying the code in: %s%s%s\n    branch %s, commit %s\n' "$B" "$DIR" "$N" "$branch" "$commit"
  if [ -n "$SAVED_DEPLOY_DIR" ] && [ "$SAVED_DEPLOY_DIR" != "$DIR" ]; then
    warn "last time you deployed from $SAVED_DEPLOY_DIR"
    warn "deploying a different checkout replaces the stack with that checkout's code; features it lacks are removed"
    confirm "Deploy from $DIR anyway?" \
      || die "deploy cancelled; re-run from the checkout you meant (cd there, then run this script)"
  fi
}

deploy() {
  step "Review changes"
  confirm_deploy_source
  ensure_aws_session
  local status; status="$(stack_status)"
  case "$status" in
    ROLLBACK_COMPLETE) die "stack $STACK_NAME is ROLLBACK_COMPLETE and cannot be updated. Run $0 --teardown, then retry." ;;
    REVIEW_IN_PROGRESS)
      # Left behind when a deploy's change set fails before anything is created. It never "finishes";
      # CDK treats it as not-yet-created and deploys over it, so an empty one is safe to continue from.
      if [ "$(aws cloudformation list-stack-resources --stack-name "$STACK_NAME" --region "$REGION" \
            --query 'length(StackResourceSummaries)' --output text 2>/dev/null || true)" = "0" ]; then
        ok "a previous deploy stopped before creating anything (REVIEW_IN_PROGRESS, no resources); deploying over it"
      else
        die "stack $STACK_NAME is REVIEW_IN_PROGRESS but has resources; inspect it in the CloudFormation console first."
      fi ;;
    *IN_PROGRESS*)     die "stack $STACK_NAME is $status. Wait for it to finish, then re-run." ;;
  esac
  printf '  Current stack status: %s\n' "$status"
  run_logged diff mise //cdk:diff -- "${CDK_ARGS[@]}"
  [ "$DRY_RUN" = 1 ] || printf '  Review the full diff: %s\n' "$LOG_DIR/$RUN_ID-diff.log"

  cost_and_exposure_warning
  [ "$DRY_RUN" = 1 ] && { printf '  %s[dry-run]%s would ask you to type the account ID, then deploy\n' "$Y" "$N"; return; }
  local typed
  if [ "$AUTO_YES" = 1 ] && [ -n "$SAVED_ACCOUNT_ID" ] && [ "$SAVED_ACCOUNT_ID" = "$ACCOUNT_ID" ]; then
    # Only the account this machine last deployed to successfully; a new one is always typed.
    typed="$ACCOUNT_ID"; auto_answer "Deploy to account $ACCOUNT_ID (the one you deployed to last time)?" yes
  else
    typed="$(AUTO_YES=0 ask "Type the account ID ($ACCOUNT_ID) to deploy, or anything else to stop" "")"
  fi
  [ "$typed" = "$ACCOUNT_ID" ] || die "deploy cancelled; nothing was created by this step"

  step "Security changes in this deploy (IAM and security groups)"
  # CDK's own approval prompt needs a terminal, and the deploy below runs with its output captured
  # (logged), so CDK cannot ask. Show the same tables CDK would and ask here instead; the deploy only
  # runs with --require-approval never after you approve exactly these changes.
  local seclog="$LOG_DIR/$RUN_ID-security-diff.log"
  printf '  computing the security changes (cdk diff --security-only, ~1-2 min)...\n'
  (cd cdk && mise exec -- npx cdk diff --security-only "${CDK_ARGS[@]}") >"$seclog" 2>&1 \
    || die "could not compute the security changes — see $seclog"
  if grep -q -E 'IAM Statement Changes|IAM Policy Changes|Security Group Changes' "$seclog"; then
    # A first deploy adds hundreds of rows; summarise, and show the full tables only on request.
    awk '/IAM Statement Changes/{s="IAM policy statements"} /IAM Policy Changes/{s="managed-policy attachments"}
         /Security Group Changes/{s="security-group rules"} /^\(NOTE: There may be security-related changes/{exit}
         s && /^│ [+-] │/{ if ($2 == "+") add[s]++; else rem[s]++ }
         END{ for (k in add) printf "    %-28s %4d added, %d removed\n", k, add[k], rem[k] + 0 }' "$seclog"
    printf '  Full tables: %s\n' "$seclog"
    if confirm_no "Show the full tables here?"; then
      awk '/IAM Statement Changes|IAM Policy Changes|Security Group Changes/{show=1} show{print} /^\(NOTE: There may be security-related changes/{exit}' "$seclog"
    fi
    confirm "Approve these IAM and security-group changes?" \
      || die "deploy cancelled at the security review; nothing was changed by this step"
  else
    ok "no IAM or security-group changes in this deploy"
  fi

  step "Deploy (~10-20 min)"
  # The repo's clean:disk task (run before deploy) empties $TMPDIR. Give it a private scratch dir
  # so it cannot delete your other temporary files.
  local scratch; scratch="$(mktemp -d "${TMPDIR:-/tmp}/abca-deploy.XXXXXX")"
  local log="$LOG_DIR/$RUN_ID-deploy.log"
  printf '  log: %s\n' "$log"
  if ! TMPDIR="$scratch" mise //cdk:deploy -- "${CDK_ARGS[@]}" --require-approval never 2>&1 | tee "$log"; then
    case "$(stack_status)" in
      UPDATE_ROLLBACK_COMPLETE)
        die "deploy failed and CloudFormation rolled it back — see $log. Nothing is broken: the stack is still running its previous version. Fix the error shown above and re-run." ;;
      ROLLBACK_COMPLETE)
        die "the first deploy failed and left an empty stack — see $log. Run $0 --teardown, then retry." ;;
      *)
        die "deploy failed — see $log." ;;
    esac
  fi
  rmdir "$scratch" 2>/dev/null || true
  SAVED_DEPLOY_DIR="$DIR"; SAVED_ACCOUNT_ID="$ACCOUNT_ID"; save_settings
  ok "stack $STACK_NAME deployed$([ "$CONSOLE" = 1 ] && printf ' (+ %s)' "$CONSOLE_STACK")"
}

verify_api_gate() {
  step "Check that the API rejects anonymous requests"
  local api code
  api="$(stack_output ApiUrl 2>/dev/null || true)"
  [ -n "$api" ] && [ "$api" != "None" ] || { warn "ApiUrl output not found; skipping"; return; }
  # Require the authorizer's own denial (401 "Unauthorized"). A bare 403 can also be WAF or
  # API Gateway's "Missing Authentication Token" for an unknown route, which proves nothing.
  local body; body="$(mktemp)"
  code="$(curl -s -o "$body" -w '%{http_code}' "${api%/}/tasks" || true)"
  if [ "$code" = 401 ] && grep -q 'Unauthorized' "$body"; then
    ok "anonymous GET /tasks → 401 Unauthorized from the authorizer"
  elif [ "${code#2}" != "$code" ] || [ "${code#3}" != "$code" ]; then
    rm -f "$body"
    die "anonymous GET /tasks returned $code: the API answers without authentication. Do not submit tasks or share the URL; run $0 --teardown and investigate."
  else
    fail "anonymous GET /tasks returned $code ($(head -c 120 "$body")), not the authorizer's 401"
    warn "could not confirm the Cognito gate. Don't share the API URL until you have checked it."
    confirm_warning "Continue with setup anyway?" || { rm -f "$body"; die "stopped after deploy; the stack is still running (teardown: $0 --teardown)"; }
  fi
  rm -f "$body"
}

# ---------- 6. credentials, user, smoke test ----------
bgagent() { (cd "$DIR/cli" && node lib/bin/bgagent.js "$@"); }

configure_cli() {
  step "Point the CLI at this deployment"
  # Every bgagent command below needs the API URL, Cognito pool/client and Region; read them from the stack.
  run bgagent configure --region "$REGION" --stack-name "$STACK_NAME"
}

# 0 when a real token was stored earlier. CDK seeds the secret with a generated placeholder, and
# `bgagent github set-token` adds a version on top, so a second version means a token is there.
# Looks at version metadata only; never reads the secret value.
github_token_stored() {
  local arn versions changed
  arn="$(stack_output GitHubTokenSecretArn 2>/dev/null || true)"
  [ -n "$arn" ] && [ "$arn" != "None" ] || return 1
  versions="$(aws secretsmanager list-secret-version-ids --secret-id "$arn" --region "$REGION" \
    --query 'length(Versions)' --output text 2>/dev/null || echo 0)"
  [ "${versions:-0}" -gt 1 ] 2>/dev/null || return 1
  changed="$(aws secretsmanager describe-secret --secret-id "$arn" --region "$REGION" \
    --query 'LastChangedDate' --output text 2>/dev/null || true)"
  confirm_yes "A GitHub token is already stored (last changed ${changed:-earlier}). Keep it?"
}

set_github_token() {
  step "GitHub token → AWS Secrets Manager"
  if github_token_stored; then ok "kept the stored GitHub token"; return 0; fi
  printf '  The agent needs a token to clone %s, push a branch and open pull requests.\n' "$TARGET_REPO"
  printf '  It is stored in AWS Secrets Manager; this script never sees or logs it.\n'
  action "create a GitHub token for the agent" \
    "Open https://github.com/settings/personal-access-tokens/new" \
    "Token name: abca-$STACK_NAME   Expiration: your choice" \
    "Repository access: Only select repositories → $TARGET_REPO" \
    "Permissions → Repository: Contents = Read and write, Pull requests = Read and write, Issues = Read-only (Metadata is added automatically)" \
    "Click Generate token and copy it" \
    "Come back here, answer y below, and paste it at the prompt (it will not be shown)"
  confirm "Ready to store the token now?" || {
    warn "skipped"
    todo "Store the GitHub token:  cd $DIR/cli && node lib/bin/bgagent.js github set-token --region $REGION --stack-name $STACK_NAME"
    return 1; }
  run bgagent github set-token --region "$REGION" --stack-name "$STACK_NAME"
}

create_user_and_login() {
  step "Your ABCA user (Cognito)"
  [ -n "$EMAIL" ] || EMAIL="$(ask "Email for your ABCA login" "$(git config user.email 2>/dev/null || true)")"
  [ -n "$EMAIL" ] || die "an email is required"
  save_settings
  local invite="$HOME/.bgagent/invites/$EMAIL.txt"
  if [ -f "$invite" ]; then
    ok "invite already exists: $invite"
  else
    run bgagent admin invite-user "$EMAIL" --region "$REGION" --stack-name "$STACK_NAME"
  fi
  run bgagent configure --region "$REGION" --stack-name "$STACK_NAME"
  [ "$DRY_RUN" = 1 ] && { run bgagent login --username "$EMAIL"; return; }

  # The pool requires a temporary password on admin-created users; you replace it on first sign-in.
  local copied=""
  if [ -f "$invite" ] && have pbcopy && grep -q '^temp password:' "$invite"; then
    sed -n 's/^temp password:[[:space:]]*//p' "$invite" | tr -d '\n' | pbcopy && copied=1
  fi
  local paste_step
  if [ -n "$copied" ]; then
    paste_step="At the Password prompt below, paste your one-time password: it is already on your clipboard, so press Cmd+V, then Enter"
  else
    paste_step="At the Password prompt below, paste your one-time password, shown by:"
  fi
  action "sign in for the first time and choose your password" \
    "$paste_step" \
    "\$ grep 'temp password' $invite" \
    "When asked for a New password, choose one with at least 12 characters, including upper- and lower-case letters, a number and a symbol (for example: Monster-Catch-2026!)" \
    "Type it again to confirm. Nothing is shown while you type; that is normal."

  local attempt
  for attempt in 1 2 3 4 5; do
    if bgagent login --username "$EMAIL"; then
      ok "signed in as $EMAIL"
      [ -n "$copied" ] && printf '' | pbcopy  # clear the clipboard
      if [ -f "$invite" ] && confirm_yes "Delete $invite now? (it held only the one-time password, which no longer works)"; then
        rm -f "$invite" && ok "deleted the one-time password file"
      elif [ -f "$invite" ]; then
        todo "Delete the one-time password file:  rm $invite"
      fi
      return 0
    fi
    warn "sign-in did not complete (attempt $attempt of 5)."
    warn "Passwords need at least 12 characters with upper- and lower-case letters, a number and a symbol."
    warn "Until you set a new one, the one-time password above still works."
    confirm_yes "Try again?" || break
  done
  todo "Finish signing in:  cd $DIR/cli && node lib/bin/bgagent.js login --username $EMAIL"
  return 1
}

smoke_test() {
  step "Smoke test"
  printf '  Submits one small task to %s; it should open a PR in 2-5 minutes (small Bedrock cost).\n' "$TARGET_REPO"
  # --yes skips it: the smoke task asks for the same change every run.
  if [ "$AUTO_YES" = 1 ]; then auto_answer "Run the smoke test now?" no; return; fi
  confirm_yes "Run the smoke test now?" || { warn "skipped"; return; }
  local task="Add a CODEOWNERS file to the repository root" out pr
  if [ "$DRY_RUN" = 1 ]; then run bgagent submit --repo "$TARGET_REPO" --task "$task" --wait --output json; return; fi
  # Progress goes to stderr (visible); the final task JSON on stdout is parsed for the PR URL.
  out="$(bgagent submit --repo "$TARGET_REPO" --task "$task" --wait --output json)" || warn "the task did not finish successfully"
  pr="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).pr_url||"")}catch(e){}})')"
  if [ -n "$pr" ]; then
    ok "pull request opened: ${B}$pr${N}"
  else
    warn "no PR URL in the result. Task details:"
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
}

next_steps() {
  step "Done"
  if [ -n "$TODO_FILE" ] && [ -s "$TODO_FILE" ]; then
    local items=()
    while IFS= read -r line; do items+=("$line"); done <"$TODO_FILE"
    action "finish setup (left over from this run)" "${items[@]}"
  fi
  local console_url=""
  if [ "$CONSOLE" = 1 ] && [ "$NO_AWS" != 1 ]; then
    console_url="$(stack_output ConsoleUrl "$CONSOLE_STACK" 2>/dev/null || true)"
    [ "$console_url" = "None" ] && console_url=""
  fi
  if [ -n "$console_url" ]; then
    action "open the operator console" \
      "Open this URL and sign in with the same email and password as the CLI:" \
      "\$ open $console_url" \
      "It shows running tasks, what each agent is doing, stuck tasks and pending approvals."
  fi
  action "give the agent its first task" \
    "Submit a GitHub issue (or describe a task) and wait for the pull request:" \
    "\$ cd $DIR/cli && node lib/bin/bgagent.js submit --repo $TARGET_REPO --issue 1 --wait" \
    "Or describe the work in words:" \
    "\$ node lib/bin/bgagent.js submit --repo $TARGET_REPO --task \"Describe the change\" --wait" \
    "Check on running tasks any time:" \
    "\$ node lib/bin/bgagent.js list"
  cat <<EOF
  Logs:      $LOG_DIR
  Jira:      needs Jira Cloud site ADMIN. Follow docs/guides/JIRA_SETUP_GUIDE.md
             (OAuth app, webhook, Forge app, project mapping, user linking).
  Remove:    $0 --teardown   (stops the $IDLE_COST idle cost)
EOF
}

# ---------- teardown ----------
teardown() {
  check_platform
  export PATH="$HOME/.local/share/mise/shims:$PATH"
  export MISE_EXPERIMENTAL=1
  export COREPACK_ENABLE_AUTO_PIN=0  # see check_deps
  [ -d "$DIR" ] || die "checkout not found at $DIR (use --dir)"
  cd "$DIR"
  aws_identity
  local status; status="$(stack_status)"
  [ "$status" = "NONE" ] && { ok "stack $STACK_NAME does not exist in $ACCOUNT_ID/$REGION; nothing to delete"; exit 0; }
  cat <<EOF

  ${B}${R}TEARDOWN${N} — stack ${B}$STACK_NAME${N} (status $status) in ${B}$ACCOUNT_ID${N} / $REGION
  This DELETES the API, Lambdas, DynamoDB tables (task history and settings), the AgentCore runtime,
  the VPC, the Cognito user pool (all users), the stack's secrets and the operator console
  ($CONSOLE_STACK, if deployed). Running tasks are lost.
  It does NOT delete: the CDKToolkit bootstrap stack, branches/PRs already pushed to GitHub,
  your GitHub token on github.com (revoke it there), or ~/.bgagent on this Mac.
  Deleting can stall 20-40 min while AWS releases AgentCore network interfaces; just re-run if it fails.

EOF
  [ "$DRY_RUN" = 1 ] && { printf '  %s[dry-run]%s mise //cdk:destroy -- %s\n' "$Y" "$N" "${CDK_ARGS[*]}"; exit 0; }
  local typed; typed="$(ask "Type the stack name ($STACK_NAME) to delete it" "")"
  [ "$typed" = "$STACK_NAME" ] || die "teardown cancelled; nothing was deleted"
  # --all removes the console stack first (it depends on the app stack's user pool and API).
  mise //cdk:destroy -- "${CDK_ARGS[@]}" 2>&1 | tee "$LOG_DIR/$RUN_ID-destroy.log"
  ok "destroy finished. Check for leftovers: aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION"
}

# ---------- main ----------
main() {
  printf '%sABCA onboarding%s  (log dir: %s)%s\n' "$B" "$N" "$LOG_DIR" "$([ "$DRY_RUN" = 1 ] && printf '  [DRY RUN]')"
  if [ "$TEARDOWN" = 1 ]; then teardown; exit 0; fi

  check_deps
  checkout
  if resume_step install; then ok "skipped install (unchanged since it last succeeded)"; else install_deps; mark_done install; fi

  if [ "$NO_AWS" = 1 ]; then compile_only; exit 0; fi

  aws_identity
  if [ "$AUTO_YES" = 1 ] && [ "$SAVED_ACCOUNT_ID" != "$ACCOUNT_ID" ]; then
    # --yes repeats a known setup; a new account gets every question.
    warn "--yes is off for this run: account $ACCOUNT_ID is not the one you last deployed to${SAVED_ACCOUNT_ID:+ ($SAVED_ACCOUNT_ID)}"
    AUTO_YES=0
  fi
  confirm "Use account $ACCOUNT_ID ${ACCOUNT_ALIAS:+($ACCOUNT_ALIAS) }in $REGION for ABCA?" \
    || { printf '\n'; warn "Stopped: you answered no to using account $ACCOUNT_ID in $REGION. Nothing was deployed or changed in AWS."
         warn "To deploy, re-run and answer y. To use another account or Region, re-run with --profile/--region."
         exit 0; }
  save_settings
  check_bedrock
  choose_repo
  save_settings
  bootstrap  # before the build: a bootstrap problem should surface in seconds, not after it
  if resume_step build; then ok "skipped build (unchanged since it last succeeded)"; else build_all; mark_done build; fi
  add_local_dev_args
  case "$(stack_status)" in
    CREATE_COMPLETE|UPDATE_COMPLETE)
      if resume_step deploy "${CDK_ARGS[*]}"; then ok "skipped deploy (stack $STACK_NAME is already deployed from this exact code and settings)"
      else deploy; mark_done deploy "${CDK_ARGS[*]}"; fi ;;
    *) deploy; mark_done deploy "${CDK_ARGS[*]}" ;;
  esac
  [ "$DRY_RUN" = 1 ] && { next_steps; exit 0; }
  verify_api_gate
  configure_cli
  local setup_ok=1
  # Not a code-fingerprint resume step: the token outlives code changes; set_github_token asks AWS.
  set_github_token || setup_ok=0
  if [ "$setup_ok" = 1 ]; then create_user_and_login || setup_ok=0; fi
  if [ "$setup_ok" = 1 ]; then
    smoke_test
  else
    warn "Setup is not finished: fix the step above and re-run this script (finished steps are offered as skips)."
  fi
  next_steps
}

main
