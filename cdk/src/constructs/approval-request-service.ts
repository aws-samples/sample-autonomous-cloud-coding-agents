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

import * as path from 'node:path';
import { Duration, NestedStack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

const REQUEST_TIMEOUT_SECONDS = 15;
/**
 * Trusted approval writer. A separate API keeps routes inside this child stack.
 * IAM binds a signed POST path to the session's task tag; direct Lambda invoke
 * would lose that binding because Lambda does not expose caller session tags.
 */
export class ApprovalRequestService extends NestedStack {
  public readonly api: apigw.RestApi;
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: {
    taskTable: dynamodb.ITable;
    approvalsTable: dynamodb.ITable;
  }) {
    super(scope, id);
    this.fn = new NodejsFunction(this, 'RequestFn', {
      entry: path.join(__dirname, '..', 'handlers', 'request-approval.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(REQUEST_TIMEOUT_SECONDS),
      memorySize: 256,
      environment: {
        ABCA_COMPONENT: 'approval',
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_APPROVALS_TABLE_NAME: props.approvalsTable.tableName,
      },
    });
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'],
      resources: [props.taskTable.tableArn],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [props.approvalsTable.tableArn],
    }));
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention: logs.RetentionDays.ONE_MONTH });
    this.api = new apigw.RestApi(this, 'Api', {
      description: 'IAM-authenticated worker approval requests; no human decision endpoint.',
      // The parent TaskApi configures the regional API Gateway logging role.
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'v1',
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        throttlingRateLimit: 60,
        throttlingBurstLimit: 100,
      },
    });
    this.api.root.addResource('tasks').addResource('{task_id}').addMethod(
      'POST', new apigw.LambdaIntegration(this.fn),
      { authorizationType: apigw.AuthorizationType.IAM },
    );
    NagSuppressions.addResourceSuppressions(this.fn, [{
      id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole provides Lambda runtime logging.',
    }], true);
    NagSuppressions.addResourceSuppressions(this.api, [
      { id: 'AwsSolutions-APIG2', reason: 'The handler validates request shape and allowed fields. Action descriptions and policy metadata remain worker assertions, not independently verified policy results.' },
      { id: 'AwsSolutions-APIG3', reason: 'Machine-only IAM-signed API; session policy restricts POST to its tagged task path, with stage throttling.' },
      { id: 'AwsSolutions-COG4', reason: 'Workers authenticate with task-scoped AWS credentials, not human Cognito credentials.' },
    ], true);
  }

  /** No wildcard task path on production session credentials. */
  public grantRequests(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [this.api.arnForExecuteApi('POST', '/tasks/${aws:PrincipalTag/task_id}', 'v1')],
      conditions: { Null: { 'aws:PrincipalTag/task_id': 'false' } },
    }));
  }
}
