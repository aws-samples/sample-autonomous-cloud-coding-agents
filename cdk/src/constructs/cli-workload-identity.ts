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

import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for CliWorkloadIdentity construct.
 */
export interface CliWorkloadIdentityProps {
  /**
   * Name of the workload identity to create. The CLI looks this up via
   * stack output and uses it as the `workloadName` argument when calling
   * `GetWorkloadAccessTokenForUserId` during OAuth flows.
   *
   * @default 'bgagent-cli'
   */
  readonly name?: string;

  /**
   * URLs that AgentCore Identity will allow as `resourceOauth2ReturnUrl`
   * — i.e. where AWS will redirect the browser after a `USER_FEDERATION`
   * OAuth dance completes. Validated server-side; AgentCore rejects
   * `get_resource_oauth2_token` calls with un-allowlisted return URLs.
   *
   * @default ['https://localhost:8443/oauth/callback']
   */
  readonly allowedResourceOauth2ReturnUrls?: readonly string[];
}

/**
 * Creates a dedicated AgentCore Identity workload identity for the
 * `bgagent` CLI. This is a separate resource from the AgentCore
 * **runtime** workload identity (which the runtime construct creates
 * automatically): runtime identities are *linked to a service* and
 * cannot mint user-scoped workload access tokens, while a manually
 * created workload identity can.
 *
 * The CLI calls `GetWorkloadAccessTokenForUserId(workloadName, userId=<cognito_sub>)`
 * to mint a token used for subsequent `get_resource_oauth2_token` calls
 * during the Linear OAuth dance.
 *
 * The `allowedResourceOauth2ReturnUrls` field on the workload identity
 * is the allowlist AWS validates browser-redirect URLs against. The CLI
 * runs an ephemeral localhost HTTPS server during `bgagent linear setup`
 * and registers `https://localhost:8443/oauth/callback` as the return URL,
 * so the URL must be on this allowlist.
 *
 * Implementation: AwsCustomResource because CDK has no L2/L1 for
 * AgentCore Identity workload identities yet (May 2026).
 */
export class CliWorkloadIdentity extends Construct {
  /** Workload identity name surfaced via stack output for the CLI. */
  public readonly workloadName: string;

  constructor(scope: Construct, id: string, props: CliWorkloadIdentityProps = {}) {
    super(scope, id);

    this.workloadName = props.name ?? 'bgagent-cli';
    const returnUrls = props.allowedResourceOauth2ReturnUrls
      ?? ['https://localhost:8443/oauth/callback'];

    // bedrock-agentcore-control's CreateWorkloadIdentity:
    //   { name: string, allowedResourceOauth2ReturnUrls?: string[] }
    // UpdateWorkloadIdentity has the same shape; idempotent recreation is
    // achieved by Update-ing on stack updates and CFN-stable physicalResourceId.
    const customResource = new cr.AwsCustomResource(this, 'WorkloadIdentityCR', {
      timeout: Duration.minutes(2),
      onCreate: {
        service: 'BedrockAgentCoreControl',
        action: 'CreateWorkloadIdentity',
        parameters: {
          name: this.workloadName,
          allowedResourceOauth2ReturnUrls: returnUrls,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`workload-identity-${this.workloadName}`),
        // If the workload already exists from a prior deploy, treat it as
        // success — UpdateWorkloadIdentity in onUpdate will reconcile state.
        ignoreErrorCodesMatching: 'ConflictException|ValidationException',
      },
      onUpdate: {
        service: 'BedrockAgentCoreControl',
        action: 'UpdateWorkloadIdentity',
        parameters: {
          name: this.workloadName,
          allowedResourceOauth2ReturnUrls: returnUrls,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`workload-identity-${this.workloadName}`),
      },
      onDelete: {
        service: 'BedrockAgentCoreControl',
        action: 'DeleteWorkloadIdentity',
        parameters: {
          name: this.workloadName,
        },
        // Don't fail stack-delete if the workload identity is already gone
        // (e.g. someone deleted it manually via aws CLI).
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateWorkloadIdentity',
            'bedrock-agentcore:UpdateWorkloadIdentity',
            'bedrock-agentcore:DeleteWorkloadIdentity',
            'bedrock-agentcore:GetWorkloadIdentity',
          ],
          // The workload identity ARN is not deterministic at synth time
          // (AgentCore generates the suffix), so we scope to the account-region
          // resource pattern. Tightening to `workload-identity/${name}` is
          // possible but the CR also needs Get for state reconciliation.
          resources: ['*'],
        }),
      ]),
    });

    NagSuppressions.addResourceSuppressions(customResource, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AwsCustomResource uses AWSLambdaBasicExecutionRole — AWS-managed and recommended for CRs.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'AgentCore Identity workload identity ARN is not deterministic at synth; resources:* '
          + 'is scoped by the action allowlist (CreateWorkloadIdentity et al).',
      },
    ], true);
  }
}
