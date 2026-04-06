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

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AgentMemory } from '../../src/constructs/agent-memory';

function createStack(props?: { memoryName?: string; expirationDuration?: Duration }): {
  stack: Stack;
  template: Template;
  agentMemory: AgentMemory;
} {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const agentMemory = new AgentMemory(stack, 'AgentMemory', props);

  const template = Template.fromStack(stack);
  return { stack, template, agentMemory };
}

describe('AgentMemory construct', () => {
  test('creates a Memory resource', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
  });

  test('uses default memory name', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      Name: 'bgagent_memory',
    });
  });

  test('accepts custom memory name', () => {
    const { template } = createStack({ memoryName: 'custom_memory' });
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      Name: 'custom_memory',
    });
  });

  test('sets description on the memory', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      Description: Match.stringLikeRegexp('Cross-task interaction memory'),
    });
  });

  test('configures memory strategies with namespace templates', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
      MemoryStrategies: Match.arrayWith([
        Match.objectLike({
          SemanticMemoryStrategy: Match.objectLike({
            Name: 'SemanticKnowledge',
            Namespaces: ['/{actorId}/knowledge/'],
          }),
        }),
        Match.objectLike({
          EpisodicMemoryStrategy: Match.objectLike({
            Name: 'TaskEpisodes',
            Namespaces: ['/{actorId}/episodes/{sessionId}/'],
          }),
        }),
      ]),
    });
  });

  test('exposes memory property', () => {
    const { agentMemory } = createStack();
    expect(agentMemory.memory).toBeDefined();
    expect(agentMemory.memory.memoryId).toBeDefined();
  });

  test('grantReadWrite grants both read and write permissions', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const agentMemory = new AgentMemory(stack, 'AgentMemory');

    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    agentMemory.grantReadWrite(role);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          // Read permissions
          Match.objectLike({
            Action: Match.arrayWith([
              'bedrock-agentcore:RetrieveMemoryRecords',
            ]),
            Effect: 'Allow',
          }),
          // Write permissions
          Match.objectLike({
            Action: 'bedrock-agentcore:CreateEvent',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
