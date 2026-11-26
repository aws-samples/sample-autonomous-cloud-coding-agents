# Right-sized ECS task def for read-only planning

> **Status:** IMPLEMENTED. Built as designed below: a second 8 GB / 2 vCPU planning
> Fargate task def in `EcsAgentCluster`, selected by `workflowIsReadOnly` in the ECS compute
> strategy. The full CDK build is green (2999 tests). The change was deployed to a dev stack with
> `--context compute_type=ecs` and verified end-to-end on an ECS-substrate project: a read-only
> workflow runs on the planning def, and a normal coding task still runs on the build def.
> Two things prompted the work. A read-only task on an ECS-substrate project failed at
> session-start because that stack had no ECS substrate provisioned. The more fundamental prompt
> was the question "does a clone-and-read task need the build box?" The sections below describe
> the shipped design. A few `.ts:NNN` line anchors are from the design snapshot and may have drifted.

## 1. Problem

An ECS-configured repo (`compute_type: ecs`) runs **every** task on the one Fargate task
definition in `EcsAgentCluster`, the BUILD tier. Its size is measured, not guessed. A fully
parallel `mise run build` of this repo (agent:quality ‖ cdk:build ‖ cli:build ‖ docs:build, and
each of them starts its own fleet of workers) peaks at about 31.6 GB and OOM-killed a 32 GB task.
The build tier serialises with `MISE_JOBS=1`, which brings the measured peak down to about 3.1 GB,
so the shipped default is 4 vCPU / 16 GB. That is roughly 5x headroom over what the build uses.

A read-only workflow such as `coding/pr-review-v1` clones the repo, then reads and greps to reach
a conclusion. **It never builds.** The build def is a large over-allocation for a clone-and-read
workload. On a stack that has not provisioned ECS at all, the workflow fails at session-start.

The current code records an explicit decision against the naive fix (`orchestrator.ts:335–337`): *"do
NOT special-case read-only workflows to agentcore … a repo big enough to need the ECS build tier for
building is also big enough to OOM the fixed AgentCore microVM just reading it."* That reasoning is
about **not routing a read-only task to the wrong substrate FAMILY**, which here means an ECS repo
sent to AgentCore. It does **not** say that reading needs the *same size* as building. This proposal
keeps the family and changes the size. An ECS repo plans on ECS, so the OOM concern is respected.
The planning task def is smaller, because planning does not build.

## 2. Proposal

Add a **second, smaller Fargate task definition** to `EcsAgentCluster` for **read-only** workflows,
and route by `workflowIsReadOnly` in the ECS compute strategy. Keep the 64 GB def for build
workflows.

### 2a. Construct — `ecs-agent-cluster.ts`
- Add a `planningTaskDefinition` (a second `FargateTaskDefinition`) alongside the existing
  `taskDefinition`. The suggested size is **8 GB / 2 vCPU**, a valid ARM64 Fargate combination.
  The workload is a clone, a read, and a bounded set of file reads into the model context. It has
  no parallel build. If 8 GB proves tight for a very large clone, 16 GB / 4 vCPU is the next step.
  Start small and size up on evidence, as the sizing history in the file does.
  - It reuses the SAME container image, log group, task role, execution role, session role,
    payload-bucket and artifacts-bucket grants, and env as the build def. The ONLY difference is
    `cpu`/`memoryLimitMiB`. Factor the container definition into a small helper so that both task
    defs share it. The helper prevents drift in grants and env. The ECS-parity bugs in the history
    all came from one task role or env that was missing something the other had.
  - Do NOT set `BUILD_VERIFY_TIMEOUT_S: '3600'` on the planning def. That setting belongs to the
    build tier. A read-only planner never runs the post-agent build verify.
- Expose `planningTaskDefinition.taskDefinitionArn` from the construct as a new public field, the
  same way as `taskDefinition`.

### 2b. Stack wiring — `agent.ts` + `task-orchestrator.ts`
- Pass the new ARN into the orchestrator's `ecsConfig` as `planningTaskDefinitionArn`
  (alongside the existing `taskDefinitionArn` at `agent.ts:994`).
- The orchestrator construct (`task-orchestrator.ts:353–357`) injects a new env var,
  `ECS_PLANNING_TASK_DEFINITION_ARN`, next to `ECS_TASK_DEFINITION_ARN`.

### 2c. Routing — `strategies/ecs-strategy.ts`
- `startSession` already receives `blueprintConfig`. Pass the **workflow id** (or a
  pre-computed `readOnly` boolean) into the strategy input. `orchestrate-task.ts` already computes
  `workflowIsReadOnly(workflowId)` for preflight (line 132), so pass that same boolean down.
- In `RunTaskCommand` (`ecs-strategy.ts:189–191`), select the task def:
  `taskDefinition: readOnly ? ECS_PLANNING_TASK_DEFINITION_ARN ?? ECS_TASK_DEFINITION_ARN : ECS_TASK_DEFINITION_ARN`.
  The `?? ECS_TASK_DEFINITION_ARN` fallback covers an older deploy where the planning def is not
  wired. The task then runs on the build def as it does today, never worse.
- The session-start guard (`ecs-strategy.ts:114`) stays as-is. It already fails with a clear
  message when the ECS substrate is not provisioned at all.

## 3. What this does NOT change
- **Substrate family routing is unchanged.** An ECS repo still plans on ECS, as
  `orchestrator.ts:335` requires. An AgentCore repo still plans on AgentCore. The change decides
  which ECS task def runs the task, not which substrate.
- **AgentCore repos are untouched.** The AgentCore project that this was verified on
  does not go near this change.
- **No workflow logic changes.** Read-only behaviour is substrate-agnostic. The change affects
  only the task def that an ECS-repo planning task runs on.

## 4. Why it's a separate workstream
- It edits `ecs-agent-cluster.ts`, `agent.ts`, `task-orchestrator.ts`, and `ecs-strategy.ts`. The
  ECS-substrate workstream owns all four files and carries the context-gated `compute_type=ecs`
  deploy.
- It resolves a tension in `orchestrator.ts:335`, which that workstream authored. That workstream
  should therefore own the change and the sizing decision.
- Verifying it requires a `--context compute_type=ecs` deploy, which provisions the Fargate
  substrate. The dev stack is currently `ComputeSubstrate: agentcore` and has no ECS resources, so
  the verification is a net-new infra deploy. That deploy is the ECS-substrate workstream's
  decision, not a side effect of this one.

## 5. Verification (done)
1. Deployed with `--context compute_type=ecs`, which provisions both task defs. ✅
2. A read-only workflow ran on the ECS-substrate project. The task ran on the **8 GB planning def**
   (confirmed by the ECS task's `taskDefinitionArn`) and emitted a plan, and the proposal was
   posted. No OOM. ✅
3. A normal coding task on the same repo ran on the **build def**. The build def is still selected
   for workflows that are not read-only. ✅
4. The shared container helper (`makeTaskDef` and one `baseEnvironment`) keeps env and grants
   identical across both defs, so the two stay at parity: the Linear OAuth reaction fires, the
   artifact delivers, and the payload fetches. Parity is enforced by construction and asserted in
   `ecs-agent-cluster.test.ts`. ✅
5. AgentCore regression check. A read-only workflow on an AgentCore repo still runs on the microVM.
   The `readOnly` flag does not affect it, because AgentCore ignores the flag. ✅

## 6. Open sizing question (starting point: 8 GB)
8 GB / 2 vCPU is the initial size. If a very large ECS-onboarded repo makes a read-only
clone and read approach the cap, size up in 8 GB steps on Container Insights `MemoryUtilized`
evidence. The build def was sized by the same empirical method. To size up, raise the
`PlanningTaskDef` cpu and mem in `ecs-agent-cluster.ts`. No code path change is needed.
