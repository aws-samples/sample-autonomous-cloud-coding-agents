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

/**
 * Name prefix for the per-workspace Linear credential providers, as minted by
 * `bgagent linear setup` (`bgagent-linear-oauth-<slug>`).
 *
 * Exists so the mint grant can be scoped to THIS surface's providers rather than every
 * provider in the account's token vault. Must match `linearCredentialProviderName` in
 * `cli/src/linear-vault.ts`; a drift here does not fail synth, it fails the mint at
 * runtime with an AccessDenied naming the provider.
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

    // Workload-identity lifecycle, scoped to the `default` DIRECTORY and the identities
    // in it — deliberately not to this stack's own identity, because the service will
    // not authorize it that way and it is worth recording why.
    //
    // These actions perform a multi-resource authorization check that includes the bare
    // directory. IAM reports only the first resource it could not authorize, so the
    // shape is invisible until you run it and each grant reveals the next. Three
    // successive live denials, from three attempts to scope this down:
    //
    //   Create, granted `…-directory/default`            → denied on
    //     …-directory/default/workload-identity/*
    //   Create, granted that wildcard instead            → denied on
    //     …-directory/default
    //   Update, granted `…/workload-identity/<this name>` → denied on
    //     …-directory/default
    //
    // So `UpdateWorkloadIdentity` authorizes at the DIRECTORY, and no identity-based
    // policy can restrict it to a single identity. That is worth being explicit about,
    // because it means the cross-stack hazard this was meant to fence off — Update
    // REPLACES `allowedResourceOauth2ReturnUrls`, so one stack can silently drop
    // another's consent URL from the allowlist — **cannot be prevented with IAM**. What
    // prevents it is the workload identity NAME being stack-derived, so two stacks never
    // address the same identity in the first place, plus this grant living only on the
    // construct's own provisioning Lambda.
    //
    // Still a real narrowing over the original `workload-identity-directory/*`, which
    // also matched every other directory in the account.
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
    // Provider names are per-workspace (`bgagent-linear-oauth-<slug>`, minted by
    // `bgagent linear setup`) so an exact name is unknown at synth — but the PREFIX
    // is known, and prefix-scoping here is the difference between "this role can mint
    // Linear tokens" and "this role can mint anything in the account's token vault".
    //
    // `oauth2credentialprovider/*` was not a theoretical over-grant: this account's
    // vault already holds a `GithubOauth2` provider alongside the Linear ones, so the
    // wildcard let every Linear-writing Lambda mint against GitHub. It gets worse the
    // moment ADR-016 P7 adds Jira and Slack providers to the same vault.
    //
    // Live-proven scopable: with this statement scoped to the Linear prefix, minting
    // the GitHub provider is denied on
    // `…:token-vault/default/oauth2credentialprovider/github-oauth-cell-a` while
    // minting a Linear provider still succeeds. Keep in sync with
    // `linearCredentialProviderName` in cli/src/linear-vault.ts.
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
        // directory — and IAM reports only the first resource it cannot authorize, so
        // the set is invisible until each one is granted in turn.
        //
        // Established by assuming a role with each candidate subset and minting for
        // real. Dropping any one of them denies the mint, each time naming the missing
        // resource: with the vault alone → the provider; + provider → the identity;
        // + identity → the directory; all four → succeeds.
        //
        // An earlier pass here trimmed this to the vault and the provider, reasoning
        // that only `token-vault/default` had appeared in a live denial. That was
        // wrong, and it silently broke minting for every Linear-writing Lambda: the
        // mint I used to "verify" it ran under an admin principal, which is not the
        // thing the grant applies to. Only the provider ARN is narrowable here.
        resources: [
          tokenVaultArn,
          credentialProviderArn,
          this.workloadIdentityArn,
          workloadDirectoryArn,
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
