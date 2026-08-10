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

import { RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for the ``OperationalAlerts`` construct.
 */
export interface OperationalAlertsProps {
  /**
   * Optional email address to subscribe to the alerts topic. When set,
   * an SNS email subscription is created and AWS sends a confirmation
   * link the operator must click before delivery starts. When omitted,
   * the topic ships with no subscriptions — operators wire Slack /
   * PagerDuty / email manually against {@link OperationalAlerts.topic}
   * (exported as a stack output by the caller).
   *
   * Delivery target is configurable (stack context / Blueprint prop)
   * rather than hard-coded per issue #629.
   */
  readonly alertEmail?: string;

  /**
   * Removal policy for the topic's customer-managed KMS key.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Reusable operational notification channel: a single SNS topic that
 * CloudWatch alarms publish to via ``addAlarmAction`` (issue #629,
 * follow-up to the DLQ-depth alarms shipped in #117 / §11.5).
 *
 * **Encryption.** The topic is encrypted with a customer-managed KMS
 * key rather than the AWS-managed ``alias/aws/sns`` key. This is
 * load-bearing, not decorative: CloudWatch cannot publish to a topic
 * encrypted with the AWS-managed key because that key's policy can't be
 * edited to grant the ``cloudwatch.amazonaws.com`` service principal
 * ``kms:GenerateDataKey*`` / ``kms:Decrypt``. The alarm→SNS action would
 * fail silently at delivery time. The CMK below grants CloudWatch (and
 * SNS) exactly those actions so delivery works while keeping
 * encryption-at-rest and satisfying cdk-nag ``AwsSolutions-SNS2``.
 *
 * The topic is intentionally stack-wide (not per-consumer) so every
 * DLQ-depth alarm shares one subscription surface — an operator
 * confirms one email / wires one Slack endpoint and receives all
 * operational alerts.
 */
export class OperationalAlerts extends Construct {
  /** The shared alerts topic. Pass to ``addAlarmActions`` or attach
   *  additional subscriptions (Slack / PagerDuty) downstream. */
  public readonly topic: sns.Topic;

  /** Customer-managed key encrypting the topic. Exposed for tests and
   *  for any downstream resource that must publish to the topic. */
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: OperationalAlertsProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // Customer-managed key so the CloudWatch service principal can be
    // granted decrypt/data-key rights (see class doc). Rotation on by
    // default — no reason not to for a low-throughput alerts key.
    this.key = new kms.Key(this, 'Key', {
      description: 'Encrypts the ABCA operational-alerts SNS topic (DLQ-depth alarms → operators)',
      enableKeyRotation: true,
      removalPolicy,
    });

    // Allow CloudWatch Alarms to publish through the encrypted topic.
    // Without these grants the alarm action resolves at deploy time but
    // every publish fails at runtime with a KMS AccessDenied the
    // operator never sees.
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsUseOfKey',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'ABCA operational alerts',
      masterKey: this.key,
    });

    // SNS delivery is best-effort operational metadata; require callers
    // to publish over TLS regardless.
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureTransport',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sns:Publish'],
      resources: [this.topic.topicArn],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    if (props.alertEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    }

    NagSuppressions.addResourceSuppressions(this.topic, [
      {
        id: 'AwsSolutions-SNS3',
        reason:
          'Topic-wide SSL enforcement is applied via an explicit DenyInsecureTransport ' +
          'resource policy statement (aws:SecureTransport=false) rather than the L2 default.',
      },
    ]);
  }

  /**
   * Wire one or more alarms to publish to the alerts topic on state
   * change. Takes the concrete {@link cloudwatch.Alarm} because
   * ``addAlarmAction`` is declared there, not on the ``IAlarm``
   * interface — which is precisely why the FanOut /
   * ApprovalMetricsPublisher / screenshot DLQ-depth alarms are exposed
   * as ``Alarm``. Those constructs stay decoupled from this one: the
   * caller passes their alarms in.
   */
  public addAlarmActions(...alarms: cloudwatch.Alarm[]): void {
    const action = new cloudwatchActions.SnsAction(this.topic);
    for (const alarm of alarms) {
      alarm.addAlarmAction(action);
    }
  }
}
