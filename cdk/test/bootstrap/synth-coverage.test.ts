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
import { AgentStack } from '../../src/stacks/agent';

describe('Bootstrap policy synth coverage', () => {
  let template: Template;
  let allowedActions: Set<string>;

  beforeAll(() => {
    const app = new App();
    new AgentStack(app, 'backgroundagent-dev', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(
      app.node.tryFindChild('backgroundagent-dev') as Stack,
    );

    const resolver = new Stack();
    resolveBootstrapPolicies(resolver);
    allowedActions = collectBootstrapAllowActions();
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
