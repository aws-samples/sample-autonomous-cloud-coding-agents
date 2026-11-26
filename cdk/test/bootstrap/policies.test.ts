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
import { computeLambdaMicrovmPolicy } from '../../src/bootstrap/policies/compute-lambda-microvm';
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
    // IAM's size limit for a managed policy.
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
      'NestedStackPassRole',
      'VPCNetworking',
      'Route53ResolverDNSFirewall',
    ]);
  });

  it('lets the execution role pass ONLY itself, ONLY to CloudFormation (nested stacks)', () => {
    // CloudFormation creates nested stacks as the execution role and passes that
    // role on to each child, which needs iam:PassRole on the role itself.
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{
      Sid: string;
      Action: string | string[];
      Resource: string | string[];
      Condition?: { StringEquals?: Record<string, string | string[]> };
    }>;
    const nested = statements.find((st) => st.Sid === 'NestedStackPassRole')!;
    expect(nested.Action).toEqual('iam:PassRole');
    expect(nested.Resource).toEqual('arn:aws:iam::*:role/cdk-*-cfn-exec-role-*');
    expect(nested.Condition?.StringEquals?.['iam:PassedToService']).toEqual('cloudformation.amazonaws.com');
  });

  it('has unique SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;
    const sids = statements.map((s) => s.Sid);
    const unique = new Set(sids);

    expect(unique.size).toBe(sids.length);
  });

  it('KEEPS the iam:PassedToService allowlist on IAMPassRole', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{
      Sid: string;
      Condition?: { StringEquals?: Record<string, string[]> };
    }>;
    const passRole = statements.find((st) => st.Sid === 'IAMPassRole')!;
    const services = passRole.Condition?.StringEquals?.['iam:PassedToService'];
    expect(services).toBeDefined();
    expect(services).toContain('lambda.amazonaws.com');
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
      'CognitoDomainRead',
      'WAFv2',
      'EventBridge',
      'SQS',
      'SNS',
      'StepFunctions',
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
        'sns',
        'sqs',
        'states',
        'wafv2',
      ]),
    );
  });

  it('grants Put/Delete provisioned-concurrency, not just Get (#409)', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(allActions).toContain('lambda:PutProvisionedConcurrencyConfig');
    expect(allActions).toContain('lambda:DeleteProvisionedConcurrencyConfig');
  });

  it('LambdaEventSourceMappings grants tagging (CDK event-source constructs tag the mapping)', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string; Action?: string | string[] }>;
    const esm = statements.find((s) => s.Sid === 'LambdaEventSourceMappings');
    expect(esm).toBeDefined();

    const actions = Array.isArray(esm!.Action) ? esm!.Action : [esm!.Action];
    expect(actions).toContain('lambda:TagResource');
    expect(actions).toContain('lambda:UntagResource');
  });

  it('SecretsManager statement allow-lists a secret pattern for every integration that creates a secret', () => {
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

  it('SNS statement grants the create + subscribe verbs the OperationalAlerts topic needs (#629)', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string; Action?: string | string[] }>;
    const sns = statements.find((s) => s.Sid === 'SNS');
    expect(sns).toBeDefined();
    const actions = Array.isArray(sns!.Action) ? sns!.Action : [sns!.Action];
    for (const action of ['sns:CreateTopic', 'sns:Subscribe', 'sns:GetTopicAttributes']) {
      expect(actions).toContain(action);
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
      'KMSCustomerManagedKeys',
      'KMSCustomerManagedKeysLifecycle',
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

  it('KMSCustomerManagedKeys grants CreateKey + tag on * (the unscopable create path) (#629)', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{
      Sid: string;
      Action?: string | string[];
      Condition?: unknown;
    }>;
    const create = statements.find((s) => s.Sid === 'KMSCustomerManagedKeys');
    expect(create).toBeDefined();
    const actions = Array.isArray(create!.Action) ? create!.Action : [create!.Action];
    expect(actions).toContain('kms:CreateKey');
    expect(actions).toContain('kms:TagResource');
    expect(actions).not.toContain('kms:PutKeyPolicy');
    expect(actions).not.toContain('kms:ScheduleKeyDeletion');
    expect(create!.Condition).toBeUndefined();
  });

  it('KMSCustomerManagedKeysLifecycle gates key-takeover actions on the ABCA resource tag (#629)', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{
      Sid: string;
      Action?: string | string[];
      Condition?: { StringEquals?: Record<string, string> };
    }>;
    const lifecycle = statements.find((s) => s.Sid === 'KMSCustomerManagedKeysLifecycle');
    expect(lifecycle).toBeDefined();
    const actions = Array.isArray(lifecycle!.Action) ? lifecycle!.Action : [lifecycle!.Action];
    expect(actions).toContain('kms:PutKeyPolicy');
    expect(actions).toContain('kms:ScheduleKeyDeletion');
    expect(lifecycle!.Condition?.StringEquals?.['aws:ResourceTag/ABCA']).toBe('operational-alerts');
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

describe('computeLambdaMicrovmPolicy', () => {
  const stack = new Stack();
  const doc = computeLambdaMicrovmPolicy();
  const json = doc.toJSON();
  const rendered = JSON.stringify(json);

  it('produces valid JSON', () => {
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  it('is under 6144 characters when serialized', () => {
    expect(rendered.length).toBeLessThan(6144);
  });

  it('contains the expected SIDs', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Sid: string }>;

    expect(statements.map((s) => s.Sid)).toEqual(['LambdaMicrovms', 'MicrovmPassRoles', 'MicrovmSuspendConfiguration']);
  });

  it('covers the expected service prefixes', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    const prefixes = new Set(allActions.map((a) => a.split(':')[0]));

    expect(prefixes).toEqual(new Set(['lambda', 'iam', 'ssm']));
  });

  it('limits parameter lifecycle and tagging to the ABCA MicroVM suspension switch', () => {
    const statement = stack.resolve(doc).Statement.find((s: { Sid: string }) => s.Sid === 'MicrovmSuspendConfiguration');
    expect(statement.Resource).toBe('arn:aws:ssm:*:*:parameter/backgroundagent-*/microvm-approval-suspend-enabled');
    expect(statement.Action).toEqual([
      'ssm:GetParameters', 'ssm:PutParameter', 'ssm:DeleteParameter',
      'ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource', 'ssm:ListTagsForResource',
    ]);
  });

  describe('MicrovmPassRoles (ADR-021 P2r2-F9)', () => {
    function passRoleStatement() {
      const resolvedDoc = stack.resolve(doc);
      const statements = resolvedDoc.Statement as Array<{
        Sid: string;
        Action: string | string[];
        Resource: string | string[];
        Condition?: unknown;
      }>;
      return statements.find((st) => st.Sid === 'MicrovmPassRoles')!;
    }

    it('carries NO iam:PassedToService condition — the service presents no usable value', () => {
      // Observed: under an `iam:PassedToService` allowlist, CloudFormation's
      // CreateMicrovmImage fails with a 403 on iam:PassRole (Service: LambdaMicrovms).
      expect(passRoleStatement().Condition).toBeUndefined();
    });

    it('grants only iam:PassRole', () => {
      expect(passRoleStatement().Action).toBe('iam:PassRole');
    });

    it('is scoped to the build + connector-operator role prefixes only', () => {
      const resources = passRoleStatement().Resource as string[];
      expect(resources).toEqual([
        'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeBuild*',
        'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeConnector*',
        'arn:aws:iam::*:role/backgroundagent-dev-MicrovmBuildRole',
        'arn:aws:iam::*:role/backgroundagent-dev-*-MicrovmBuildRole',
        'arn:aws:iam::*:role/backgroundagent-dev-MicrovmConnectorRole',
        'arn:aws:iam::*:role/backgroundagent-dev-*-MicrovmConnectorRole',
      ]);
      expect(resources).not.toContain('arn:aws:iam::*:role/backgroundagent-dev-*');
    });

    it('does NOT cover the MicroVM execution role', () => {
      const resources = passRoleStatement().Resource as string[];
      const executionRoleArn =
        'arn:aws:iam::123456789012:role/backgroundagent-dev-LambdaMicrovmComputeExecutionRo-abc123';
      const matches = resources.some((pattern) => {
        const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return re.test(executionRoleArn);
      });
      expect(matches).toBe(false);
    });

    it('matches the live physical names CloudFormation generated for both roles', () => {
      // CFN truncates the logical id to fit 64 chars before appending a random suffix,
      // so a pattern that reaches past the cut silently matches nothing.
      const resources = passRoleStatement().Resource as string[];
      const live = [
        'arn:aws:iam::123456789012:role/backgroundagent-dev-LambdaMicrovmComputeBuildRoleF0-9FxjQbiJC3px',
        'arn:aws:iam::123456789012:role/backgroundagent-dev-LambdaMicrovmComputeConnectorOp-Ab12Cd34Ef56',
      ];
      for (const arn of live) {
        const matched = resources.some((pattern) => {
          const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
          return re.test(arn);
        });
        expect(matched).toBe(true);
      }
    });

    it('limits nested PassRole to the build and operator names of the default or a suffixed stack', () => {
      const resources = passRoleStatement().Resource as string[];
      const matches = (name: string) => resources.some(pattern =>
        new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
          .test(`arn:aws:iam::123456789012:role/${name}`));
      expect(matches('backgroundagent-dev-MicrovmBuildRole')).toBe(true);
      expect(matches('backgroundagent-dev-MicrovmConnectorRole')).toBe(true);
      expect(matches('backgroundagent-dev-team-b-MicrovmBuildRole')).toBe(true);
      expect(matches('backgroundagent-dev-team-b-MicrovmConnectorRole')).toBe(true);
      for (const name of [
        'backgroundagent-dev-MicrovmExecutionRole',
        'backgroundagent-dev-team-b-MicrovmExecutionRole',
        'other-stack-MicrovmBuildRole',
        'backgroundagent-dev-MicrovmBuildRoleOther',
        'backgroundagent-dev-OtherBuildRole',
      ]) {
        expect(matches(name)).toBe(false);
      }
    });
  });

  it('covers both CFN resource types the construct synthesizes', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );

    expect(allActions).toContain('lambda:CreateMicrovmImage');
    expect(allActions).toContain('lambda:CreateNetworkConnector');
    // The documented dependent action of CreateMicrovmImage.
    expect(allActions).toContain('lambda:PassNetworkConnector');
  });

  it('grants NO runtime session lifecycle actions (those belong to the orchestrator role)', () => {
    const resolvedDoc = stack.resolve(doc);
    const statements = resolvedDoc.Statement as Array<{ Action: string | string[] }>;
    const allActions = new Set(statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    ));

    for (const action of [
      'lambda:RunMicrovm',
      'lambda:GetMicrovm',
      'lambda:TerminateMicrovm',
      'lambda:SuspendMicrovm',
      'lambda:ResumeMicrovm',
      'lambda:CreateMicrovmAuthToken',
      'lambda:CreateMicrovmShellAuthToken',
      'lambda:ConnectMicrovm',
    ]) {
      expect(allActions.has(action)).toBe(false);
    }
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

  it('returns exactly 6 policies', () => {
    expect(policies).toHaveLength(6);
  });

  it('every policy is under 6144 character limit', () => {
    for (const policy of policies) {
      const rendered = JSON.stringify(policy.toJSON());
      expect(rendered.length).toBeLessThan(6144);
    }
  });
});
