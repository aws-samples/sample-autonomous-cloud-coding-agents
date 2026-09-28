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

import { App, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { OperationalAlerts } from '../../src/constructs/operational-alerts';

/** Builds a throwaway DLQ-depth alarm to exercise ``addAlarmActions``. */
function makeDlqAlarm(stack: Stack, id: string): cloudwatch.Alarm {
  const queue = new sqs.Queue(stack, `${id}Queue`);
  return new cloudwatch.Alarm(stack, `${id}Alarm`, {
    metric: queue.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(5),
      statistic: 'Maximum',
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  });
}

describe('OperationalAlerts', () => {
  let template: Template;
  let topicRef: { Ref: string };

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const alerts = new OperationalAlerts(stack, 'Alerts');
    alerts.addAlarmActions(makeDlqAlarm(stack, 'One'), makeDlqAlarm(stack, 'Two'));
    template = Template.fromStack(stack);
    topicRef = { Ref: Object.keys(template.findResources('AWS::SNS::Topic'))[0] };
  });

  test('permits CloudWatch publishing only to this topic from regional account alarms', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      Topics: [topicRef],
      PolicyDocument: {
        Statement: Match.arrayWith([{
          Sid: 'AllowCloudWatchAlarmsPublish',
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: 'sns:Publish',
          Resource: topicRef,
          Condition: {
            StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
            ArnLike: {
              'aws:SourceArn': {
                'Fn::Join': ['', [
                  'arn:', { Ref: 'AWS::Partition' },
                  ':cloudwatch:', { Ref: 'AWS::Region' },
                  ':', { Ref: 'AWS::AccountId' }, ':alarm:*',
                ]],
              },
            },
          },
        }]),
      },
    });
  });

  test('creates a KMS-encrypted SNS topic with key rotation', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::KMS::Key', 1);
    // The topic must reference THIS construct's CMK by GetAtt — asserting
    // Match.anyValue() would pass even for the literal `alias/aws/sns`,
    // the exact AWS-managed-key state the construct exists to prevent
    // (CloudWatch can't publish through it). Pin the GetAtt to the Key.
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: {
        'Fn::GetAtt': [Match.stringLikeRegexp('AlertsKey'), 'Arn'],
      },
    });
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('CMK key policy grants CloudWatch decrypt + generate-data-key', () => {
    // Load-bearing: CloudWatch cannot deliver to a topic on the
    // AWS-managed key. Without this grant the alarm action deploys but
    // every publish fails at runtime with KMS AccessDenied.

    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: Match.arrayWith(['kms:Decrypt', 'kms:GenerateDataKey*']),
          }),
        ]),
      },
    });
  });

  test('enforces TLS on publish via a DenyInsecureTransport topic policy', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 'sns:Publish',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('creates no subscription when alertEmail is omitted', () => {
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  describe('with email subscription', () => {
    let emailTemplate: Template;
    beforeAll(() => {
      const app = new App();
      const stack = new Stack(app, 'TestStack');
      new OperationalAlerts(stack, 'Alerts', { alertEmail: 'ops@example.com' });
      emailTemplate = Template.fromStack(stack);
    });

    test('creates the configured email subscription', () => {
      emailTemplate.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
    });
  });

  test('throws at synth on a malformed alertEmail rather than shipping a junk subscription', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    expect(
      () => new OperationalAlerts(stack, 'Alerts', { alertEmail: 'not-an-email' }),
    ).toThrow(/not a valid email/);
  });

  describe('with retention', () => {
    let retainedTemplate: Template;
    beforeAll(() => {
      const app = new App();
      const stack = new Stack(app, 'TestStack');
      new OperationalAlerts(stack, 'Alerts', { removalPolicy: RemovalPolicy.RETAIN });
      retainedTemplate = Template.fromStack(stack);
    });

    test('retains both the topic and the key', () => {
      // Regression guard: removalPolicy previously reached only the key,
      // leaving the topic on CDK's implicit default — key and topic could
      // diverge on stack deletion.
      retainedTemplate.hasResource('AWS::SNS::Topic', { DeletionPolicy: 'Retain' });
      retainedTemplate.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    });
  });

  test('addAlarmActions wires each alarm to publish to the topic', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.allResourcesProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: [topicRef],
    });
  });
});
