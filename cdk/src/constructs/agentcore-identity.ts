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

import { Stack, CfnOutput, SecretValue } from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Properties for the AgentCoreIdentity construct.
 */
export interface AgentCoreIdentityProps {
  /**
   * Name for the WorkloadIdentity resource (unique per account).
   * Must match `[A-Za-z0-9_.-]+`, 3–255 characters.
   */
  readonly workloadIdentityName: string;

  /**
   * GitHub OAuth2 credential provider configuration.
   */
  readonly githubOAuth: {
    /**
     * Name for the OAuth2 credential provider (unique per account).
     * Must match `[a-zA-Z0-9-_]+`, 1–128 characters.
     */
    readonly credentialProviderName: string;

    /**
     * GitHub App client ID (starts with `Iv...`).
     */
    readonly clientId: string;

    /**
     * GitHub App client secret (sensitive).
     * Use `SecretValue.secretsManager(...)` or `SecretValue.unsafePlainText(...)`.
     */
    readonly clientSecret: SecretValue;
  };
}

/**
 * CDK construct that provisions AgentCore Identity resources for GitHub
 * OAuth2 authentication via the Token Vault.
 *
 * Creates a WorkloadIdentity (the agent's identity) and an OAuth2
 * credential provider (registered with the `GithubOauth2` vendor).
 * At runtime, the agent calls `GetWorkloadAccessToken` followed by
 * `GetResourceOauth2Token` to obtain a short-lived GitHub access token.
 *
 * The Token Vault handles credential exchange and token refresh
 * automatically, eliminating the need for static, long-lived PATs.
 */
export class AgentCoreIdentity extends Construct {
  /** Name of the WorkloadIdentity (used in `GetWorkloadAccessToken` calls). */
  public readonly workloadIdentityName: string;

  /** ARN of the WorkloadIdentity. */
  public readonly workloadIdentityArn: string;

  /** Name of the OAuth2 credential provider (used in `GetResourceOauth2Token` calls). */
  public readonly credentialProviderName: string;

  /** ARN of the OAuth2 credential provider. */
  public readonly credentialProviderArn: string;

  /**
   * Callback URL returned by the credential provider.
   * This must be registered as the callback URL in the GitHub App settings.
   */
  public readonly callbackUrl: string;

  constructor(scope: Construct, id: string, props: AgentCoreIdentityProps) {
    super(scope, id);

    // --- WorkloadIdentity ---
    // The AgentCore Runtime auto-creates a workload identity, but we create an
    // explicit one because: (1) the orchestrator Lambda also calls
    // GetWorkloadAccessToken and runs outside the Runtime, so it needs a shared
    // identity with a known name; (2) the auto-created identity's name is
    // service-generated and only exposed via attrWorkloadIdentityDetails ARN,
    // not directly controllable. For deployments using non-Runtime compute (ECS,
    // Lambda), a standalone identity is required regardless.
    const workloadIdentity = new bedrockagentcore.CfnWorkloadIdentity(this, 'WorkloadIdentity', {
      name: props.workloadIdentityName,
    });

    this.workloadIdentityName = props.workloadIdentityName;
    this.workloadIdentityArn = workloadIdentity.attrWorkloadIdentityArn;

    // --- OAuth2 Credential Provider (GitHub) ---
    // The L1 CfnOAuth2CredentialProvider requires a string for clientSecret.
    // unsafeUnwrap() is safe here when the caller passes SecretValue.secretsManager(),
    // which produces a CFN dynamic reference resolved at deploy time. Never pass
    // SecretValue.unsafePlainText() in production — the plaintext would appear in the
    // synthesized CloudFormation template.
    const credentialProvider = new bedrockagentcore.CfnOAuth2CredentialProvider(this, 'GitHubOAuth2Provider', {
      name: props.githubOAuth.credentialProviderName,
      credentialProviderVendor: 'GithubOauth2',
      oauth2ProviderConfigInput: {
        githubOauth2ProviderConfig: {
          clientId: props.githubOAuth.clientId,
          clientSecret: props.githubOAuth.clientSecret.unsafeUnwrap(),
        },
      },
    });

    this.credentialProviderName = props.githubOAuth.credentialProviderName;
    this.credentialProviderArn = credentialProvider.attrCredentialProviderArn;
    this.callbackUrl = credentialProvider.attrCallbackUrl;

    // Output the callback URL — operator must register it in GitHub App settings
    new CfnOutput(this, 'GitHubOAuthCallbackUrl', {
      value: this.callbackUrl,
      description: 'Register this URL as the callback URL in your GitHub App settings',
    });
  }

  /**
   * Grant an IAM principal the permissions needed to obtain GitHub tokens
   * via the Token Vault (GetWorkloadAccessToken + GetResourceOauth2Token).
   *
   * Note: As of @aws-cdk/aws-bedrock-agentcore-alpha, the Runtime L2 construct
   * auto-grants GetWorkloadAccessToken* but NOT GetResourceOauth2Token.
   * This method grants both for completeness.
   *
   * The Token Vault APIs require the workload-identity-directory ARN as the
   * resource, not individual identity ARNs, hence the directory-level scope.
   */
  public grantTokenVaultAccess(grantee: iam.IGrantable): void {
    const stack = Stack.of(this);

    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:GetWorkloadAccessToken',
        'bedrock-agentcore:GetResourceOauth2Token',
      ],
      resources: [
        stack.formatArn({
          service: 'bedrock-agentcore',
          resource: 'workload-identity-directory',
          resourceName: 'default',
        }),
        stack.formatArn({
          service: 'bedrock-agentcore',
          resource: 'workload-identity-directory',
          resourceName: 'default/*',
        }),
      ],
    }));
  }
}
