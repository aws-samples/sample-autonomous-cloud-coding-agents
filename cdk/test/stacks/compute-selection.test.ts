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

import { App, NestedStack, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../../src/stacks/agent';

/** MicroVM resources live in a nested stack, so count across the whole assembly. */
function assemblyResources(stack: Stack, type: string): Array<{ Properties?: Record<string, unknown> } & Record<string, unknown>> {
  const templates = [stack, ...stack.node.findAll().filter(child => NestedStack.isNestedStack(child))]
    .map(scope => Template.fromStack(scope as Stack));
  return templates.flatMap(template => Object.values(template.findResources(type)));
}

describe.each(['agentcore', 'ecs', 'lambda-microvm'])('exclusive %s deployment', backend => {
  let template: Template;
  let stack: Stack;
  beforeAll(() => {
    const app = new App({
      context: {
        compute_types: backend,
        microvm_nested_stack: true,
        enableToolGateway: true,
        enableLinearIdentityVault: true,
        ...(backend === 'lambda-microvm' ? {
          microvm_image_identifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test-image',
          microvm_image_version: '1',
        } : {}),
      },
    });
    stack = new AgentStack(app, 'ComputeSelection', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('provisions only the selected compute backend and advertises its default', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', backend === 'agentcore' ? 1 : 0);
    template.resourceCountIs('AWS::ECS::Cluster', backend === 'ecs' ? 1 : 0);
    expect(assemblyResources(stack, 'AWS::Lambda::NetworkConnector')).toHaveLength(backend === 'lambda-microvm' ? 2 : 0);
    template.hasOutput('ComputeSubstrate', { Value: backend });
    template.hasOutput('ComputeDeploymentMode', { Value: 'exclusive' });
    expect(!!template.toJSON().Outputs.RuntimeArn).toBe(backend === 'agentcore');
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
  });

  test('keeps AgentCore logs owned across backend switches with the existing destroy policy', () => {
    const groups = Object.fromEntries(Object.entries(template.findResources('AWS::Logs::LogGroup'))
      .filter(([id]) => id.startsWith('RuntimeApplicationLogGroup') || id.startsWith('RuntimeUsageLogGroup'))
      .map(([id, resource]) => [id, {
        name: resource.Properties.LogGroupName,
        retention: resource.Properties.RetentionInDays,
        deletion: resource.DeletionPolicy,
        replacement: resource.UpdateReplacePolicy,
      }]));
    expect(groups).toEqual({
      RuntimeApplicationLogGroupCCD512EC: {
        name: '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/ComputeSelection',
        retention: 90,
        deletion: 'Delete',
        replacement: 'Delete',
      },
      RuntimeUsageLogGroup3193D914: {
        name: '/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/ComputeSelection',
        retention: 90,
        deletion: 'Delete',
        replacement: 'Delete',
      },
    });
  });

  test('allows fixed-name logs to be cleaned up on destroy and failed creation', () => {
    const groups = assemblyResources(stack, 'AWS::Logs::LogGroup');
    const names = [
      '/aws/bedrock/model-invocation-logs/ComputeSelection',
      '/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/ComputeSelection',
      '/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/ComputeSelection',
      ...(backend === 'lambda-microvm' ? ['/aws/lambda-microvms/ComputeSelection-abca-agent'] : []),
    ];
    for (const name of names) {
      expect(groups.find(resource => resource.Properties.LogGroupName === name)).toMatchObject({
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      });
    }
  });

  test('dispatch and cancellation target the selected backend', () => {
    const fns = Object.entries(template.findResources('AWS::Lambda::Function'));
    const orchestrator = fns.find(([id]) => id.startsWith('TaskOrchestratorOrchestratorFn'))![1];
    const env = orchestrator.Properties.Environment.Variables;
    expect(env.DEPLOYED_COMPUTE_TYPE).toBe(backend);
    expect(!!env.RUNTIME_ARN).toBe(backend === 'agentcore');
    expect(env.LINEAR_VAULT_ENABLED).toBe('true');
    expect(env.LINEAR_WORKLOAD_IDENTITY_NAME).toBeDefined();
    expect(env.ABCA_TOOL_GATEWAY_URL).toBeDefined();
    expect(!!env.ECS_CLUSTER_ARN).toBe(backend === 'ecs');
    const cancel = fns.find(([id]) => id.startsWith('TaskApiCancelTaskFn'))![1];
    expect(!!cancel.Properties.Environment.Variables.RUNTIME_ARN).toBe(backend === 'agentcore');
    expect(!!cancel.Properties.Environment.Variables.ECS_CLUSTER_ARN).toBe(backend === 'ecs');
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies.includes('bedrock-agentcore:InvokeAgentRuntime')).toBe(backend === 'agentcore');
    expect(policies.includes('bedrock-agentcore:StopRuntimeSession')).toBe(backend === 'agentcore');
    expect(policies.includes('ecs:StopTask')).toBe(backend === 'ecs');
    expect(policies.includes('lambda:TerminateMicrovm')).toBe(backend === 'lambda-microvm');
  });

  test('session trust contains only the selected compute role', () => {
    const role = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([id]) => id.startsWith('AgentSessionRole'))![1];
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    expect(trust.includes('RuntimeExecutionRole')).toBe(backend === 'agentcore');
    expect(trust.includes('EcsAgentClusterTaskRole')).toBe(backend === 'ecs');
    expect(trust.includes('LambdaMicrovmComputeExecutionRole')).toBe(backend === 'lambda-microvm');
    expect(trust).toContain('sts:TagSession');
    const prefix = backend === 'agentcore' ? 'RuntimeExecutionRole' : backend === 'ecs' ? 'EcsAgentClusterTaskRole' : 'LambdaMicrovmComputeExecutionRole';
    const policies = JSON.stringify(Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith(prefix)));
    expect(policies).toContain('bedrock-agentcore:InvokeGateway');
    expect(policies).toContain('bedrock-agentcore:GetResourceOauth2Token');
  });
});

describe.each([
  { label: 'explicit AgentCore/MicroVM', selector: { compute_types: 'agentcore,lambda-microvm' }, backends: ['agentcore', 'lambda-microvm'] },
  { label: 'legacy MicroVM', selector: { compute_type: 'lambda-microvm' }, backends: ['agentcore', 'lambda-microvm'] },
  { label: 'legacy ECS', selector: { compute_type: 'ecs' }, backends: ['agentcore', 'ecs'] },
  { label: 'ECS default with AgentCore', selector: { compute_types: ['ecs', 'agentcore'] }, backends: ['ecs', 'agentcore'] },
  { label: 'MicroVM default without AgentCore', selector: { compute_types: 'lambda-microvm,ecs' }, backends: ['lambda-microvm', 'ecs'] },
  { label: 'all backends', selector: { compute_types: 'agentcore,ecs,lambda-microvm' }, backends: ['agentcore', 'ecs', 'lambda-microvm'] },
])('additive deployment from $label', ({ selector, backends }) => {
  let template: Template;
  let stack: Stack;
  beforeAll(() => {
    const app = new App({
      context: {
        ...selector,
        microvm_nested_stack: true,
        microvm_image_identifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test-image',
        microvm_image_version: '1',
      },
    });
    stack = new AgentStack(app, 'ComputeSelection', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('provisions every listed backend and preserves its declared default', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', backends.includes('agentcore') ? 1 : 0);
    expect(assemblyResources(stack, 'AWS::Lambda::NetworkConnector')).toHaveLength(backends.includes('lambda-microvm') ? 2 : 0);
    template.resourceCountIs('AWS::ECS::Cluster', backends.includes('ecs') ? 1 : 0);
    // Existing CLIs parse a comma list here on non-exclusive stacks.
    template.hasOutput('ComputeSubstrate', { Value: backends.join(',') });
    template.hasOutput('ComputeTypes', { Value: backends.join(',') });
    template.hasOutput('ComputeDeploymentMode', { Value: 'additive' });
    const orchestrator = Object.entries(template.findResources('AWS::Lambda::Function'))
      .find(([id]) => id.startsWith('TaskOrchestratorOrchestratorFn'))![1];
    const env = orchestrator.Properties.Environment.Variables;
    expect(env.DEPLOYED_COMPUTE_TYPE).toBe(backends.join(','));
    expect(!!env.RUNTIME_ARN).toBe(backends.includes('agentcore'));
    expect(!!env.ECS_CLUSTER_ARN).toBe(backends.includes('ecs'));
  });

  test('session trust admits every deployed compute role', () => {
    const role = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([id]) => id.startsWith('AgentSessionRole'))![1];
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    expect(trust.includes('RuntimeExecutionRole')).toBe(backends.includes('agentcore'));
    expect(trust.includes('EcsAgentClusterTaskRole')).toBe(backends.includes('ecs'));
    expect(trust.includes('LambdaMicrovmComputeExecutionRole')).toBe(backends.includes('lambda-microvm'));
  });

  test('grants Linear and Jira OAuth reads to every deployed compute role', () => {
    const prefixes: Record<string, string> = {
      'agentcore': 'RuntimeExecutionRole',
      'ecs': 'EcsAgentClusterTaskRole',
      'lambda-microvm': 'LambdaMicrovmComputeExecutionRole',
    };
    const policies = {
      ...template.findResources('AWS::IAM::Policy'),
      ...template.findResources('AWS::IAM::ManagedPolicy'),
    };
    for (const backend of backends) {
      const grants = JSON.stringify(Object.entries(policies).filter(([id]) => id.startsWith(prefixes[backend])));
      expect(grants).toContain('secretsmanager:GetSecretValue');
      expect(grants).toContain('bgagent-linear-oauth-*');
      expect(grants).toContain('bgagent-jira-oauth-*');
    }
  });
});
