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

import { Stack } from 'aws-cdk-lib';
import { allPolicies } from '../../src/bootstrap/policies';
import { applicationPolicy } from '../../src/bootstrap/policies/application';
import { infrastructurePolicy } from '../../src/bootstrap/policies/infrastructure';
import { observabilityPolicy } from '../../src/bootstrap/policies/observability';

describe('infrastructurePolicy', () => {
  const stack = new Stack();
  const doc = infrastructurePolicy();
  const json = doc.toJSON();
  const rendered = JSON.stringify(json);

  it('produces valid JSON', () => {
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  it('is under 6144 characters when serialized', () => {
    // AWS managed policy size limit
    expect(rendered.length).toBeLessThan(6144);
  });

  it('contains the expected SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);

    expect(sids).toEqual([
      'CloudFormationSelf',
      'IAMRolesAndPolicies',
      'IAMPassRole',
      'VPCNetworking',
      'Route53ResolverDNSFirewall',
    ]);
  });

  it('has unique SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);
    const unique = new Set(sids);

    expect(unique.size).toBe(sids.length);
  });

  it('covers the expected service prefixes', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    const prefixes = new Set(allActions.map((a) => a.split(':')[0]));

    expect(prefixes).toEqual(
      new Set([
        'cloudformation',
        'iam',
        'ec2',
        'route53resolver',
      ]),
    );
  });
});

describe('IaCRole-ABCA-Application', () => {
  const stack = new Stack();
  const doc = applicationPolicy();
  const json = doc.toJSON();
  const rendered = JSON.stringify(json);

  it('produces valid JSON', () => {
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  it('is under 6144 characters when serialized', () => {
    // AWS managed policy size limit
    expect(rendered.length).toBeLessThan(6144);
  });

  it('contains the expected SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);

    expect(sids).toEqual([
      'DynamoDB',
      'Lambda',
      'APIGateway',
      'Cognito',
      'WAFv2',
      'EventBridge',
      'SecretsManager',
      'SecretsManagerAccountLevel',
    ]);
  });

  it('has unique SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);
    const unique = new Set(sids);

    expect(unique.size).toBe(sids.length);
  });

  it('covers the expected service prefixes', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    const prefixes = new Set(allActions.map((a) => a.split(':')[0]));

    expect(prefixes).toEqual(
      new Set([
        'apigateway',
        'cognito-idp',
        'dynamodb',
        'events',
        'lambda',
        'secretsmanager',
        'wafv2',
      ]),
    );
  });
});

describe('IaCRole-ABCA-Observability', () => {
  const stack = new Stack();
  const doc = observabilityPolicy();
  const json = doc.toJSON();
  const rendered = JSON.stringify(json);

  it('produces valid JSON', () => {
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  it('is under 6144 characters when serialized', () => {
    // AWS managed policy size limit
    expect(rendered.length).toBeLessThan(6144);
  });

  it('contains the expected SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);

    expect(sids).toEqual([
      'BedrockAgentCore',
      'BedrockGuardrailsAndLogging',
      'CloudWatchLogsAndDashboards',
      'S3CDKAssets',
      'KMSForCDKAssets',
      'ECRForDockerAssets',
      'ECRAuthToken',
      'XRay',
      'SSMParameterStoreForCDK',
      'STSForCDK',
    ]);
  });

  it('has unique SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);
    const unique = new Set(sids);

    expect(unique.size).toBe(sids.length);
  });

  it('covers the expected service prefixes', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    const prefixes = new Set(allActions.map((a) => a.split(':')[0]));

    expect(prefixes).toEqual(
      new Set([
        'bedrock',
        'bedrock-agentcore',
        'cloudwatch',
        'ecr',
        'kms',
        'logs',
        's3',
        'ssm',
        'sts',
        'xray',
      ]),
    );
  });
});

describe('Cross-policy validation', () => {
  const stack = new Stack();
  const policies = allPolicies();

  it('all SIDs are globally unique across all three policies', () => {
    const allSids: string[] = [];

    for (const policy of policies) {
      const resolved = stack.resolve(policy);
      const statements = resolved.Statement as Array<{ Sid: string }>;
      allSids.push(...statements.map((s) => s.Sid));
    }

    const unique = new Set(allSids);
    expect(unique.size).toBe(allSids.length);
  });

  it('returns exactly 3 policies', () => {
    expect(policies).toHaveLength(3);
  });

  it('every policy is under 6144 character limit', () => {
    for (const policy of policies) {
      const rendered = JSON.stringify(policy.toJSON());
      expect(rendered.length).toBeLessThan(6144);
    }
  });
});
