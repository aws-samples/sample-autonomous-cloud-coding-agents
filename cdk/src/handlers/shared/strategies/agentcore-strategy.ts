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

import { randomUUID } from 'crypto';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { ComputeStrategy, SessionHandle, SessionStatus } from '../compute-strategy';
import { logger } from '../logger';
import type { BlueprintConfig } from '../repo-config';

export class AgentCoreComputeStrategy implements ComputeStrategy {
  readonly type = 'agentcore';
  private readonly client: BedrockAgentCoreClient;
  private readonly runtimeArn: string;

  constructor(options: { runtimeArn: string }) {
    this.runtimeArn = options.runtimeArn;
    this.client = new BedrockAgentCoreClient({});
  }

  async startSession(input: {
    taskId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
  }): Promise<SessionHandle> {
    // AgentCore requires runtimeSessionId >= 33 chars; UUID v4 is 36 chars.
    const sessionId = randomUUID();
    const runtimeArn = input.blueprintConfig.runtime_arn ?? this.runtimeArn;

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify({ input: input.payload })),
    });

    await this.client.send(command);

    logger.info('AgentCore session invoked', { task_id: input.taskId, session_id: sessionId, runtime_arn: runtimeArn });

    return {
      sessionId,
      strategyType: this.type,
      metadata: { runtimeArn },
    };
  }

  async pollSession(_handle: SessionHandle): Promise<SessionStatus> {
    // Polling is currently done at the orchestrator level via DDB reads.
    // This method exists for PR 2 where different strategies may poll differently.
    return { status: 'running' };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    const runtimeArn = handle.metadata.runtimeArn as string | undefined;
    if (!runtimeArn) {
      logger.warn('No runtimeArn in session handle, cannot stop session', { session_id: handle.sessionId });
      return;
    }

    try {
      await this.client.send(new StopRuntimeSessionCommand({
        agentRuntimeArn: runtimeArn,
        runtimeSessionId: handle.sessionId,
      }));
      logger.info('AgentCore session stopped', { session_id: handle.sessionId });
    } catch (err) {
      logger.warn('Failed to stop AgentCore session (best-effort)', {
        session_id: handle.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
