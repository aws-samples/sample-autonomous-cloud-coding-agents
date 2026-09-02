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

/** Consent-time parameters. Part of the vault's cache key, so every resolve must
 *  send the identical set or a live grant reads as "needs consent". */
const LINEAR_VAULT_CUSTOM_PARAMS: Record<string, string> = { actor: 'app', prompt: 'consent' };

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
 * Vault subject derived from the workspace SLUG rather than its organization UUID.
 *
 * The UUID is only knowable once a Linear token exists, so binding the grant to it
 * forces two consents during onboarding: one to learn the organization, a second to
 * bind the vault. The slug is known from the command line, so a slug-derived
 * subject lets a single consent onboard a workspace. The chosen id is recorded on
 * the registry row (`vault_user_id`) because it is no longer derivable at runtime.
 *
 * Distinct prefix from {@link linearVaultUserId} so the two forms can never collide.
 */
export function linearVaultUserIdForSlug(workspaceSlug: string): string {
  return `linear-ws-${workspaceSlug}`;
}

/**
 * Create (or update, if it already exists) the CustomOauth2 credential provider
 * for a Linear workspace. Returns the provider name + the fixed callback URL the
 * operator must register as the Linear OAuth app's redirect_uri (spike F6).
 *
 * `created` distinguishes the first run from every later one, which matters
 * because the callback URL ends in an id AgentCore mints here. On a first run that
 * URL cannot yet be registered on the Linear app, so consent is guaranteed to fail
 * with "Invalid redirect_uri" — the caller should print it and stop rather than
 * open a browser to a dead end.
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
    return { providerName, callbackUrl: existing.callbackUrl ?? '', created: false };
  }
}

/**
 * Read the callback URL of an EXISTING provider, or null if there isn't one.
 *
 * Read-only and best-effort by design: this exists so `linear app-template` can
 * print the real vault redirect_uri instead of asking the operator to go and find
 * it. On a first run the provider does not exist yet, and the operator may have no
 * credentials at all, so every failure is reported as "unknown" rather than
 * raised — a template command must still work offline.
 */
export async function lookupLinearVaultCallbackUrl(args: {
  region: string;
  workspaceSlug: string;
}): Promise<string | null> {
  try {
    const control = makeClient(BedrockAgentCoreControlClient, { region: args.region });
    const existing = await control.send(
      new GetOauth2CredentialProviderCommand({ name: linearVaultProviderName(args.workspaceSlug) }),
    );
    return existing.callbackUrl ?? null;
  } catch {
    // nosemgrep: ts-silent-success-masking -- the only caller renders a template and prints a "NOT FOUND" line naming how to create the provider; "absent" and "unreadable" lead to identical output, and raising would make the command that explains onboarding unusable before onboarding
    return null;
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

/**
 * True when a vault call failed because AgentCore Identity is not usable here —
 * as opposed to the service answering and rejecting our input.
 *
 * The distinction matters because the two demand opposite handling: unusable means
 * fall back to Secrets Manager and onboard anyway (AgentCore Identity is
 * region-limited, and a sample has to work where it is absent), while a rejected
 * request means the operator gave us something wrong — bad client credentials, a
 * malformed name — and silently switching substrate would bury that behind a
 * second, unrelated failure.
 *
 * `ValidationException` and `ConflictException` are the service talking, so they
 * surface. Everything else (endpoint resolution, no such service in region,
 * credentials, network, throttling) is treated as unusable.
 */
export function isVaultUnavailableError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name ?? '';
  // The service REJECTING our input — surface it, the vault is plainly there.
  if (name === 'ValidationException' || name === 'ConflictException') return false;
  // Nor is a permissions problem an availability problem. Reporting it as one tells a
  // first-time operator "AgentCore Identity not available in <region>" when the real
  // cause is a missing `CreateOauth2CredentialProvider` on their own principal — they
  // then go looking at regional availability instead of at their IAM policy, and the
  // onboarding silently completes on Secrets Manager as though the vault were absent.
  if (name === 'AccessDeniedException' || name === 'UnauthorizedException') return false;
  return true;
}

/**
 * Mint a Linear token from an EXISTING vault grant.
 *
 * Read-only: no `forceAuthentication`, so it can never open a browser or start a
 * consent. That is what makes it safe for ordinary CLI commands — they want a
 * token, not an onboarding flow.
 *
 * Needed because a workspace onboarded onto the vault has no usable Secrets
 * Manager token (deliberately, for a fresh onboarding — and any preserved one dies
 * with the app it was issued for). Without this, every CLI command that calls
 * Linear fails with a bare 401 on exactly the workspaces the vault is managing.
 *
 * The return URL is NOT part of the vault's cache key — verified against a
 * workspace consented through the hosted page and minted with the loopback URL —
 * so callers do not have to know which one consent used.
 */
export type VaultMintResult =
  | { readonly kind: 'token'; readonly accessToken: string }
  /** The vault answered with an authorization URL: this grant needs a fresh consent. */
  | { readonly kind: 'consent-required' }
  /** The vault could not be asked (permissions, throttle, not in this region). */
  | { readonly kind: 'unavailable'; readonly reason: string };

export async function mintLinearTokenFromVault(args: {
  region: string;
  workloadName: string;
  providerName: string;
  userId: string;
  returnUrl?: string;
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
        resourceOauth2ReturnUrl: args.returnUrl ?? 'http://localhost:8080/oauth/callback',
        // Must match what consent sent: customParameters are part of the vault's
        // cache key, so omitting them reports "needs consent" despite a live grant.
        customParameters: { ...LINEAR_VAULT_CUSTOM_PARAMS },
      }),
    );
    if (resp.accessToken) return { kind: 'token', accessToken: resp.accessToken };
    // An authorizationUrl with no token means the grant needs re-consent, which a
    // non-interactive command cannot drive.
    return { kind: 'consent-required' };
  } catch (err) {
    // Distinguished, not collapsed. `bgagent platform doctor` turns a verdict into a
    // hard `fail` whose remedy is `bgagent linear setup`, and a re-consent can replace
    // the Linear installation — so reporting a throttle or a missing permission as
    // "revoked" tells an operator to destroy a grant that is working. Mirrors the
    // cdk-side `VaultTokenResult` for the same reason.
    return {
      kind: 'unavailable',
      reason: (err as { name?: string } | undefined)?.name ?? 'unknown_error',
    };
  }
}

/**
 * What `beginVaultConsent` found: either the grant is already good, or a browser
 * round-trip is required.
 *
 * Tagged rather than a flat record with empty-string sentinels. Under the old shape
 * "already consented" was `authorizationUrl: ''` and callers branched on truthiness,
 * so a partially-populated step — a URL with no session, or a session with no URL —
 * was a constructable value that read as valid. The consent fields now exist only on
 * the arm that has them, which is the same reason `VaultTokenResult` is a union.
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
    /**
     * The federation session this consent belongs to
     * (`urn:ietf:params:oauth:request_uri:…`). AgentCore appends the same value to
     * the return URL as `?session_id=…` once consent completes, and it must be
     * handed to {@link finalizeVaultConsent} before a token can be fetched.
     *
     * Exposed even though `bgagent linear setup` currently finalizes with the id the
     * operator pastes from the landing page: dropping it is what made the first
     * implementation hang, and a non-interactive caller needs it.
     *
     * OPTIONAL, and deliberately not enforced. AgentCore models `sessionUri` as
     * optional on the token response, so an absent value is the service's contract
     * rather than a fault — throwing would refuse a consent the interactive flow can
     * still complete from the pasted id. Optionality puts the absence in the type so a
     * non-interactive caller has to handle it, instead of an empty string that reads
     * as a session.
     */
    readonly sessionUri?: string;
    /** Poll this to check whether the token has been minted yet. */
    readonly poll: () => Promise<string | null>;
  };

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
  /** The subject the consent was started under — must match beginVaultConsent. */
  userId: string;
  sessionUri: string;
  client?: BedrockAgentCoreClient;
}): Promise<void> {
  const dataplane = args.client ?? makeClient(BedrockAgentCoreClient, { region: args.region });
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
  /** The subject to bind the grant to; recorded so runtime can reuse it. */
  userId: string;
  returnUrl: string;
}): Promise<VaultConsentStep> {
  const dataplane = makeClient(BedrockAgentCoreClient, { region: args.region });
  const userId = args.userId;

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
        // From the shared constant, not inlined: this is the call that DEFINES the
        // cache key every resolver is required to reproduce, so a divergence here
        // silently turns every later resolve into a cache miss.
        customParameters: { ...LINEAR_VAULT_CUSTOM_PARAMS },
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
    return { kind: 'already-consented', poll: async () => cached.token };
  }

  const first = await requestToken(true);
  if (first.token) {
    // Raced with another consent between the two calls — take the token.
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
    ...(first.sessionUri && { sessionUri: first.sessionUri }),
    poll: async () => (await requestToken(false)).token,
  };
}
