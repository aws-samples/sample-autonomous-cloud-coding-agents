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
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

/** Days a task record is kept when `taskRetentionDays` is not given. */
const DEFAULT_TASK_RETENTION_DAYS = 90;

/** What a function that creates tasks works with. */
export interface TaskCreationInputs {
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
  /** The pool in which the budget check looks up the groups of a user. Used only with `budgetTable`. */
  readonly userPool: cognito.IUserPool;
  readonly repoTable?: dynamodb.ITable;
  readonly budgetTable?: dynamodb.ITable;
  readonly orchestratorFunctionArn?: string;
  readonly guardrailId?: string;
  readonly guardrailVersion?: string;
  readonly attachmentsBucket?: s3.IBucket;
  readonly taskRetentionDays?: number;
}

/** The environment variables that task creation reads, for the inputs that are given. */
export function taskCreationEnvironment(inputs: TaskCreationInputs): Record<string, string> {
  const environment: Record<string, string> = {
    TASK_TABLE_NAME: inputs.taskTable.tableName,
    TASK_EVENTS_TABLE_NAME: inputs.taskEventsTable.tableName,
    TASK_RETENTION_DAYS: String(inputs.taskRetentionDays ?? DEFAULT_TASK_RETENTION_DAYS),
  };
  if (inputs.repoTable) {
    environment.REPO_TABLE_NAME = inputs.repoTable.tableName;
  }
  if (inputs.orchestratorFunctionArn) {
    environment.ORCHESTRATOR_FUNCTION_ARN = inputs.orchestratorFunctionArn;
  }
  if (inputs.guardrailId && inputs.guardrailVersion) {
    environment.GUARDRAIL_ID = inputs.guardrailId;
    environment.GUARDRAIL_VERSION = inputs.guardrailVersion;
  }
  if (inputs.attachmentsBucket) {
    environment.ATTACHMENTS_BUCKET_NAME = inputs.attachmentsBucket.bucketName;
  }
  if (inputs.budgetTable) {
    environment.BUDGET_TABLE_NAME = inputs.budgetTable.tableName;
    environment.USER_POOL_ID = inputs.userPool.userPoolId;
  }
  return environment;
}

/**
 * Gives `fn` the access that task creation needs, for the inputs that are given. The statements
 * enter the policy of the role in the order of these grants: another order rewrites that policy
 * for every caller.
 */
export function grantTaskCreation(fn: lambda.Function, inputs: TaskCreationInputs): void {
  inputs.taskTable.grantReadWriteData(fn);
  inputs.taskEventsTable.grantReadWriteData(fn);
  if (inputs.repoTable) {
    inputs.repoTable.grantReadData(fn);
  }
  if (inputs.budgetTable) {
    inputs.budgetTable.grantReadData(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminListGroupsForUser'],
      resources: [inputs.userPool.userPoolArn],
    }));
  }
  if (inputs.orchestratorFunctionArn) {
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [inputs.orchestratorFunctionArn],
    }));
  }
  if (inputs.guardrailId) {
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [
        Stack.of(fn).formatArn({
          service: 'bedrock',
          resource: 'guardrail',
          resourceName: inputs.guardrailId,
        }),
      ],
    }));
  }
  if (inputs.attachmentsBucket) {
    inputs.attachmentsBucket.grantPut(fn);
    inputs.attachmentsBucket.grantDelete(fn);
  }
}
