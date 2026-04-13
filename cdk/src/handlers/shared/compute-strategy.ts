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

export type SessionHandle =
  | { readonly sessionId: string; readonly strategyType: 'agentcore'; readonly runtimeArn: string }
  | { readonly sessionId: string; readonly strategyType: 'ecs'; readonly clusterArn: string; readonly taskArn: string };

export type SessionStatus =
  | { readonly status: 'running' }
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly error: string };

export interface ComputeStrategy {
  readonly type: ComputeType;
  startSession(input: {
    taskId: string;
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
    default: {
      const _exhaustive: never = computeType;
      throw new Error(`Unknown compute_type: '${_exhaustive}'`);
    }
  }
}
