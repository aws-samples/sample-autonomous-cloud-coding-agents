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

// The operator console (`web/`): a static single-page app served by CloudFront from
// a private S3 bucket, signing users in against the platform's existing Cognito user
// pool with Cognito managed login (authorization code + PKCE).
//
// Its own top-level stack rather than part of `AgentStack`: the application stack runs
// close to CloudFormation's 500-resource limit, and the console has an independent
// lifecycle (UI releases should not touch the platform's resources).
//
// Exposure: the app shell (HTML/JS/CSS) is public, like any SPA served from a CDN. It
// contains no data or secrets; the only values it learns at runtime (`config.json`:
// API URL, user pool and public client ids, login domain) are public identifiers. All
// data comes from the REST API, which requires a Cognito token on every route.
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface OperatorConsoleStackProps extends StackProps {
  /** The platform's user pool (from `AgentStack`); the console adds its own app client and login domain. */
  readonly userPool: cognito.IUserPool;
  /** REST API base URL including the stage, e.g. `https://abc.execute-api.us-east-1.amazonaws.com/v1/`. */
  readonly apiUrl: string;
  /** Directory with the built console (`web/dist`, produced by `mise //web:bundle`). */
  readonly assetDirectory: string;
  /**
   * Cognito managed-login domain prefix (globally unique per Region).
   * @default `abca-<account>-<stack name>`
   */
  readonly loginDomainPrefix?: string;
  /** Extra sign-in redirect origins, e.g. `http://localhost:5173` for local development against a deployed stack. */
  readonly additionalOrigins?: readonly string[];
  readonly removalPolicy?: RemovalPolicy;
  /**
   * Onboarded repositories and the platform GitHub token. With both, the stack adds a
   * small console API (`GET /repos/{repo_id}/issues`) for the issue picker. It lives
   * here, not on the platform API, so console features never spend the platform
   * stack's resource budget.
   */
  readonly repoTable?: dynamodb.ITable;
  readonly githubTokenSecret?: secretsmanager.ISecret;
}

const HANDLERS_DIR = path.join(__dirname, '..', 'handlers');
/** Covers one GitHub call (8 s client timeout) plus a cold start. */
const ISSUES_HANDLER_TIMEOUT_SECONDS = 15;

/** Hashed bundle files never change, so browsers may cache them for a year. */
const IMMUTABLE_CACHE = s3deploy.CacheControl.fromString('public, max-age=31536000, immutable');
/** index.html and config.json must be fetched fresh, or a release would not reach browsers. */
const NO_CACHE = s3deploy.CacheControl.fromString('no-cache');
/** How long a console sign-in lasts before the user must sign in again (a working day). */
const SESSION_HOURS = 12;

export class OperatorConsoleStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly appClient: cognito.UserPoolClient;
  /** `https://<distribution>.cloudfront.net/` */
  public readonly consoleUrl: string;
  /** Console-only API (issue picker); undefined without `repoTable` and `githubTokenSecret`. */
  public readonly consoleApi?: apigw.RestApi;

  constructor(scope: Construct, id: string, props: OperatorConsoleStackProps) {
    super(scope, id, props);
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    const indexHtml = path.join(props.assetDirectory, 'index.html');
    if (!existsSync(indexHtml)) {
      throw new Error(`Operator console bundle not found at ${props.assetDirectory}. Run \`mise //web:bundle\` first, `
        + 'or deploy without the console by dropping `-c operatorConsole=true`.');
    }

    const bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // AWS-managed: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy.
        // The Content-Security-Policy ships in index.html, so no custom policy resource is needed.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      // Client-side routes (/tasks/…) have no object in S3; OAC reports a missing key as 403.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
      enableLogging: false,
      comment: 'ABCA operator console',
    });
    const origin = `https://${this.distribution.distributionDomainName}`;
    this.consoleUrl = `${origin}/`;

    const loginDomain = new cognito.UserPoolDomain(this, 'LoginDomain', {
      userPool: props.userPool,
      cognitoDomain: {
        domainPrefix: props.loginDomainPrefix
          ?? Fn.join('-', ['abca', Aws.ACCOUNT_ID, this.stackName.toLowerCase()]),
      },
    });

    const origins_ = [origin, ...(props.additionalOrigins ?? [])];
    this.appClient = new cognito.UserPoolClient(this, 'ConsoleClient', {
      userPool: props.userPool,
      // A browser app cannot keep a secret: public client, authorization code + PKCE.
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: origins_.map((o) => `${o}/auth/callback`),
        logoutUrls: origins_.map((o) => `${o}/`),
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(SESSION_HOURS),
    });

    if (props.repoTable && props.githubTokenSecret) {
      this.consoleApi = this.createConsoleApi(props.userPool, props.repoTable, props.githubTokenSecret, origins_, removalPolicy);
    }

    const assets = new s3deploy.BucketDeployment(this, 'Assets', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(props.assetDirectory, { exclude: ['index.html'] })],
      cacheControl: [IMMUTABLE_CACHE],
      // Keep earlier hashed bundles: browsers mid-session still reference them.
      prune: false,
    });

    const entry = new s3deploy.BucketDeployment(this, 'Entry', {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.data('index.html', readFileSync(indexHtml, 'utf8')),
        s3deploy.Source.jsonData('config.json', {
          apiBaseUrl: props.apiUrl,
          ...(this.consoleApi ? { consoleApiBaseUrl: this.consoleApi.url } : {}),
          region: Aws.REGION,
          auth: {
            mode: 'cognito',
            userPoolId: props.userPool.userPoolId,
            userPoolClientId: this.appClient.userPoolClientId,
            domain: loginDomain.baseUrl(),
          },
        }),
      ],
      cacheControl: [NO_CACHE],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
    // The new index.html must only appear once the bundle it references is in place.
    entry.node.addDependency(assets);

    new CfnOutput(this, 'ConsoleUrl', { value: this.consoleUrl, description: 'Operator console URL' });

    this.suppressNagFindings(bucket);
  }

  /** `GET /repos/{repo_id}/issues` behind the platform's Cognito user pool. */
  private createConsoleApi(
    userPool: cognito.IUserPool,
    repoTable: dynamodb.ITable,
    githubTokenSecret: secretsmanager.ISecret,
    allowedOrigins: readonly string[],
    removalPolicy: RemovalPolicy,
  ): apigw.RestApi {
    const accessLogs = new logs.LogGroup(this, 'ConsoleApiAccessLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy });
    const api = new apigw.RestApi(this, 'ConsoleApi', {
      restApiName: 'OperatorConsoleApi',
      description: 'Console-only routes (issue picker). Every method requires a Cognito ID token.',
      // The platform stack already owns the account-level API Gateway CloudWatch role.
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
      // Only the console's own origin(s), unlike the platform API's '*'.
      defaultCorsPreflightOptions: {
        allowOrigins: [...allowedOrigins],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'ConsoleApiAuthorizer', { cognitoUserPools: [userPool] });
    const validator = new apigw.RequestValidator(this, 'ConsoleApiValidator', { restApi: api, validateRequestParameters: true, validateRequestBody: true });

    const listIssues = new lambda.NodejsFunction(this, 'ListRepoIssuesFn', {
      entry: path.join(HANDLERS_DIR, 'list-repo-issues.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(ISSUES_HANDLER_TIMEOUT_SECONDS),
      environment: {
        REPO_TABLE_NAME: repoTable.tableName,
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
      },
      bundling: { externalModules: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-secrets-manager', '@aws-sdk/lib-dynamodb', '@aws-sdk/util-dynamodb'] },
    });
    repoTable.grantReadData(listIssues);
    githubTokenSecret.grantRead(listIssues);

    api.root.resourceForPath('repos/{repo_id}/issues').addMethod('GET', new apigw.LambdaIntegration(listIssues, { allowTestInvoke: false }), {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      requestValidator: validator,
      requestParameters: { 'method.request.path.repo_id': true },
    });

    new CfnOutput(this, 'ConsoleApiUrl', { value: api.url, description: 'Console-only API (issue picker)' });

    NagSuppressions.addResourceSuppressions(listIssues, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is the AWS-recommended managed policy for Lambda functions.' },
      { id: 'AwsSolutions-IAM5', reason: 'DynamoDB index/* wildcard generated by CDK grantReadData on the repo table.' },
    ], true);
    NagSuppressions.addResourceSuppressions(api, [
      {
        id: 'AwsSolutions-APIG3',
        reason: 'No WAF: one authenticated, read-only route with stage throttling (10 rps). The platform API, which serves all task data and writes, has its own WAF.',
      },
      {
        id: 'AwsSolutions-APIG6',
        reason: 'Access logs are on; execution logging needs the account-level CloudWatch role, which this opt-in stack does not own (the platform stack does).',
      },
      { id: 'AwsSolutions-APIG4', reason: 'CORS preflight (OPTIONS) is unauthenticated by design; the GET route requires a Cognito token.' },
      { id: 'AwsSolutions-COG4', reason: 'CORS preflight (OPTIONS) cannot carry a Cognito token; the GET route uses the Cognito authorizer.' },
    ], true);
    return api;
  }

  private suppressNagFindings(bucket: s3.Bucket): void {
    NagSuppressions.addResourceSuppressions(bucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Server access logs are not enabled. The bucket holds only the public console bundle (no user data); every data access is logged by the authenticated REST API instead.',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'No geo restriction: operators sign in from anywhere; access control is Cognito authentication on the API.' },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'No WAF on the distribution: it serves only the static console bundle with no server-side logic. The REST API that serves all data has its own WAF. A CloudFront-scoped web ACL must also live in us-east-1, which this Region-agnostic stack cannot assume.',
      },
      { id: 'AwsSolutions-CFR3', reason: 'Distribution access logs are not enabled: static public bundle only; data access is logged by the API.' },
      { id: 'AwsSolutions-CFR4', reason: 'Uses the default *.cloudfront.net certificate; no custom domain, so no minimum-TLS-version override applies.' },
      { id: 'AwsSolutions-CFR7', reason: 'OAC is in use (`S3BucketOrigin.withOriginAccessControl`); cdk-nag misclassifies the L2 helper as an OAI deployment.' },
    ], true);

    // Same CDK-managed singletons as LinearVaultConsentPage: found by id prefix so a
    // CDK upgrade that changes their hash does not silently drop the suppression.
    for (const child of this.node.children) {
      if (!child.node.id.startsWith('Custom::CDKBucketDeployment') && !child.node.id.startsWith('Custom::S3AutoDeleteObjects')) continue;
      NagSuppressions.addResourceSuppressions(child, [
        { id: 'AwsSolutions-IAM4', reason: 'CDK-managed singleton Lambda uses the AWS managed AWSLambdaBasicExecutionRole — required by the framework.' },
        { id: 'AwsSolutions-IAM5', reason: 'CDK-managed singleton grants wildcard object access on the CDK assets bucket and the console bucket; generated by the framework, not authored here.' },
        { id: 'AwsSolutions-L1', reason: 'CDK-managed singleton Lambda runtime is chosen by the framework.' },
      ], true);
    }
  }
}

/** Where `mise //web:bundle` writes the console, relative to this file (`cdk/src/stacks`). */
export const DEFAULT_CONSOLE_ASSET_DIRECTORY = path.join(__dirname, '..', '..', '..', 'web', 'dist');
