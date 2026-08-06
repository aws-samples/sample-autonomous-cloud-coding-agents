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

// The agent asset registry API (#246), isolated in its own NestedStack.
//
// WHY A SEPARATE API (not routes on the main TaskApi): the four handler Lambdas
// + their roles/policies + the API Gateway methods/resources/permissions are
// ~35 resources. Once the orchestration arc (#695) landed on the root
// AgentStack, the root was near CloudFormation's hard 500-resource-per-stack
// limit; adding the registry surface pushed it over (and further over on the
// ECS compute path). API Gateway routes must live on the same stack as their
// RestApi, so the only way to move the routes off the root is to give the
// registry its OWN RestApi. This nested stack owns the RestApi, a Cognito
// authorizer (bound to the SHARED user pool so credentials are identical), the
// four Lambdas, and their routes — reclaiming the whole surface from the root
// budget. The trade-off is a second invoke URL (`registryApiUrl`) the CLI must
// be configured with; see docs/design/REGISTRY.md.
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

/** Standard API-handler Lambda timeout (seconds); mirrors TaskApi's handlers. */
const REGISTRY_HANDLER_TIMEOUT_SECONDS = 15;

export interface RegistryApiProps extends NestedStackProps {
  /** AgentCore registry id the handlers target (via `AGENT_REGISTRY_ID`). */
  readonly agentRegistryId: string;
  /** The SHARED Cognito user pool — the registry API authorizes against the same
   *  pool as the main API, so a caller's existing JWT works unchanged. The two
   *  RegistryPublisher/RegistryApprover groups are created on this pool. */
  readonly userPool: cognito.IUserPool;
  /** API Gateway stage name; matches the main API (default `v1`). */
  readonly stageName?: string;
}

/**
 * NestedStack exposing the registry REST API. {@link apiUrl} is the invoke URL
 * the CLI targets for `registry` commands (distinct from the main API URL).
 */
export class RegistryApi extends NestedStack {
  public readonly api: apigw.RestApi;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: RegistryApiProps) {
    super(scope, id, props);

    // Two Cognito groups gate writes (REGISTRY.md §10): publishers submit,
    // approvers drive records to APPROVED. Resolve/list/show are open to any
    // authenticated caller. Created on the shared pool.
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

    // --- Handler Lambdas ---
    const handlersDir = path.join(__dirname, '..', 'handlers');
    const environment = { AGENT_REGISTRY_ID: props.agentRegistryId, ABCA_COMPONENT: 'registry-api' };
    // The AgentCore control-plane SDK is preview and NOT in the Lambda runtime,
    // so bundle it (do not externalize) — mirrors the provisioning handler.
    const bundling: lambda.BundlingOptions = { externalModules: [] };

    const registryFn = (fnId: string, entry: string): lambda.NodejsFunction =>
      new lambda.NodejsFunction(this, fnId, {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `entry` is always one of four hardcoded literals below (registry-{publish,resolve,list,show}.ts); never user input. handlersDir is a compile-time __dirname join.
        entry: path.join(handlersDir, entry),
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        environment,
        bundling,
        timeout: Duration.seconds(REGISTRY_HANDLER_TIMEOUT_SECONDS),
      });

    const publishFn = registryFn('RegistryPublishFn', 'registry-publish.ts');
    const resolveFn = registryFn('RegistryResolveFn', 'registry-resolve.ts');
    const listFn = registryFn('RegistryListFn', 'registry-list.ts');
    const showFn = registryFn('RegistryShowFn', 'registry-show.ts');

    // Control-plane + data-plane actions, scoped to THIS registry (the id is
    // known at synth time). Record ids are server-assigned, so the record ARN
    // keeps a `/record/*` wildcard under this registry.
    const registryArn = Stack.of(this).formatArn({
      service: 'bedrock-agentcore',
      resource: 'registry',
      resourceName: props.agentRegistryId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const recordArn = Stack.of(this).formatArn({
      service: 'bedrock-agentcore',
      resource: 'registry',
      resourceName: `${props.agentRegistryId}/record/*`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const readActions = [
      'bedrock-agentcore:GetRegistryRecord',
      'bedrock-agentcore:ListRegistryRecords',
    ];
    const writeActions = [
      'bedrock-agentcore:CreateRegistryRecord',
      'bedrock-agentcore:SubmitRegistryRecordForApproval',
      'bedrock-agentcore:UpdateRegistryRecordStatus',
    ];
    publishFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: [...readActions, ...writeActions], resources: [registryArn, recordArn] }),
    );
    for (const fn of [resolveFn, listFn, showFn]) {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: readActions, resources: [registryArn, recordArn] }));
    }

    // --- REST API (own RestApi + Cognito authorizer on the shared pool) ---
    // Access + method logging mirror the main TaskApi so cdk-nag APIG1/APIG6 pass.
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

    // --- Routes: /registry ---
    const registry = this.api.root.addResource('registry');
    const records = registry.addResource('records');
    records.addMethod('POST', new apigw.LambdaIntegration(publishFn), authOptions);
    records.addMethod('GET', new apigw.LambdaIntegration(listFn), authOptions);

    const resolve = registry.addResource('resolve');
    resolve.addMethod('GET', new apigw.LambdaIntegration(resolveFn), authOptions);

    // show: /registry/records/{kind}/{namespace}/{name}
    const byKind = records.addResource('{kind}');
    const byNamespace = byKind.addResource('{namespace}');
    const byName = byNamespace.addResource('{name}');
    byName.addMethod('GET', new apigw.LambdaIntegration(showFn), authOptions);

    this.apiUrl = this.api.url;

    // --- cdk-nag suppressions ---
    for (const fn of [publishFn, resolveFn, listFn, showFn]) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'bedrock-agentcore registry/<id>/record/* wildcard scoped to this registry because record ids are server-assigned and unknown at synth (#246)',
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
      {
        id: 'AwsSolutions-COG4',
        reason: 'All routes use the Cognito authorizer bound to the shared user pool (authOptions).',
      },
    ], true);
  }
}
