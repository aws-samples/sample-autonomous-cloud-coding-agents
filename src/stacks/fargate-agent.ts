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
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { FargateAgentCluster } from '../constructs/fargate-agent-cluster';
import { TaskStepFunction } from '../constructs/task-step-function';

/**
 * Properties for the FargateAgentStack.
 */
export interface FargateAgentStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly runtimeSecurityGroup: ec2.ISecurityGroup;
  readonly taskTable: dynamodb.ITable;
  readonly taskEventsTable: dynamodb.ITable;
  readonly userConcurrencyTable: dynamodb.ITable;
  readonly repoTable: dynamodb.ITable;
  readonly githubTokenSecret: secretsmanager.ISecret;
  readonly memoryId?: string;
}

export class FargateAgentStack extends Stack {
  constructor(scope: Construct, id: string, props: FargateAgentStackProps) {
    super(scope, id, props);

    const handlersDir = path.join(__dirname, '..', 'handlers', 'sfn-steps');

    // --- Fargate Cluster ---
    const fargateCluster = new FargateAgentCluster(this, 'FargateCluster', {
      vpc: props.vpc,
      securityGroup: props.runtimeSecurityGroup,
      taskTable: props.taskTable,
      taskEventsTable: props.taskEventsTable,
      userConcurrencyTable: props.userConcurrencyTable,
      githubTokenSecret: props.githubTokenSecret,
      memoryId: props.memoryId,
    });

    // --- Shared Lambda config ---
    const sharedEnv = {
      TASK_TABLE_NAME: props.taskTable.tableName,
      TASK_EVENTS_TABLE_NAME: props.taskEventsTable.tableName,
      USER_CONCURRENCY_TABLE_NAME: props.userConcurrencyTable.tableName,
      GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecret.secretArn,
      ...(props.repoTable && { REPO_TABLE_NAME: props.repoTable.tableName }),
      ...(props.memoryId && { MEMORY_ID: props.memoryId }),
    };

    const defaultFnProps = {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      environment: sharedEnv,
      bundling: { externalModules: ['@aws-sdk/*'] },
    };

    const grantDynamoAndSecrets = (fn: lambda.NodejsFunction) => {
      props.taskTable.grantReadWriteData(fn);
      props.taskEventsTable.grantReadWriteData(fn);
      props.userConcurrencyTable.grantReadWriteData(fn);
      props.githubTokenSecret.grantRead(fn);
      if (props.repoTable) {
        props.repoTable.grantReadData(fn);
      }
      // AgentCore Memory permissions for hydration/finalization (fail-open)
      if (props.memoryId) {
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['bedrock-agentcore:*'],
          resources: ['*'],
        }));
      }
    };

    // --- Step Function Lambda handlers ---
    const loadTaskFn = new lambda.NodejsFunction(this, 'LoadTaskFn', {
      ...defaultFnProps,
      entry: path.join(handlersDir, 'load-task.ts'),
      handler: 'handler',
    });
    grantDynamoAndSecrets(loadTaskFn);

    const admissionControlFn = new lambda.NodejsFunction(this, 'AdmissionControlFn', {
      ...defaultFnProps,
      entry: path.join(handlersDir, 'admission-control.ts'),
      handler: 'handler',
    });
    grantDynamoAndSecrets(admissionControlFn);

    const hydrateContextFn = new lambda.NodejsFunction(this, 'HydrateContextFn', {
      ...defaultFnProps,
      entry: path.join(handlersDir, 'hydrate-context.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
    });
    grantDynamoAndSecrets(hydrateContextFn);

    const transitionToRunningFn = new lambda.NodejsFunction(this, 'TransitionToRunningFn', {
      ...defaultFnProps,
      entry: path.join(handlersDir, 'transition-to-running.ts'),
      handler: 'handler',
    });
    grantDynamoAndSecrets(transitionToRunningFn);

    const finalizeTaskFn = new lambda.NodejsFunction(this, 'FinalizeTaskFn', {
      ...defaultFnProps,
      entry: path.join(handlersDir, 'finalize-task.ts'),
      handler: 'handler',
    });
    grantDynamoAndSecrets(finalizeTaskFn);

    const handleErrorFn = new lambda.NodejsFunction(this, 'HandleErrorFn', {
      ...defaultFnProps,
      entry: path.join(handlersDir, 'handle-error.ts'),
      handler: 'handler',
    });
    grantDynamoAndSecrets(handleErrorFn);

    // --- Step Functions Orchestration ---
    const stepFunction = new TaskStepFunction(this, 'TaskStepFunction', {
      cluster: fargateCluster.cluster,
      taskDefinition: fargateCluster.taskDefinition,
      containerDefinition: fargateCluster.containerDefinition,
      securityGroup: fargateCluster.securityGroup,
      vpc: props.vpc,
      loadTaskFn,
      admissionControlFn,
      hydrateContextFn,
      transitionToRunningFn,
      finalizeTaskFn,
      handleErrorFn,
    });

    // --- Outputs ---
    new CfnOutput(this, 'StateMachineArn', {
      value: stepFunction.stateMachine.stateMachineArn,
      description: 'ARN of the Fargate task orchestration state machine',
    });

    new CfnOutput(this, 'ClusterArn', {
      value: fargateCluster.cluster.clusterArn,
      description: 'ARN of the ECS Fargate cluster',
    });

    new CfnOutput(this, 'TaskDefinitionArn', {
      value: fargateCluster.taskDefinition.taskDefinitionArn,
      description: 'ARN of the Fargate task definition',
    });

    // --- cdk-nag suppressions ---
    const allFns = [loadTaskFn, admissionControlFn, hydrateContextFn, transitionToRunningFn, finalizeTaskFn, handleErrorFn];
    for (const fn of allFns) {
      NagSuppressions.addResourceSuppressions(fn, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Lambda basic execution role is the AWS-recommended managed policy',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB index/* wildcards generated by CDK grantReadWriteData; Secrets Manager wildcards generated by CDK grantRead',
        },
      ], true);
    }
  }
}
