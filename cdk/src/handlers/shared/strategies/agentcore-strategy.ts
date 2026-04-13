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

let sharedClient: BedrockAgentCoreClient | undefined;
function getClient(): BedrockAgentCoreClient {
  if (!sharedClient) {
    sharedClient = new BedrockAgentCoreClient({});
  }
  return sharedClient;
}

export class AgentCoreComputeStrategy implements ComputeStrategy {
  readonly type = 'agentcore';

  async startSession(input: {
    taskId: string;
    payload: Record<string, unknown>;
    blueprintConfig: BlueprintConfig;
  }): Promise<SessionHandle> {
    // AgentCore requires runtimeSessionId >= 33 chars; UUID v4 is 36 chars.
    const sessionId = randomUUID();
    const runtimeArn = input.blueprintConfig.runtime_arn;

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify({ input: input.payload })),
    });

    await getClient().send(command);

    logger.info('AgentCore session invoked', { task_id: input.taskId, session_id: sessionId, runtime_arn: runtimeArn });

    return {
      sessionId,
      strategyType: 'agentcore',
      runtimeArn,
    };
  }

  async pollSession(_handle: SessionHandle): Promise<SessionStatus> {
    return { status: 'running' };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    if (handle.strategyType !== 'agentcore') {
      throw new Error('stopSession called with non-agentcore handle');
    }
    const { runtimeArn } = handle;

    try {
      await getClient().send(new StopRuntimeSessionCommand({
        agentRuntimeArn: runtimeArn,
        runtimeSessionId: handle.sessionId,
      }));
      logger.info('AgentCore session stopped', { session_id: handle.sessionId });
    } catch (err) {
      const errName = err instanceof Error ? err.name : undefined;
      if (errName === 'ResourceNotFoundException') {
        logger.info('AgentCore session already gone', { session_id: handle.sessionId });
      } else if (errName === 'ThrottlingException' || errName === 'AccessDeniedException') {
        logger.error('Failed to stop AgentCore session', {
          session_id: handle.sessionId,
          error_type: errName,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        logger.warn('Failed to stop AgentCore session (best-effort)', {
          session_id: handle.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
