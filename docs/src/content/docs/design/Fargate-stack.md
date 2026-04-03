---
title: Fargate stack
---

# FargateAgentStack Design Document

## 1. Overview

This document describes the design for a new **FargateAgentStack** that provides an alternative compute backend for autonomous coding agents using **AWS Fargate** containers orchestrated by **AWS Step Functions**. It coexists alongside the existing `AgentStack` (which uses AgentCore Runtime + durable Lambda) and shares the same DynamoDB tables, VPC, and secrets.

### Motivation

- Offer a Fargate-based compute option alongside AgentCore Runtime
- Replace polling-based durable Lambda orchestration with Step Functions' native ECS `.sync` integration
- Leverage patterns proven in the `idp-human-validation` reference project (Lambda + containers + Step Functions)

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Stack relationship | Separate, coexisting stack | Zero risk to existing AgentStack |
| Orchestration | Step Functions Standard | Native ECS RunTask `.sync` — no polling loop needed |
| Agent code | Reuse existing `agent/` | Same Dockerfile, same `entrypoint.py` batch mode |
| Shared resources | Cross-stack references | Shared DDB tables, VPC, secrets via public props |
| API routing | Blueprint `compute_type` field | Shared API, per-repo routing via existing Blueprint config |
| Security group | Reuse AgentCore runtime SG | Identical network needs; one set of rules to manage |
| DNS Firewall | Inherited (same VPC) | Fargate tasks in private subnets automatically get DNS filtering |
| Bedrock Guardrails | Inherited (shared API) | Input screening runs in `create-task-core.ts` before routing |
| Concurrency limits | Account-level Fargate quota (500 tasks) | Per-user concurrency still enforced via DynamoDB |
| Fargate Spot | No | Latency and performance prioritized over cost savings |

---

## 2. Architecture

### API Routing

The existing `TaskApi` is shared by both stacks. Routing is controlled by the `compute_type` field in the per-repo `Blueprint` construct (which writes to the `RepoTable` at deploy time). The `create-task-core.ts` handler reads the repo config and dispatches accordingly:

```
POST /tasks  →  create-task-core.ts
                     │
                     ├─ Load repo config from RepoTable
                     │
                     ├─ compute_type === "fargate"
                     │      → sfnClient.startExecution({ stateMachineArn, input: { task_id } })
                     │
                     └─ compute_type === "agentcore" (default)
                            → lambdaClient.invoke({ FunctionName: orchestratorArn, InvocationType: 'Event' })
```

This requires:
1. A new env var `STATE_MACHINE_ARN` on the create-task Lambda (set by `TaskApi` construct)
2. A small conditional in `create-task-core.ts` to branch on `compute_type`
3. IAM: `states:StartExecution` permission on the create-task Lambda role
4. The `TaskApi` construct accepts an optional `stateMachineArn` prop

### Resource Diagram

```
                    ┌─────────────────────────────────────────┐
                    │           AgentStack (existing)          │
                    │  ┌──────┐ ┌────────┐ ┌───────────────┐  │
                    │  │ VPC  │ │ DDB    │ │ Secrets Mgr   │  │
                    │  │      │ │ Tables │ │ (GitHub PAT)  │  │
                    │  └──┬───┘ └───┬────┘ └──────┬────────┘  │
                    │     │         │              │           │
                    │  ┌──┴─────────┴──────────────┴────────┐ │
                    │  │  AgentCore Runtime + Durable Lambda │ │
                    │  └────────────────────────────────────┘  │
                    └──────┬────────┬──────────────┬───────────┘
          cross-stack refs │        │              │
                    ┌──────▼────────▼──────────────▼───────────┐
                    │         FargateAgentStack (new)           │
                    │                                           │
                    │  ┌─────────────────────────────────────┐  │
                    │  │   Step Functions State Machine       │  │
                    │  │                                     │  │
                    │  │  LoadTask ──► AdmissionControl      │  │
                    │  │     ──► HydrateContext               │  │
                    │  │     ──► TransitionToRunning          │  │
                    │  │     ──► RunFargateTask (.sync)       │  │
                    │  │     ──► FinalizeTask                 │  │
                    │  └────────────────┬────────────────────┘  │
                    │                   │                        │
                    │  ┌────────────────▼────────────────────┐  │
                    │  │   ECS Fargate Cluster               │  │
                    │  │   Task Def: agent/Dockerfile        │  │
                    │  │   CMD: python /app/entrypoint.py    │  │
                    │  │   4 vCPU / 16 GB / 100 GB ephemeral │  │
                    │  └────────────────────────────────────┘  │
                    │                                           │
                    │  ┌────────────────────────────────────┐   │
                    │  │   Step Function Lambda Handlers    │   │
                    │  │   (6 thin wrappers over shared/)   │   │
                    │  └────────────────────────────────────┘   │
                    └───────────────────────────────────────────┘
```

### Comparison with Existing Stack

| Aspect | AgentStack (existing) | FargateAgentStack (new) |
|--------|----------------------|------------------------|
| Compute | AgentCore Runtime (MicroVM) | ECS Fargate |
| Orchestration | Durable Lambda (checkpoint/replay) | Step Functions Standard |
| Completion detection | Poll DDB every 30s for terminal status | ECS RunTask `.sync` (native wait) |
| Max duration | 9 hours (Lambda timeout) | Up to 1 year (Step Functions) |
| Container model | FastAPI server, HTTP invocation | Batch mode, run-to-completion |
| State visibility | Custom DDB + CloudWatch | Step Functions execution history + visual graph |
| Error handling | Try/catch in code | Declarative retries, catch states |

---

## 3. Step Functions State Machine

### Flow

```
StartExecution { task_id }
  │
  ▼
┌──────────────────────┐
│  LoadTaskAndBlueprint │ Lambda: load-task.ts
│  Retry: 3x, backoff  │ Calls: loadTask() + loadBlueprintConfig()
└──────────┬───────────┘ Output: { task, blueprintConfig }
           │
           ▼
┌──────────────────────┐
│  AdmissionControl    │ Lambda: admission-control.ts
│  Retry: 2x, backoff  │ Calls: admissionControl()
└──────────┬───────────┘ Output: { admitted, task, blueprintConfig }
           │
     ┌─────┴─────┐
     │ Choice:    │
     │ admitted?  │
     └─────┬─────┘
     No    │    Yes
     │     │
     ▼     ▼
  ┌──────┐ ┌──────────────────────┐
  │ Fail │ │  HydrateContext      │ Lambda: hydrate-context.ts
  │ Task │ │  Retry: 2x, backoff  │ Calls: hydrateAndTransition()
  └──────┘ └──────────┬───────────┘ Output: { task, payload }
                      │
                      ▼
           ┌──────────────────────┐
           │  TransitionToRunning │ Lambda: transition-to-running.ts
           │                      │ HYDRATING → RUNNING
           └──────────┬───────────┘ Output: { task, containerOverrides }
                      │
                      ▼
           ┌──────────────────────────────────┐
           │  RunFargateTask                  │ ECS RunTask (.sync)
           │  Timeout: 8 hours               │ Container: agent/Dockerfile
           │  Heartbeat: 30 min              │ Env vars from payload
           │  No retry (not idempotent)       │
           └──────────┬───────────────────────┘
                      │
                      ▼
           ┌──────────────────────┐
           │  FinalizeTask        │ Lambda: finalize-task.ts
           │  Retry: 3x, backoff  │ Calls: finalizeTask()
           └──────────┬───────────┘ Releases concurrency
                      │
                      ▼
                   Succeed
```

### Error Handling

Every step has a `.addCatch()` that routes to a shared **HandleError** state:

```
Any Step ──[error]──► HandleError (Lambda)
                        │
                        ├─ Read current task status from DDB
                        ├─ Transition to FAILED with error details
                        ├─ Release concurrency (if acquired)
                        ├─ Emit failure event
                        │
                        ▼
                      Fail
```

### Retry Policies

| Step | Max Retries | Backoff | Interval | Errors Retried |
|------|-------------|---------|----------|---------------|
| LoadTaskAndBlueprint | 3 | 2x | 1s | States.ALL (except States.TaskFailed) |
| AdmissionControl | 2 | 2x | 1s | DynamoDB transient errors |
| HydrateContext | 2 | 2x | 2s | GitHub API, Secrets Manager transient |
| TransitionToRunning | 2 | 2x | 1s | DynamoDB transient errors |
| RunFargateTask | 0 | — | — | Not idempotent |
| FinalizeTask | 3 | 2x | 1s | DynamoDB transient errors |

### Payload Passing Strategy

Step Functions has a **256 KB payload limit**. The hydrated context (issue body, comments, memory) could approach this. Mitigation strategy:

- **Option A (default)**: Pass full payload through state machine. For most tasks this fits within 256 KB.
- **Option B (fallback)**: If payload exceeds limit, store it in DynamoDB (new `payload` field on task record) and pass only `task_id` to the Fargate container. The agent reads it at startup.

---

## 4. Fargate Task Definition

### Container Specification

| Property | Value | Rationale |
|----------|-------|-----------|
| CPU | 4096 (4 vCPU) | Agent runs git, builds, linters |
| Memory | 16384 (16 GB) | Repo clones + build processes |
| Ephemeral Storage | 100 GB | Large repos with dependencies |
| Platform | LINUX/ARM64 | Cost-efficient, matches Lambda ARM64 |
| Image | `agent/Dockerfile` (fromAsset) | Reuse existing agent image |
| Command | `["python", "/app/entrypoint.py"]` | Batch mode (not server mode) |
| Network | awsvpc, private subnets + NAT | Same VPC as AgentCore |

### Environment Variables

Set via Step Functions container overrides at runtime:

| Variable | Source | Description |
|----------|--------|-------------|
| `TASK_ID` | Payload | Task identifier |
| `REPO_URL` | Payload | Repository to clone |
| `BRANCH_NAME` | Payload | Branch to create |
| `ISSUE_NUMBER` | Payload (optional) | GitHub issue number |
| `PROMPT` | Payload (optional) | Task description |
| `MAX_TURNS` | Blueprint/task config | Max agent turns |
| `MAX_BUDGET_USD` | Blueprint/task config | Max cost budget |
| `MODEL_ID` | Blueprint config | Bedrock model ID |
| `GITHUB_TOKEN_SECRET_ARN` | Stack config | Secrets Manager ARN |
| `AWS_REGION` | Stack config | Deployment region |
| `TASK_TABLE_NAME` | Stack config | DynamoDB table name |
| `TASK_EVENTS_TABLE_NAME` | Stack config | Events table name |
| `USER_CONCURRENCY_TABLE_NAME` | Stack config | Concurrency table |
| `CLAUDE_CODE_USE_BEDROCK` | `"1"` | Use Bedrock backend |
| `MEMORY_ID` | Stack config (optional) | AgentCore Memory ID |

### IAM Permissions (Task Role)

| Service | Actions | Resource |
|---------|---------|----------|
| DynamoDB | Read/Write | Task table, Events table, Concurrency table |
| Secrets Manager | GetSecretValue | GitHub token secret |
| Bedrock | InvokeModel | Claude Sonnet 4.6, Haiku 4.5, cross-region profiles |
| Bedrock AgentCore | Memory read/write | Memory ID (if configured) |
| CloudWatch Logs | CreateLogStream, PutLogEvents | `/ecs/fargate-agent` log group |

### Agent Compatibility

The existing `agent/entrypoint.py` already supports batch mode (line 5-6):
> Supports two modes:
> - Local batch mode: `python entrypoint.py` (reads config from env vars)
> - AgentCore server mode: imported by server.py via `run_task()`

No changes to agent code are required. The Fargate container runs `entrypoint.py` directly, which:
1. Resolves GitHub token from Secrets Manager
2. Clones repo, creates branch
3. Runs setup (mise install, initial build)
4. Invokes Claude Code SDK
5. Post-hooks (commit, verify build/lint, ensure PR)
6. Writes terminal status to DynamoDB
7. Writes memory (task episodes + repo learnings)
8. Exits with code 0 (success) or non-zero (failure)

Step Functions detects completion via the Fargate task exit code (`.sync` pattern), not DDB polling.

---

## 5. Step Function Lambda Handlers

Six thin Lambda handlers in `src/handlers/sfn-steps/`, each wrapping existing logic from `src/handlers/shared/orchestrator.ts`:

### Handler Specifications

| Handler | Input | Calls | Output |
|---------|-------|-------|--------|
| `load-task.ts` | `{ task_id }` | `loadTask()` + `loadBlueprintConfig()` | `{ task, blueprintConfig }` |
| `admission-control.ts` | `{ task, blueprintConfig }` | `admissionControl()` | `{ admitted, task, blueprintConfig }` |
| `hydrate-context.ts` | `{ task, blueprintConfig }` | `hydrateAndTransition()` | `{ task, blueprintConfig, payload }` |
| `transition-to-running.ts` | `{ task, payload }` | `transitionTask()` + `emitTaskEvent()` | `{ task, containerOverrides }` |
| `finalize-task.ts` | `{ task }` | `finalizeTask()` | `{ status: "finalized" }` |
| `handle-error.ts` | `{ Error, Cause, task_id, user_id, concurrency_acquired }` | `failTask()` | `{ status: "failed" }` |

### Design Principles

- **No duplicated logic** — all handlers import from `../shared/orchestrator`
- **Stateless** — all state flows through the Step Functions payload
- **Same env vars** as existing handlers: `TASK_TABLE_NAME`, `TASK_EVENTS_TABLE_NAME`, etc.
- **Same Lambda config** as existing handlers: NodejsFunction, ARM64, Node 24, esbuild bundling

---

## 6. Cross-Stack Resource Sharing

### Approach

The `AgentStack` exposes shared resources as public readonly properties. The `FargateAgentStack` receives them as props in `main.ts`.

### Resources Shared

| Resource | AgentStack Property | FargateAgentStack Prop |
|----------|-------------------|----------------------|
| VPC | `agentVpc.vpc` | `vpc: ec2.IVpc` |
| Runtime Security Group | `agentVpc.runtimeSecurityGroup` | `runtimeSecurityGroup: ec2.ISecurityGroup` |
| Task Table | `taskTable.table` | `taskTable: dynamodb.ITable` |
| Task Events Table | `taskEventsTable.table` | `taskEventsTable: dynamodb.ITable` |
| Concurrency Table | `userConcurrencyTable.table` | `userConcurrencyTable: dynamodb.ITable` |
| Repo Table | `repoTable.table` | `repoTable: dynamodb.ITable` |
| GitHub Token Secret | `githubTokenSecret` | `githubTokenSecret: secretsmanager.ISecret` |
| AgentCore Memory ID | `agentMemory.memory.memoryId` | `memoryId?: string` |

### main.ts Wiring

```typescript
const agentStack = new AgentStack(app, 'backgroundagent-dev', {
  env: devEnv,
  description: 'ABCA Development Stack',
});

new FargateAgentStack(app, 'backgroundagent-fargate-dev', {
  env: devEnv,
  description: 'ABCA Fargate Development Stack',
  vpc: agentStack.agentVpc.vpc,
  runtimeSecurityGroup: agentStack.agentVpc.runtimeSecurityGroup,
  taskTable: agentStack.taskTable.table,
  taskEventsTable: agentStack.taskEventsTable.table,
  userConcurrencyTable: agentStack.userConcurrencyTable.table,
  repoTable: agentStack.repoTable.table,
  githubTokenSecret: agentStack.githubTokenSecret,
  memoryId: agentStack.agentMemory.memory.memoryId,
});
```

---

## 7. VPC Endpoints

The Fargate stack requires additional VPC interface endpoints beyond what the existing `AgentVpc` provides:

| Endpoint | Service | Purpose |
|----------|---------|---------|
| `com.amazonaws.<region>.ecs` | ECS | ECS API calls for task management |
| `com.amazonaws.<region>.ecs-agent` | ECS Agent | Container agent communication |
| `com.amazonaws.<region>.ecs-telemetry` | ECS Telemetry | Container telemetry |
| `com.amazonaws.<region>.states` | Step Functions | `.sync` callback from ECS to Step Functions |

These endpoints ensure Fargate tasks and Step Functions callbacks route through the VPC rather than through the NAT gateway.

---

## 8. User Stories

### Story 1: Expose Shared Resources from AgentStack

**As a** platform developer
**I want** the existing `AgentStack` to expose its shared resources as public readonly properties
**So that** the new `FargateAgentStack` can reference them via cross-stack props

**Files to modify:** `src/stacks/agent.ts`

**Changes:** Promote local `const` variables (`taskTable`, `taskEventsTable`, `userConcurrencyTable`, `repoTable`, `webhookTable`, `agentVpc`, `githubTokenSecret`, `agentMemory`) to `public readonly` instance properties. Update all downstream references within the constructor.

**Completion criteria:**
- All 8 resources are public readonly properties on `AgentStack`
- `npx projen build` passes with no changes to existing behavior
- `npx projen synth` produces an unchanged CloudFormation template

---

### Story 2: Create Fargate Agent Cluster Construct

**As a** platform developer
**I want** an ECS Fargate construct that defines the agent container task
**So that** Step Functions can launch agent tasks on Fargate

**Files to create:**
- `src/constructs/fargate-agent-cluster.ts`
- `test/constructs/fargate-agent-cluster.test.ts`

**Completion criteria:**
- Construct synthesizes a valid CloudFormation template
- Task definition: 4 vCPU, 16 GB memory, 100 GB ephemeral storage
- Container image builds from `agent/Dockerfile`
- Task role has DDB, Secrets, Bedrock, Memory permissions
- cdk-nag passes with documented suppressions
- Unit tests verify resource properties and IAM policies

---

### Story 3: Create Step Functions Orchestration Construct

**As a** platform developer
**I want** a Step Functions state machine that orchestrates the task lifecycle
**So that** tasks flow through load, admit, hydrate, run (Fargate), finalize

**Files to create:**
- `src/constructs/task-step-function.ts`
- `test/constructs/task-step-function.test.ts`

**Completion criteria:**
- State machine has all 7 states with correct transitions
- `RunFargateTask` uses `.sync` integration pattern (no polling)
- Error catch routes exist on every step
- State machine timeout: 9 hours; Fargate task timeout: 8 hours
- Retry policies per step as specified
- cdk-nag passes
- Tests verify state machine definition structure

---

### Story 4: Create Step Functions Step Lambda Handlers

**As a** platform developer
**I want** thin Lambda handlers for each Step Functions step
**So that** the state machine can invoke existing orchestrator logic without duplication

**Files to create:**
- `src/handlers/sfn-steps/load-task.ts`
- `src/handlers/sfn-steps/admission-control.ts`
- `src/handlers/sfn-steps/hydrate-context.ts`
- `src/handlers/sfn-steps/transition-to-running.ts`
- `src/handlers/sfn-steps/finalize-task.ts`
- `src/handlers/sfn-steps/handle-error.ts`
- Corresponding test files in `test/handlers/sfn-steps/`

**Completion criteria:**
- 6 handlers, each under 80 lines
- All import from `../shared/orchestrator` — no duplicated logic
- Input/output types align with Step Functions payload passing
- Unit tests with mocked DDB/Secrets cover success and error paths

---

### Story 5: Create the FargateAgentStack

**As a** platform developer
**I want** a complete CDK stack composing the Fargate cluster, Step Functions, and step handlers
**So that** it can be deployed as an alternative compute backend

**Files to create:**
- `src/stacks/fargate-agent.ts`
- `test/stacks/fargate-agent.test.ts`

**Completion criteria:**
- Stack synthesizes: 1 ECS Cluster, 1 Fargate Task Def, 1 State Machine, 6 Lambdas
- Cross-stack props correctly wired
- CfnOutputs: `StateMachineArn`, `ClusterArn`, `TaskDefinitionArn`
- cdk-nag `AwsSolutionsChecks` passes
- Unit tests verify resource counts and key properties

---

### Story 6: Wire FargateAgentStack into main.ts

**As a** platform developer
**I want** the new stack instantiated in the CDK app alongside the existing stack
**So that** both can be deployed independently

**Files to modify:** `src/main.ts`

**Completion criteria:**
- `npx projen synth` produces two templates: `backgroundagent-dev` and `backgroundagent-fargate-dev`
- Original template has no resource changes (only export additions)
- New template contains expected ECS, Step Functions, and Lambda resources
- `npx projen build` passes

---

### Story 7: VPC Endpoints for ECS and Step Functions

**As a** platform developer
**I want** VPC interface endpoints for ECS and Step Functions
**So that** Fargate tasks and state machine callbacks stay within the VPC

**Files to modify:** `src/constructs/agent-vpc.ts`

**Completion criteria:**
- VPC endpoints for ECS (ecs, ecs-agent, ecs-telemetry) and Step Functions (states)
- Endpoints in private subnets with correct security group
- Existing VPC endpoints unchanged
- CDK assertion tests verify new endpoint resources

---

### Story 8: Blueprint Routing — Shared API Dispatch

**As a** platform developer
**I want** the existing `TaskApi` to route tasks to either AgentCore or Step Functions based on Blueprint config
**So that** users interact with a single API regardless of compute backend

**Files to modify:**
- `src/handlers/shared/create-task-core.ts` — add conditional dispatch logic
- `src/constructs/task-api.ts` — accept optional `stateMachineArn` prop, pass as env var to create-task Lambdas, grant `states:StartExecution`

**Files to create:**
- `test/handlers/create-task-sfn-routing.test.ts` — unit tests for the routing logic

**Implementation details:**
- After creating the task record, check `repoConfig.compute_type`:
  - `"fargate"` → `sfnClient.startExecution({ stateMachineArn, input: { task_id } })`
  - `"agentcore"` (default) → existing `lambdaClient.invoke()` path
- Add `@aws-sdk/client-sfn` to the create-task Lambda bundle (already available in Node runtime)
- `TaskApi` construct gets a new optional prop: `stateMachineArn?: string`
- If `stateMachineArn` is set, the construct grants `states:StartExecution` on the create-task Lambda role

**Completion criteria:**
- Tasks for repos with `compute_type: "agentcore"` continue to use durable Lambda (no behavior change)
- Tasks for repos with `compute_type: "fargate"` start a Step Functions execution
- If `STATE_MACHINE_ARN` env var is not set, all tasks route to durable Lambda (backwards compatible)
- Unit tests cover both routing paths and the missing-env-var fallback

---

### Story 9: Fargate Task Dashboard

**As a** platform operator
**I want** a CloudWatch dashboard for the Fargate compute backend
**So that** I can monitor task outcomes, durations, costs, and Fargate resource utilization

**Files to create:**
- `src/constructs/fargate-task-dashboard.ts`
- `test/constructs/fargate-task-dashboard.test.ts`

**Implementation details (following `task-dashboard.ts` pattern):**
- CloudWatch dashboard with Logs Insights widgets:
  - Task outcomes (completed, failed, timed_out) from `/ecs/fargate-agent` log group
  - Task duration distribution
  - Agent cost per task (token usage)
  - Agent turns per task
  - Build/lint success rates
  - Error breakdown
- Step Functions metrics widgets:
  - Execution count (started, succeeded, failed, timed out)
  - Execution duration (p50, p90, p99)
  - State transition count
- ECS Fargate metrics widgets:
  - Running task count
  - CPU utilization
  - Memory utilization
  - Task launch time (from PENDING to RUNNING)
- Dashboard name: `FargateAgent-Dashboard`

**Completion criteria:**
- Dashboard construct creates a valid CloudWatch dashboard
- Includes Logs Insights, Step Functions, and ECS metric widgets
- Follows the same construct pattern as existing `TaskDashboard`
- cdk-nag passes
- Unit tests verify dashboard body contains expected widgets

---

### Story 10: End-to-End Integration Verification

**As a** platform developer
**I want** to verify the full pipeline works end-to-end
**So that** I'm confident the Fargate stack can run coding tasks

**Test plan (manual):**
1. Deploy both stacks: `npx projen deploy --all`
2. Start a Step Functions execution with a valid `task_id`
3. Monitor: verify each step completes in the visual graph
4. Check Fargate task starts in ECS console
5. Verify CloudWatch logs at `/ecs/fargate-agent`
6. Verify DDB task record transitions: SUBMITTED -> HYDRATING -> RUNNING -> COMPLETED
7. Test error handling: invalid repo -> verify FAILED transition
8. Test Fargate task failure: kill task -> verify HandleError catches it

---

## 9. Implementation Order

| Phase | Stories | Can Parallelize? |
|-------|---------|-----------------|
| 1 | Story 1 (expose props) | Yes — independent |
| 1 | Story 4 (step handlers) | Yes — independent |
| 1 | Story 2 (Fargate construct) | Yes — independent |
| 1 | Story 7 (VPC endpoints) | Yes — independent |
| 2 | Story 3 (Step Functions construct) | After Stories 2 + 4 |
| 2 | Story 9 (Fargate dashboard) | Yes — independent of Stories 2-4 |
| 3 | Story 5 (FargateAgentStack) | After Stories 1-4, 7, 9 |
| 4 | Story 6 (main.ts wiring) | After Stories 1 + 5 |
| 4 | Story 8 (Blueprint routing) | After Stories 5 + 6 |
| 5 | Story 10 (E2E verification) | After all |

---

## 10. Cost Comparison

| Component | AgentCore (current) | Fargate (new) |
|-----------|-------------------|---------------|
| Compute (30 min task) | AgentCore MicroVM pricing | ~$0.15 (4 vCPU, 16 GB, ARM64) |
| Compute (60 min task) | AgentCore MicroVM pricing | ~$0.30 |
| Orchestration | Durable Lambda (~$0.001) | Step Functions (~$0.001 for ~40 transitions) |
| Container startup | ~10s (warm MicroVM) | ~60-180s (Fargate cold start) |
| Ephemeral storage | Included in MicroVM | +$0.005/GB/hr for >20 GB |

### Decisions
- **No Fargate Spot** — latency and performance are prioritized over cost savings
- **Account-level Fargate limits** — rely on AWS default service quota (500 tasks/region) rather than custom limits; per-user concurrency is still enforced via DynamoDB
- Fargate cold starts (1-3 min) are slower than AgentCore warm MicroVMs
- Step Functions provides free-tier of 4,000 state transitions/month

---

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Fargate cold start latency (1-3 min) | Slower task startup | Pre-pull images, keep image lean, layer caching |
| Step Functions 256 KB payload limit | Large hydrated contexts may exceed limit | Store payload in DDB, pass only task_id (Option B) |
| Cross-stack reference coupling | Cannot delete AgentStack resources if Fargate stack depends on them | Use SSM Parameter Store for loose coupling if needed |
| Agent batch mode env var compatibility | Missing/mismatched env vars | Verify all env vars in `entrypoint.py` are mapped in container overrides |
| Container image size (~2 GB) | Slow ECR pull, high storage cost | Multi-stage Dockerfile, ARM64 base, layer caching |

---

## 12. Files Reference

### New Files

| File | Story | Description |
|------|-------|-------------|
| `src/stacks/fargate-agent.ts` | 5 | FargateAgentStack definition |
| `src/constructs/fargate-agent-cluster.ts` | 2 | ECS Fargate construct |
| `src/constructs/task-step-function.ts` | 3 | Step Functions construct |
| `src/handlers/sfn-steps/load-task.ts` | 4 | Load task + blueprint handler |
| `src/handlers/sfn-steps/admission-control.ts` | 4 | Admission control handler |
| `src/handlers/sfn-steps/hydrate-context.ts` | 4 | Context hydration handler |
| `src/handlers/sfn-steps/transition-to-running.ts` | 4 | Status transition handler |
| `src/handlers/sfn-steps/finalize-task.ts` | 4 | Finalization handler |
| `src/handlers/sfn-steps/handle-error.ts` | 4 | Error handling handler |
| `test/stacks/fargate-agent.test.ts` | 5 | Stack tests |
| `test/constructs/fargate-agent-cluster.test.ts` | 2 | Fargate construct tests |
| `test/constructs/task-step-function.test.ts` | 3 | Step Functions construct tests |
| `test/handlers/sfn-steps/*.test.ts` | 4 | Handler unit tests (6 files) |

| `src/constructs/fargate-task-dashboard.ts` | 9 | Fargate dashboard construct |
| `test/constructs/fargate-task-dashboard.test.ts` | 9 | Dashboard construct tests |
| `test/handlers/create-task-sfn-routing.test.ts` | 8 | Routing logic tests |

### Modified Files

| File | Story | Change |
|------|-------|--------|
| `src/stacks/agent.ts` | 1 | Expose public readonly properties |
| `src/constructs/agent-vpc.ts` | 7 | Add ECS + Step Functions VPC endpoints |
| `src/main.ts` | 6 | Add FargateAgentStack instantiation |
| `src/handlers/shared/create-task-core.ts` | 8 | Add conditional dispatch (SFN vs Lambda) |
| `src/constructs/task-api.ts` | 8 | Accept optional `stateMachineArn` prop |

### Reused Files (no changes)

| File | Used By | Purpose |
|------|---------|---------|
| `src/handlers/shared/orchestrator.ts` | Story 4 handlers | All orchestration logic |
| `src/handlers/shared/context-hydration.ts` | hydrate-context handler | Context assembly |
| `src/handlers/shared/types.ts` | All handlers | TypeScript interfaces |
| `src/handlers/shared/repo-config.ts` | load-task handler | Blueprint loading |
| `src/handlers/shared/memory.ts` | finalize-task handler | Memory fallback |
| `src/constructs/task-status.ts` | All handlers | Status constants + transitions |
| `agent/Dockerfile` | Fargate construct | Container image |
| `agent/entrypoint.py` | Fargate runtime | Batch mode entry point |
