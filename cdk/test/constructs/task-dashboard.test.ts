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

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { TaskDashboard } from '../../src/constructs/task-dashboard';

function createStack(): { stack: Stack; template: Template } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  const logGroup = new logs.LogGroup(stack, 'AppLogGroup');

  new TaskDashboard(stack, 'TaskDashboard', {
    applicationLogGroup: logGroup,
    runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test-runtime',
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('TaskDashboard construct', () => {
  test('creates a CloudWatch Dashboard', () => {
    const { template } = createStack();
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('dashboard name includes stack name', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'BackgroundAgent-Tasks-TestStack',
    });
  });
});
