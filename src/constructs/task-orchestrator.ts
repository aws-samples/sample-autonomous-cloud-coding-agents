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
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for TaskOrchestrator construct.
 */
export interface TaskOrchestratorProps {
  /**
   * The DynamoDB task table.
   */
  readonly taskTable: dynamodb.ITable;

  /**
   * The DynamoDB task events table.
   */
  readonly taskEventsTable: dynamodb.ITable;

  /**
   * The DynamoDB user concurrency table.
   */
  readonly userConcurrencyTable: dynamodb.ITable;

  /**
   * ARN of the AgentCore runtime.
   */
  readonly runtimeArn: string;

  /**
   * The DynamoDB repo config table. When provided, the orchestrator loads
   * per-repo blueprint configuration at the start of each task.
   */
  readonly repoTable?: dynamodb.ITable;

  /**
   * Maximum concurrent tasks per user.
   * @default 3
   */
  readonly maxConcurrentTasksPerUser?: number;

  /**
   * Number of days to retain completed task and event records before DynamoDB TTL deletes them.
   * @default 90
   */
  readonly taskRetentionDays?: number;

  /**
   * ARN of the Secrets Manager secret containing the GitHub token.
   * When provided, the orchestrator fetches issue context from GitHub during hydration.
   */
  readonly githubTokenSecretArn?: string;

  /**
   * Additional AgentCore runtime ARNs the orchestrator may invoke.
   * Required when Blueprints specify per-repo runtime ARN overrides.
   */
  readonly additionalRuntimeArns?: string[];

  /**
   * Additional Secrets Manager ARNs the orchestrator may read.
   * Required when Blueprints specify per-repo GitHub token secrets.
   */
  readonly additionalSecretArns?: string[];

  /**
   * Maximum token budget for the assembled user prompt.
   * @default 100000
   */
  readonly userPromptTokenBudget?: number;

  /**
   * AgentCore Memory resource ID for cross-task learning.
   * When provided, the orchestrator reads memory context during hydration
   * and writes fallback episodes during finalization.
   */
  readonly memoryId?: string;
}

/**
 * CDK construct that creates the orchestrator Lambda function with durable execution
 * for managing the task lifecycle (admission → hydration → session → poll → finalize).
 */
export class TaskOrchestrator extends Construct {
  /**
   * The orchestrator Lambda function.
   */
  public readonly fn: lambda.NodejsFunction;

  /**
   * The Lambda alias (required for durable function invocation).
   */
  public readonly alias: iam.IGrantable & { functionArn: string };

  /**
   * CloudWatch alarm that fires when the orchestrator Lambda errors exceed threshold.
   */
  public readonly errorAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: TaskOrchestratorProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');
    const maxConcurrent = props.maxConcurrentTasksPerUser ?? 3;

    this.fn = new lambda.NodejsFunction(this, 'OrchestratorFn', {
      entry: path.join(handlersDir, 'orchestrate-task.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 256,
      durableConfig: {
        executionTimeout: Duration.hours(9),
        retentionPeriod: Duration.days(14),
      },
      environment: {
        TASK_TABLE_NAME: props.taskTable.tableName,
        TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
        USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
        RUNTIME_ARN: props.runtimeArn,
        MAX_CONCURRENT_TASKS_PER_USER: String(maxConcurrent),
        TASK_RETENTION_DAYS: String(props.taskRetentionDays ?? 90),
        ...(props.repoTable && { REPO_TABLE_NAME: props.repoTable.tableName }),
        ...(props.githubTokenSecretArn && { GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn }),
        ...(props.userPromptTokenBudget !== undefined && {
          USER_PROMPT_TOKEN_BUDGET: String(props.userPromptTokenBudget),
        }),
        ...(props.memoryId && { MEMORY_ID: props.memoryId }),
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // DynamoDB grants
    props.taskTable.grantReadWriteData(this.fn);
    props.taskEventsTable.grantReadWriteData(this.fn);
    props.userConcurrencyTable.grantReadWriteData(this.fn);
    if (props.repoTable) {
      props.repoTable.grantReadData(this.fn);
    }

    // Durable execution managed policy
    this.fn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );

    // Secrets Manager grant for GitHub token (context hydration)
    if (props.githubTokenSecretArn) {
      const githubTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'GitHubTokenSecret', props.githubTokenSecretArn,
      );
      githubTokenSecret.grantRead(this.fn);
    }

    // AgentCore runtime invocation permissions
    // The InvokeAgentRuntime API targets a sub-resource (runtime-endpoint/DEFAULT),
    // so we need a wildcard after the runtime ARN.
    const runtimeArns = [props.runtimeArn, ...(props.additionalRuntimeArns ?? [])];
    const runtimeResources = runtimeArns.flatMap(arn => [arn, `${arn}/*`]);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:StopRuntimeSession',
      ],
      resources: runtimeResources,
    }));

    // Per-repo Secrets Manager grants (e.g. per-repo GitHub tokens from Blueprints)
    for (const [index, secretArn] of (props.additionalSecretArns ?? []).entries()) {
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this, `AdditionalSecret${index}`, secretArn,
      );
      secret.grantRead(this.fn);
    }

    // Create alias for durable function invocation
    const fnAlias = this.fn.currentVersion.addAlias('live');
    this.alias = fnAlias;

    // Retry config: durable execution handles retries; disable Lambda-level retries
    // to avoid duplicate invocations that could lead to double task execution.
    fnAlias.configureAsyncInvoke({
      retryAttempts: 0,
    });

    // CloudWatch alarm on orchestrator errors — alerts when async invocations
    // are consistently failing (throttled, dropped, or crashing).
    this.errorAlarm = new cloudwatch.Alarm(this, 'OrchestratorErrorAlarm', {
      metric: this.fn.metricErrors({
        period: Duration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 2,
      alarmDescription: 'Orchestrator Lambda errors exceeded threshold — tasks may be stuck in SUBMITTED state',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    NagSuppressions.addResourceSuppressions(this.fn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicDurableExecutionRolePolicy is the AWS-recommended managed policy for durable Lambda functions',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; AgentCore runtime/* required for sub-resource invocation; Secrets Manager wildcards generated by CDK grantRead; AgentCore Memory wildcards generated by CDK grantRead/grantWrite',
      },
    ], true);
  }
}
