# Right-sized ECS task def for read-only planning

> **Status:** IMPLEMENTED. Built as designed below: a second 8 GB / 2 vCPU planning
> Fargate task def in `EcsAgentCluster`, selected by `workflowIsReadOnly` in the ECS compute
> strategy. Full CDK build green (2999 tests). Deployed to a dev stack with `--context compute_type=ecs`
> and verified end-to-end on an ECS-substrate project (a read-only workflow runs on the planning
> def; a normal coding task still runs on the build def).
> Prompted by a read-only task on an ECS-substrate project failing at session-start because that
> stack had no ECS substrate provisioned — and, more fundamentally, by the question "does a
> clone-and-read task need the build box?" The sections below describe the shipped design; a few `.ts:NNN` line
> anchors are from the design snapshot and may have drifted.

## 1. Problem

An ECS-configured repo (`compute_type: ecs`) runs **every** task on the one Fargate task
definition in `EcsAgentCluster` — the BUILD tier. Its size is measured, not guessed: a fully
parallel `mise run build` of this repo (agent:quality ‖ cdk:build ‖ cli:build ‖ docs:build, each
fanning out worker fleets) peaks ~31.6 GB and OOM-killed a 32 GB task. The build tier serialises
with `MISE_JOBS=1`, which brings the measured peak down to ~3.1 GB, so the shipped default is
4 vCPU / 16 GB — roughly 5x headroom over what it actually uses.

But a read-only workflow such as **`coding/pr-review-v1`** clones and reads/greps to reach a
conclusion. **It never builds.** Running it on the build box is a large over-allocation for a
clone-and-read workload (and, on a stack that hasn't provisioned ECS at all, it just fails at
session-start).

The current code has an explicit decision against the naive fix (`orchestrator.ts:242–252`): *"do
NOT special-case read-only workflows to agentcore … a repo big enough to need the ECS build tier for
building is also big enough to OOM the fixed AgentCore microVM just reading it."* That reasoning is
about **not routing a read-only task to the wrong substrate FAMILY** (ECS repo → AgentCore). It
does **not** say reading needs the *same size* as building. This proposal threads that needle: **same family
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
    share it (avoid drift in grants/env — the ECS-parity bugs in the history all came from one
    task role/env missing something the other had).
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
- The session-start guard (`ecs-strategy.ts:100`) stays as-is (it already fails honestly, with a
  clear message, when the ECS substrate isn't provisioned at all).

## 3. What this does NOT change
- **Substrate family routing is unchanged** — an ECS repo still plans on ECS (honors
  `orchestrator.ts:242`); an AgentCore repo still plans on AgentCore. This is purely "which ECS task
  def," not "which substrate."
- **AgentCore repos are untouched** — the AgentCore project this was verified on
  doesn't go near this.
- **No workflow logic changes.** Read-only behaviour is substrate-agnostic;
  this only affects the box an ECS-repo planning task runs on.

## 4. Why it's a separate workstream
- It edits `ecs-agent-cluster.ts`, `agent.ts`, `task-orchestrator.ts`, `ecs-strategy.ts` — all owned
  by the ECS-substrate workstream, which carries the context-gated `compute_type=ecs` deploy.
- It resolves a tension in `orchestrator.ts:242` that that workstream authored — so that workstream
  should own the change + the sizing call.
- Verifying it requires a `--context compute_type=ecs` deploy (provisions the Fargate substrate).
  The dev stack is currently `ComputeSubstrate: agentcore` (no ECS resources), so this is a net-new
  infra deploy — appropriately that workstream's call, not a side effect of this one.

## 5. Verification (done)
1. Deployed with `--context compute_type=ecs` (provisions both task defs). ✅
2. A read-only workflow on the ECS-substrate project → the task ran on the **8 GB planning def**
   (confirmed via the ECS task's `taskDefinitionArn`), emitted a plan, proposal posted. No OOM. ✅
3. A normal coding task on the same repo → ran on the **build def** (build def still selected
   for non-read-only workflows). ✅
4. Shared container helper (`makeTaskDef` + one `baseEnvironment`) keeps env/grants identical across
   both defs, so the two stay at parity (Linear OAuth reaction fires, artifact delivers, payload
   fetches). Enforced by construction and asserted in `ecs-agent-cluster.test.ts`. ✅
5. AgentCore regression: a read-only workflow on an AgentCore repo still runs on the microVM,
   unaffected by the `readOnly` flag (AgentCore ignores it). ✅

## 6. Open sizing question (starting point: 8 GB)
8 GB / 2 vCPU is the initial size. If a very large ECS-onboarded repo makes a read-only
clone + read approach the cap, size up in 8 GB steps on Container Insights `MemoryUtilized` evidence
(the same empirical method the build def was arrived at) — bump the `PlanningTaskDef` cpu/mem
in `ecs-agent-cluster.ts`. No code path change is needed to grow it.
