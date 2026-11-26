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

import * as path from 'path';
import { ArnFormat, Duration, NestedStack, type NestedStackProps, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const REGISTRY_HANDLER_TIMEOUT_SECONDS = 15;

// API Gateway cuts an integration off at 29 s.
const REGISTRY_PUBLISH_TIMEOUT_SECONDS = 28;

export interface RegistryApiProps extends NestedStackProps {
  readonly agentRegistryId: string;
  /** The Cognito user pool the main API authorizes against. The
   *  RegistryPublisher and RegistryApprover groups are created on it. */
  readonly userPool: cognito.IUserPool;
  /** API Gateway stage name; matches the main API (default `v1`). */
  readonly stageName?: string;
}

/**
 * NestedStack exposing the registry REST API. {@link apiUrl} is the invoke URL
 * the CLI targets for `registry` commands (distinct from the main API URL).
 * It owns its RestApi: API Gateway methods live in the stack of their RestApi,
 * and CloudFormation allows 500 resources per stack.
 */
export class RegistryApi extends NestedStack {
  public readonly api: apigw.RestApi;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: RegistryApiProps) {
    super(scope, id, props);

    new cognito.CfnUserPoolGroup(this, 'RegistryPublisherGroup', {
      userPoolId: props.userPool.userPoolId,
      groupName: 'RegistryPublisher',
      description: 'May publish agent asset registry records (#246).',
    });
    new cognito.CfnUserPoolGroup(this, 'RegistryApproverGroup', {
      userPoolId: props.userPool.userPoolId,
      groupName: 'RegistryApprover',
      description: 'May approve/reject/deprecate registry records and auto-approve on publish (#246).',
    });

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const environment = { AGENT_REGISTRY_ID: props.agentRegistryId, ABCA_COMPONENT: 'registry-api' };
    const bundling: lambda.BundlingOptions = { externalModules: [] };

    const registryFn = (
      fnId: string,
      entry: string,
      timeoutSeconds = REGISTRY_HANDLER_TIMEOUT_SECONDS,
    ): lambda.NodejsFunction =>
      new lambda.NodejsFunction(this, fnId, {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `entry` is always one of four hardcoded literals below (registry-{publish,resolve,list,show}.ts); never user input. handlersDir is a compile-time __dirname join.
        entry: path.join(handlersDir, entry),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment,
        bundling,
        timeout: Duration.seconds(timeoutSeconds),
      });

    const publishFn = registryFn('RegistryPublishFn', 'registry-publish.ts', REGISTRY_PUBLISH_TIMEOUT_SECONDS);
    const resolveFn = registryFn('RegistryResolveFn', 'registry-resolve.ts');
    const listFn = registryFn('RegistryListFn', 'registry-list.ts');
    const showFn = registryFn('RegistryShowFn', 'registry-show.ts');

    const registryArn = Stack.of(this).formatArn({
      service: 'agent-registry',
      resource: 'registry',
      resourceName: props.agentRegistryId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const recordArn = Stack.of(this).formatArn({
      service: 'agent-registry',
      resource: 'registry',
      resourceName: `${props.agentRegistryId}/record/*`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const readActions = [
      'agent-registry:GetRegistryRecord',
      'agent-registry:ListRegistryRecords',
    ];
    const writeActions = [
      'agent-registry:CreateRegistryRecord',
      'agent-registry:SubmitRegistryRecordForApproval',
      'agent-registry:UpdateRegistryRecordStatus',
    ];
    publishFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: [...readActions, ...writeActions], resources: [registryArn, recordArn] }),
    );
    for (const fn of [resolveFn, listFn, showFn]) {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: readActions, resources: [registryArn, recordArn] }));
    }

    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });
    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `${Stack.of(this).stackName}-registry`,
      description: 'ABCA agent asset registry API (#246).',
      deployOptions: {
        stageName: props.stageName ?? 'v1',
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigw.MethodLoggingLevel.INFO,
      },
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [props.userPool],
    });
    const authOptions: apigw.MethodOptions = {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    const registry = this.api.root.addResource('registry');
    const records = registry.addResource('records');
    records.addMethod('POST', new apigw.LambdaIntegration(publishFn, { allowTestInvoke: false }), authOptions);
    records.addMethod('GET', new apigw.LambdaIntegration(listFn, { allowTestInvoke: false }), authOptions);

    const resolve = registry.addResource('resolve');
    resolve.addMethod('GET', new apigw.LambdaIntegration(resolveFn, { allowTestInvoke: false }), authOptions);

    const byKind = records.addResource('{kind}');
    const byNamespace = byKind.addResource('{namespace}');
    const byName = byNamespace.addResource('{name}');
    byName.addMethod('GET', new apigw.LambdaIntegration(showFn, { allowTestInvoke: false }), authOptions);

    this.apiUrl = this.api.url;

    for (const fn of [publishFn, resolveFn, listFn, showFn]) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'agent-registry registry/<id>/record/* wildcard scoped to this registry because record ids are server-assigned and unknown at synth (#246)',
        },
      ], true);
    }
    NagSuppressions.addResourceSuppressions(this.api, [
      {
        id: 'AwsSolutions-APIG2',
        reason: 'Request validation is performed in-handler (parseRef / body schema); registry payloads are small and typed at the handler boundary.',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'No WAFv2 web ACL on the registry API — same posture as the internal/dev deployment; the API is Cognito-authenticated and operator-scoped (#246).',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonAPIGatewayPushToCloudWatchLogs is the AWS-recommended managed policy for API Gateway CloudWatch logging',
      },
    ], true);
  }
}
