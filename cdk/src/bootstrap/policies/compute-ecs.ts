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

import { aws_iam as iam } from 'aws-cdk-lib';

/**
 * Returns the IAM PolicyDocument for the IaCRole-ABCA-Compute-ECS role.
 *
 * Covers: ECS cluster and task definition management for the Fargate
 * compute backend.
 */
export function computeEcsPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'ECS',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecs:CreateCluster',
          'ecs:DeleteCluster',
          'ecs:DescribeClusters',
          'ecs:UpdateCluster',
          'ecs:UpdateClusterSettings',
          'ecs:PutClusterCapacityProviders',
          'ecs:RegisterTaskDefinition',
          'ecs:DeregisterTaskDefinition',
          'ecs:DescribeTaskDefinition',
          'ecs:ListTaskDefinitions',
          'ecs:TagResource',
          'ecs:UntagResource',
          'ecs:ListTagsForResource',
          'ecs:PutAccountSetting',
        ],
        resources: ['*'],
      }),
    ],
  });
}
