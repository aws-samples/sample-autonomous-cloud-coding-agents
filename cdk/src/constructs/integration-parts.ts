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

import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * A table that an integration construct owns (the platform tables keep their own constructs).
 * It is `Table` under an inner construct `id`, because the logical ID of the deployed table is
 * derived from that path: without the level, or under other names, the table would be replaced.
 */
export function integrationTable(scope: Construct, id: string, props: {
  readonly partitionKey: string;
  readonly ttl?: boolean;
  readonly platformUserIndex?: boolean;
  readonly removalPolicy: RemovalPolicy;
}): dynamodb.Table {
  const table = new dynamodb.Table(new Construct(scope, id), 'Table', {
    partitionKey: { name: props.partitionKey, type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: props.ttl ? 'ttl' : undefined,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: props.removalPolicy,
  });
  if (props.platformUserIndex) {
    table.addGlobalSecondaryIndex({
      indexName: 'PlatformUserIndex',
      partitionKey: { name: 'platform_user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'linked_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
  return table;
}

/** The table in which a webhook receiver records the deliveries it has seen, until their TTL. */
export function webhookDedupTable(scope: Construct, removalPolicy: RemovalPolicy): dynamodb.Table {
  return new dynamodb.Table(scope, 'WebhookDedupTable', {
    partitionKey: { name: 'dedup_key', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'ttl',
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy,
  });
}

/** The ARN pattern of the secrets whose name matches `namePattern`, in the account and Region of `scope`. */
export function secretArnPattern(scope: Construct, namePattern: string): string {
  return Stack.of(scope).formatArn({
    service: 'secretsmanager',
    resource: 'secret',
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    resourceName: namePattern,
  });
}

/** A tracker to whose issues Lambdas outside its construct write feedback. */
export interface FeedbackTracker {
  /** The task-table index that leads from an issue of this tracker to its tasks. */
  readonly issueIndexName: string;

  /**
   * Lets `fn` resolve the token of a workspace: read access to the workspace registry, the
   * registry's name in the environment, and access to the OAuth secrets of the workspaces.
   */
  grantFeedback(fn: lambda.Function, options: {
    /** Whether `fn` may store a rotated token. Without the write it reads a workspace's token and cannot store one. */
    readonly writeBack: boolean;
  }): void;
}

/** What a tracker's `grantFeedback` does, with that tracker's registry and names. */
export function grantTrackerFeedback(
  fn: lambda.Function,
  registryTable: dynamodb.ITable,
  registryEnvironmentName: string,
  oauthSecretNamePattern: string,
  writeBack: boolean,
): void {
  registryTable.grantReadData(fn);
  fn.addEnvironment(registryEnvironmentName, registryTable.tableName);
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', ...(writeBack ? ['secretsmanager:PutSecretValue'] : [])],
    resources: [secretArnPattern(fn, oauthSecretNamePattern)],
  }));
}
