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

// Helpers for onboarding a Linear workspace through the AgentCore Identity
// Token Vault (RFC #249 Phase 1). Linear is not a built-in vault vendor, so it
// uses a CustomOauth2 credential provider (verified by the Phase-0 spike);
// these functions create that provider from the workspace's Linear OAuth app
// credentials and drive the one 3LO (USER_FEDERATION) consent round-trip that
// mints + caches the first token in the vault.
//
// The provider is created once per workspace and named deterministically from
// the slug (mirrors the Secrets-Manager secret name), so re-running setup is
// idempotent (create → fall back to update).
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  ConflictException,
  CreateOauth2CredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  type Oauth2ProviderConfigInput,
  UpdateOauth2CredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { CliError } from './errors';
import { LINEAR_AUTHORIZE_ENDPOINT, LINEAR_OAUTH_SCOPES, LINEAR_TOKEN_ENDPOINT } from './linear-oauth';
import { makeClient } from './ua';

/** Linear OAuth issuer, for the CustomOauth2 discovery metadata. */
const LINEAR_ISSUER = 'https://linear.app';

/**
 * Vault credential-provider name for a workspace. Deterministic from the slug
 * so setup is idempotent and the runtime resolvers can recompute it. Matches
 * the `bgagent-linear-oauth-<slug>` shape used for the SM secret, keeping the
 * two names aligned in operator output.
 */
export function linearVaultProviderName(workspaceSlug: string): string {
  return `bgagent-linear-oauth-${workspaceSlug}`;
}

/** The per-workspace user id bound to the vault federation session. One bot
 *  identity per workspace — must match the runtime resolvers' workspaceUserId
 *  (linear-vault-token.ts / config.py). */
export function linearVaultUserId(linearWorkspaceId: string): string {
  return `linear-workspace-${linearWorkspaceId}`;
}

/**
 * Create (or update, if it already exists) the CustomOauth2 credential provider
 * for a Linear workspace. Returns the provider name + the fixed callback URL the
 * operator must register as the Linear OAuth app's redirect_uri (spike F6).
 */
export async function upsertLinearCredentialProvider(args: {
  region: string;
  workspaceSlug: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ providerName: string; callbackUrl: string }> {
  const control = makeClient(BedrockAgentCoreControlClient, { region: args.region });
  const providerName = linearVaultProviderName(args.workspaceSlug);
  const providerConfig: Oauth2ProviderConfigInput = {
    customOauth2ProviderConfig: {
      oauthDiscovery: {
        authorizationServerMetadata: {
          issuer: LINEAR_ISSUER,
          authorizationEndpoint: LINEAR_AUTHORIZE_ENDPOINT,
          tokenEndpoint: LINEAR_TOKEN_ENDPOINT,
          responseTypes: ['code'],
          tokenEndpointAuthMethods: ['client_secret_post'],
        },
      },
      clientId: args.clientId,
      clientSecret: args.clientSecret,
    },
  };

  try {
    const created = await control.send(
      new CreateOauth2CredentialProviderCommand({
        name: providerName,
        credentialProviderVendor: 'CustomOauth2',
        oauth2ProviderConfigInput: providerConfig,
      }),
    );
    return { providerName, callbackUrl: created.callbackUrl ?? '' };
  } catch (err) {
    if (!(err instanceof ConflictException)) throw err;
    // Provider exists (re-run) — update the client credentials in place so a
    // rotated Linear app secret is picked up, then re-read the callback URL.
    await control.send(
      new UpdateOauth2CredentialProviderCommand({
        name: providerName,
        credentialProviderVendor: 'CustomOauth2',
        oauth2ProviderConfigInput: providerConfig,
      }),
    );
    const existing = await control.send(
      new GetOauth2CredentialProviderCommand({ name: providerName }),
    );
    return { providerName, callbackUrl: existing.callbackUrl ?? '' };
  }
}

export interface VaultConsentStep {
  /** URL the operator opens to consent (AgentCore PAR → Linear authorize). */
  readonly authorizationUrl: string;
  /** Poll this to check whether the token has been minted yet. */
  readonly poll: () => Promise<string | null>;
}

/**
 * Begin the 3LO consent flow: request a token for the workspace's user identity.
 * When no cached grant exists the vault returns an `authorizationUrl` (a PAR
 * that redirects to Linear's authorize endpoint with actor=app + prompt=consent
 * forwarded via customParameters — spike F1). After the operator consents, the
 * returned `poll` closure re-requests the token; it returns the access token
 * once the session completes, or null while consent is still pending.
 *
 * The return URL is required by USER_FEDERATION (spike F7) and must be on the
 * workload identity's allowlist. The CLI localhost loopback is always
 * registered by the LinearIdentityVault construct.
 */
export async function beginVaultConsent(args: {
  region: string;
  workloadName: string;
  providerName: string;
  linearWorkspaceId: string;
  returnUrl: string;
}): Promise<VaultConsentStep> {
  const dataplane = makeClient(BedrockAgentCoreClient, { region: args.region });
  const userId = linearVaultUserId(args.linearWorkspaceId);

  async function requestToken(forceAuth: boolean): Promise<{ token: string | null; authUrl: string | null }> {
    const wat = await dataplane.send(
      new GetWorkloadAccessTokenForUserIdCommand({ workloadName: args.workloadName, userId }),
    );
    if (!wat.workloadAccessToken) {
      throw new CliError(
        'AgentCore did not return a workload access token. Verify the workload identity '
        + `'${args.workloadName}' exists (deploy the stack with --context enableLinearIdentityVault=true).`,
      );
    }
    const resp = await dataplane.send(
      new GetResourceOauth2TokenCommand({
        workloadIdentityToken: wat.workloadAccessToken,
        resourceCredentialProviderName: args.providerName,
        scopes: [...LINEAR_OAUTH_SCOPES],
        oauth2Flow: 'USER_FEDERATION',
        resourceOauth2ReturnUrl: args.returnUrl,
        // Forward the agent-install params onto Linear's authorize URL (spike F1).
        customParameters: { actor: 'app', prompt: 'consent' },
        ...(forceAuth ? { forceAuthentication: true } : {}),
      }),
    );
    return { token: resp.accessToken ?? null, authUrl: resp.authorizationUrl ?? null };
  }

  const first = await requestToken(true);
  if (first.token) {
    // Already consented (rare on a fresh setup) — hand back a poll that returns it.
    return { authorizationUrl: '', poll: async () => first.token };
  }
  if (!first.authUrl) {
    throw new CliError(
      'AgentCore returned neither a token nor an authorization URL for the Linear vault provider. '
      + 'Check that the CustomOauth2 provider was created for this workspace.',
    );
  }
  return {
    authorizationUrl: first.authUrl,
    poll: async () => (await requestToken(false)).token,
  };
}
