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

import { ManagedPolicy, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { AGENTCORE_AZS_CONTEXT_KEY } from '../../src/constructs/agentcore-azs';
import { OrchestrationReconciler } from '../../src/constructs/orchestration-reconciler';
import { TaskOrchestrator } from '../../src/constructs/task-orchestrator';
import { buildApp } from '../../src/main';

const configurations = [false, true].flatMap(enableLinearIdentityVault =>
  [false, true].map(extraWildcard => ({ enableLinearIdentityVault, extraWildcard })));

describe.each(configurations)('managed MicroVM security checks (vault=$enableLinearIdentityVault, extra wildcard=$extraWildcard)', ({ enableLinearIdentityVault, extraWildcard }) => {
  let errors: string[];

  beforeAll(async () => {
    const app = await buildApp({
      account: '123456789012',
      region: 'us-west-2',
      appProps: {
        context: {
          compute_type: 'lambda-microvm',
          microvm_nested_stack: true,
          enableLinearIdentityVault,
          enableToolGateway: true,
          microvm_base_image_arn: 'arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1',
          microvm_base_image_version: '1',
          microvm_artifact_sha256: 'a'.repeat(64),
          [AGENTCORE_AZS_CONTEXT_KEY]: ['us-west-2a', 'us-west-2b'],
        },
      },
    });
    const stack = app.node.findChild('backgroundagent-dev');
    const orchestrator = stack.node.findChild('TaskOrchestrator') as TaskOrchestrator;
    if (enableLinearIdentityVault) {
      const reconciler = stack.node.findChild('OrchestrationReconciler') as OrchestrationReconciler;
      // Bundled policies can overflow at different boundaries from unit-test
      // policies. Exercise the documented exceptions on both owning roles.
      for (const role of [orchestrator.fn.role, reconciler.fn.role]) {
        new ManagedPolicy(role as Role, 'OverflowPolicyVaultProbe', {
          statements: [
            new PolicyStatement({
              actions: ['bedrock-agentcore:GetResourceOauth2Token'],
              resources: ['arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/bgagent-linear-oauth-*'],
            }),
            new PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: ['arn:aws:secretsmanager:us-west-2:123456789012:secret:bedrock-agentcore-identity!default/oauth2/bgagent-linear-oauth-*'],
            }),
          ],
        });
      }
    }
    if (extraWildcard) {
      // Model a future overflow document without relying on the policy
      // splitter placing an extra statement in a particular document.
      new ManagedPolicy(orchestrator.fn.role as Role, 'OverflowPolicy999', {
        statements: [new PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: ['arn:aws:ssm:us-west-2:123456789012:parameter/unrelated-*'],
        })],
      });
    }
    // The real entry point installs cdk-nag. The CLI fails on these assembly
    // annotations even though in-process synth itself does not throw.
    const artifact = app.synth().getStackByName('backgroundagent-dev');
    errors = artifact.messages.filter(message => message.level === 'error')
      .map(message => String(message.entry.data));
  }, 60_000);

  test('accepts documented Jira access while still reporting unrelated wildcard grants', () => {
    expect(errors).toEqual(extraWildcard
      ? [expect.stringMatching(/AwsSolutions-IAM5.*parameter\/unrelated-\*/)]
      : []);
  });
});
