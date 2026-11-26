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
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  LINEAR_CREDENTIAL_PROVIDER_PREFIX,
  LinearIdentityVault,
} from '../../src/constructs/linear-identity-vault';

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

function synth(returnUrls: string[] = ['http://localhost:8080/oauth/callback']): {
  template: Template;
  vault: LinearIdentityVault;
  stack: Stack;
} {
  const { vault, stack } = build(returnUrls);
  return { template: Template.fromStack(stack), vault, stack };
}

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
    expect(Object.keys(template.findResources('AWS::Lambda::Function')).length).toBeGreaterThanOrEqual(2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
    template.hasResourceProperties('Custom::LinearWorkloadIdentity', {
      WorkloadName: 'abca_linear_oauth',
      AllowedReturnUrls: JSON.stringify(['http://localhost:8080/oauth/callback']),
    });
  });

  test('the onEvent handler lifecycle is scoped to the default directory, not the account', () => {
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

    // AgentCore authorizes these actions against the bare directory as well as the identity.
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p.Properties.PolicyDocument.Statement ?? []) as Array<{
        Action?: unknown; Resource?: unknown;
      }>);
    const forAction = (action: string) => statements
      .filter((s) => {
        const a = s.Action;
        return Array.isArray(a) ? a.includes(action) : a === action;
      })
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]) as unknown[]);

    const arnTail = (resource: unknown): string => {
      const join = (resource as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
      const parts = join ? join[1] : [resource];
      const last = parts[parts.length - 1];
      return typeof last === 'string' ? last : String(resource);
    };

    for (const action of [
      'bedrock-agentcore:CreateWorkloadIdentity',
      'bedrock-agentcore:UpdateWorkloadIdentity',
      'bedrock-agentcore:DeleteWorkloadIdentity',
      'bedrock-agentcore:GetWorkloadIdentity',
    ]) {
      const tails = forAction(action).map(arnTail);
      expect(tails.some((t) => t.endsWith('workload-identity-directory/default'))).toBe(true);
      expect(tails.some((t) => t.endsWith('workload-identity-directory/default/workload-identity/*')))
        .toBe(true);
      expect(tails.some((t) => t.endsWith('workload-identity-directory/*'))).toBe(false);
    }
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
    expect(rendered).toContain('bedrock-agentcore:GetWorkloadAccessTokenForUserId');
    expect(rendered).toContain('bedrock-agentcore:GetResourceOauth2Token');

    // GetWorkloadAccessTokenForUserId authorizes against the workload-identity directory itself.
    const statements = (consumerPolicy?.Properties.PolicyDocument.Statement ?? []) as Array<{
      Action?: unknown;
      Resource?: unknown;
    }>;
    const watResources = statements
      .filter((s) => JSON.stringify(s.Action ?? '').includes('GetWorkloadAccessTokenForUserId'))
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]) as unknown[]);
    expect(watResources.length).toBeGreaterThan(0);
    const arnTail = (resource: unknown): string => {
      const join = (resource as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
      const parts = join ? join[1] : [resource];
      const last = parts[parts.length - 1];
      return typeof last === 'string' ? last : '';
    };
    expect(watResources.map(arnTail).some((tail) => tail.endsWith('workload-identity-directory/default')))
      .toBe(true);
    // GetResourceOauth2Token authorizes against four resources and requires all of them.
    const tokenResources = statements
      .filter((st) => JSON.stringify(st.Action ?? '').includes('GetResourceOauth2Token'))
      .flatMap((st) => (Array.isArray(st.Resource) ? st.Resource : [st.Resource]) as unknown[])
      .map(arnTail);
    expect(tokenResources).toHaveLength(4);
    for (const suffix of [
      'token-vault/default',
      `token-vault/default/oauth2credentialprovider/${LINEAR_CREDENTIAL_PROVIDER_PREFIX}*`,
      'workload-identity-directory/default',
      'workload-identity-directory/default/workload-identity/abca_linear_oauth',
    ]) {
      expect(tokenResources.some((t) => t.endsWith(suffix))).toBe(true);
    }
    expect(tokenResources.some((t) => t.endsWith('oauth2credentialprovider/*'))).toBe(false);
    // The token vault reads each provider's client secret with the caller's credentials.
    const secretResources = statements
      .filter((st) => JSON.stringify(st.Action ?? '').includes('secretsmanager:GetSecretValue'))
      .flatMap((st) => (Array.isArray(st.Resource) ? st.Resource : [st.Resource]) as unknown[])
      .map(arnTail);
    expect(secretResources).toHaveLength(1);
    expect(secretResources[0]!.endsWith(
      `bedrock-agentcore-identity!default/oauth2/${LINEAR_CREDENTIAL_PROVIDER_PREFIX}*`,
    )).toBe(true);
    expect(rendered).not.toContain('bedrock-agentcore-identity!*');

    expect(rendered).not.toContain('CreateWorkloadIdentity');
    expect(rendered).not.toContain('DeleteWorkloadIdentity');
    expect(rendered).not.toContain('CreateOauth2CredentialProvider');
    expect(consumerPolicy?.Properties.PolicyDocument.Statement).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ Resource: '*' })]),
    );
  });
});
