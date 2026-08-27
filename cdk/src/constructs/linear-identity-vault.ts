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

// Provisions the AgentCore Identity *workload identity* that backs the Linear
// OAuth token vault (RFC #249 Phase 1). This is the stack-owned half of the
// design; the CustomOauth2 credential *provider* is created at runtime by
// `bgagent linear setup` because it needs the admin's Linear client id/secret
// (which only exist at onboarding time).
//
// There is no CDK L1/L2 construct for workload identities yet, and the control
// -plane SDK is not in the Lambda runtime, so this wraps the CDK Provider
// framework with a bundled `onEvent` handler (mirrors registry.ts). Workload-
// identity create/delete are synchronous, so no `isComplete` poller is needed.
import * as path from 'path';
import { ArnFormat, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const PROVISION_TIMEOUT_SECONDS = 60;
const PROVISION_MEMORY_MB = 256;

export interface LinearIdentityVaultProps {
  /**
   * Name of the AgentCore workload identity to provision. Stable natural id;
   * threaded to token-resolving Lambdas + the agent as
   * `LINEAR_WORKLOAD_IDENTITY_NAME`.
   */
  readonly workloadName: string;

  /**
   * Return URLs the 3LO (USER_FEDERATION) consent flow is allowed to bounce
   * back to. Registered on the workload identity's allowlist (enforced by the
   * vault — spike F9). Include BOTH the hosted onboarding page and the CLI
   * localhost loopback so either onboarding mode works off one identity (F11).
   */
  readonly allowedReturnUrls: readonly string[];
}

/**
 * The Linear identity vault's workload identity. Grant helpers wire the token
 * data-plane permissions onto whichever principal resolves Linear tokens
 * (webhook processor, orchestrator, agent session role).
 */
export class LinearIdentityVault extends Construct {
  /** The provisioned workload identity name (stable natural id). */
  public readonly workloadName: string;

  /** ARN of the workload identity, for scoping data-plane grants. */
  public readonly workloadIdentityArn: string;

  constructor(scope: Construct, id: string, props: LinearIdentityVaultProps) {
    super(scope, id);

    this.workloadName = props.workloadName;
    this.workloadIdentityArn = Stack.of(this).formatArn({
      service: 'bedrock-agentcore',
      resource: 'workload-identity-directory',
      resourceName: `default/workload-identity/${props.workloadName}`,
    });

    const entry = path.join(__dirname, '..', 'handlers', 'linear-identity-provisioning', 'index.ts');
    // The bedrock-agentcore-control SDK is not in the Lambda runtime, so it must
    // be bundled (the repo default externalizes @aws-sdk/*, which we override).
    const onEventFn = new lambda.NodejsFunction(this, 'OnEventFn', {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(PROVISION_TIMEOUT_SECONDS),
      memorySize: PROVISION_MEMORY_MB,
      bundling: { externalModules: [] },
      entry,
      handler: 'onEvent',
      // Names this component in the solution UA segment (#319).
      environment: { ABCA_COMPONENT: 'linear-identity-provisioning' },
    });

    // Workload-identity lifecycle. The directory + identity are scoped to
    // `workload-identity-directory/*`: the identity name is ours but the
    // directory segment is `default`, and Create authorizes against the
    // directory before the identity exists.
    onEventFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateWorkloadIdentity',
          'bedrock-agentcore:GetWorkloadIdentity',
          'bedrock-agentcore:UpdateWorkloadIdentity',
          'bedrock-agentcore:DeleteWorkloadIdentity',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'bedrock-agentcore',
            resource: 'workload-identity-directory',
            resourceName: '*',
          }),
        ],
      }),
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEventFn,
    });

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::LinearWorkloadIdentity',
      properties: {
        WorkloadName: props.workloadName,
        // CFN resource properties are strings; JSON-encode the URL list.
        AllowedReturnUrls: JSON.stringify(props.allowedReturnUrls),
      },
    });
    // Ensure updates to the allowlist re-run the handler even if the name is stable.
    resource.node.addDependency(onEventFn);

    NagSuppressions.addResourceSuppressions(
      onEventFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Workload-identity lifecycle actions use workload-identity-directory/* because '
            + 'the directory segment is the fixed `default` vault and Create authorizes against '
            + 'the directory before the named identity exists.',
        },
      ],
      true,
    );

    // The CDK Provider framework synthesizes its own framework Lambda + role
    // that we do not author; these findings are on framework-managed resources.
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        { id: 'AwsSolutions-IAM4', reason: 'CDK custom-resources framework Lambda role' },
        { id: 'AwsSolutions-IAM5', reason: 'CDK custom-resources framework grants invoke on the onEvent function' },
        { id: 'AwsSolutions-L1', reason: 'CDK custom-resources framework manages its Lambda runtime' },
      ],
      true,
    );
  }

  /**
   * Grant a principal the data-plane permissions to mint a Linear OAuth token
   * for a user via this workload identity (3LO USER_FEDERATION). Used by the
   * token resolvers (webhook processor, orchestrator) and the agent runtime role.
   *
   * `GetWorkloadAccessTokenForUserId` mints the user-bound workload token (spike
   * F2: USER_FEDERATION requires a user-bound token, not a plain one), and
   * `GetResourceOauth2Token` exchanges it for the Linear access token.
   *
   * **Resource scoping is service-dictated, and was live-corrected.** An earlier
   * revision scoped both actions to the named workload-identity ARN, which the
   * service rejected:
   *
   *     not authorized to perform: bedrock-agentcore:GetWorkloadAccessTokenForUserId
   *     on resource: …:workload-identity-directory/default
   *
   * `GetWorkloadAccessTokenForUserId` authorizes against the workload-identity
   * **directory** (`workload-identity-directory/default`), not the named identity
   * beneath it, so the directory ARN must be granted (the named-identity ARN is
   * kept alongside it — harmless, and future-proof if the service tightens to
   * per-identity). `GetResourceOauth2Token` authorizes against the token-vault
   * **credential provider**, so it is scoped to this account's oauth2 providers
   * rather than `*`. Unit tests assert the ARN we *chose*, so only a live run
   * surfaces a mismatch — see the deploy verification on #809.
   */
  public grantMintToken(grantee: iam.IGrantable): void {
    const stack = Stack.of(this);
    const workloadDirectoryArn = stack.formatArn({
      service: 'bedrock-agentcore',
      resource: 'workload-identity-directory',
      resourceName: 'default',
    });
    // `GetResourceOauth2Token` authorizes against the token VAULT itself
    // (`token-vault/default`) — live-confirmed by a second AccessDenied after the
    // directory fix: "not authorized … on resource: …:token-vault/default".
    const tokenVaultArn = stack.formatArn({
      service: 'bedrock-agentcore',
      resource: 'token-vault',
      resourceName: 'default',
    });
    // Provider names are per-workspace (`bgagent-linear-oauth-<slug>`) and created
    // at onboarding time by `bgagent linear vault-setup`, so they are unknown at
    // synth — scope to the account's oauth2 credential providers in the default
    // token vault rather than a single name. Kept alongside the vault ARN above
    // so the grant still holds if the service moves to per-provider authorization.
    const credentialProviderArn = stack.formatArn({
      service: 'bedrock-agentcore',
      resource: 'token-vault',
      resourceName: 'default/oauth2credentialprovider/*',
    });

    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:GetWorkloadAccessTokenForUserId'],
        resources: [workloadDirectoryArn, this.workloadIdentityArn],
      }),
    );
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:GetResourceOauth2Token'],
        resources: [
          workloadDirectoryArn,
          this.workloadIdentityArn,
          tokenVaultArn,
          credentialProviderArn,
        ],
      }),
    );
    // The vault stores each provider's client secret in a service-owned secret
    // named `bedrock-agentcore-identity!…`; resolving a token reads it through
    // the caller's credentials, so without this the exchange fails on
    // GetSecretValue (ADR-016 P1 notes this same grant).
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          stack.formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            resourceName: 'bedrock-agentcore-identity!*',
          }),
        ],
      }),
    );
  }
}
