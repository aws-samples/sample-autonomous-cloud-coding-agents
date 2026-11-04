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

const RECONCILER_TIMEOUT_MINUTES = 5;
const RECONCILER_SCHEDULE_MINUTES = 5;
import * as path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import constants from '../../../contracts/constants.json';

export interface MicrovmContinuationManagerProps {
  readonly taskTable: dynamodb.ITable;
  readonly approvalsTable: dynamodb.ITable;
  readonly userConcurrencyTable: dynamodb.ITable;
  readonly continuationBucket: ContinuationBucket;
  /** Unqualified function ARN; saved tasks select their original published version. */
  readonly orchestratorFunctionArn: string;
  readonly imageArn: string;
  readonly maxConcurrentTasksPerUser?: number;
}

/** Recover lost continuation signals and clean saved objects after confirmed shutdown. */
export class MicrovmContinuationManager extends Construct {
  public readonly fn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: MicrovmContinuationManagerProps) {
    super(scope, id);
    this.fn = new lambda.NodejsFunction(this, 'ReconcilerFn', {
      entry: path.join(__dirname, '..', 'handlers', 'reconcile-microvm-continuations.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(RECONCILER_TIMEOUT_MINUTES),
      memorySize: 256,
      environment: {
        ABCA_COMPONENT: 'orchestr',
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_APPROVALS_TABLE_NAME: props.approvalsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        CONTINUATION_BUCKET_NAME: props.continuationBucket.bucket.bucketName,
        ORCHESTRATOR_FUNCTION_ARN: props.orchestratorFunctionArn,
        MAX_CONCURRENT_TASKS_PER_USER: String(props.maxConcurrentTasksPerUser ?? 10),
      },
      // Bundle the pinned Lambda serializer: DurableExecutionName is required
      // for deduplication and may be absent from the runtime's older SDK.
      bundling: {
        externalModules: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
        // Shared supervisor imports reach attachment screening; pdf-parse needs
        // its packaged worker assets, just as in the main orchestrator bundle.
        nodeModules: ['pdf-parse'],
      },
    });
    props.taskTable.grantReadWriteData(this.fn);
    props.approvalsTable.grantReadWriteData(this.fn);
    props.userConcurrencyTable.grantReadWriteData(this.fn);
    props.continuationBucket.grantCoordinator(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:GetMicrovm', 'lambda:TerminateMicrovm'],
      resources: [props.imageArn, `${props.imageArn}:*`],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'], resources: [`${props.orchestratorFunctionArn}:*`],
    }));
    new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(Duration.minutes(RECONCILER_SCHEDULE_MINUTES)),
      targets: [new targets.LambdaFunction(this.fn)],
    });
    NagSuppressions.addResourceSuppressions(this.fn, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole supplies CloudWatch runtime logs.' },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* grants accompany the task tables; S3 is restricted to the continuation prefix; MicroVM state/termination uses one image and its versions; invoke uses only retained versions of the one coordinator.',
      },
    ], true);
  }
}

/** Durable task recovery data. Active checkpoints must not expire with debug traces. */
export class ContinuationBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id: 'abandoned-multipart-uploads',
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      }],
    });
    NagSuppressions.addResourceSuppressions(this.bucket, [{
      id: 'AwsSolutions-S1',
      reason: 'Recovery data is private and task-scoped through IAM; coordinator cleanup runs after task closure. No public or anonymous access path. Server access logging is not enabled for task storage.',
    }]);
  }

  /** A worker can save/read its own task versions, never list or remove data. */
  public grantWorker(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      resources: [this.bucket.arnForObjects(
        `${constants.microvm_continuation.object_key_prefix}\${aws:PrincipalTag/task_id}/*`,
      )],
    }));
  }

  /** Coordinator owns launch inputs and cleanup after a task closes. */
  public grantCoordinator(grantee: iam.IGrantable): void {
    const prefix = constants.microvm_continuation.object_key_prefix;
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [this.bucket.arnForObjects(`${prefix}*`)],
    }));
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucketVersions'],
      resources: [this.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': `${prefix}*` } },
    }));
  }
}
