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
import { AgentRegistry } from '../../src/constructs/registry';

function createStack(): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new AgentRegistry(stack, 'AgentRegistry', {
    registryName: 'abca_test',
    description: 'test registry',
  });

  return Template.fromStack(stack);
}

describe('AgentRegistry construct', () => {
  test('creates onEvent and isComplete Lambda handlers plus the provider framework', () => {
    const template = createStack();
    // onEvent + isComplete + the provider framework's own onEvent Lambda.
    const fns = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(3);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
  });

  test('registers the custom resource with the standalone Agent Registry type', () => {
    const template = createStack();
    template.hasResourceProperties('Custom::AgentRegistry', {
      RegistryName: 'abca_test',
      Description: 'test registry',
    });
  });

  test('defaults description to empty when omitted', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new AgentRegistry(stack, 'AgentRegistry', { registryName: 'abca_test' });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('Custom::AgentRegistry', {
      RegistryName: 'abca_test',
      Description: '',
    });
  });

  test('grants CreateRegistry/ListRegistries on * (account-level actions)', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'agent-registry:CreateRegistry',
              'agent-registry:ListRegistries',
            ]),
            Resource: '*',
          }),
        ]),
      },
    });
  });

  test('allows creation of only the Agent Registry service-linked role', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:CreateServiceLinkedRole',
            Resource: '*',
            Condition: {
              StringEquals: {
                'iam:AWSServiceName': 'agent-registry.amazonaws.com',
              },
            },
          }),
        ]),
      },
    });
  });

  test('grants the per-registry + record actions scoped to registry ARNs', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'agent-registry:GetRegistry',
              'agent-registry:UpdateRegistry',
              'agent-registry:DeleteRegistry',
            ]),
          }),
        ]),
      },
    });
  });
});
