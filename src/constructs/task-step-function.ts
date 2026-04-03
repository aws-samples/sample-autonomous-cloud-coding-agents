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

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for TaskStepFunction construct.
 */
export interface TaskStepFunctionProps {
  readonly cluster: ecs.ICluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly containerDefinition: ecs.ContainerDefinition;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly vpc: ec2.IVpc;
  readonly loadTaskFn: lambda.IFunction;
  readonly admissionControlFn: lambda.IFunction;
  readonly hydrateContextFn: lambda.IFunction;
  readonly transitionToRunningFn: lambda.IFunction;
  readonly finalizeTaskFn: lambda.IFunction;
  readonly handleErrorFn: lambda.IFunction;
}

/**
 * CDK construct that creates a Step Functions state machine orchestrating the
 * task lifecycle: load → admit → hydrate → run (Fargate) → finalize.
 */
export class TaskStepFunction extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: TaskStepFunctionProps) {
    super(scope, id);

    // --- Error handler (shared catch target) ---
    const handleError = new sfn_tasks.LambdaInvoke(this, 'HandleError', {
      lambdaFunction: props.handleErrorFn,
      resultPath: '$.errorResult',
      payloadResponseOnly: true,
    });

    const failState = new sfn.Fail(this, 'TaskFailed', {
      cause: 'Task processing failed',
    });

    handleError.next(failState);

    // --- Step 1: Load Task and Blueprint ---
    const loadTask = new sfn_tasks.LambdaInvoke(this, 'LoadTaskAndBlueprint', {
      lambdaFunction: props.loadTaskFn,
      resultPath: '$',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    loadTask.addRetry({
      maxAttempts: 3,
      backoffRate: 2,
      interval: Duration.seconds(2),
      errors: ['States.TaskFailed'],
    });
    loadTask.addCatch(handleError, {
      resultPath: '$.error',
    });

    // --- Step 2: Admission Control ---
    const admissionControl = new sfn_tasks.LambdaInvoke(this, 'AdmissionControl', {
      lambdaFunction: props.admissionControlFn,
      resultPath: '$',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    admissionControl.addRetry({
      maxAttempts: 2,
      backoffRate: 2,
      interval: Duration.seconds(2),
      errors: ['States.TaskFailed'],
    });
    admissionControl.addCatch(handleError, {
      resultPath: '$.error',
    });

    // --- Step 3: Choice — admitted? ---
    const admissionChoice = new sfn.Choice(this, 'IsAdmitted');

    const notAdmittedError = new sfn_tasks.LambdaInvoke(this, 'HandleNotAdmitted', {
      lambdaFunction: props.handleErrorFn,
      payload: sfn.TaskInput.fromObject({
        'Error': 'AdmissionDenied',
        'Cause': 'Concurrency limit reached',
        'task_id.$': '$.task.task_id',
        'user_id.$': '$.task.user_id',
      }),
      resultPath: '$.errorResult',
      payloadResponseOnly: true,
    });
    notAdmittedError.next(failState);

    // --- Step 4: Hydrate Context ---
    const hydrateContext = new sfn_tasks.LambdaInvoke(this, 'HydrateContext', {
      lambdaFunction: props.hydrateContextFn,
      resultPath: '$',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    hydrateContext.addRetry({
      maxAttempts: 2,
      backoffRate: 2,
      interval: Duration.seconds(5),
      errors: ['States.TaskFailed'],
    });
    hydrateContext.addCatch(handleError, {
      resultPath: '$.error',
    });

    // --- Step 5: Transition to Running ---
    const transitionToRunning = new sfn_tasks.LambdaInvoke(this, 'TransitionToRunning', {
      lambdaFunction: props.transitionToRunningFn,
      resultPath: '$',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    transitionToRunning.addCatch(handleError, {
      resultPath: '$.error',
    });

    // --- Step 6: Run Fargate Task (.sync — waits for completion) ---
    const runFargateTask = new sfn_tasks.EcsRunTask(this, 'RunFargateTask', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster: props.cluster,
      taskDefinition: props.taskDefinition,
      launchTarget: new sfn_tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      containerOverrides: [{
        containerDefinition: props.containerDefinition,
        environment: [
          { name: 'REPO_URL', value: sfn.JsonPath.stringAt('$.containerEnv.REPO_URL') },
          { name: 'TASK_DESCRIPTION', value: sfn.JsonPath.stringAt('$.containerEnv.TASK_DESCRIPTION') },
          { name: 'ISSUE_NUMBER', value: sfn.JsonPath.stringAt('$.containerEnv.ISSUE_NUMBER') },
          { name: 'MAX_TURNS', value: sfn.JsonPath.stringAt('$.containerEnv.MAX_TURNS') },
          { name: 'MAX_BUDGET_USD', value: sfn.JsonPath.stringAt('$.containerEnv.MAX_BUDGET_USD') },
          { name: 'ANTHROPIC_MODEL', value: sfn.JsonPath.stringAt('$.containerEnv.ANTHROPIC_MODEL') },
          { name: 'TASK_ID', value: sfn.JsonPath.stringAt('$.containerEnv.TASK_ID') },
          { name: 'SYSTEM_PROMPT_OVERRIDES', value: sfn.JsonPath.stringAt('$.containerEnv.SYSTEM_PROMPT_OVERRIDES') },
        ],
      }],
      taskTimeout: sfn.Timeout.duration(Duration.hours(8)),
      resultPath: '$.fargateResult',
    });
    runFargateTask.addCatch(handleError, {
      resultPath: '$.error',
    });

    // --- Step 7: Finalize Task ---
    const finalizeTask = new sfn_tasks.LambdaInvoke(this, 'FinalizeTask', {
      lambdaFunction: props.finalizeTaskFn,
      resultPath: '$',
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    finalizeTask.addRetry({
      maxAttempts: 3,
      backoffRate: 2,
      interval: Duration.seconds(2),
      errors: ['States.TaskFailed'],
    });
    finalizeTask.addCatch(handleError, {
      resultPath: '$.error',
    });

    const successState = new sfn.Succeed(this, 'TaskSucceeded');
    finalizeTask.next(successState);

    // --- Wire the chain ---
    const definition = loadTask
      .next(admissionControl)
      .next(
        admissionChoice
          .when(sfn.Condition.booleanEquals('$.admitted', false), notAdmittedError)
          .otherwise(
            hydrateContext
              .next(transitionToRunning)
              .next(runFargateTask)
              .next(finalizeTask),
          ),
      );

    // --- Log group for state machine execution logs ---
    const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: '/aws/stepfunctions/fargate-agent',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(9),
      tracingEnabled: true,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    NagSuppressions.addResourceSuppressions(this.stateMachine, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Step Functions state machine requires wildcard permissions for Lambda invoke, ECS RunTask, CloudWatch Logs, and X-Ray tracing — generated by CDK grants',
      },
      {
        id: 'AwsSolutions-SF1',
        reason: 'State machine logging is configured with ALL log level',
      },
      {
        id: 'AwsSolutions-SF2',
        reason: 'X-Ray tracing is enabled on the state machine',
      },
    ], true);
  }
}
