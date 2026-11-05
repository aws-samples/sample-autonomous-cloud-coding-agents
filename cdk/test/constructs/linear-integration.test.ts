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
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { LinearIntegration } from '../../src/constructs/linear-integration';

describe('LinearIntegration construct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });

    new LinearIntegration(stack, 'LinearIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates four Linear DynamoDB tables (project mapping + user mapping + workspace registry + dedup)', () => {
    // TaskTable + TaskEventsTable + LinearProjectMapping + LinearUserMapping
    // + LinearWorkspaceRegistry + LinearWebhookDedup = 6
    template.resourceCountIs('AWS::DynamoDB::Table', 6);
  });

  test('workspace registry table is keyed on linear_workspace_id', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'linear_workspace_id', KeyType: 'HASH' }],
    });
  });

  test('creates four Lambda functions (webhook, processor, link, remove-workspace)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 4);
  });

  test('creates API Gateway resources under /linear', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'linear' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'webhook' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'link' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'workspaces' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{slug}' });
  });

  test('DELETE /linear/workspaces/{slug} is Cognito-authorized (pinned to the {slug} resource)', () => {
    // Pin the method to the {slug} resource so "any authorized DELETE
    // anywhere" cannot satisfy this — the DELETE must be on the
    // workspace-by-slug path specifically.
    const slugResources = template.findResources('AWS::ApiGateway::Resource', {
      Properties: { PathPart: '{slug}' },
    });
    const slugLogicalIds = Object.keys(slugResources);
    expect(slugLogicalIds).toHaveLength(1);
    const slugId = slugLogicalIds[0];

    const deleteMethods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: 'DELETE' },
    });
    const onSlug = Object.values(deleteMethods).filter(
      (m) => (m.Properties as { ResourceId?: { Ref?: string } }).ResourceId?.Ref === slugId,
    );
    expect(onSlug).toHaveLength(1);
    expect((onSlug[0].Properties as { AuthorizationType?: string }).AuthorizationType).toBe('COGNITO_USER_POOLS');
  });

  // Locate the RemoveWorkspaceFn INDEPENDENTLY of any IAM policy: it is the
  // ONLY Lambda whose environment is registry-only — it carries
  // `LINEAR_WORKSPACE_REGISTRY_TABLE_NAME` but none of the sibling markers
  // (`LINEAR_PROJECT_MAPPING_TABLE_NAME` on the processor,
  // `LINEAR_WEBHOOK_SECRET_ARN` on the webhook receiver,
  // `LINEAR_USER_MAPPING_TABLE_NAME` on the link handler). We then read the
  // role off the FUNCTION resource itself (`Role: Fn::GetAtt[<roleId>]`), so
  // the derived `role` is bound to the function's own identity — NOT read out
  // of the DeleteSecret policy. This lets the secret-prefix test assert the
  // grant lands on THIS role and genuinely fail if a future edit attaches the
  // DeleteSecret grant to the wrong role.
  function findRemoveWorkspaceFn(): { logicalId: string; role: string } {
    const fns = template.findResources('AWS::Lambda::Function');
    const matches = Object.entries(fns).filter(([, fn]) => {
      const vars =
        (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables ?? {};
      return (
        'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME' in vars &&
        !('LINEAR_PROJECT_MAPPING_TABLE_NAME' in vars) &&
        !('LINEAR_WEBHOOK_SECRET_ARN' in vars) &&
        !('LINEAR_USER_MAPPING_TABLE_NAME' in vars)
      );
    });
    expect(matches).toHaveLength(1);
    const [logicalId, fn] = matches[0];
    const role = (fn.Properties as { Role?: { 'Fn::GetAtt'?: [string, string] } })
      .Role?.['Fn::GetAtt']?.[0];
    expect(role).toBeDefined();
    return { logicalId, role: role! };
  }

  test('remove-workspace handler wires ONLY the workspace registry (no project mapping table)', () => {
    // B2: the mapping-cleanup path was dropped, so the remove-workspace
    // function must NOT carry the project-mapping table env var (that was
    // the dead grant + no-op cleanup the reviewer flagged).
    const { logicalId } = findRemoveWorkspaceFn();
    const fn = template.findResources('AWS::Lambda::Function')[logicalId];
    const vars = (fn.Properties as { Environment: { Variables: Record<string, unknown> } })
      .Environment.Variables;
    expect(vars).toHaveProperty('LINEAR_WORKSPACE_REGISTRY_TABLE_NAME');
    expect(vars).not.toHaveProperty('LINEAR_PROJECT_MAPPING_TABLE_NAME');
  });

  test('remove-workspace role can delete ONLY the bgagent-linear-oauth-* secret prefix (scope pinned to the role)', () => {
    // Bind the DeleteSecret grant to the remove-workspace role AND pin the
    // resource ARN to the bgagent-linear-oauth-* prefix, so a future
    // widening of that wildcard (or attaching DeleteSecret to another role)
    // fails this test.
    const { role } = findRemoveWorkspaceFn();
    const policies = template.findResources('AWS::IAM::Policy');
    const deletePolicies = Object.values(policies).filter((p) => {
      const doc = (p.Properties as { PolicyDocument: { Statement: Array<{ Action?: unknown }> } })
        .PolicyDocument;
      return doc.Statement.some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('secretsmanager:DeleteSecret');
      });
    });
    expect(deletePolicies).toHaveLength(1);

    const policy = deletePolicies[0];
    // The policy is attached to the remove-workspace role only.
    const roleRefs = ((policy.Properties as { Roles?: Array<{ Ref?: string }> }).Roles ?? [])
      .map((r) => r.Ref);
    expect(roleRefs).toContain(role);

    // The DeleteSecret statement's resource ends with the documented prefix.
    const stmt = (policy.Properties as {
      PolicyDocument: { Statement: Array<{ Action?: unknown; Resource?: unknown }> };
    }).PolicyDocument.Statement.find((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('secretsmanager:DeleteSecret');
    })!;
    expect(JSON.stringify(stmt.Resource)).toContain('bgagent-linear-oauth-*');
  });

  test('creates one Secrets Manager secret (webhook signing) — OAuth tokens are CLI-created at runtime', () => {
    // Phase 2.0b-O2: per-workspace OAuth tokens live in
    // `bgagent-linear-oauth-<slug>` secrets created by `bgagent linear setup`,
    // NOT by CDK. Only the webhook signing secret is CDK-managed.
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Linear webhook signing secret'),
    });
  });

  test('has NO DynamoDB Streams event-source mapping (outbound goes through MCP)', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  test('webhook handler env wires dedup table + processor + secret ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          LINEAR_WEBHOOK_SECRET_ARN: Match.anyValue(),
          LINEAR_WEBHOOK_DEDUP_TABLE_NAME: Match.anyValue(),
          LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('processor handler env wires all mapping tables + task table + workspace registry', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          LINEAR_PROJECT_MAPPING_TABLE_NAME: Match.anyValue(),
          LINEAR_USER_MAPPING_TABLE_NAME: Match.anyValue(),
          LINEAR_WORKSPACE_REGISTRY_TABLE_NAME: Match.anyValue(),
          TASK_TABLE_NAME: Match.anyValue(),
          TASK_EVENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('webhook processor Lambda timeout is generous (>=120s) for its synchronous work', () => {
    // The processor does real synchronous work per event — attachment screening,
    // orchestration graph seed + root release, per-workspace OAuth resolve. The
    // Lambda timeout is kept generous (WEBHOOK_PROCESSOR_TIMEOUT_SECONDS=120) so an
    // issue with several attachments or a wide root layer never gets killed
    // mid-call, which surfaces as a silent hang rather than an error. Identify the
    // processor by its unique env var and assert its Timeout is at least 120s.
    const fns = template.findResources('AWS::Lambda::Function');
    const processors = Object.values(fns).filter(
      (fn) => fn.Properties?.Environment?.Variables?.LINEAR_PROJECT_MAPPING_TABLE_NAME !== undefined,
    );
    expect(processors).toHaveLength(1);
    expect(processors[0].Properties.Timeout).toBeGreaterThanOrEqual(120);
  });

  test('webhook dedup table has TTL attribute for 60s expiry', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'dedup_key', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });
});

describe('LinearIntegration construct — seed-time root release throttle', () => {
  // When orchestrationTable + userConcurrencyTable are both provided, the
  // webhook processor env carries the concurrency table + cap so it throttles
  // the seed-time ROOT release (a failed root is unrecoverable by the sweep).
  function buildWith(opts: { withConcurrency: boolean }): Template {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const orchestrationTable = new dynamodb.Table(stack, 'OrchTable', {
      partitionKey: { name: 'orchestration_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sub_issue_id', type: dynamodb.AttributeType.STRING },
    });
    const userConcurrencyTable = opts.withConcurrency
      ? new dynamodb.Table(stack, 'ConcTable', {
        partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      })
      : undefined;
    new LinearIntegration(stack, 'LinearIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
      orchestrationTable,
      ...(userConcurrencyTable && { userConcurrencyTable, maxConcurrentTasksPerUser: 7 }),
    });
    return Template.fromStack(stack);
  }

  test('wires USER_CONCURRENCY_TABLE_NAME + cap when the concurrency table is provided', () => {
    const t = buildWith({ withConcurrency: true });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATION_TABLE_NAME: Match.anyValue(),
          USER_CONCURRENCY_TABLE_NAME: Match.anyValue(),
          MAX_CONCURRENT_TASKS_PER_USER: '7',
        }),
      },
    });
  });

  test('does NOT set USER_CONCURRENCY_TABLE_NAME when the table is omitted (back-compat)', () => {
    const t = buildWith({ withConcurrency: false });
    // The processor still has ORCHESTRATION_TABLE_NAME but no concurrency var.
    const fns = t.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: { Variables: Match.objectLike({ USER_CONCURRENCY_TABLE_NAME: Match.anyValue() }) },
      },
    });
    expect(Object.keys(fns)).toHaveLength(0);
  });
});

describe('LinearIntegration construct — attachmentsBucket wiring', () => {
  // Regression-guard: webhook processor needs ATTACHMENTS_BUCKET_NAME and S3
  // Put/Delete on the bucket so `extractImageUrlAttachments` can reach the
  // bucket via createTaskCore. Without this, Linear-triggered tasks with
  // markdown image attachments fail with 503 ("Attachment storage is not
  // configured.").
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    const attachmentsBucket = new s3.Bucket(stack, 'AttachmentsBucket');

    new LinearIntegration(stack, 'LinearIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
      attachmentsBucket,
    });

    template = Template.fromStack(stack);
  });

  test('processor env includes ATTACHMENTS_BUCKET_NAME when bucket provided', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ATTACHMENTS_BUCKET_NAME: Match.anyValue(),
          LINEAR_PROJECT_MAPPING_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('processor role can PutObject and DeleteObject on the attachments bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Effect: 'Allow',
          }),
          Match.objectLike({
            Action: 's3:DeleteObject*',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});

describe('revoked-authorization recording (#812)', () => {
  // The whole point of the issue: markWorkspaceRevoked existed but every
  // token-resolving role held read-only registry access, so the conditional write
  // failed AccessDenied and was swallowed — a feature that read as implemented
  // while being permanently inert. The grant is the fix; assert it exists, so a
  // future least-privilege tightening cannot quietly make it dormant again.
  test('the webhook processor holds registry WRITE, not just read', () => {
    const app = new App();
    const stack = new Stack(app, 'RevocationStack');
    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
    });
    new LinearIntegration(stack, 'LinearIntegration', { api, userPool, taskTable, taskEventsTable });
    const template = Template.fromStack(stack);

    const processorPolicy = Object.values(template.findResources('AWS::IAM::Policy')).find((p) =>
      JSON.stringify(p.Properties.Roles ?? '').includes('WebhookProcessorFn'),
    );
    expect(processorPolicy).toBeDefined();
    // Scoped to the statement that actually covers the REGISTRY table. Stringifying
    // the whole statement list and grepping for `dynamodb:UpdateItem` proved nothing:
    // this same role holds grantReadWriteData on taskTable and taskEventsTable, which
    // contribute that action anyway — so the assertion stayed green with the registry
    // grant reverted to read-only, leaving `markWorkspaceRevoked` permanently inert,
    // which is the dormancy this grant exists to end. Mutation-checked by reverting it.
    const statements = processorPolicy!.Properties.PolicyDocument.Statement as Array<{
      Action?: unknown;
      Resource?: unknown;
    }>;
    const registryStatements = statements.filter((s) =>
      JSON.stringify(s.Resource ?? '').includes('WorkspaceRegistryTable'),
    );
    expect(registryStatements.length).toBeGreaterThan(0);
    // UpdateItem is what markWorkspaceRevoked needs; a read-only grant omits it.
    expect(JSON.stringify(registryStatements.map((s) => s.Action))).toContain('dynamodb:UpdateItem');
  });
});
