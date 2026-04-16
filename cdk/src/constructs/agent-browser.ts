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
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface AgentBrowserProps {
  readonly browserName?: string;
  readonly screenshotRetentionDays?: number;
}

export class AgentBrowser extends Construct {
  public readonly browser: agentcore.BrowserCustom;
  public readonly gateway: agentcore.Gateway;
  public readonly browserToolFn: lambda.NodejsFunction;
  public readonly screenshotBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: AgentBrowserProps) {
    super(scope, id);

    // --- Screenshot S3 bucket ---
    this.screenshotBucket = new s3.Bucket(this, 'ScreenshotBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: Duration.days(props?.screenshotRetentionDays ?? 30),
        },
      ],
    });

    NagSuppressions.addResourceSuppressions(this.screenshotBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Screenshot bucket does not require server access logging — short-lived artifacts with lifecycle expiration',
      },
    ]);

    // --- BrowserCustom resource ---
    this.browser = new agentcore.BrowserCustom(this, 'BrowserCustom', {
      browserCustomName: props?.browserName ?? 'bgagent_browser',
      recordingConfig: {
        enabled: true,
        s3Location: {
          bucketName: this.screenshotBucket.bucketName,
          objectKey: 'recordings/',
        },
      },
      browserSigning: agentcore.BrowserSigning.ENABLED,
    });

    // --- Lambda function for browser tool ---
    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.browserToolFn = new lambda.NodejsFunction(this, 'BrowserToolFn', {
      entry: path.join(handlersDir, 'browser-tool.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: {
        BROWSER_ID: this.browser.browserId,
        SCREENSHOT_BUCKET_NAME: this.screenshotBucket.bucketName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    this.browser.grantUse(this.browserToolFn);
    this.screenshotBucket.grantReadWrite(this.browserToolFn);

    NagSuppressions.addResourceSuppressions(this.browserToolFn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Lambda basic execution role uses AWS managed AWSLambdaBasicExecutionRole',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Browser grantUse and S3 grantReadWrite generate wildcard permissions — required by L2 construct grants',
      },
    ], true);

    // --- Gateway with Lambda target ---
    this.gateway = new agentcore.Gateway(this, 'Gateway');

    const toolSchema = agentcore.ToolSchema.fromInline([
      {
        name: 'screenshot',
        description: 'Capture a screenshot of a web page at the given URL',
        inputSchema: {
          type: agentcore.SchemaDefinitionType.OBJECT,
          properties: {
            action: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'The action to perform. Must be "screenshot".',
            },
            url: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'The URL of the web page to capture',
            },
            taskId: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'Optional task ID for organizing screenshots',
            },
          },
          required: ['action', 'url'],
        },
        outputSchema: {
          type: agentcore.SchemaDefinitionType.OBJECT,
          properties: {
            status: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'Result status: success or error',
            },
            screenshotS3Key: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'S3 key of the stored screenshot',
            },
            presignedUrl: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'Presigned URL to download the screenshot',
            },
            error: {
              type: agentcore.SchemaDefinitionType.STRING,
              description: 'Error message if the action failed',
            },
          },
        },
      },
    ]);

    this.gateway.addLambdaTarget('BrowserToolTarget', {
      lambdaFunction: this.browserToolFn,
      toolSchema,
    });

    NagSuppressions.addResourceSuppressions(this.gateway, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Gateway execution role requires wildcard permissions — generated by CDK L2 construct',
      },
      {
        id: 'AwsSolutions-COG1',
        reason: 'Gateway default Cognito user pool uses M2M client credentials flow — password policy not applicable',
      },
      {
        id: 'AwsSolutions-COG2',
        reason: 'Gateway default Cognito user pool uses M2M client credentials flow — MFA not applicable',
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'Gateway default Cognito user pool uses M2M client credentials flow — advanced security not required',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(this.browser, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'BrowserCustom execution role requires wildcard permissions for Bedrock browser operations — generated by CDK L2 construct',
      },
    ], true);
  }

  grantInvokeBrowserTool(grantee: iam.IGrantable): void {
    this.browserToolFn.grantInvoke(grantee);
  }

  grantReadScreenshots(grantee: iam.IGrantable): void {
    this.screenshotBucket.grantRead(grantee);
  }
}
