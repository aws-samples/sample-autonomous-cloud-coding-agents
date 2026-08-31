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

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { IterationHeartbeat } from '../../src/constructs/iteration-heartbeat';

function synth(props?: { schedule?: Duration }) {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const taskTable = new dynamodb.Table(stack, 'TaskTable', {
    partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
  });
  new IterationHeartbeat(stack, 'IterationHeartbeat', { taskTable, ...props });
  return Template.fromStack(stack);
}

describe('IterationHeartbeat', () => {
  test('creates a scheduled Lambda that runs every 2 minutes by default', () => {
    const template = synth();
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(2 minutes)',
      State: 'ENABLED',
    });
  });

  test('honours a caller-supplied schedule', () => {
    synth({ schedule: Duration.minutes(5) }).hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  test('the rule targets the sweep function', () => {
    const template = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const sweep = Object.keys(fns).find((id) => id.startsWith('IterationHeartbeatSweepFn'));
    expect(sweep).toBeDefined();
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([Match.objectLike({ Arn: { 'Fn::GetAtt': [sweep, 'Arn'] } })]),
    });
  });

  test('surfaces the task table + its status index to the handler', () => {
    // The sweep queries the StatusIndex GSI for RUNNING tasks; without both env
    // vars it has nothing to sweep and silently no-ops.
    const template = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const sweep = Object.values(fns).find((f) => {
      const vars = (f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables ?? {};
      return 'TASK_STATUS_INDEX_NAME' in vars;
    });
    expect(sweep).toBeDefined();
    const vars = (sweep as { Properties: { Environment: { Variables: Record<string, unknown> } } })
      .Properties.Environment.Variables;
    expect(vars.TASK_TABLE_NAME).toBeDefined();
    expect(vars.TASK_STATUS_INDEX_NAME).toBeDefined();
  });

  test('is granted READ on the task table and never write', () => {
    // The construct's own comment claims read-only. The sweep edits a Linear
    // comment, not a task row, so a write grant here would be unexplained
    // privilege on the platform's most sensitive table.
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = JSON.stringify(Object.values(policies)
      .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: unknown[] } } })
        .Properties.PolicyDocument.Statement));
    expect(actions).toContain('dynamodb:Query');
    for (const write of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem']) {
      expect(actions).not.toContain(write);
    }
  });

  test('runs on ARM with a bounded timeout', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Timeout: 120,
    });
  });
});
