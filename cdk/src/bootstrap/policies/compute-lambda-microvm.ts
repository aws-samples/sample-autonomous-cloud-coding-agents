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
 * Returns the IAM PolicyDocument for the IaCRole-ABCA-Compute-LambdaMicrovms role.
 *
 * `Resource: '*'`: several of these actions (`CreateMicrovmImage`,
 * `PassNetworkConnector`, `ListMicrovmImages`, `ListManagedMicrovmImages`,
 * `ListNetworkConnectors`) support no resource-level permissions at all in
 * the Service Authorization Reference.
 */
export function computeLambdaMicrovmPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'LambdaMicrovms',
        effect: iam.Effect.ALLOW,
        actions: [
          // The CFN resource handlers call `Get*`/`List*` for read and stabilization.
          'lambda:CreateMicrovmImage',
          'lambda:GetMicrovmImage',
          'lambda:UpdateMicrovmImage',
          'lambda:DeleteMicrovmImage',
          'lambda:ListMicrovmImages',
          // Every snapshot build creates a new image version; CFN reads build
          // state and deletes versions on replace/rollback.
          'lambda:GetMicrovmImageVersion',
          'lambda:UpdateMicrovmImageVersion',
          'lambda:DeleteMicrovmImageVersion',
          'lambda:ListMicrovmImageVersions',
          'lambda:GetMicrovmImageBuild',
          'lambda:ListMicrovmImageBuilds',
          'lambda:ListManagedMicrovmImages',
          'lambda:ListManagedMicrovmImageVersions',
          'lambda:CreateNetworkConnector',
          'lambda:GetNetworkConnector',
          'lambda:UpdateNetworkConnector',
          'lambda:DeleteNetworkConnector',
          'lambda:ListNetworkConnectors',
          // Documented dependent of CreateMicrovmImage/UpdateMicrovmImage.
          'lambda:PassNetworkConnector',
        ],
        resources: ['*'],
      }),

      // iam:PassRole for the two MicroVM roles CloudFormation hands to the
      // service, WITHOUT a service condition (ADR-021 P2r2-F9).
      // Measured: the Lambda MicroVMs service presents no usable `iam:PassedToService`
      // value, so a grant conditioned on it is denied with a 403 on iam:PassRole.
      new iam.PolicyStatement({
        sid: 'MicrovmPassRoles',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [
          // CloudFormation truncates the logical ids (`…ComputeBuildRole…`,
          // `…ComputeConnectorOperatorRole…`) to fit 64 characters before its random suffix.
          'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeBuild*',
          'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeConnector*',
          'arn:aws:iam::*:role/backgroundagent-dev-MicrovmBuildRole',
          'arn:aws:iam::*:role/backgroundagent-dev-*-MicrovmBuildRole',
          'arn:aws:iam::*:role/backgroundagent-dev-MicrovmConnectorRole',
          'arn:aws:iam::*:role/backgroundagent-dev-*-MicrovmConnectorRole',
        ],
      }),
      new iam.PolicyStatement({
        sid: 'MicrovmSuspendConfiguration',
        actions: [
          'ssm:GetParameters',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:AddTagsToResource',
          'ssm:RemoveTagsFromResource',
          'ssm:ListTagsForResource',
        ],
        resources: ['arn:aws:ssm:*:*:parameter/backgroundagent-*/microvm-approval-suspend-enabled'],
      }),
    ],
  });
}
