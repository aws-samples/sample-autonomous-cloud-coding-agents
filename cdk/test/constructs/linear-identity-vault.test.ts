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
import * as iam from 'aws-cdk-lib/aws-iam';
import { LinearIdentityVault } from '../../src/constructs/linear-identity-vault';

function build(returnUrls: string[] = ['http://localhost:8080/oauth/callback']): {
  vault: LinearIdentityVault;
  stack: Stack;
} {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const vault = new LinearIdentityVault(stack, 'LinearIdentityVault', {
    workloadName: 'abca_linear_oauth',
    allowedReturnUrls: returnUrls,
  });
  return { vault, stack };
}

/** Build the stack then synth once (Template.fromStack must be the last step —
 *  the construct tree may not be mutated after the first synth). */
function synth(returnUrls: string[] = ['http://localhost:8080/oauth/callback']): {
  template: Template;
  vault: LinearIdentityVault;
  stack: Stack;
} {
  const { vault, stack } = build(returnUrls);
  return { template: Template.fromStack(stack), vault, stack };
}

/** Collect the flattened action list across every IAM policy statement. */
function allPolicyActions(template: Template): string[] {
  const actions: string[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const statements = policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>;
    for (const s of statements) {
      const a = s.Action;
      if (typeof a === 'string') actions.push(a);
      else if (Array.isArray(a)) actions.push(...(a as string[]));
    }
  }
  return actions;
}

describe('LinearIdentityVault construct', () => {
  test('provisions a workload identity via a custom resource + bundled onEvent handler', () => {
    const { template } = synth();
    // onEvent handler + the provider framework's own Lambda.
    expect(Object.keys(template.findResources('AWS::Lambda::Function')).length).toBeGreaterThanOrEqual(2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
    // The custom resource carries the workload name + JSON-encoded return URLs.
    template.hasResourceProperties('Custom::LinearWorkloadIdentity', {
      WorkloadName: 'abca_linear_oauth',
      AllowedReturnUrls: JSON.stringify(['http://localhost:8080/oauth/callback']),
    });
  });

  test('grants the onEvent handler workload-identity lifecycle scoped to the directory', () => {
    const { template } = synth();
    const actions = allPolicyActions(template);
    for (const a of [
      'bedrock-agentcore:CreateWorkloadIdentity',
      'bedrock-agentcore:GetWorkloadIdentity',
      'bedrock-agentcore:UpdateWorkloadIdentity',
      'bedrock-agentcore:DeleteWorkloadIdentity',
    ]) {
      expect(actions).toContain(a);
    }
    // Scoped to the workload-identity-directory, NOT '*'.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['bedrock-agentcore:CreateWorkloadIdentity']),
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('workload-identity-directory')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  test('multiple return URLs (localhost + hosted) are both registered', () => {
    const urls = ['http://localhost:8080/oauth/callback', 'https://d123.cloudfront.net/linear/done'];
    const { template } = synth(urls);
    template.hasResourceProperties('Custom::LinearWorkloadIdentity', {
      AllowedReturnUrls: JSON.stringify(urls),
    });
  });

  test('grantMintToken grants the token data-plane actions on the SERVICE-REQUIRED resources', () => {
    const { vault, stack } = build();
    const role = new iam.Role(stack, 'Consumer', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    vault.grantMintToken(role);
    const t2 = Template.fromStack(stack);
    const consumerPolicy = Object.values(t2.findResources('AWS::IAM::Policy')).find(p =>
      JSON.stringify(p.Properties.Roles ?? '').includes('Consumer'),
    );
    const rendered = JSON.stringify(consumerPolicy?.Properties.PolicyDocument.Statement ?? []);

    // Both token actions present.
    expect(rendered).toContain('bedrock-agentcore:GetWorkloadAccessTokenForUserId');
    expect(rendered).toContain('bedrock-agentcore:GetResourceOauth2Token');

    // GetWorkloadAccessTokenForUserId authorizes against the workload-identity
    // DIRECTORY. Granting only the named identity produced a live AccessDenied
    // ("not authorized … on resource: …/workload-identity-directory/default"),
    // so the bare directory ARN must be present — this is the regression guard.
    expect(rendered).toContain('workload-identity-directory/default');
    // GetResourceOauth2Token authorizes against the token-vault credential
    // provider; names are created at onboarding time so the grant is scoped to
    // this account's oauth2 providers rather than '*'.
    expect(rendered).toContain('token-vault/default/oauth2credentialprovider/*');
    // The vault reads each provider's client secret through the caller.
    expect(rendered).toContain('bedrock-agentcore-identity!*');

    // Still least-privilege: no control-plane lifecycle, no wildcard resource.
    expect(rendered).not.toContain('CreateWorkloadIdentity');
    expect(rendered).not.toContain('DeleteWorkloadIdentity');
    expect(rendered).not.toContain('CreateOauth2CredentialProvider');
    expect(consumerPolicy?.Properties.PolicyDocument.Statement).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ Resource: '*' })]),
    );
  });
});
