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

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { grantTrackerFeedback, integrationTable, secretArnPattern, webhookDedupTable } from '../../src/constructs/integration-parts';
import { JiraIntegration } from '../../src/constructs/jira-integration';
import { LinearIntegration } from '../../src/constructs/linear-integration';

/** The tables that `build` creates under a construct with the deployed id `LinearIntegration`, by logical ID. */
function tablesUnderLinearIntegration(build: (parent: Construct) => void): Record<string, Record<string, any>> {
  const stack = new Stack(new App(), 'TestStack');
  build(new Construct(stack, 'LinearIntegration'));
  return Template.fromStack(stack).findResources('AWS::DynamoDB::Table');
}

describe('integrationTable', () => {
  test('without options: the whole resource, under the logical ID a deployed stack holds', () => {
    const tables = tablesUnderLinearIntegration((parent) => {
      integrationTable(parent, 'ProjectMappingTable', { partitionKey: 'linear_project_id', removalPolicy: RemovalPolicy.DESTROY });
    });

    expect(tables).toEqual({
      LinearIntegrationProjectMappingTableF152E008: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          AttributeDefinitions: [{ AttributeName: 'linear_project_id', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName: 'linear_project_id', KeyType: 'HASH' }],
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        },
        UpdateReplacePolicy: 'Delete',
        DeletionPolicy: 'Delete',
      },
    });
  });

  test('ttl alone adds the TTL attribute and no index', () => {
    const [table] = Object.values(tablesUnderLinearIntegration((parent) => {
      integrationTable(parent, 'InstallationTable', { partitionKey: 'team_id', ttl: true, removalPolicy: RemovalPolicy.DESTROY });
    }));

    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(table.Properties.GlobalSecondaryIndexes).toBeUndefined();
  });

  test('platformUserIndex alone adds the index and no TTL attribute; the removal policy is the given one', () => {
    const [table] = Object.values(tablesUnderLinearIntegration((parent) => {
      integrationTable(parent, 'UserMappingTable', {
        partitionKey: 'linear_identity', platformUserIndex: true, removalPolicy: RemovalPolicy.RETAIN,
      });
    }));

    expect(table.Properties.AttributeDefinitions).toEqual([
      { AttributeName: 'linear_identity', AttributeType: 'S' },
      { AttributeName: 'platform_user_id', AttributeType: 'S' },
      { AttributeName: 'linked_at', AttributeType: 'S' },
    ]);
    expect(table.Properties.GlobalSecondaryIndexes).toEqual([{
      IndexName: 'PlatformUserIndex',
      KeySchema: [
        { AttributeName: 'platform_user_id', KeyType: 'HASH' },
        { AttributeName: 'linked_at', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    }]);
    expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
    expect(table).toMatchObject({ UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' });
  });
});

describe('webhookDedupTable', () => {
  test('the whole resource, under the logical ID a deployed stack holds', () => {
    const tables = tablesUnderLinearIntegration((parent) => {
      webhookDedupTable(parent, RemovalPolicy.DESTROY);
    });

    expect(tables).toEqual({
      LinearIntegrationWebhookDedupTable1162175A: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          AttributeDefinitions: [{ AttributeName: 'dedup_key', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName: 'dedup_key', KeyType: 'HASH' }],
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
        },
        UpdateReplacePolicy: 'Delete',
        DeletionPolicy: 'Delete',
      },
    });
  });

  test('the removal policy is the given one', () => {
    const [table] = Object.values(tablesUnderLinearIntegration((parent) => {
      webhookDedupTable(parent, RemovalPolicy.RETAIN);
    }));

    expect(table).toMatchObject({ UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' });
  });
});

/** The ARN pattern of the secrets named `namePattern`, as a stack without a fixed account and Region renders it. */
function secretsNamed(namePattern: string): Record<string, unknown> {
  return {
    'Fn::Join': ['', [
      'arn:', { Ref: 'AWS::Partition' }, ':secretsmanager:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, `:secret:${namePattern}`,
    ]],
  };
}

/** A function outside a tracker's construct, as the consumers of the stack are. */
function consumer(stack: Stack, id: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => undefined;'),
  });
}

/** What the function `id` was given: its environment, and the statements of its role's policy in their order. */
function granted(template: Template, id: string): { environment: Record<string, unknown>; statements: Array<Record<string, any>> } {
  const only = (type: string) => {
    const found = Object.entries(template.findResources(type)).filter(([logicalId]) => logicalId.startsWith(id));
    expect(found).toHaveLength(1);
    return found[0][1].Properties;
  };
  return {
    environment: only('AWS::Lambda::Function').Environment.Variables,
    statements: only('AWS::IAM::Policy').PolicyDocument.Statement,
  };
}

/** `statements` read the table whose ARN holds `arnFragment` and nothing else, and none of them writes. */
function expectTableRead(statements: Array<Record<string, any>>, arnFragment: string): void {
  const actions: string[] = statements.flatMap(statement => statement.Action);
  expect(actions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Scan']));
  expect(actions.filter(action => /Put|Update|Delete|Write|\*/.test(action))).toEqual([]);
  const resources: unknown[] = statements.flatMap(statement => statement.Resource);
  expect(resources.filter(resource => !JSON.stringify(resource).includes(arnFragment))).toEqual([]);
}

describe('secretArnPattern', () => {
  test('the secrets of that name pattern, in the account and Region of the scope', () => {
    const stack = new Stack(new App(), 'TestStack');
    const pattern = secretArnPattern(new Construct(stack, 'LinearIntegration'), 'bgagent-linear-oauth-*');

    expect(stack.resolve(pattern)).toEqual(secretsNamed('bgagent-linear-oauth-*'));
  });
});

describe('grantTrackerFeedback', () => {
  test.each<[boolean, string | string[]]>([
    [true, ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']],
    [false, 'secretsmanager:GetSecretValue'],
  ])('writeBack %s: the registry read, its name in the environment, then %j on the OAuth secrets', (writeBack, secretActions) => {
    const stack = new Stack(new App(), 'TestStack');
    const registry = dynamodb.Table.fromTableName(stack, 'Registry', 'JiraRegistry');
    grantTrackerFeedback(consumer(stack, 'Consumer'), registry, 'JIRA_WORKSPACE_REGISTRY_TABLE_NAME', 'bgagent-jira-oauth-*', writeBack);
    const { environment, statements } = granted(Template.fromStack(stack), 'Consumer');

    expect(environment).toEqual({ JIRA_WORKSPACE_REGISTRY_TABLE_NAME: 'JiraRegistry' });
    expectTableRead(statements.slice(0, -1), ':table/JiraRegistry');
    expect(statements.at(-1)).toEqual({ Action: secretActions, Effect: 'Allow', Resource: secretsNamed('bgagent-jira-oauth-*') });
  });
});

// Each tracker under its deployed id, so the registry is the table a deployed stack holds.
describe.each([
  [
    'LinearIntegration', LinearIntegration, 'LinearIssueIndex',
    'LINEAR_WORKSPACE_REGISTRY_TABLE_NAME', 'LinearIntegrationWorkspaceRegistryTableC954A5BC', 'bgagent-linear-oauth-*',
  ],
  [
    'JiraIntegration', JiraIntegration, 'JiraIssueIndex',
    'JIRA_WORKSPACE_REGISTRY_TABLE_NAME', 'JiraIntegrationWorkspaceRegistryTableFF87F094', 'bgagent-jira-oauth-*',
  ],
] as const)('%s as a FeedbackTracker', (id, Integration, issueIndexName, registryEnvironmentName, registryLogicalId, oauthSecretNamePattern) => {
  let tracker: LinearIntegration | JiraIntegration;
  let template: Template;

  beforeAll(() => {
    const stack = new Stack(new App(), 'TestStack');
    const table = (tableId: string) => new dynamodb.Table(stack, tableId, {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    tracker = new Integration(stack, id, {
      api: new apigw.RestApi(stack, 'Api'),
      userPool: new cognito.UserPool(stack, 'UserPool'),
      taskTable: table('TaskTable'),
      taskEventsTable: table('TaskEventsTable'),
    });
    tracker.grantFeedback(consumer(stack, 'WriteBack'), { writeBack: true });
    tracker.grantFeedback(consumer(stack, 'NoWriteBack'), { writeBack: false });
    template = Template.fromStack(stack);
  });

  test('names the task-table index of its issues', () => {
    expect(tracker.issueIndexName).toBe(issueIndexName);
  });

  test.each<[string, string | string[]]>([
    ['WriteBack', ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']],
    ['NoWriteBack', 'secretsmanager:GetSecretValue'],
  ])('grantFeedback, consumer %s: its registry read and name, then %j on its OAuth secrets', (consumerId, secretActions) => {
    const { environment, statements } = granted(template, consumerId);

    expect(environment).toEqual({ [registryEnvironmentName]: { Ref: registryLogicalId } });
    expectTableRead(statements.slice(0, -1), registryLogicalId);
    expect(statements.at(-1)).toEqual({ Action: secretActions, Effect: 'Allow', Resource: secretsNamed(oauthSecretNamePattern) });
  });
});
