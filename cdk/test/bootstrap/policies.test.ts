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
import { computeAgentcorePolicy } from '../../src/bootstrap/policies/compute-agentcore';
import { computeEcsPolicy } from '../../src/bootstrap/policies/compute-ecs';
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
      'LambdaEventSourceMappings',
      'APIGateway',
      'Cognito',
      'WAFv2',
      'EventBridge',
      'SQS',
      'CloudFront',
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
        'cloudfront',
        'cognito-idp',
        'dynamodb',
        'events',
        'lambda',
        'secretsmanager',
        'sqs',
        'wafv2',
      ]),
    );
  });

  it('SecretsManager statement allow-lists a secret pattern for every integration that creates a secret', () => {
    // Regression guard for #402: each integration construct that creates a
    // Secrets Manager secret (GitHub token, Slack, Linear, Jira, GitHub
    // screenshot) names it after its construct id, so the CFN exec role's
    // scoped CreateSecret allow-list must carry a matching prefix. A missing
    // pattern is invisible to the service-prefix check above (it's still
    // `secretsmanager:`) but fails the deploy with AccessDenied at
    // CreateSecret time. Jira shipped without its pattern; this locks the
    // contract so the next integration can't repeat it.
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{
      Sid: string;
      Resource?: string | string[];
    }>;
    const secretsStatement = statements.find((s) => s.Sid === 'SecretsManager');
    expect(secretsStatement).toBeDefined();

    const resources = Array.isArray(secretsStatement!.Resource)
      ? secretsStatement!.Resource
      : [secretsStatement!.Resource];

    for (const prefix of [
      'GitHubTokenSecret',
      'SlackIntegration',
      'LinearIntegration',
      'JiraIntegration',
      'GitHubScreenshot',
    ]) {
      expect(resources).toContain(`arn:aws:secretsmanager:*:*:secret:${prefix}*`);
    }
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
      'BedrockGuardrailsAndLogging',
      'CloudWatchLogsAndDashboards',
      'S3CDKAssets',
      'S3ApplicationBuckets',
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

  it('S3ApplicationBuckets grants the bucket-feature actions the stack buckets enable', () => {
    // Regression guard for #404: the exec role must hold a CreateBucket-time
    // action for every feature the application buckets turn on, or a fresh
    // deploy rolls back with AccessDenied at that specific configure call.
    // AttachmentsBucket sets `versioned: true`, so PutBucketVersioning (and
    // GetBucketVersioning for the read/drift path) are required — they were
    // missing, which is how this reached main. The service-prefix check above
    // can't catch it (still `s3:`). If a bucket later enables notifications,
    // CORS, etc., add the matching action here and to the policy together.
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{
      Sid: string;
      Action?: string | string[];
    }>;
    const s3Buckets = statements.find((s) => s.Sid === 'S3ApplicationBuckets');
    expect(s3Buckets).toBeDefined();

    const actions = Array.isArray(s3Buckets!.Action)
      ? s3Buckets!.Action
      : [s3Buckets!.Action];

    for (const action of [
      's3:CreateBucket',
      's3:PutEncryptionConfiguration',
      's3:PutLifecycleConfiguration',
      's3:PutBucketVersioning',
      's3:GetBucketVersioning',
    ]) {
      expect(actions).toContain(action);
    }
  });
});

describe('IaCRole-ABCA-Compute-AgentCore', () => {
  const stack = new Stack();
  const doc = computeAgentcorePolicy();
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

    expect(sids).toEqual(['BedrockAgentCore']);
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

    expect(prefixes).toEqual(new Set(['bedrock-agentcore']));
  });
});

describe('IaCRole-ABCA-Compute-ECS', () => {
  const stack = new Stack();
  const doc = computeEcsPolicy();
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

    expect(sids).toEqual(['ECS']);
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

    expect(prefixes).toEqual(new Set(['ecs']));
  });
});

describe('Cross-policy validation', () => {
  const stack = new Stack();
  const policies = allPolicies();

  it('all SIDs are globally unique across all policies', () => {
    const allSids: string[] = [];

    for (const policy of policies) {
      const resolved = stack.resolve(policy);
      const statements = resolved.Statement as Array<{ Sid: string }>;
      allSids.push(...statements.map((s) => s.Sid));
    }

    const unique = new Set(allSids);
    expect(unique.size).toBe(allSids.length);
  });

  it('returns exactly 5 policies', () => {
    expect(policies).toHaveLength(5);
  });

  it('every policy is under 6144 character limit', () => {
    for (const policy of policies) {
      const rendered = JSON.stringify(policy.toJSON());
      expect(rendered.length).toBeLessThan(6144);
    }
  });
});
