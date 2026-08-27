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

import {
  CFN_TYPES_WITHOUT_EXEC_ROLE_IAM,
  RESOURCE_ACTION_MAP,
  collectBootstrapAllowActions,
  findMissingBootstrapActions,
  resolveBootstrapPolicies,
} from '../../src/bootstrap/resource-action-map';
import { AgentRegistryStack } from '../../src/constructs/registry';
import { AgentStack } from '../../src/stacks/agent';

describe('Bootstrap policy synth coverage', () => {
  let template: Template;
  let registryTemplate: Template;
  let allowedActions: Set<string>;

  beforeAll(() => {
    const app = new App();
    const stack = new AgentStack(app, 'backgroundagent-dev', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
    const registryStack = stack.node.tryFindChild('AgentRegistryStack') as
      AgentRegistryStack | undefined;
    if (!registryStack) {
      throw new Error('AgentRegistryStack was not synthesized');
    }
    registryTemplate = Template.fromStack(registryStack);

    const resolver = new Stack();
    resolveBootstrapPolicies(resolver);
    allowedActions = collectBootstrapAllowActions();
  });

  it('maps the nested Agent Registry custom resource to bootstrap actions', () => {
    const resources = registryTemplate.toJSON().Resources as Record<string, { Type: string }>;
    const typesInTemplate = new Set(Object.values(resources).map((r) => r.Type));
    const cfnType = 'Custom::AgentRegistry';

    expect(typesInTemplate.has(cfnType)).toBe(true);
    expect(cfnType in RESOURCE_ACTION_MAP).toBe(true);
    expect(findMissingBootstrapActions(cfnType, allowedActions)).toEqual([]);
  });

  it('maps every synthesized CFN type (that needs IAM) to bootstrap actions', () => {
    const resources = template.toJSON().Resources as Record<string, { Type: string }>;
    const typesInTemplate = new Set(Object.values(resources).map((r) => r.Type));

    const unmapped: string[] = [];
    const missingByType: Record<string, string[]> = {};

    for (const cfnType of typesInTemplate) {
      if (CFN_TYPES_WITHOUT_EXEC_ROLE_IAM.has(cfnType)) {
        continue;
      }
      if (!(cfnType in RESOURCE_ACTION_MAP)) {
        unmapped.push(cfnType);
        continue;
      }
      const missing = findMissingBootstrapActions(cfnType, allowedActions);
      if (missing.length > 0) {
        missingByType[cfnType] = missing;
      }
    }

    expect(unmapped).toEqual([]);
    expect(missingByType).toEqual({});
  });

  it('maps the context-gated tool-gateway CFN types (ADR-019, not in default synth)', () => {
    // The default synth above never instantiates the ToolGateway construct, so
    // its two CFN types would slip past the coverage loop. Synthesize the gated
    // path explicitly and assert both types are mapped AND fully covered by the
    // bootstrap policy bundle — the same guarantee the loop gives default types.
    const app = new App({ context: { enableToolGateway: true } });
    const gatedTemplate = Template.fromStack(
      new AgentStack(app, 'GatewayCoverageStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      }),
    );
    const gatedTypes = new Set(
      Object.values(
        gatedTemplate.toJSON().Resources as Record<string, { Type: string }>,
      ).map((r) => r.Type),
    );

    for (const cfnType of [
      'AWS::BedrockAgentCore::Gateway',
      'AWS::BedrockAgentCore::GatewayTarget',
    ]) {
      expect(gatedTypes.has(cfnType)).toBe(true);
      expect(cfnType in RESOURCE_ACTION_MAP).toBe(true);
      expect(findMissingBootstrapActions(cfnType, allowedActions)).toEqual([]);
    }
  });

  it('maps the context-gated Linear identity vault custom resource (#249 P1, not in default synth)', () => {
    // The default synth never instantiates LinearIdentityVault, so its custom
    // resource type would slip past the coverage loop. Synthesize the gated path
    // explicitly and assert the type is present, mapped, AND fully covered by the
    // bootstrap policy bundle — same guarantee the loop gives default types.
    const app = new App({ context: { enableLinearIdentityVault: true } });
    const gatedTemplate = Template.fromStack(
      new AgentStack(app, 'LinearVaultCoverageStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      }),
    );
    const gatedTypes = new Set(
      Object.values(
        gatedTemplate.toJSON().Resources as Record<string, { Type: string }>,
      ).map((r) => r.Type),
    );

    const cfnType = 'Custom::LinearWorkloadIdentity';
    expect(gatedTypes.has(cfnType)).toBe(true);
    expect(cfnType in RESOURCE_ACTION_MAP).toBe(true);
    expect(findMissingBootstrapActions(cfnType, allowedActions)).toEqual([]);
  });

  it('covers integration resources that previously failed deploy (regression)', () => {
    const regressionTypes = [
      'AWS::SecretsManager::Secret',
      'AWS::SQS::Queue',
      'AWS::CloudFront::OriginAccessControl',
      'AWS::CloudFront::Distribution',
      'AWS::Lambda::LayerVersion',
      'AWS::Lambda::EventSourceMapping',
      'AWS::S3::Bucket',
    ];

    for (const cfnType of regressionTypes) {
      const missing = findMissingBootstrapActions(cfnType, allowedActions);
      expect(missing).toEqual([]);
    }
  });
});
