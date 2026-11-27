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
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { JiraIntegration } from '../../src/constructs/jira-integration';
import { LinearIntegration } from '../../src/constructs/linear-integration';
import { SlackIntegration } from '../../src/constructs/slack-integration';
import { grantTaskCreation, taskCreationEnvironment, TaskCreationInputs } from '../../src/constructs/task-creation';

const tableArn = (name: string) => `arn:aws:dynamodb:us-east-1:123456789012:table/${name}`;
const USER_POOL_ARN = 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_pool';
const ORCHESTRATOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';
const ATTACHMENT_OBJECTS_ARN = 'arn:aws:s3:::attachments/*';

/** The required inputs, as resources from outside the stack: their names and ARNs are literal. */
function minimalInputs(stack: Stack): TaskCreationInputs {
  return {
    taskTable: dynamodb.Table.fromTableArn(stack, 'Tasks', tableArn('Tasks')),
    taskEventsTable: dynamodb.Table.fromTableArn(stack, 'TaskEvents', tableArn('TaskEvents')),
    userPool: cognito.UserPool.fromUserPoolArn(stack, 'UserPool', USER_POOL_ARN),
  };
}

/** Every input but the bucket, which the Slack construct does not take. */
function inputsWithoutBucket(stack: Stack): TaskCreationInputs {
  return {
    ...minimalInputs(stack),
    repoTable: dynamodb.Table.fromTableArn(stack, 'Repos', tableArn('Repos')),
    budgetTable: dynamodb.Table.fromTableArn(stack, 'Budgets', tableArn('Budgets')),
    orchestratorFunctionArn: ORCHESTRATOR_ARN,
    guardrailId: 'gr-1',
    guardrailVersion: '3',
    taskRetentionDays: 30,
  };
}

function allInputs(stack: Stack): TaskCreationInputs {
  return { ...inputsWithoutBucket(stack), attachmentsBucket: s3.Bucket.fromBucketArn(stack, 'Attachments', 'arn:aws:s3:::attachments') };
}

describe('taskCreationEnvironment', () => {
  test('all inputs: the ten variables', () => {
    expect(taskCreationEnvironment(allInputs(new Stack()))).toEqual({
      TASK_TABLE_NAME: 'Tasks',
      TASK_EVENTS_TABLE_NAME: 'TaskEvents',
      TASK_RETENTION_DAYS: '30',
      REPO_TABLE_NAME: 'Repos',
      ORCHESTRATOR_FUNCTION_ARN: ORCHESTRATOR_ARN,
      GUARDRAIL_ID: 'gr-1',
      GUARDRAIL_VERSION: '3',
      ATTACHMENTS_BUCKET_NAME: 'attachments',
      BUDGET_TABLE_NAME: 'Budgets',
      USER_POOL_ID: 'us-east-1_pool',
    });
  });

  test('minimal inputs: the two table names and a retention of 90 days', () => {
    expect(taskCreationEnvironment(minimalInputs(new Stack()))).toEqual({
      TASK_TABLE_NAME: 'Tasks',
      TASK_EVENTS_TABLE_NAME: 'TaskEvents',
      TASK_RETENTION_DAYS: '90',
    });
  });

  test.each(['guardrailId', 'guardrailVersion'] as const)('%s without the other: neither guardrail variable', (given) => {
    const environment = taskCreationEnvironment({ ...minimalInputs(new Stack()), [given]: 'gr-1' });

    expect(Object.keys(environment)).toEqual(['TASK_TABLE_NAME', 'TASK_EVENTS_TABLE_NAME', 'TASK_RETENTION_DAYS']);
  });
});

type Statement = { Action: string | string[]; Effect: string; Resource: unknown };

/**
 * The statements that `grantTaskCreation` adds to the policy of a function's role, in the order of
 * the policy. A table grant also renders a statement for the stream of the table: it is left out.
 */
function statementsGranted(inputsIn: (stack: Stack) => TaskCreationInputs): Statement[] {
  const stack = new Stack(new App(), 'TestStack');
  const fn = new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => undefined;'),
  });
  grantTaskCreation(fn, inputsIn(stack));
  const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
  expect(policies).toHaveLength(1);
  const statements: Statement[] = policies[0].Properties.PolicyDocument.Statement;
  return statements.filter(({ Action }) => ![Action].flat().every(action => /^dynamodb:Get(Records|ShardIterator)$/.test(action)));
}

const allow = (Action: unknown, Resource: unknown) => ({ Action, Effect: 'Allow', Resource });
const readWrite = (table: string) => allow(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem']), [tableArn(table)]);
const read = (table: string) => allow(expect.arrayContaining(['dynamodb:GetItem']), [tableArn(table)]);

describe('grantTaskCreation', () => {
  test('all inputs: the tables, the group lookup, the orchestrator, the guardrail, then the bucket', () => {
    const statements = statementsGranted(allInputs);

    expect(statements).toEqual([
      readWrite('Tasks'),
      readWrite('TaskEvents'),
      read('Repos'),
      read('Budgets'),
      allow('cognito-idp:AdminListGroupsForUser', USER_POOL_ARN),
      allow('lambda:InvokeFunction', ORCHESTRATOR_ARN),
      allow('bedrock:ApplyGuardrail', {
        'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':guardrail/gr-1']],
      }),
      allow(expect.arrayContaining(['s3:PutObject']), ATTACHMENT_OBJECTS_ARN),
      allow('s3:DeleteObject*', ATTACHMENT_OBJECTS_ARN),
    ]);
    // Read means read only, and the objects of the bucket can be put and deleted but not read or listed.
    const actionsOn = (arnFragment: string) => statements
      .filter(statement => JSON.stringify(statement.Resource).includes(arnFragment))
      .flatMap(statement => statement.Action);
    expect([...actionsOn('table/Repos'), ...actionsOn('table/Budgets')].filter(action => /Put|Update|Delete|Write|\*/.test(action))).toEqual([]);
    expect(actionsOn(':s3:').filter(action => !/^s3:(PutObject|Abort|DeleteObject)/.test(action))).toEqual([]);
  });

  test('minimal inputs: read and write of the two tables, nothing else', () => {
    expect(statementsGranted(minimalInputs)).toEqual([readWrite('Tasks'), readWrite('TaskEvents')]);
  });
});

// The constructs that create tasks: each hands its processor, and every input its props declare, to both functions.
test.each([
  ['LinearIntegration', 'WebhookProcessorFn', LinearIntegration],
  ['JiraIntegration', 'WebhookProcessorFn', JiraIntegration],
  ['SlackIntegration', 'CommandProcessorFn', SlackIntegration],
] as const)('%s gives its %s the environment and the access of task creation', (id, processor, Integration) => {
  const stack = new Stack(new App(), 'TestStack');
  const inputs = inputsWithoutBucket(stack);
  new Integration(stack, id, { api: new apigw.RestApi(stack, 'Api'), ...inputs });
  const template = Template.fromStack(stack);
  const ofProcessor = (type: string) => {
    const found = Object.entries(template.findResources(type)).filter(([logicalId]) => logicalId.startsWith(id + processor));
    expect(found).toHaveLength(1);
    return found[0][1].Properties;
  };

  expect(ofProcessor('AWS::Lambda::Function').Environment.Variables).toMatchObject(taskCreationEnvironment(inputs));
  expect(ofProcessor('AWS::IAM::Policy').PolicyDocument.Statement).toEqual(expect.arrayContaining(statementsGranted(inputsWithoutBucket)));
});

test('SlackIntegration hands on no bucket, whatever its props object carries', () => {
  const stack = new Stack(new App(), 'TestStack');
  new SlackIntegration(stack, 'SlackIntegration', { api: new apigw.RestApi(stack, 'Api'), ...allInputs(stack) });
  const template = JSON.stringify(Template.fromStack(stack).toJSON());

  expect(template).not.toContain('ATTACHMENTS_BUCKET_NAME');
  expect(template).not.toContain('s3:');
});
