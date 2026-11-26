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

import * as path from 'path';
import { ArnFormat, AspectPriority, Aspects, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';

const PROVISION_TIMEOUT_SECONDS = 60;
const PROVISION_MEMORY_MB = 256;

/**
 * Name prefix for the per-workspace Linear credential providers, as minted by
 * `bgagent linear setup` (`bgagent-linear-oauth-<slug>`). Must match
 * `linearVaultProviderName` in `cli/src/linear-vault.ts`.
 */
export const LINEAR_CREDENTIAL_PROVIDER_PREFIX = 'bgagent-linear-oauth-';

export interface LinearIdentityVaultProps {
  /**
   * Name of the AgentCore workload identity to provision. Stable natural id;
   * threaded to token-resolving Lambdas + the agent as
   * `LINEAR_WORKLOAD_IDENTITY_NAME`.
   */
  readonly workloadName: string;

  /**
   * Return URLs the 3LO (USER_FEDERATION) consent flow is allowed to bounce
   * back to. Registered on the workload identity's allowlist. Include BOTH the
   * hosted onboarding page and the CLI localhost loopback so either onboarding
   * mode works off one identity.
   */
  readonly allowedReturnUrls: readonly string[];
}

/**
 * The Linear identity vault's workload identity. Grant helpers wire the token
 * data-plane permissions onto whichever principal resolves Linear tokens
 * (webhook processor, orchestrator, agent session role).
 */
export class LinearIdentityVault extends Construct {
  private readonly annotatedMintGrantees = new WeakSet<IConstruct>();

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
    const onEventFn = new lambda.NodejsFunction(this, 'OnEventFn', {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(PROVISION_TIMEOUT_SECONDS),
      memorySize: PROVISION_MEMORY_MB,
      // The bedrock-agentcore-control SDK is not in the Lambda runtime, so it must
      // be bundled.
      bundling: { externalModules: [] },
      entry,
      handler: 'onEvent',
      environment: { ABCA_COMPONENT: 'linear-identity-provisioning' },
    });

    // These actions authorize against both the bare `default` directory and the
    // identities in it.
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
            resourceName: 'default',
          }),
          Stack.of(this).formatArn({
            service: 'bedrock-agentcore',
            resource: 'workload-identity-directory',
            resourceName: 'default/workload-identity/*',
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
        AllowedReturnUrls: JSON.stringify(props.allowedReturnUrls),
      },
    });
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
   * for a user via this workload identity (3LO USER_FEDERATION).
   *
   * `GetWorkloadAccessTokenForUserId` mints the user-bound workload token
   * (USER_FEDERATION requires a user-bound token, not a plain one), and
   * `GetResourceOauth2Token` exchanges it for the Linear access token.
   *
   * `GetWorkloadAccessTokenForUserId` authorizes against the workload-identity
   * **directory** (`workload-identity-directory/default`), so the directory ARN
   * must be granted.
   */
  public grantMintToken(grantee: iam.IGrantable): void {
    const stack = Stack.of(this);
    const workloadDirectoryArn = stack.formatArn({
      service: 'bedrock-agentcore',
      resource: 'workload-identity-directory',
      resourceName: 'default',
    });
    const tokenVaultArn = stack.formatArn({
      service: 'bedrock-agentcore',
      resource: 'token-vault',
      resourceName: 'default',
    });
    const credentialProviderArn = stack.formatArn({
      service: 'bedrock-agentcore',
      resource: 'token-vault',
      resourceName: `default/oauth2credentialprovider/${LINEAR_CREDENTIAL_PROVIDER_PREFIX}*`,
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
        // ALL FOUR are required. This action authorizes against the token vault, the
        // specific credential provider, the workload identity AND the workload-identity
        // directory — and IAM reports only the first resource it cannot authorize.
        resources: [
          tokenVaultArn,
          credentialProviderArn,
          this.workloadIdentityArn,
          workloadDirectoryArn,
        ],
      }),
    );
    // The vault keeps each provider's client secret in a service-owned secret and
    // reads it through the CALLER's credentials during the token exchange. The
    // trailing `*` covers the id suffix the service appends.
    const credentialSecretArn = stack.formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      resourceName: `bedrock-agentcore-identity!default/oauth2/${LINEAR_CREDENTIAL_PROVIDER_PREFIX}*`,
    });
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [credentialSecretArn],
      }),
    );
    this.annotateMintGrant(grantee);
  }

  /** Follow these specific grant resources into CDK's lazily created overflow policies. */
  private annotateMintGrant(grantee: iam.IGrantable): void {
    if (!Construct.isConstruct(grantee) || this.annotatedMintGrantees.has(grantee)) return;
    this.annotatedMintGrantees.add(grantee);
    Aspects.of(grantee).add({
      visit(node: IConstruct): void {
        if (!(node instanceof iam.CfnPolicy || node instanceof iam.CfnManagedPolicy)) return;
        NagSuppressions.addResourceSuppressions(node, [{
          id: 'AwsSolutions-IAM5',
          reason: 'Linear OAuth providers are created per workspace after deployment. Minting requires the Linear-only provider prefix and its service-owned OAuth secret suffix; unrelated providers and secrets remain excluded.',
          appliesTo: [
            { regex: `/^Resource::arn:[^*?]+:bedrock-agentcore:[^*?]+:token-vault/default/oauth2credentialprovider/${LINEAR_CREDENTIAL_PROVIDER_PREFIX}\\*$/` },
            { regex: `/^Resource::arn:[^*?]+:secretsmanager:[^*?]+:secret:bedrock-agentcore-identity!default/oauth2/${LINEAR_CREDENTIAL_PROVIDER_PREFIX}\\*$/` },
          ],
        }]);
      },
    }, { priority: AspectPriority.MUTATING });
  }
}
