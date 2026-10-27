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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { AwsSolutionsChecks } from 'cdk-nag';
import {
  CFN_TYPES_WITHOUT_EXEC_ROLE_IAM,
  collectBootstrapAllowActions,
  findMissingBootstrapActions,
  RESOURCE_ACTION_MAP,
} from '../../src/bootstrap/resource-action-map';
import { buildApp } from '../../src/main';
import { OperatorConsoleStack } from '../../src/stacks/console';
import { FIXTURE, STRUCTURAL_CONTEXT } from '../../src/synthesis/profiles';

const ENV = { account: '123456789012', region: 'us-east-1' };
const API_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/';

describe('OperatorConsoleStack', () => {
  let bundle: string;
  let stack: OperatorConsoleStack;
  let template: Template;

  beforeAll(() => {
    bundle = mkdtempSync(path.join(tmpdir(), 'console-bundle-'));
    writeFileSync(path.join(bundle, 'index.html'), '<!doctype html><title>console</title>');
    mkdirSync(path.join(bundle, 'assets'));
    writeFileSync(path.join(bundle, 'assets', 'index-abc123.js'), 'console.log(1)');

    const app = new App();
    const platform = new Stack(app, 'platform', { env: ENV });
    const userPool = new cognito.UserPool(platform, 'UserPool');
    stack = new OperatorConsoleStack(app, 'backgroundagent-dev-console', {
      env: ENV,
      userPool,
      apiUrl: API_URL,
      assetDirectory: bundle,
      additionalOrigins: ['http://localhost:5173'],
    });
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    template = Template.fromStack(stack);
  });

  afterAll(() => rmSync(bundle, { recursive: true, force: true }));

  test('the bucket is private, encrypted and TLS-only', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        })]),
      },
    });
  });

  test('only CloudFront (via OAC) may read the bucket', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const allows = Object.values(policies).flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as Array<{ Effect: string; Principal?: unknown }>)
        .filter((s) => s.Effect === 'Allow'));
    for (const statement of allows) {
      expect(statement.Principal).not.toEqual('*');
      expect(statement.Principal).not.toEqual({ AWS: '*' });
    }
    expect(allows).toEqual(expect.arrayContaining([
      expect.objectContaining({ Principal: { Service: 'cloudfront.amazonaws.com' } }),
    ]));
  });

  test('the distribution forces HTTPS and serves index.html for client-side routes', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        CustomErrorResponses: [403, 404].map((code) => ({
          ErrorCode: code,
          ResponseCode: 200,
          ResponsePagePath: '/index.html',
          ErrorCachingMinTTL: 0,
        })),
      }),
    });
  });

  test('the app client is public and uses the authorization code flow only', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      SupportedIdentityProviders: ['COGNITO'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      CallbackURLs: [
        { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] }, '/auth/callback']] },
        'http://localhost:5173/auth/callback',
      ],
      LogoutURLs: [
        { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] }, '/']] },
        'http://localhost:5173/',
      ],
    });
    const [client] = Object.values(template.findResources('AWS::Cognito::UserPoolClient'));
    expect(client.Properties.ExplicitAuthFlows).toBeUndefined();
    expect(client.Properties.AllowedOAuthFlows).not.toContain('implicit');
  });

  test('a managed-login domain is created on the platform user pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: { 'Fn::Join': ['-', ['abca', { Ref: 'AWS::AccountId' }, 'backgroundagent-dev-console']] },
    });
  });

  test('ships the bundle in two deployments: immutable assets, then index.html + config.json', () => {
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    expect(Object.keys(deployments)).toHaveLength(2);
    const [assetsId, entryId] = Object.keys(deployments).sort();
    expect(deployments[assetsId].Properties.SystemMetadata).toEqual({ 'cache-control': 'public, max-age=31536000, immutable' });
    expect(deployments[entryId].Properties.SystemMetadata).toEqual({ 'cache-control': 'no-cache' });
    expect(deployments[entryId].Properties.DistributionPaths).toEqual(['/*']);
    expect(deployments[entryId].DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/^Assets/)]));
  });

  test('outputs the console URL', () => {
    template.hasOutput('ConsoleUrl', {
      Value: { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] }, '/']] },
    });
  });

  test('has no unsuppressed cdk-nag errors', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toEqual([]);
  });

  test('every resource type is mapped and granted by the bootstrap bundle', () => {
    const types = new Set(Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type));
    const allowed = collectBootstrapAllowActions();
    for (const type of types) {
      if (CFN_TYPES_WITHOUT_EXEC_ROLE_IAM.has(type)) continue;
      expect({ type, mapped: type in RESOURCE_ACTION_MAP }).toEqual({ type, mapped: true });
      expect({ type, missing: findMissingBootstrapActions(type, allowed) }).toEqual({ type, missing: [] });
    }
  });

  test('fails with guidance when the bundle has not been built', () => {
    const app = new App();
    const platform = new Stack(app, 'platform', { env: ENV });
    expect(() => new OperatorConsoleStack(app, 'missing', {
      env: ENV,
      userPool: new cognito.UserPool(platform, 'UserPool'),
      apiUrl: API_URL,
      assetDirectory: path.join(bundle, 'does-not-exist'),
    })).toThrow(/mise \/\/web:bundle.*operatorConsole=true/s);
  });
});

describe('buildApp operator console wiring', () => {
  let bundle: string;
  const outdirs: string[] = [];

  beforeAll(() => {
    bundle = mkdtempSync(path.join(tmpdir(), 'console-bundle-'));
    writeFileSync(path.join(bundle, 'index.html'), '<!doctype html>');
  });

  afterAll(() => {
    for (const dir of [bundle, ...outdirs]) rmSync(dir, { recursive: true, force: true });
  });

  async function synthesize(context: Record<string, unknown>): Promise<App> {
    const outdir = mkdtempSync(path.join(tmpdir(), 'console-app-'));
    outdirs.push(outdir);
    return buildApp({
      account: FIXTURE.account,
      region: FIXTURE.region,
      describeAzs: async () => [...FIXTURE.zones],
      resolveCallerAccount: async () => FIXTURE.account,
      operatorConsoleAssetDirectory: bundle,
      appProps: {
        outdir,
        autoSynth: false,
        context: { stackName: 'backgroundagent-dev', ...context },
        postCliContext: STRUCTURAL_CONTEXT,
      },
    });
  }

  test('is off by default, so a bare `cdk deploy` still sees a single stack', async () => {
    const app = await synthesize({});
    expect(app.node.tryFindChild('backgroundagent-dev-console')).toBeUndefined();
  });

  test('-c operatorConsole=true adds the console stack, wired to the platform user pool and API', async () => {
    const app = await synthesize({ operatorConsole: 'true', operatorConsoleDevOrigins: 'http://localhost:5173' });
    const consoleStack = app.node.tryFindChild('backgroundagent-dev-console');
    expect(consoleStack).toBeInstanceOf(OperatorConsoleStack);
    const template = Template.fromStack(consoleStack as OperatorConsoleStack);
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { UserPoolId: { 'Fn::ImportValue': Match.anyValue() } });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['http://localhost:5173/auth/callback']),
    });
    expect((consoleStack as OperatorConsoleStack).dependencies.map((s) => s.stackName)).toContain('backgroundagent-dev');
  });
});
