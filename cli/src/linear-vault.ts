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
  CompleteResourceTokenAuthCommand,
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
    if (!isAlreadyExistsError(err)) throw err;
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

/**
 * True when a create failed only because the provider already exists, so the
 * caller can fall back to update-in-place and stay idempotent across re-runs.
 *
 * AgentCore reports a duplicate provider name as a **`ValidationException`**
 * ("Credential provider with name: <name> already exists"), NOT the
 * `ConflictException` the name suggests — live-caught when a second
 * `vault-setup` run aborted instead of updating. `ConflictException` is still
 * accepted in case the service tightens this later, and the message check keeps
 * genuine validation errors (bad endpoints, malformed config) surfacing.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof ConflictException) return true;
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'ValidationException' && /already exists/i.test(message);
}

export interface VaultConsentStep {
  /** URL the operator opens to consent (AgentCore PAR → Linear authorize). */
  readonly authorizationUrl: string;
  /**
   * The federation session this consent belongs to
   * (`urn:ietf:params:oauth:request_uri:…`). AgentCore appends the same value to
   * the return URL as `?session_id=…` once consent completes, and it must be
   * handed to {@link finalizeVaultConsent} before a token can be fetched.
   */
  readonly sessionUri: string;
  /** Poll this to check whether the token has been minted yet. */
  readonly poll: () => Promise<string | null>;
}

/**
 * Finalize a consented federation session so the vault mints + caches the token.
 *
 * **This step is mandatory and easy to miss.** The browser flow is:
 * Linear consent → AgentCore's own callback (AWS exchanges the code for a token)
 * → AgentCore redirects the browser to `resourceOauth2ReturnUrl?session_id=…`.
 * Until `CompleteResourceTokenAuth` is called with that `session_id`, the session
 * stays open and `GetResourceOauth2Token` keeps returning an `authorizationUrl`
 * as if consent never happened — so a caller that only polls waits forever.
 * Live-caught: the first vault-setup implementation skipped this and hung on the
 * poll while the browser 404'd on an unlistened return URL.
 */
export async function finalizeVaultConsent(args: {
  region: string;
  linearWorkspaceId: string;
  sessionUri: string;
  client?: BedrockAgentCoreClient;
}): Promise<void> {
  const dataplane = args.client ?? makeClient(BedrockAgentCoreClient, { region: args.region });
  await dataplane.send(
    new CompleteResourceTokenAuthCommand({
      userIdentifier: { userId: linearVaultUserId(args.linearWorkspaceId) },
      sessionUri: args.sessionUri,
    }),
  );
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

  async function requestToken(
    forceAuth: boolean,
  ): Promise<{ token: string | null; authUrl: string | null; sessionUri: string | null }> {
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
    return {
      token: resp.accessToken ?? null,
      authUrl: resp.authorizationUrl ?? null,
      sessionUri: resp.sessionUri ?? null,
    };
  }

  // Try the CACHED grant first (no forceAuthentication). A re-run on a healthy
  // workspace then costs nothing and needs no browser — forcing unconditionally
  // would drag the operator through consent again just to re-record a provider
  // name. Only when there is no usable grant do we force a fresh authorization.
  const cached = await requestToken(false);
  if (cached.token) {
    return { authorizationUrl: '', sessionUri: cached.sessionUri ?? '', poll: async () => cached.token };
  }

  const first = await requestToken(true);
  if (first.token) {
    // Raced with another consent between the two calls — take the token.
    return { authorizationUrl: '', sessionUri: first.sessionUri ?? '', poll: async () => first.token };
  }
  if (!first.authUrl) {
    throw new CliError(
      'AgentCore returned neither a token nor an authorization URL for the Linear vault provider. '
      + 'Check that the CustomOauth2 provider was created for this workspace.',
    );
  }
  return {
    authorizationUrl: first.authUrl,
    sessionUri: first.sessionUri ?? '',
    poll: async () => (await requestToken(false)).token,
  };
}
