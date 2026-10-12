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

import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import constants from '../../../contracts/constants.json';

/** Authenticate deployment settings with IAM; task payloads require a one-object capability. */
export function grantWorkerBootstrap(bucket: s3.IBucket, worker: iam.IGrantable): void {
  const manifests = bucket.arnForObjects(`${constants.payload_bootstrap.manifest_prefix}*`);
  worker.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [manifests],
  }));
  // An Allow alone is not an authentication boundary: another bucket could
  // publicly grant access to an attacker's fake deployment manifest.
  worker.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY,
    actions: ['s3:GetObject*'],
    notResources: [manifests],
  }));
  worker.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY,
    actions: ['s3:List*'],
    resources: [bucket.bucketArn],
  }));
}

export function grantCoordinatorPayloads(bucket: s3.IBucket, coordinator: iam.IGrantable): void {
  // S3 returns AccessDenied rather than NoSuchKey for an absent launch record
  // without ListBucket. Only the trusted coordinator needs this permission.
  coordinator.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [bucket.bucketArn],
  }));
  const taskObjects = [
    bucket.arnForObjects('*/payload.json'),
    bucket.arnForObjects(`*/${constants.payload_bootstrap.launch_filename}`),
  ];
  coordinator.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject'],
    resources: [
      ...taskObjects,
      bucket.arnForObjects(`${constants.payload_bootstrap.manifest_prefix}*`),
    ],
  }));
  coordinator.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:DeleteObject'],
    resources: taskObjects,
  }));
}
