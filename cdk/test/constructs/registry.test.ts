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
import { AgentRegistry, AgentRegistryStack } from '../../src/constructs/registry';

function createStack(): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  new AgentRegistry(stack, 'AgentRegistry', {
    registryName: 'abca_test',
    description: 'test registry',
  });

  return Template.fromStack(stack);
}

function policyStatementsForRole(
  template: Template,
  roleLogicalIdFragment: string,
): Array<Record<string, unknown>> {
  const policy = Object.values(template.findResources('AWS::IAM::Policy')).find(resource =>
    JSON.stringify(resource.Properties.Roles).includes(roleLogicalIdFragment),
  );
  if (!policy) {
    throw new Error(`No IAM policy found for role matching ${roleLogicalIdFragment}`);
  }
  return policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>;
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

  test('names the Provider waiter state machine under the stack prefix (least-privilege bootstrap)', () => {
    // The bootstrap policy allows states:CreateStateMachine only on
    // `stateMachine:<stack>-*`; an unnamed state machine gets `<LogicalId>-<random>`
    // from CloudFormation and is denied. Live-observed as a full rollback.
    const template = createStack();
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    expect(Object.keys(machines)).toHaveLength(1);
    const name = Object.values(machines)[0].Properties.StateMachineName;
    expect(name).toBe('TestStack-AgentRegistryWaiter');
    expect(name.length).toBeLessThanOrEqual(80);
  });

  test('uses the ROOT stack name for the waiter when placed in a NestedStack', () => {
    // Inside a NestedStack, Stack.of(construct).stackName is a token for a
    // ~100-char generated name — over the 80-char state-machine limit and, more
    // importantly, not the prefix the bootstrap policy is scoped to.
    const app = new App();
    const parent = new Stack(app, 'backgroundagent-dev');
    const nested = new AgentRegistryStack(parent, 'AgentRegistryStack', { registryName: 'abca_test' });
    const machines = Template.fromStack(nested).findResources('AWS::StepFunctions::StateMachine');
    expect(Object.values(machines)[0].Properties.StateMachineName).toBe(
      'backgroundagent-dev-AgentRegistryWaiter',
    );
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

  test('grants CreateRegistry on * because the registry does not exist yet', () => {
    const template = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'agent-registry:CreateRegistry',
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

  test('grants workload identity lifecycle actions to both Provider handlers', () => {
    const template = createStack();

    for (const role of [
      'AgentRegistryOnEventFnServiceRole',
      'AgentRegistryIsCompleteFnServiceRole',
    ]) {
      const statement = policyStatementsForRole(template, role).find(candidate => {
        const actions = Array.isArray(candidate.Action) ? candidate.Action : [candidate.Action];
        return actions.includes('bedrock-agentcore:CreateWorkloadIdentity');
      });

      expect(statement).toBeDefined();
      expect(statement?.Action).toEqual(expect.arrayContaining([
        'bedrock-agentcore:CreateWorkloadIdentity',
        'bedrock-agentcore:GetWorkloadIdentity',
        'bedrock-agentcore:DeleteWorkloadIdentity',
      ]));
      expect(statement?.Resource).not.toBe('*');
      expect(JSON.stringify(statement?.Resource)).toContain('workload-identity-directory/*');
    }
  });

  test('grants the per-registry actions scoped to registry ARNs', () => {
    const template = createStack();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(resource =>
      resource.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
    );
    const statement = statements.find(candidate => {
      const actions = Array.isArray(candidate.Action) ? candidate.Action : [candidate.Action];
      return actions.includes('agent-registry:GetRegistry');
    });

    expect(statement).toBeDefined();
    expect(statement?.Action).toEqual(expect.arrayContaining([
      'agent-registry:GetRegistry',
      'agent-registry:UpdateRegistry',
      'agent-registry:DeleteRegistry',
    ]));
    expect(statement?.Resource).not.toBe('*');
    expect(JSON.stringify(statement?.Resource)).toContain('registry/*');
  });
});
