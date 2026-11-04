#!/usr/bin/env bash
# microvm-acceptance.sh — live end-to-end acceptance for the Lambda MicroVM backend.
#
# Drives a deployed stack through the real `bgagent` CLI and the MicroVM API:
# normal task, approval after sleep (approve / deny), cancel while suspended,
# a declined suspend on a working guest, worker replacement (continuation) and a
# concurrent burst. Each scenario records PASS/FAIL with the evidence it checked.
# This is the scripted form of docs/verification/README.md "Live acceptance".
#
# Usage:
#   ABCA_ACCEPT_REPO=owner/test-repo ./scripts/microvm-acceptance.sh [scenario ...]
#
# Scenarios (default: all): normal approve deny cancel declined continuation burst
#
# Environment:
#   ABCA_ACCEPT_REPO      Required. An owned test repository onboarded with
#                         compute_type lambda-microvm. Tasks open real PRs there.
#   ABCA_ACCEPT_SLEEP_S   Sleep-after for gate tasks (default 60).
#   ABCA_ACCEPT_TIMEOUT_S Per-wait timeout (default 900).
#   ABCA_ACCEPT_OUT       Results directory (default: a new mktemp dir).
#   AWS_REGION            Region of the stack (default us-east-1).
# Prerequisites: `bgagent configure` + `bgagent login` for the target stack, operator
# AWS credentials for the same account (MicroVM API), jq, and `mise run install`
# (the MicroVM SDK is resolved from cdk/node_modules).
#
# Safety: only tasks this script submits are touched; it never deletes stacks,
# repositories or data. It costs model spend (roughly $0.15-0.30 per task).

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO=${ABCA_ACCEPT_REPO:?set ABCA_ACCEPT_REPO to an owned lambda-microvm test repository}
SLEEP_S=${ABCA_ACCEPT_SLEEP_S:-60}
TIMEOUT_S=${ABCA_ACCEPT_TIMEOUT_S:-900}
OUT=${ABCA_ACCEPT_OUT:-$(mktemp -d -t microvm-acceptance.XXXXXX)}
export AWS_REGION=${AWS_REGION:-us-east-1}
RUN=$(date -u +%Y%m%d%H%M%S)
RESULTS="$OUT/results.tsv"
mkdir -p "$OUT"

bg() { node "$ROOT/cli/lib/bin/bgagent.js" "$@"; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$OUT/run.log" >&2; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULTS"; log "$2 $1 ($3) $4"; }

# MicroVM API: get <id> | suspend <id> | terminate <id>. Prints the state for get.
vm() {
  NODE_PATH="$ROOT/cdk/node_modules" node -e '
    const m = require("@aws-sdk/client-lambda-microvms");
    const c = new m.LambdaMicrovmsClient({});
    const [op, id] = process.argv.slice(1);
    const cmd = { get: m.GetMicrovmCommand, suspend: m.SuspendMicrovmCommand,
      terminate: m.TerminateMicrovmCommand }[op];
    c.send(new cmd({ microvmIdentifier: id }))
      .then(r => { if (op === "get") console.log(r.state ?? "UNKNOWN"); })
      .catch(e => { if (op === "get" && e.name === "ResourceNotFoundException") console.log("NOT_FOUND");
        else { console.error(e.name); process.exit(1); } });' "$1" "$2"
}

status() { bg status "$1" --output json 2>/dev/null | jq -r '.status // "UNKNOWN"'; }
vm_of() { bg status "$1" --output json 2>/dev/null | jq -r '.compute_metadata.microvmId // .session_id // empty'; }
pr_of() { bg status "$1" --output json 2>/dev/null | jq -r '.pr_url // empty'; }
events() { bg events "$1" --all --output json 2>/dev/null | jq -r '[.. | objects | .event_type? // empty] | join(" ")'; }
pending() {
  bg pending --output json 2>/dev/null \
    | jq -r --arg t "$1" '[.. | objects | select(.task_id? == $t) | (.request_id // empty)] | .[0] // empty'
}

# wait_for <description> <timeout_s> <command...>: poll until the command prints non-empty.
wait_for() {
  local what=$1 limit=$2 waited=0 value; shift 2
  while (( waited < limit )); do
    value=$("$@" 2>/dev/null || true)
    [[ -n $value ]] && { printf '%s' "$value"; return 0; }
    sleep 10; waited=$((waited + 10))
  done
  log "timeout waiting for $what"; return 1
}
status_in() { local s; s=$(status "$1"); shift; for w in "$@"; do [[ $s == "$w" ]] && { echo "$s"; return; }; done; }
vm_in() { local s; s=$(vm get "$1"); shift; for w in "$@"; do [[ $s == "$w" ]] && { echo "$s"; return; }; done; }

submit_plain() {
  bg submit --repo "$REPO" --max-turns 30 --max-budget 2 --output json \
    --task "MicroVM acceptance $RUN-$1: append the single line 'abca acceptance $RUN-$1' to README.md, commit it on a new branch named abca-accept-$RUN-$1 and open a pull request. Change nothing else." \
    | jq -r '.task_id'
}
# Writes a .env file, which the built-in write_env_files soft-deny gates.
submit_gate() {
  bg submit --repo "$REPO" --max-turns 40 --max-budget 3 --microvm-sleep-after "$SLEEP_S" --output json \
    --task "MicroVM acceptance $RUN-$1: create docs/accept-$RUN-$1.env containing EXAMPLE_FLAG=false using your file-write tool (not shell redirection). If that is denied, create docs/accept-$RUN-$1.example with the same content instead. Commit on a new branch named abca-accept-$RUN-$1 and open a pull request. Change nothing else." \
    | jq -r '.task_id'
}
# Gate task -> AWAITING_APPROVAL with a pending request and a SUSPENDED worker.
gate_and_sleep() {
  local id=$1
  wait_for "$id awaiting approval" "$TIMEOUT_S" status_in "$id" AWAITING_APPROVAL >/dev/null || return 1
  wait_for "$id pending request" 120 pending "$id" >/dev/null || return 1
  wait_for "$id worker suspended" "$TIMEOUT_S" vm_in "$(vm_of "$id")" SUSPENDED >/dev/null
}
finished() { wait_for "$1 terminal" "$TIMEOUT_S" status_in "$1" COMPLETED FAILED CANCELLED TIMED_OUT; }

scenario_normal() {
  local id; id=$(submit_plain normal)
  local final; final=$(finished "$id") || final=TIMEOUT
  local vm_id; vm_id=$(vm_of "$id")
  [[ $final == COMPLETED && -n $(pr_of "$id") ]] \
    && record normal PASS "$id" "completed, PR $(pr_of "$id"), worker $(vm get "$vm_id")" \
    || record normal FAIL "$id" "status $final"
}

scenario_decision() { # approve|deny
  local kind=$1 id; id=$(submit_gate "$kind")
  gate_and_sleep "$id" || { record "$kind" FAIL "$id" "never reached a suspended approval wait"; return; }
  local request; request=$(pending "$id")
  if [[ $kind == approve ]]; then bg approve "$id" "$request" >/dev/null
  else bg deny "$id" "$request" --reason "Use the .example file instead" >/dev/null; fi
  local final; final=$(finished "$id") || final=TIMEOUT
  [[ $final == COMPLETED ]] \
    && record "$kind" PASS "$id" "slept, woke on $kind, completed, PR $(pr_of "$id")" \
    || record "$kind" FAIL "$id" "status $final"
}

scenario_cancel() {
  local id; id=$(submit_gate cancel)
  gate_and_sleep "$id" || { record cancel FAIL "$id" "never reached a suspended approval wait"; return; }
  local vm_id; vm_id=$(vm_of "$id")
  bg cancel "$id" >/dev/null
  local final; final=$(finished "$id") || final=TIMEOUT
  local state; state=$(wait_for "$vm_id terminated" 120 vm_in "$vm_id" TERMINATED NOT_FOUND) || state=$(vm get "$vm_id")
  [[ $final == CANCELLED && ( $state == TERMINATED || $state == NOT_FOUND ) ]] \
    && record cancel PASS "$id" "cancelled while suspended, worker $state" \
    || record cancel FAIL "$id" "status $final, worker $state"
}

# A suspend the guest cannot honour must be declined (VM kept), never terminate it.
scenario_declined() {
  local id; id=$(submit_plain declined)
  wait_for "$id running" "$TIMEOUT_S" status_in "$id" RUNNING >/dev/null || { record declined FAIL "$id" "never ran"; return; }
  local vm_id; vm_id=$(wait_for "$id worker" 120 vm_of "$id")
  sleep 20
  vm suspend "$vm_id"
  sleep 15
  local after; after=$(vm get "$vm_id")
  local final; final=$(finished "$id") || final=TIMEOUT
  [[ $after != TERMINATED && $final == COMPLETED ]] \
    && record declined PASS "$id" "external suspend left worker $after; task completed" \
    || record declined FAIL "$id" "worker $after after suspend, status $final"
}

# Lose the suspended worker, then approve: a replacement must restore and finish.
scenario_continuation() {
  local id; id=$(submit_gate continuation)
  gate_and_sleep "$id" || { record continuation FAIL "$id" "never reached a suspended approval wait"; return; }
  local old; old=$(vm_of "$id")
  vm terminate "$old"
  wait_for "$old terminated" 300 vm_in "$old" TERMINATED NOT_FOUND >/dev/null || true
  bg approve "$id" "$(pending "$id")" >/dev/null
  local final; final=$(finished "$id") || final=TIMEOUT
  local seen; seen=$(events "$id")
  [[ $final == COMPLETED && $seen == *continuation_restored* && $(vm_of "$id") != "$old" ]] \
    && record continuation PASS "$id" "replacement $(vm_of "$id") restored the checkpoint, PR $(pr_of "$id")" \
    || record continuation FAIL "$id" "status $final; events: $(grep -o 'continuation_[a-z_]*' <<<"$seen" | sort -u | tr '\n' ' ')"
}

scenario_burst() {
  local ids=() id final ok=0
  for n in 1 2 3; do ids+=("$(submit_plain "burst$n")"); done
  for id in "${ids[@]}"; do
    final=$(finished "$id") || final=TIMEOUT
    [[ $final == COMPLETED ]] && ok=$((ok + 1))
  done
  (( ok == 3 )) && record burst PASS "${ids[*]}" "3 concurrent tasks completed" \
    || record burst FAIL "${ids[*]}" "$ok/3 completed"
}

run_scenario() {
  case $1 in
    normal) scenario_normal ;;
    approve | deny) scenario_decision "$1" ;;
    cancel) scenario_cancel ;;
    declined) scenario_declined ;;
    continuation) scenario_continuation ;;
    burst) scenario_burst ;;
    *) echo "unknown scenario: $1" >&2; exit 64 ;;
  esac
}

scenarios=("$@")
(( ${#scenarios[@]} )) || scenarios=(normal approve deny cancel declined continuation burst)
printf 'scenario\tresult\ttask\tevidence\n' > "$RESULTS"
log "repo $REPO, region $AWS_REGION, results $RESULTS"
# Independent scenarios run in parallel; each one owns only the tasks it submits.
pids=()
for s in "${scenarios[@]}"; do run_scenario "$s" & pids+=($!); done
for pid in "${pids[@]}"; do wait "$pid" || true; done
column -t -s $'\t' "$RESULTS" >&2
! grep -q $'\tFAIL\t' "$RESULTS"
