/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import type { BlueprintConfig, ComputeType } from './repo-config';
import { AgentCoreComputeStrategy } from './strategies/agentcore-strategy';
import { EcsComputeStrategy } from './strategies/ecs-strategy';
import { LambdaMicrovmComputeStrategy } from './strategies/lambda-microvm-strategy';

/**
 * Per-session compute handle, discriminated on ``strategyType``.
 *
 * ``sessionId`` is the shared key across every variant: it is what the
 * orchestrator persists as ``TaskRecord.session_id`` (and what
 * ``cancel-task.ts`` / ``pollTaskStatus`` read back), so every variant must
 * supply a non-empty, substrate-meaningful value. AgentCore uses a fresh UUID
 * (its ``runtimeSessionId`` must be ≥ 33 chars); ECS uses the task ARN; the
 * MicroVM backend uses the ``microvmId`` — see the note on the
 * ``lambda-microvm`` variant below.
 *
 * ADR-021 sub-decision 1: the MicroVM variant carries ``microvmId`` (every
 * lifecycle API — suspend/resume/terminate/get — takes only that identifier)
 * and ``endpoint`` (minted per session by ``RunMicrovm``, required for any
 * future orchestrator→agent HTTP interaction). The image ARN/version is
 * deliberately NOT in the handle: like the ECS task-definition ARN it is
 * deployment-time configuration consumed by ``startSession`` from the
 * construct-injected environment and recorded in the session-start log entry
 * for diagnostics, not per-session lifecycle state.
 */
export type SessionHandle =
  | { readonly sessionId: string; readonly strategyType: 'agentcore'; readonly runtimeArn: string }
  | { readonly sessionId: string; readonly strategyType: 'ecs'; readonly clusterArn: string; readonly taskArn: string }
  | { readonly sessionId: string; readonly strategyType: 'lambda-microvm'; readonly microvmId: string; readonly endpoint: string };

/**
 * Substrate-observed session state. Deliberately mechanical: the strategy
 * REPORTS, the orchestrator INTERPRETS (ADR-021 sub-decision 1 — "Poll
 * semantics"). ``pollSession`` receives only the handle and cannot see the
 * task's DynamoDB status, so no health rule may live in a strategy.
 *
 * ``suspended`` exists only for backends with an orchestrator-visible suspend
 * API (today: ``lambda-microvm``). It is NOT a health verdict — a suspended
 * MicroVM is healthy while the task is ``AWAITING_APPROVAL`` and an anomaly
 * otherwise, and only the orchestrator can tell the two apart.
 */
export type SessionStatus =
  | { readonly status: 'running' }
  | { readonly status: 'suspended' }
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly error: string };

export interface ComputeStrategy {
  readonly type: ComputeType;
  startSession(input: {
    taskId: string;
    /**
     * Stable user identifier (the task's Cognito sub) propagated to
     * AgentCore via `runtimeUserId` on `InvokeAgentRuntimeCommand`. Used
     * by AgentCore Identity to derive a workload access token and inject
     * it into the agent container via the `WorkloadAccessToken` request
     * header. Without this, `BedrockAgentCoreContext.get_workload_
     * access_token()` returns None inside the runtime and any code path
     * that resolves a credential through Identity (e.g.
     * `agent/src/config.py::resolve_linear_api_token`) silently
     * fails-closed. Phase 2.0a requirement.
     */
    userId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
  }): Promise<SessionHandle>;
  pollSession(handle: SessionHandle): Promise<SessionStatus>;
  stopSession(handle: SessionHandle): Promise<void>;
}

export function resolveComputeStrategy(blueprintConfig: BlueprintConfig): ComputeStrategy {
  const computeType: ComputeType = blueprintConfig.compute_type;
  switch (computeType) {
    case 'agentcore':
      return new AgentCoreComputeStrategy();
    case 'ecs':
      return new EcsComputeStrategy();
    case 'lambda-microvm':
      return new LambdaMicrovmComputeStrategy();
    default: {
      const _exhaustive: never = computeType;
      throw new Error(`Unknown compute_type: '${_exhaustive}'`);
    }
  }
}
