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

import type { MicrovmState } from '@aws-sdk/client-lambda-microvms';
import type { MicrovmImageMetadata } from './microvm/image-capability';
import type { BlueprintConfig, ComputeType } from './repo-config';
import { AgentCoreComputeStrategy } from './strategies/agentcore-strategy';
import { EcsComputeStrategy } from './strategies/ecs-strategy';
import { LambdaMicrovmComputeStrategy } from './strategies/lambda-microvm-strategy';

/**
 * Per-session compute handle, discriminated on ``strategyType``.
 *
 * ``sessionId`` is what the orchestrator persists as ``TaskRecord.session_id``:
 * every variant supplies a non-empty value. AgentCore uses a fresh UUID (its
 * ``runtimeSessionId`` must be ≥ 33 chars), ECS the task ARN, the MicroVM
 * backend the ``microvmId``.
 *
 * The MicroVM variant's image metadata describes the snapshot that launched
 * this worker, not the current deployment settings (ADR-021).
 */
export type SessionHandle =
  | { readonly sessionId: string; readonly strategyType: 'agentcore'; readonly runtimeArn: string }
  | { readonly sessionId: string; readonly strategyType: 'ecs'; readonly clusterArn: string; readonly taskArn: string }
  | ({ readonly sessionId: string; readonly strategyType: 'lambda-microvm'; readonly microvmId: string; readonly endpoint: string } & MicrovmImageMetadata);

/** UNKNOWN/NOT_FOUND are local observations, not AWS service states. */
export type MicrovmObservedState = MicrovmState | 'UNKNOWN' | 'NOT_FOUND';

/**
 * Substrate-observed session state: the strategy reports, the orchestrator
 * interprets (ADR-021).
 *
 * ``suspended`` is not a health verdict: a suspended MicroVM is healthy while the
 * task is ``AWAITING_APPROVAL`` and an anomaly otherwise.
 *
 * ``reason`` is the substrate's own explanation of the state, verbatim. Only
 * ``LambdaMicrovmComputeStrategy.pollSession`` sets it, from ``GetMicrovm``'s
 * ``stateReason``: it is not a cross-backend contract.
 */
export type SessionStatus = (
  | { readonly status: 'running'; readonly reason?: string }
  | { readonly status: 'suspended'; readonly reason?: string }
  | { readonly status: 'completed'; readonly reason?: string }
  | { readonly status: 'failed'; readonly error: string; readonly reason?: string }
) & {
  /** Explicit MicroVM observation; coarse `running` also covers pending/unknown. */
  readonly microvmState?: MicrovmObservedState;
  /** Service observations used to retain the original lifetime across durable replay. */
  readonly microvmStartedAtMs?: number;
  readonly microvmMaximumDurationSeconds?: number;
};

/** A caller may impose a shorter total budget across several control operations. */
export interface SessionControlOptions {
  readonly abortSignal?: AbortSignal;
}

/**
 * `supported: true` means the lifecycle command was acknowledged, not that the
 * target state has been reached. Callers must observe/reconcile the session.
 * Failures throw; they must never be disguised as an unsupported capability.
 */
export type SessionLifecycleResult =
  | { readonly supported: false }
  | { readonly supported: true };

/** Optional evidence from best-effort cleanup. A request is not confirmed teardown. */
export type SessionStopResult =
  | { readonly outcome: 'requested' | 'not-found' | 'terminated' }
  | { readonly outcome: 'unconfirmed'; readonly error_type: string; readonly aws_request_id?: string };

export interface ComputeStrategy {
  readonly type: ComputeType;
  startSession(input: {
    taskId: string;
    /**
     * Stable user identifier (the task's Cognito sub), sent to AgentCore as
     * `runtimeUserId`: AgentCore Identity derives the workload access token
     * from it.
     */
    userId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
    /**
     * True for a read-only workflow that clones and reads but never builds: the
     * ECS strategy picks the smaller planning task definition. The other
     * backends ignore it. Omitted means the build definition.
     */
    readOnly?: boolean;
  }): Promise<SessionHandle>;
  pollSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionStatus>;
  stopSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionStopResult | void>;
  suspendSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionLifecycleResult>;
  resumeSession(handle: SessionHandle, options?: SessionControlOptions): Promise<SessionLifecycleResult>;
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
