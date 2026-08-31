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

  test('the onEvent handler gets the full lifecycle, but Update/Delete are scoped to THIS identity', () => {
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

    // Create names the DIRECTORY because it authorizes before the identity exists —
    // there is nothing narrower to point at. Everything else must not.
    //
    // Update is the one that makes this a real boundary, not hygiene: it REPLACES
    // `allowedResourceOauth2ReturnUrls`, so a directory-wide grant lets this Lambda
    // rewrite the consent allowlist of any workload identity in the account,
    // including another stack's — whose consent then starts failing with nothing in
    // either template to explain it.
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

    const createTails = forAction('bedrock-agentcore:CreateWorkloadIdentity').map(arnTail);
    expect(createTails.length).toBeGreaterThan(0);
    // `default`, not `*` — the directory segment is always `default`.
    expect(createTails.every((t) => t.endsWith('workload-identity-directory/default'))).toBe(true);

    for (const action of [
      'bedrock-agentcore:UpdateWorkloadIdentity',
      'bedrock-agentcore:DeleteWorkloadIdentity',
    ]) {
      const tails = forAction(action).map(arnTail);
      expect(tails.length).toBeGreaterThan(0);
      // Every resource must name a specific identity UNDER the directory.
      expect(tails.every((t) => /workload-identity-directory\/default\/workload-identity\/.+$/.test(t)))
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

    // Both token actions present.
    expect(rendered).toContain('bedrock-agentcore:GetWorkloadAccessTokenForUserId');
    expect(rendered).toContain('bedrock-agentcore:GetResourceOauth2Token');

    // GetWorkloadAccessTokenForUserId authorizes against the workload-identity
    // DIRECTORY. Granting only the named identity produced a live AccessDenied
    // ("not authorized … on resource: …/workload-identity-directory/default"),
    // so the bare directory ARN must be present — this is the regression guard.
    //
    // Asserted as a distinct resource ENTRY rather than a substring of the rendered
    // statement, because the named-identity ARN is
    // `…/workload-identity-directory/default/workload-identity/<name>` — it CONTAINS
    // the directory ARN. A `toContain('workload-identity-directory/default')` therefore
    // stayed green with the directory grant deleted, i.e. the guard for the live
    // AccessDenied could not fail. Mutation-checked by removing the grant.
    const statements = (consumerPolicy?.Properties.PolicyDocument.Statement ?? []) as Array<{
      Action?: unknown;
      Resource?: unknown;
    }>;
    const watResources = statements
      .filter((s) => JSON.stringify(s.Action ?? '').includes('GetWorkloadAccessTokenForUserId'))
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]) as unknown[]);
    expect(watResources.length).toBeGreaterThan(0);
    // An ARN built by CDK renders as an Fn::Join; the path lives in its LAST literal,
    // so "ends there" is what distinguishes the directory from the identity under it.
    const arnTail = (resource: unknown): string => {
      const join = (resource as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
      const parts = join ? join[1] : [resource];
      const last = parts[parts.length - 1];
      return typeof last === 'string' ? last : '';
    };
    expect(watResources.map(arnTail).some((tail) => tail.endsWith('workload-identity-directory/default')))
      .toBe(true);
    // GetResourceOauth2Token authorizes against the token VAULT itself — a second
    // live AccessDenied ("… on resource: …:token-vault/default") proved the
    // credential-provider sub-path alone is not enough. Both are granted: the
    // vault (what the service checks today) and the per-provider path (scoped to
    // this account's oauth2 providers rather than '*', since provider names are
    // created at onboarding time and unknown at synth).
    expect(rendered).toContain('token-vault/default"');
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
