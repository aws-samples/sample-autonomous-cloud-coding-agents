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
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { RegistryApi } from '../../src/constructs/registry-api';

function synth(): { template: Template; registryApi: RegistryApi } {
  const app = new App();
  const parent = new Stack(app, 'ParentStack');
  const userPool = new cognito.UserPool(parent, 'UserPool');
  const registryApi = new RegistryApi(parent, 'RegistryApi', {
    agentRegistryId: 'reg-abc123',
    userPool,
  });
  // A NestedStack renders as AWS::CloudFormation::Stack in the parent; assert on
  // the nested stack's own synthesized template.
  return { template: Template.fromStack(registryApi), registryApi };
}

describe('RegistryApi nested stack', () => {
  test('creates the four handler Lambdas', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Lambda::Function', 4);
  });

  test('creates its own REST API + Cognito authorizer (not the shared API)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
    });
  });

  test('creates the two Cognito groups on the shared pool', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'RegistryPublisher',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'RegistryApprover',
    });
  });

  test('publish role gets write actions scoped to the wired registry', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'bedrock-agentcore:CreateRegistryRecord',
              'bedrock-agentcore:SubmitRegistryRecordForApproval',
              'bedrock-agentcore:UpdateRegistryRecordStatus',
            ]),
          }),
        ]),
      },
    });
  });

  test('handler roles are scoped to the wired registry ARN — no bare "*" resource (#246 review)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    // The wired registry id must appear in the resource ARNs...
    expect(serialized).toContain('reg-abc123');
    // ...and no registry statement may grant a bare "*" resource (the finding-10
    // regression: a resource:['*'] would let a read handler reach other registries).
    for (const policy of Object.values(policies)) {
      const statements = (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } } })
        .Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        const actions = JSON.stringify(stmt.Action);
        if (actions.includes('bedrock-agentcore:')) {
          expect(stmt.Resource).not.toBe('*');
          expect(JSON.stringify(stmt.Resource)).not.toBe('"*"');
        }
      }
    }
  });

  test('exposes an apiUrl for the CLI to target', () => {
    const { registryApi } = synth();
    expect(registryApi.apiUrl).toBeDefined();
  });
});
