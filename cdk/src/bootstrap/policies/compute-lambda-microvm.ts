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
 * therefore not repeated: `iam:CreateServiceLinkedRole` (network-connector ENI
 * management) lives in the `infrastructure` policy; `lambda:TagResource` /
 * `lambda:UntagResource` live in `application`. `iam:PassRole` USED to be in that
 * list — see the second statement below for why it is not.
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

      // --- iam:PassRole for the two MicroVM roles CloudFormation hands to the
      //     service, WITHOUT a service condition (ADR-021 P2r2-F9) ---
      //
      // Why this statement exists at all, when `infrastructure`'s `IAMPassRole`
      // already covers `role/backgroundagent-dev-*`: that statement carries a
      // `iam:PassedToService` allowlist, and the Lambda MicroVMs service does not
      // present a usable value for that key. Live 2026-08-07 (run 2), the
      // CDK-managed image path died on exactly this, one step past the enum fix
      // that unblocked change-set validation:
      //
      //   LambdaMicrovmComputeImage…  CREATE_FAILED
      //   "User: …/cdk-hnb659fds-cfn-exec-role-…/AWSCloudFormation is not
      //    authorized to perform: iam:PassRole on resource:
      //    …role/backgroundagent-dev-LambdaMicrovmComputeBuildRoleF0-… because no
      //    identity-based policy allows the iam:PassRole action
      //    (Service: LambdaMicrovms, Status Code: 403)"
      //
      // Three pieces of evidence pin it to the CONDITION rather than to a stale
      // bootstrap or a wrong resource pattern:
      //  1. the live `IaCRole-ABCA-Infrastructure` policy was byte-identical to
      //     this branch's `bootstrap/policies/infrastructure.json`, so
      //     `bootstrap --force` would have changed nothing;
      //  2. `simulate-principal-policy` on the deploy role returned `allowed` WITH
      //     `iam:PassedToService=lambda.amazonaws.com` supplied and `implicitDeny`
      //     with no context — so the resource pattern matches and the condition is
      //     the only remaining variable;
      //  3. the CONTROL: the out-of-band `create-microvm-image` call passed **the
      //     same build role** to the same service successfully, using operator
      //     credentials that carry no such condition. So the role's trust is fine
      //     and the denial is genuinely caller-side.
      //
      // This is the CloudFormation-side twin of P2r2-F10 (the orchestrator's
      // `RunMicrovm` PassRole, `task-orchestrator.ts`): one root cause — the
      // service presents no usable `iam:PassedToService` — with two symptoms, one
      // per PassRole path.
      //
      // WHY HERE rather than editing `infrastructure`'s `IAMPassRole`:
      //  - this policy is CONDITIONAL on `ComputeTypes` including
      //    `lambda-microvm` (template condition `IncludeComputeLambdaMicrovms`), so
      //    an agentcore-only or ECS-only bootstrap gains nothing — the
      //    unconditioned pass simply does not exist there;
      //  - the existing allowlisted statement stays untouched, so every other role
      //    in the stack keeps its `iam:PassedToService` constraint. Relaxing the
      //    shared statement would have dropped that constraint for ~30 roles to
      //    fix two.
      //
      // SCOPE. Two name-prefix patterns, not `role/backgroundagent-dev-*`, and
      // deliberately NOT the execution role — CloudFormation never passes that one
      // (the orchestrator does, at `RunMicrovm`), so including it here would widen
      // the unconditioned pass to the role that runs untrusted repo code for no
      // reason. The patterns match the physical names CloudFormation generates from
      // the construct's logical ids (`LambdaMicrovmComputeBuildRole…`,
      // `LambdaMicrovmComputeConnectorOperatorRole…`), which it truncates to fit
      // 64 characters before appending a random suffix — verified against the live
      // ARNs. If a future rename or a longer stack name pushed the discriminating
      // part out of that window, the failure is the loud AccessDenied above naming
      // the exact ARN, not a silent widening.
      new iam.PolicyStatement({
        sid: 'MicrovmPassRoles',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [
          // Passed as `buildRoleArn` on AWS::Lambda::MicrovmImage.
          'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeBuild*',
          // Passed as `operatorRole` on AWS::Lambda::NetworkConnector (required
          // for VPC_EGRESS connectors).
          'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeConnector*',
        ],
      }),
    ],
  });
}
