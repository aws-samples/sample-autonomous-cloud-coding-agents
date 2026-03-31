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

import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Duration } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for the AgentMemory construct.
 */
export interface AgentMemoryProps {
  /**
   * Name for the Memory resource.
   * Must start with a letter and be up to 48 characters (a-zA-Z0-9_).
   * @default 'bgagent_memory'
   */
  readonly memoryName?: string;

  /**
   * Short-term memory event expiration.
   * @default Duration.days(365)
   */
  readonly expirationDuration?: Duration;
}

/**
 * CDK construct wrapping an AgentCore Memory resource with semantic and episodic
 * extraction strategies for cross-task learning.
 *
 * The Memory resource stores:
 * - **Semantic records**: factual knowledge extracted from task episodes
 *   (e.g. repo conventions, build quirks, testing patterns)
 * - **Episodic records**: summarized interaction slices (task outcome, cost,
 *   duration, self-feedback) for pattern recognition
 *
 * Namespace design:
 *   Events are written with `actorId = "owner/repo"` and `sessionId = taskId`.
 *   The extraction strategies use namespace templates to place extracted records
 *   into hierarchical paths keyed by repository:
 *
 *   - Semantic: `/{actorId}/knowledge/`  →  e.g. `/krokoko/agent-plugins/knowledge/`
 *   - Episodic: `/{actorId}/episodes/{sessionId}/`  →  per-task episodes
 *   - Episodic reflection: `/{actorId}/episodes/`  →  cross-task summaries
 */
export class AgentMemory extends Construct {
  /**
   * The underlying AgentCore Memory resource.
   */
  public readonly memory: agentcore.Memory;

  constructor(scope: Construct, id: string, props?: AgentMemoryProps) {
    super(scope, id);

    this.memory = new agentcore.Memory(this, 'Memory', {
      memoryName: props?.memoryName ?? 'bgagent_memory',
      description: 'Cross-task interaction memory for background coding agents',
      expirationDuration: props?.expirationDuration ?? Duration.days(365),
      memoryStrategies: [
        agentcore.MemoryStrategy.usingSemantic({
          name: 'SemanticKnowledge',
          namespaces: ['/{actorId}/knowledge/'],
        }),
        agentcore.MemoryStrategy.usingEpisodic({
          name: 'TaskEpisodes',
          namespaces: ['/{actorId}/episodes/{sessionId}/'],
          reflectionConfiguration: {
            namespaces: ['/{actorId}/episodes/'],
          },
        }),
      ],
    });

    NagSuppressions.addResourceSuppressions(this.memory, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'AgentCore Memory execution role requires wildcard permissions for Bedrock model invocation used by memory extraction strategies',
      },
    ], true);
  }

  /**
   * Grant read + write access to the memory (for the agent runtime).
   * @param grantee - the principal to grant access to.
   */
  grantReadWrite(grantee: iam.IGrantable): void {
    this.memory.grantRead(grantee);
    this.memory.grantWrite(grantee);
  }
}
