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
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CliWorkloadIdentity } from '../../src/constructs/cli-workload-identity';

describe('CliWorkloadIdentity construct', () => {
  test('default name is bgagent-cli with localhost return URL on the allowlist', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const construct = new CliWorkloadIdentity(stack, 'CliWorkloadIdentity');
    expect(construct.workloadName).toBe('bgagent-cli');

    const template = Template.fromStack(stack);
    // AwsCustomResource synthesises as a Custom::AWS resource; the parameters
    // for Create / Update / Delete are stringified into the Create/Update/Delete
    // template fields. We verify the Create payload includes both the name
    // and the localhost return URL — those are the contract with the CLI side.
    template.hasResourceProperties('Custom::AWS', {
      Create: Match.serializedJson(Match.objectLike({
        service: 'BedrockAgentCoreControl',
        action: 'CreateWorkloadIdentity',
        parameters: Match.objectLike({
          name: 'bgagent-cli',
          allowedResourceOauth2ReturnUrls: ['https://localhost:8443/oauth/callback'],
        }),
      })),
    });
  });

  test('custom name and return URLs flow through to the Create payload', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new CliWorkloadIdentity(stack, 'CliWorkloadIdentity', {
      name: 'acme-cli',
      allowedResourceOauth2ReturnUrls: [
        'https://localhost:8443/oauth/callback',
        'https://localhost:9443/oauth/callback',
      ],
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('Custom::AWS', {
      Create: Match.serializedJson(Match.objectLike({
        parameters: Match.objectLike({
          name: 'acme-cli',
          allowedResourceOauth2ReturnUrls: [
            'https://localhost:8443/oauth/callback',
            'https://localhost:9443/oauth/callback',
          ],
        }),
      })),
    });
  });

  test('emits Create / Update / Delete actions for full lifecycle', () => {
    // The CR re-applies the URL allowlist on stack updates and removes the
    // workload identity on stack deletes — both important for not leaking
    // workload identities (50/account-region quota).
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new CliWorkloadIdentity(stack, 'CliWorkloadIdentity');

    const template = Template.fromStack(stack);
    const customResources = template.findResources('Custom::AWS');
    const cr = Object.values(customResources)[0] as { Properties: Record<string, unknown> };
    // CDK serializes each lifecycle as a JSON string under Create/Update/Delete.
    expect(JSON.parse(cr.Properties.Create as string).action).toBe('CreateWorkloadIdentity');
    expect(JSON.parse(cr.Properties.Update as string).action).toBe('UpdateWorkloadIdentity');
    expect(JSON.parse(cr.Properties.Delete as string).action).toBe('DeleteWorkloadIdentity');
  });

  test('IAM policy grants the four workload-identity actions only', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new CliWorkloadIdentity(stack, 'CliWorkloadIdentity');

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'bedrock-agentcore:CreateWorkloadIdentity',
              'bedrock-agentcore:UpdateWorkloadIdentity',
              'bedrock-agentcore:DeleteWorkloadIdentity',
              'bedrock-agentcore:GetWorkloadIdentity',
            ],
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
