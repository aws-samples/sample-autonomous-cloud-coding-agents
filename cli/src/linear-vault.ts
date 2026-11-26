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
import { CALLBACK_URL } from './oauth-callback-server';
import { makeClient } from './ua';

/** Consent-time parameters. Part of the vault's cache key, so every resolve must
 *  send the identical set or a live grant reads as "needs consent". */
const LINEAR_VAULT_CUSTOM_PARAMS: Record<string, string> = { actor: 'app', prompt: 'consent' };
export const LINEAR_VAULT_CUSTOM_PARAMS_FOR_TEST = LINEAR_VAULT_CUSTOM_PARAMS;

const LINEAR_ISSUER = 'https://linear.app';

/**
 * Vault credential-provider name for a workspace. Deterministic from the slug
 * so setup is idempotent and the runtime resolvers can recompute it.
 */
export function linearVaultProviderName(workspaceSlug: string): string {
  return `bgagent-linear-oauth-${workspaceSlug}`;
}

/** Subject for workspaces onboarded before `vault_user_id` was recorded on the
 *  registry row. Fresh installs use {@link linearVaultUserIdForSlug}. */
export function linearVaultUserId(linearWorkspaceId: string): string {
  return `linear-workspace-${linearWorkspaceId}`;
}

/**
 * Vault subject derived from the workspace SLUG rather than its organization UUID.
 * Distinct prefix from {@link linearVaultUserId} so the two forms can never collide.
 */
export function linearVaultUserIdForSlug(workspaceSlug: string): string {
  return `linear-ws-${workspaceSlug}`;
}

/**
 * Create (or update, if it already exists) the CustomOauth2 credential provider
 * for a Linear workspace. Returns the provider name + the fixed callback URL the
 * operator must register as the Linear OAuth app's redirect_uri.
 * Linear is not a built-in AgentCore Identity vault vendor, hence CustomOauth2.
 *
 * `created` is true only on the run that created the provider. The callback URL ends in
 * an id AgentCore mints at creation, so on that run it is not yet registered on the
 * Linear app and consent fails with "Invalid redirect_uri".
 */
export async function upsertLinearCredentialProvider(args: {
  region: string;
  workspaceSlug: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ providerName: string; callbackUrl: string; created: boolean }> {
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
    return { providerName, callbackUrl: created.callbackUrl ?? '', created: true };
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
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
    return { providerName, callbackUrl: existing.callbackUrl ?? '', created: false };
  }
}

/**
 * Outcome of reading an existing provider's callback URL, the vault path's Linear
 * `redirect_uri`. `absent`: no provider exists. `unreadable`: the read failed for any
 * other reason (expired credentials, wrong region). The probe never throws.
 */
export type VaultCallbackProbe =
  | { readonly kind: 'found'; readonly callbackUrl: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly errorName: string };

export async function probeLinearVaultCallbackUrl(args: {
  region: string;
  workspaceSlug: string;
}): Promise<VaultCallbackProbe> {
  try {
    const control = makeClient(BedrockAgentCoreControlClient, { region: args.region });
    const existing = await control.send(
      new GetOauth2CredentialProviderCommand({ name: linearVaultProviderName(args.workspaceSlug) }),
    );
    return existing.callbackUrl ? { kind: 'found', callbackUrl: existing.callbackUrl } : { kind: 'absent' };
  } catch (err) {
    const errorName = (err as { name?: string } | undefined)?.name ?? 'Error';
    if (errorName === 'ResourceNotFoundException') return { kind: 'absent' };
    return { kind: 'unreadable', errorName };
  }
}

/**
 * AgentCore reports a duplicate provider name as a `ValidationException`
 * ("Credential provider with name: <name> already exists"), not a `ConflictException`.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof ConflictException) return true;
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'ValidationException' && /already exists/i.test(message);
}

/**
 * True when a vault call failed because AgentCore Identity is not usable here —
 * as opposed to the service answering and rejecting our input.
 *
 * `ValidationException`, `ConflictException`, `AccessDeniedException` and
 * `UnauthorizedException` are the service answering, so they yield false. Everything
 * else (endpoint resolution, no such service in the region, network, throttling) yields
 * true.
 */
export function isVaultUnavailableError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name ?? '';
  if (name === 'ValidationException' || name === 'ConflictException') return false;
  if (name === 'AccessDeniedException' || name === 'UnauthorizedException') return false;
  return true;
}

export type VaultMintResult =
  | { readonly kind: 'token'; readonly accessToken: string }
  /** The vault answered with an authorization URL: this grant needs a fresh consent. */
  | { readonly kind: 'consent-required' }
  /** The vault could not be asked (permissions, throttle, not in this region). */
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Mint a Linear token from an EXISTING vault grant.
 *
 * Read-only: no `forceAuthentication`, so it can never open a browser or start a
 * consent.
 *
 * The return URL is not part of the vault's cache key, so it need not be the one
 * consent used.
 */
export async function mintLinearTokenFromVault(args: {
  region: string;
  workloadName: string;
  providerName: string;
  userId: string;
}): Promise<VaultMintResult> {
  try {
    const dataplane = makeClient(BedrockAgentCoreClient, { region: args.region });
    const wat = await dataplane.send(
      new GetWorkloadAccessTokenForUserIdCommand({ workloadName: args.workloadName, userId: args.userId }),
    );
    if (!wat.workloadAccessToken) return { kind: 'unavailable', reason: 'no_workload_access_token' };
    const resp = await dataplane.send(
      new GetResourceOauth2TokenCommand({
        workloadIdentityToken: wat.workloadAccessToken,
        resourceCredentialProviderName: args.providerName,
        scopes: [...LINEAR_OAUTH_SCOPES],
        oauth2Flow: 'USER_FEDERATION',
        resourceOauth2ReturnUrl: CALLBACK_URL,
        customParameters: { ...LINEAR_VAULT_CUSTOM_PARAMS },
      }),
    );
    if (resp.accessToken) return { kind: 'token', accessToken: resp.accessToken };
    return { kind: 'consent-required' };
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: (err as { name?: string } | undefined)?.name ?? 'unknown_error',
    };
  }
}

/**
 * What `beginVaultConsent` found: either the grant is already good, or a browser
 * round-trip is required.
 */
export type VaultConsentStep =
  | {
    readonly kind: 'already-consented';
    /** Poll this to read the cached token. */
    readonly poll: () => Promise<string | null>;
  }
  | {
    readonly kind: 'consent-required';
    /** URL the operator opens to consent (AgentCore PAR → Linear authorize). */
    readonly authorizationUrl: string;
    /** Poll this to check whether the token has been minted yet. */
    readonly poll: () => Promise<string | null>;
  };

/**
 * Finalize a consented federation session so the vault mints + caches the token.
 *
 * After consent AgentCore redirects the browser to
 * `resourceOauth2ReturnUrl?session_id=…`. Until `CompleteResourceTokenAuth` is called
 * with that `session_id`, `GetResourceOauth2Token` keeps returning an `authorizationUrl`.
 */
export async function finalizeVaultConsent(args: {
  region: string;
  /** The subject the consent was started under — must match beginVaultConsent. */
  userId: string;
  sessionUri: string;
}): Promise<void> {
  const dataplane = makeClient(BedrockAgentCoreClient, { region: args.region });
  await dataplane.send(
    new CompleteResourceTokenAuthCommand({
      userIdentifier: { userId: args.userId },
      sessionUri: args.sessionUri,
    }),
  );
}

/**
 * Begin the 3LO consent flow: request a token for the workspace's user identity.
 * When no cached grant exists the vault returns an `authorizationUrl` (a PAR
 * that redirects to Linear's authorize endpoint with actor=app + prompt=consent
 * forwarded via customParameters). After the operator consents, the
 * returned `poll` closure re-requests the token; it returns the access token
 * once the session completes, or null while consent is still pending.
 *
 * The return URL is required by USER_FEDERATION and must be on the
 * workload identity's allowlist.
 */
export async function beginVaultConsent(args: {
  region: string;
  workloadName: string;
  providerName: string;
  /** The subject to bind the grant to; recorded so runtime can reuse it. */
  userId: string;
  returnUrl: string;
}): Promise<VaultConsentStep> {
  const dataplane = makeClient(BedrockAgentCoreClient, { region: args.region });
  const userId = args.userId;

  async function requestToken(
    forceAuth: boolean,
  ): Promise<{ token: string | null; authUrl: string | null }> {
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
        customParameters: { ...LINEAR_VAULT_CUSTOM_PARAMS },
        ...(forceAuth ? { forceAuthentication: true } : {}),
      }),
    );
    return {
      token: resp.accessToken ?? null,
      authUrl: resp.authorizationUrl ?? null,
    };
  }

  const cached = await requestToken(false);
  if (cached.token) {
    return { kind: 'already-consented', poll: async () => cached.token };
  }

  const first = await requestToken(true);
  if (first.token) {
    return { kind: 'already-consented', poll: async () => first.token };
  }
  if (!first.authUrl) {
    throw new CliError(
      'AgentCore returned neither a token nor an authorization URL for the Linear vault provider. '
      + 'Check that the CustomOauth2 provider was created for this workspace.',
    );
  }
  return {
    kind: 'consent-required',
    authorizationUrl: first.authUrl,
    poll: async () => (await requestToken(false)).token,
  };
}
