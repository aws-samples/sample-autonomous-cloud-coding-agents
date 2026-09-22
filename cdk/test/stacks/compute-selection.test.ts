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

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../../src/stacks/agent';

describe.each(['agentcore', 'ecs', 'lambda-microvm'])('exclusive %s deployment', backend => {
  let template: Template;
  beforeAll(() => {
    const app = new App({
      context: {
        compute_type: backend,
        blueprintProvisioning: 'managed',
        enableToolGateway: true,
        enableLinearIdentityVault: true,
        ...(backend === 'lambda-microvm' ? {
          microvm_image_identifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test-image',
          microvm_image_version: '1',
        } : {}),
      },
    });
    template = Template.fromStack(new AgentStack(app, 'ComputeSelection', {
      env: { account: '123456789012', region: 'us-east-1' },
    }));
  });

  test('provisions only the selected compute backend and advertises its default', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', backend === 'agentcore' ? 1 : 0);
    template.resourceCountIs('AWS::ECS::Cluster', backend === 'ecs' ? 1 : 0);
    template.resourceCountIs('AWS::Lambda::NetworkConnector', backend === 'lambda-microvm' ? 2 : 0);
    template.hasOutput('ComputeSubstrate', { Value: backend });
    template.hasOutput('ComputeDeploymentMode', { Value: 'exclusive' });
    expect(!!template.toJSON().Outputs.RuntimeArn).toBe(backend === 'agentcore');
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
  });

  test('keeps the same named AgentCore logs owned and retained across backend switches', () => {
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
        deletion: 'Retain',
        replacement: 'Retain',
      },
      RuntimeUsageLogGroup3193D914: {
        name: '/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/ComputeSelection',
        retention: 90,
        deletion: 'Retain',
        replacement: 'Retain',
      },
    });
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
