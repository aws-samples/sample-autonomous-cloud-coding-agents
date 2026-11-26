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

import { ArnFormat, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface OperationalAlertsProps {
  /**
   * Optional email address to subscribe to the alerts topic. When set,
   * an SNS email subscription is created and AWS sends a confirmation
   * link the operator must click before delivery starts. When omitted,
   * the topic ships with no subscriptions.
   */
  readonly alertEmail?: string;

  /**
   * Removal policy applied to both resources this construct owns — the
   * SNS topic and its customer-managed KMS key — so they share one
   * lifecycle on stack deletion.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * One stack-wide SNS topic that CloudWatch alarms publish to, encrypted
 * with a customer-managed KMS key.
 */
export class OperationalAlerts extends Construct {
  public readonly topic: sns.Topic;

  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: OperationalAlertsProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // CloudWatch cannot publish to a topic encrypted with the AWS-managed
    // ``alias/aws/sns`` key: that key's policy cannot be edited to grant
    // ``cloudwatch.amazonaws.com`` ``kms:GenerateDataKey*`` / ``kms:Decrypt``.
    this.key = new kms.Key(this, 'Key', {
      description: 'Encrypts the ABCA operational-alerts SNS topic (DLQ-depth alarms → operators)',
      enableKeyRotation: true,
      removalPolicy,
    });
    // CMK ARNs are UUIDs and cannot be ARN-scoped: the deploy role's
    // KMS-lifecycle grant is conditioned on this tag.
    Tags.of(this.key).add('ABCA', 'operational-alerts');

    // In a KMS key policy ``Resource: '*'`` means this key only.
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsUseOfKey',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
    }));

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'ABCA operational alerts',
      masterKey: this.key,
    });
    this.topic.applyRemovalPolicy(removalPolicy);

    // ``SnsAction`` does not grant the alarm ``sns:Publish`` on the topic (#925).
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsPublish',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.topic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
        ArnLike: {
          'aws:SourceArn': Stack.of(this).formatArn({
            service: 'cloudwatch',
            resource: 'alarm',
            resourceName: '*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        },
      },
    }));

    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureTransport',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sns:Publish'],
      resources: [this.topic.topicArn],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    if (props.alertEmail) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(props.alertEmail)) {
        throw new Error(
          `OperationalAlerts: alertEmail "${props.alertEmail}" is not a valid email address`,
        );
      }
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    }
  }

  /** Makes each alarm publish to the alerts topic when it goes into ALARM. */
  public addAlarmActions(...alarms: cloudwatch.Alarm[]): void {
    const action = new cloudwatchActions.SnsAction(this.topic);
    for (const alarm of alarms) {
      alarm.addAlarmAction(action);
    }
  }

  /**
   * Lets a principal publish to this topic, use of its key included. The
   * caller must suppress cdk-nag AwsSolutions-IAM5 for the generated
   * `kms:GenerateDataKey*`.
   */
  public grantPublish(grantee: iam.IGrantable): void {
    this.topic.grantPublish(grantee);
  }
}
