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

import { App, Stack, Duration } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { TaskStepFunction } from '../../src/constructs/task-step-function';

function createStack(): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const securityGroup = new ec2.SecurityGroup(stack, 'SG', { vpc });
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef', {
    cpu: 4096,
    memoryLimitMiB: 16384,
  });
  const containerDefinition = taskDefinition.addContainer('Agent', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/python:3.12'),
  });

  const fnProps = {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    timeout: Duration.seconds(60),
  };

  const loadTaskFn = new lambda.Function(stack, 'LoadTaskFn', fnProps);
  const admissionControlFn = new lambda.Function(stack, 'AdmissionControlFn', fnProps);
  const hydrateContextFn = new lambda.Function(stack, 'HydrateContextFn', fnProps);
  const transitionToRunningFn = new lambda.Function(stack, 'TransitionToRunningFn', fnProps);
  const finalizeTaskFn = new lambda.Function(stack, 'FinalizeTaskFn', fnProps);
  const handleErrorFn = new lambda.Function(stack, 'HandleErrorFn', fnProps);

  new TaskStepFunction(stack, 'TaskSFN', {
    cluster,
    taskDefinition,
    containerDefinition,
    securityGroup,
    vpc,
    loadTaskFn,
    admissionControlFn,
    hydrateContextFn,
    transitionToRunningFn,
    finalizeTaskFn,
    handleErrorFn,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('TaskStepFunction construct', () => {
  test('creates a Step Functions state machine', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  });

  test('state machine has logging configured', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: Match.objectLike({
        Level: 'ALL',
        IncludeExecutionData: true,
      }),
    });
  });

  test('state machine has tracing enabled', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      TracingConfiguration: {
        Enabled: true,
      },
    });
  });

  test('creates a log group for the state machine', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/stepfunctions/fargate-agent',
      RetentionInDays: 90,
    });
  });

  test('state machine definition contains expected states', () => {
    const { template } = createStack();
    const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
    const smResource = Object.values(stateMachines)[0];
    const definitionString = JSON.stringify(smResource.Properties.DefinitionString);
    expect(definitionString).toContain('LoadTaskAndBlueprint');
    expect(definitionString).toContain('AdmissionControl');
    expect(definitionString).toContain('IsAdmitted');
    expect(definitionString).toContain('HydrateContext');
    expect(definitionString).toContain('TransitionToRunning');
    expect(definitionString).toContain('RunFargateTask');
    expect(definitionString).toContain('FinalizeTask');
    expect(definitionString).toContain('HandleError');
    expect(definitionString).toContain('TaskFailed');
    expect(definitionString).toContain('TaskSucceeded');
  });

  test('state machine definition uses ECS RunTask.sync integration', () => {
    const { template } = createStack();
    const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
    const smResource = Object.values(stateMachines)[0];
    const definitionString = JSON.stringify(smResource.Properties.DefinitionString);
    expect(definitionString).toContain('ecs:runTask.sync');
  });

  test('state machine IAM role has ECS RunTask permissions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ecs:RunTask',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('state machine IAM role has Lambda invoke permissions', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});
