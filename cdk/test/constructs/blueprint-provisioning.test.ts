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

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { BlueprintProvisioningMode } from '../../src/blueprints/configuration';
import { Blueprint, BlueprintProps } from '../../src/constructs/blueprint';
import { BlueprintProvider } from '../../src/constructs/blueprint-provider';

function fixture(mode: BlueprintProvisioningMode, multiple = false) {
  const app = new App({ context: { blueprintProvisioning: mode } });
  const stack = new Stack(app, 'TestStack');
  const table = new dynamodb.Table(stack, 'Repos', { partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING } });
  const props: BlueprintProps = {
    repo: 'org/repo',
    repoTable: table,
    compute: { type: 'ecs', runtimeArn: 'runtime-arn' },
    agent: { modelId: 'model', maxTurns: 50, maxBudgetUsd: 2.5, systemPromptOverrides: 'prompt' },
    credentials: { githubTokenSecretArn: 'secret-arn' },
    pipeline: { pollIntervalMs: 5000, buildCommand: 'make build', lintCommand: 'make lint' },
    networking: { egressAllowlist: ['example.com'] },
    security: { cedarPolicies: ['policy'], approvalGateCap: 10 },
    assets: {
      mcpServers: ['registry://mcp_server/acme/pdf-tools@1.0.0'],
      cedarPolicyModules: ['registry://cedar_policy_module/acme/policy@1.0.0'],
      skills: ['registry://skill/acme/research@1.0.0'],
    },
  };
  new Blueprint(stack, 'Blueprint', props);
  if (multiple) new Blueprint(stack, 'SecondBlueprint', { repo: 'org/second', repoTable: table });
  const template = Template.fromStack(stack);
  const child = stack.node.tryFindChild('BlueprintProvisioning') as BlueprintProvider | undefined;
  return { template, child: child && Template.fromStack(child) };
}

function sdkCall(value: any) {
  const text = typeof value === 'string' ? value : value['Fn::Join'][1]
    .map((part: unknown) => typeof part === 'string' ? part : 'TOKEN').join('');
  return JSON.parse(text);
}

describe('blueprint provider handoff', () => {
  let legacy: ReturnType<typeof fixture>;
  let prepare: ReturnType<typeof fixture>;
  let adopt: ReturnType<typeof fixture>;
  let managed: ReturnType<typeof fixture>;
  let multiple: ReturnType<typeof fixture>;
  beforeAll(() => {
    legacy = fixture('legacy');
    prepare = fixture('prepare');
    adopt = fixture('adopt');
    managed = fixture('managed');
    multiple = fixture('managed', true);
  });

  test('preparation preserves the legacy resource identity and service token', () => {
    const [[oldId, oldResource]] = Object.entries(legacy.template.findResources('Custom::AWS'));
    const [[id, resource]] = Object.entries(prepare.template.findResources('Custom::AWS'));
    expect(id).toBe(oldId);
    expect(resource.Properties.ServiceToken).toEqual(oldResource.Properties.ServiceToken);
    expect(sdkCall(resource.Properties.Create).physicalResourceId)
      .toEqual(sdkCall(oldResource.Properties.Create).physicalResourceId);
    expect(resource.DeletionPolicy).toBe('Retain');
    expect(resource.UpdateReplacePolicy).toBe('Retain');
  });

  test('every prepared callback is read-only or absent, including rollback Create', () => {
    const [resource] = Object.values(prepare.template.findResources('Custom::AWS'));
    expect(resource.Properties.Delete).toBeUndefined();
    for (const key of ['Create', 'Update']) {
      expect(sdkCall(resource.Properties[key])).toEqual(expect.objectContaining({
        service: 'DynamoDB', action: 'describeTable', outputPaths: ['Table.TableStatus'],
      }));
    }
    expect(JSON.stringify(prepare.template.toJSON())).not.toMatch(/onboarded_at|updated_at|putItem|updateItem/);
    const policies = JSON.stringify(prepare.template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('dynamodb:DescribeTable');
    expect(policies).not.toContain('dynamodb:PutItem');
    expect(policies).not.toContain('dynamodb:UpdateItem');
    expect(prepare.child).toBeUndefined();
  });

  test('adoption retains its resource; activation preserves identity and enables normal deletion', () => {
    const [[id, resource]] = Object.entries(adopt.template.findResources('Custom::BlueprintRepoConfig'));
    const [[managedId, managedResource]] = Object.entries(managed.template.findResources('Custom::BlueprintRepoConfig'));
    expect(managedId).toBe(id);
    expect(resource.DeletionPolicy).toBe('Retain');
    expect(resource.UpdateReplacePolicy).toBe('Retain');
    expect(managedResource.DeletionPolicy).toBe('Delete');
    expect(managedResource.Properties).toEqual({ ...resource.Properties, Mode: 'managed' });
    adopt.template.resourceCountIs('Custom::AWS', 0);
    managed.template.resourceCountIs('Custom::AWS', 0);
  });

  test('managed configuration contains exactly the fields legacy Create supplied', () => {
    const legacyResource = Object.values(legacy.template.findResources('Custom::AWS'))[0];
    const item = sdkCall(legacyResource.Properties.Create).parameters.Item;
    delete item.repo; delete item.status; delete item.onboarded_at; delete item.updated_at;
    const managedResource = Object.values(managed.template.findResources('Custom::BlueprintRepoConfig'))[0];
    expect(JSON.parse(managedResource.Properties.Configuration)).toEqual(item);
    expect(managedResource.Properties).toEqual(expect.objectContaining({ Repo: 'org/repo', Mode: 'managed' }));
    expect(managedResource.Properties.Configuration).not.toMatch(/onboarded_at|updated_at/);
  });

  test('multiple blueprints share one nested provider and private ownership ledger', () => {
    multiple.template.resourceCountIs('Custom::BlueprintRepoConfig', 2);
    multiple.template.resourceCountIs('AWS::CloudFormation::Stack', 1);
    multiple.template.resourceCountIs('AWS::Lambda::Function', 0);
    multiple.child!.resourceCountIs('AWS::DynamoDB::Table', 1);
    multiple.child!.resourceCountIs('AWS::Lambda::Function', 2);
    const resources = Object.values(multiple.template.findResources('Custom::BlueprintRepoConfig'));
    expect(resources[0].Properties.ServiceToken).toEqual(resources[1].Properties.ServiceToken);
    expect(resources[0].Properties.ServiceToken).toHaveProperty('Fn::GetAtt');
    const policies = JSON.stringify(multiple.child!.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('dynamodb:UpdateItem');
    expect(policies).toContain('dynamodb:ConditionCheckItem');
    multiple.child!.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          OWNERSHIP_TABLE: { Ref: Object.keys(multiple.child!.findResources('AWS::DynamoDB::Table'))[0] },
          ABCA_COMPONENT: 'blueprint-provisioning',
        },
      },
    });
  });
});
