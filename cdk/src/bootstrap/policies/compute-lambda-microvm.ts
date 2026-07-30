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
 * Covers: MicroVM image and network-connector management for the AWS Lambda
 * MicroVMs compute backend (ADR-021 sub-decision 4).
 *
 * This is the *deploy-time* (CloudFormation execution role) policy — the
 * `AWS::Lambda::MicrovmImage` and `AWS::Lambda::NetworkConnector` resources the
 * `LambdaMicrovmCompute` construct synthesizes. It deliberately does NOT include
 * the *runtime* lifecycle actions (`lambda:RunMicrovm` / `GetMicrovm` /
 * `TerminateMicrovm`): those belong to the orchestrator's own role, are granted
 * per-deployment in `task-orchestrator.ts`, and would be a privilege escalation
 * on a deploy role that never starts a session.
 *
 * `Resource: '*'` matches the `compute-ecs` precedent and is load-bearing here
 * rather than lazy: several of these actions (`CreateMicrovmImage`,
 * `PassNetworkConnector`, the `List*` reads) support no resource-level
 * permissions at all in the Service Authorization Reference, so a narrowed ARN
 * would silently never match and the deploy would fail with AccessDenied.
 *
 * Dependent actions that are already covered elsewhere in the bundle and are
 * therefore not repeated: `iam:PassRole` (the build role, →
 * `lambda.amazonaws.com`) and `iam:CreateServiceLinkedRole` (network-connector
 * ENI management) live in the `infrastructure` policy; `lambda:TagResource` /
 * `lambda:UntagResource` live in `application`.
 */
export function computeLambdaMicrovmPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'LambdaMicrovms',
        effect: iam.Effect.ALLOW,
        actions: [
          // MicroVM images — the snapshot CloudFormation creates, updates,
          // replaces and deletes. `Get*`/`List*` are required by the CFN
          // resource handlers for read/stabilization, not just by humans.
          'lambda:CreateMicrovmImage',
          'lambda:GetMicrovmImage',
          'lambda:UpdateMicrovmImage',
          'lambda:DeleteMicrovmImage',
          'lambda:ListMicrovmImages',
          // Image *versions* and their builds: every snapshot build creates a
          // new version, and CFN must be able to read build state (a failed
          // build otherwise stalls the stack with no diagnosis) and delete
          // versions on replace/rollback — the ADR calls out that versions are
          // billed storage and need lifecycle cleanup.
          'lambda:GetMicrovmImageVersion',
          'lambda:UpdateMicrovmImageVersion',
          'lambda:DeleteMicrovmImageVersion',
          'lambda:ListMicrovmImageVersions',
          'lambda:GetMicrovmImageBuild',
          'lambda:ListMicrovmImageBuilds',
          // Base images: resolving/validating the managed base image the
          // snapshot is built on.
          'lambda:ListManagedMicrovmImages',
          'lambda:ListManagedMicrovmImageVersions',
          // Network connectors — the platform-VPC egress path.
          'lambda:CreateNetworkConnector',
          'lambda:GetNetworkConnector',
          'lambda:UpdateNetworkConnector',
          'lambda:DeleteNetworkConnector',
          'lambda:ListNetworkConnectors',
          // Documented dependent of CreateMicrovmImage/UpdateMicrovmImage: the
          // image declares its egress connectors, so creating it *passes* them.
          'lambda:PassNetworkConnector',
        ],
        resources: ['*'],
      }),
    ],
  });
}
