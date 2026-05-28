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
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AgentSessionRole } from '../../src/constructs/agent-session-role';

function createStack() {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const computeRole = new iam.Role(stack, 'ComputeRole', {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
  });

  const mkTable = (id: string, sortKey?: string) =>
    new dynamodb.Table(stack, id, {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      ...(sortKey
        ? { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } }
        : {}),
    });

  const taskTable = mkTable('TaskTable');
  const taskEventsTable = mkTable('TaskEventsTable', 'event_id');
  const taskApprovalsTable = mkTable('TaskApprovalsTable', 'request_id');
  const taskNudgesTable = mkTable('TaskNudgesTable', 'nudge_id');

  const traceArtifactsBucket = new s3.Bucket(stack, 'TraceBucket');
  const attachmentsBucket = new s3.Bucket(stack, 'AttachmentsBucket');

  const sessionRole = new AgentSessionRole(stack, 'AgentSessionRole', {
    assumingRoles: [computeRole],
    taskScopedTables: [
      taskTable,
      taskEventsTable,
      taskApprovalsTable,
      taskNudgesTable,
    ],
    traceArtifactsBucket,
    attachmentsBucket,
  });
  sessionRole.grantAssumeToComputeRole(computeRole);

  return { stack, template: Template.fromStack(stack), computeRole, sessionRole };
}

describe('AgentSessionRole construct', () => {
  let template: Template;

  beforeAll(() => {
    template = createStack().template;
  });

  test('creates a role whose trust policy admits the compute role for AssumeRole + TagSession', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'sts:AssumeRole' }),
          Match.objectLike({ Action: 'sts:TagSession' }),
        ]),
      },
      // Role chaining caps at 1h regardless; documented explicitly.
      MaxSessionDuration: 3600,
    });
  });

  test('DynamoDB item access is gated by a task_id leading-key condition (one statement per table)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const sessionPolicy = Object.entries(policies).find(([id]) =>
      id.includes('AgentSessionRole'),
    );
    expect(sessionPolicy).toBeDefined();
    const statements = sessionPolicy![1].Properties.PolicyDocument.Statement;

    const ddbStatements = statements.filter((s: { Action: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a: string) => a.startsWith('dynamodb:'));
    });
    // Four task-scoped tables → four conditioned statements.
    expect(ddbStatements).toHaveLength(4);
    for (const s of ddbStatements) {
      expect(s.Condition).toEqual({
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': ['${aws:PrincipalTag/task_id}'],
        },
      });
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      // Scan must NOT be granted — it ignores leading-keys.
      expect(actions).not.toContain('dynamodb:Scan');
    }
  });

  test('S3 trace writes are scoped to the per-user prefix', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const sessionPolicy = Object.entries(policies).find(([id]) =>
      id.includes('AgentSessionRole'),
    )![1];
    const statements = sessionPolicy.Properties.PolicyDocument.Statement;

    const putObject = statements.find((s: { Action: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('s3:PutObject');
    });
    expect(putObject).toBeDefined();
    // The resource ARN embeds the user_id principal tag as the key prefix.
    expect(JSON.stringify(putObject.Resource)).toContain(
      '/traces/${aws:PrincipalTag/user_id}/*',
    );
  });

  test('S3 attachment reads are scoped to the per-user prefix', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const sessionPolicy = Object.entries(policies).find(([id]) =>
      id.includes('AgentSessionRole'),
    )![1];
    const statements = sessionPolicy.Properties.PolicyDocument.Statement;

    const getObject = statements.find((s: { Action: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('s3:GetObject');
    });
    expect(getObject).toBeDefined();
    expect(JSON.stringify(getObject.Resource)).toContain(
      '/attachments/${aws:PrincipalTag/user_id}/*',
    );
  });

  test('compute role is granted sts:AssumeRole + sts:TagSession on the SessionRole', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const computePolicy = Object.entries(policies).find(([id]) =>
      id.includes('ComputeRole'),
    )![1];
    const statements = computePolicy.Properties.PolicyDocument.Statement;
    const stsStatement = statements.find((s: { Action: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('sts:AssumeRole') && actions.includes('sts:TagSession');
    });
    expect(stsStatement).toBeDefined();
  });

  test('addAssumingRole admits a second compute role (ECS task role) to the trust', () => {
    const app = new App();
    const stack = new Stack(app, 'MultiPrincipalStack');
    const agentcoreRole = new iam.Role(stack, 'AgentCoreRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    const ecsTaskRole = new iam.Role(stack, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const table = new dynamodb.Table(stack, 'T', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const sessionRole = new AgentSessionRole(stack, 'SR', {
      assumingRoles: [agentcoreRole],
      taskScopedTables: [table],
      traceArtifactsBucket: new s3.Bucket(stack, 'TB'),
      attachmentsBucket: new s3.Bucket(stack, 'AB'),
    });
    sessionRole.addAssumingRole(ecsTaskRole);

    const trustStatements = Template.fromStack(stack).findResources(
      'AWS::IAM::Role',
    );
    const sr = Object.entries(trustStatements).find(([id]) => id.includes('SR'))![1];
    // Trust policy now has statements for both AssumeRole and TagSession; the
    // ECS task role ARN appears as an additional principal.
    const serialized = JSON.stringify(sr.Properties.AssumeRolePolicyDocument);
    expect(serialized).toContain('sts:TagSession');
    expect(serialized).toContain('EcsTaskRole');
    expect(serialized).toContain('AgentCoreRole');
  });
});
