# Design proposal — right-sized ECS task def for read-only planning

> **Status:** PROPOSAL for the ECS-substrate workstream (K12/K14 / `feat/slack-channel-mapping`).
> NOT part of the plan-mode stack (T1/T4/T5/T2 on `fix/492-t1-short-negation`). No code written yet.
> **Author:** plan-mode QA/design session, 2026-07-07. Prompted by ABCA-583 (a `:decompose` on the
> ECS-substrate `abca-fork-dev` project) failing at session-start because the dev stack has no ECS
> substrate — and, more fundamentally, by the question "does *planning* need the 64 GB build box?"

## 1. Problem

An ECS-configured repo (`compute_type: ecs`) runs **every** task on the one Fargate task
definition in `EcsAgentCluster` — **64 GB / 16 vCPU** (`ecs-agent-cluster.ts:149`). That size exists
for a specific reason (sizing history in the same file): ABCA's own parallel `mise run build`
(agent:quality ‖ cdk:build ‖ cli:build ‖ docs:build, each fanning out worker fleets) peaks ~31.6 GB
and OOM-killed a 32 GB task, so the build tier needs 64 GB headroom.

But **`coding/decompose-v1` is `read_only: true`** — it clones, reads/greps to explore, and emits a
plan artifact. **It never builds.** Running it on the 64 GB build box is a large over-allocation for
a clone-and-read workload (and, on a stack that hasn't provisioned ECS at all, it just fails at
session-start — ABCA-583).

The current code has an explicit decision against the naive fix (`orchestrator.ts:242–252`): *"do
NOT special-case read-only workflows to agentcore … a repo big enough to need the 64 GB ECS tier for
building is also big enough to OOM the fixed AgentCore microVM just reading it."* That reasoning is
about **not routing planning to the wrong substrate FAMILY** (ECS repo → AgentCore). It does **not**
say planning needs the *same size* as building. This proposal threads that needle: **same family
(ECS repo → ECS planning, so the OOM concern is respected), right-sized (a smaller task def, since
planning doesn't build).**

## 2. Proposal

Add a **second, smaller Fargate task definition** to `EcsAgentCluster` for **read-only** workflows,
and route by `workflowIsReadOnly` in the ECS compute strategy. Keep the 64 GB def for build
workflows.

### 2a. Construct — `ecs-agent-cluster.ts`
- Add a `planningTaskDefinition` (a second `FargateTaskDefinition`) alongside the existing
  `taskDefinition`. Suggested size: **8 GB / 2 vCPU** (valid ARM64 Fargate combo). Rationale: a
  clone + read + a bounded set of file reads into the model context; no parallel build storm. If
  8 GB proves tight for a very large clone, 16 GB / 4 vCPU is the next step — but start small and
  size up on evidence (mirror the existing sizing-history discipline in the file).
  - It reuses the SAME container image, log group, task role, execution role, session role,
    payload-bucket + artifacts-bucket grants, and env as the build def — the ONLY difference is
    `cpu`/`memoryLimitMiB`. Factor the container definition into a small helper so both task defs
    share it (avoid drift in grants/env — the ECS-parity bugs in the history, e.g. ABCA-488/#502,
    all came from one task role/env missing something the other had).
  - Do NOT set `BUILD_VERIFY_TIMEOUT_S: '3600'` on the planning def (that's a build-tier concern;
    a read-only planner never runs the post-agent build verify).
- Expose `planningTaskDefinition.taskDefinitionArn` from the construct (new public field, mirror
  `taskDefinition`).

### 2b. Stack wiring — `agent.ts` + `task-orchestrator.ts`
- Pass the new ARN into the orchestrator's `ecsConfig` as `planningTaskDefinitionArn`
  (alongside the existing `taskDefinitionArn` at `agent.ts:704`).
- Orchestrator construct (`task-orchestrator.ts:271`) injects a new env var
  `ECS_PLANNING_TASK_DEFINITION_ARN` next to `ECS_TASK_DEFINITION_ARN`.

### 2c. Routing — `strategies/ecs-strategy.ts`
- `startSession` already receives `blueprintConfig`; thread the **workflow id** (or a
  pre-computed `readOnly` boolean) into the strategy input. `orchestrate-task.ts` already computes
  `workflowIsReadOnly(workflowId)` for preflight (line 121) — pass that same boolean down.
- In `RunTaskCommand` (`ecs-strategy.ts:206–208`), select the task def:
  `taskDefinition: readOnly ? ECS_PLANNING_TASK_DEFINITION_ARN ?? ECS_TASK_DEFINITION_ARN : ECS_TASK_DEFINITION_ARN`.
  The `?? ECS_TASK_DEFINITION_ARN` fallback keeps it safe if the planning def isn't wired (older
  deploy) — it just runs on the build def as today, never worse.
- The session-start guard (`ecs-strategy.ts:100`) stays as-is (it already fails honestly when the
  ECS substrate isn't provisioned at all — that's ABCA-583's message, working correctly).

## 3. What this does NOT change
- **Substrate family routing is unchanged** — an ECS repo still plans on ECS (honors
  `orchestrator.ts:242`); an AgentCore repo still plans on AgentCore. This is purely "which ECS task
  def," not "which substrate."
- **AgentCore repos are untouched** — `abca-demo` (where plan-mode T1/T4/T5/T2 were verified)
  doesn't go near this.
- **No plan-mode logic changes.** The decompose/revise/command/digest behavior is substrate-agnostic;
  this only affects the box an ECS-repo planning task runs on.

## 4. Why it's a separate workstream (not the plan-mode stack)
- It edits `ecs-agent-cluster.ts`, `agent.ts`, `task-orchestrator.ts`, `ecs-strategy.ts` — all owned
  by the ECS-substrate work (K12/K14, `feat/slack-channel-mapping`), which is **live-proven on dev
  but NOT pushed** and carries the context-gated `compute_type=ecs` deploy.
- It resolves a tension in `orchestrator.ts:242` that that workstream authored — so that workstream
  should own the change + the sizing call.
- Verifying it requires a `--context compute_type=ecs` deploy (provisions the Fargate substrate).
  The dev stack is currently `ComputeSubstrate: agentcore` (no ECS resources), so this is a net-new
  infra deploy — appropriately that workstream's call, not a plan-mode side effect.

## 5. Verification plan (for whoever builds it)
1. Deploy with `--context compute_type=ecs` (provisions both task defs).
2. `:decompose` on an ECS repo (e.g. `abca-fork-dev` / ABCA-583 re-run) → planning task runs on the
   **8 GB planning def** (confirm via the ECS task's `taskDefinitionArn` + CloudWatch), emits a plan,
   proposal posts. No OOM.
3. A normal coding task on the same repo → runs on the **64 GB build def** (confirm the build def is
   still selected for non-read-only workflows).
4. Confirm the shared container helper kept env/grants identical across both defs (ABCA-488/#502
   parity — Linear OAuth reaction fires, artifact delivers, payload fetches).

## 6. Open sizing question
8 GB is a starting guess. The honest input the builder needs: what's the largest ECS-onboarded repo,
and what's a decompose-v1 clone + read peak on it? If unknown, deploy at 8 GB, watch Container
Insights `MemoryUtilized` on a few real plans, and size up in 8 GB steps only if it approaches the
cap (same empirical method the 64 GB build def was arrived at).
