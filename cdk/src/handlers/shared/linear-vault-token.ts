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

// Resolve a Linear OAuth access token through the AgentCore Identity Token
// Vault (RFC #249 Phase 1). This is the vault half of the Linear token
// resolver; `linear-oauth-resolver.ts` calls it first when the vault is
// enabled and falls back to the per-workspace Secrets-Manager token on any
// non-`token` result.
//
// The flow (proven by the Phase-0 spike):
//   1. `GetWorkloadAccessTokenForUserId` mints a USER-BOUND workload token
//      (spike F2: USER_FEDERATION requires a user-bound token, not a plain one).
//      The user id is the `vault_user_id` recorded on the registry row at consent
//      time (slug-derived, `linear-ws-<slug>`) — one bgagent[bot] identity per
//      workspace. `linear-workspace-<organizationId>` is the pre-#809 fallback.
//   2. `GetResourceOauth2Token` (USER_FEDERATION) exchanges it for the Linear
//      access token from the credential provider `bgagent linear setup` created.
//
// In the resolver context there is no browser, so the grant must ALREADY be
// consented (done at setup time). If the vault returns an `authorizationUrl`
// instead of an `accessToken` — i.e. consent is required / the session is not
// complete — this reports `consent-required` and the caller falls back to the SM
// token rather than blocking a task on an impossible interactive consent.
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { logger } from './logger';
import { makeClient } from './ua';

/**
 * Linear agent-install scopes. Enforced against `contracts/constants.json` by
 * `cdk/test/contracts/linear-vault-cache-key-parity.test.ts` — change the
 * contract, not this literal.
 */
export const LINEAR_VAULT_SCOPES = ['read', 'write', 'app:assignable', 'app:mentionable'] as const;

/**
 * Extra authorize-URL parameters for Linear's agent install.
 *
 * These are NOT optional at resolve time. AgentCore keys a cached grant by the
 * full token-request shape, `customParameters` included — live-proven: the same
 * user + provider returns the cached `accessToken` when these are passed and an
 * `authorizationUrl` ("needs consent") when they are omitted. So the runtime
 * resolvers must send the IDENTICAL set that `bgagent linear setup` used at
 * consent time, or every resolve is a cache miss that silently degrades to the
 * Secrets-Manager fallback.
 *
 * Contract-enforced like the scopes above — change `contracts/constants.json`.
 */
export const LINEAR_VAULT_CUSTOM_PARAMS: Record<string, string> = {
  actor: 'app',
  prompt: 'consent',
};

/**
 * Return URL required by USER_FEDERATION (spike F7: mandatory). In the resolver
 * (non-interactive) path the grant is already consented, so this URL is never
 * actually visited — but the API rejects the call without one, and it must be
 * on the workload identity's allowlist. The CLI localhost loopback is always
 * registered (see LinearIdentityVault), so it is the safe default here.
 */
const RESOLVER_RETURN_URL = 'http://localhost:8080/oauth/callback';

export interface VaultTokenInput {
  /** Linear organization UUID (from the inbound webhook / registry row). */
  readonly linearWorkspaceId: string;
  /** Credential-provider name recorded by `bgagent linear setup`. */
  readonly providerName: string;
  /**
   * The user id the grant was actually bound to, as recorded at consent time.
   * Preferred over deriving it — see `linearVaultUserIdForSlug` in
   * `cli/src/linear-vault.ts` for why. Absent on workspaces onboarded before this
   * was recorded; those fall back to the derived form their grant is under.
   */
  readonly vaultUserId?: string;
  /** AWS region for the SDK client. */
  readonly region?: string;
  /** Override client for testing. */
  readonly client?: BedrockAgentCoreClient;
}

/** Subject for workspaces onboarded before `vault_user_id` was recorded on the
 *  registry row. Fresh installs use the slug-derived id the CLI records at
 *  consent time — see `linearVaultUserIdForSlug` in `cli/src/linear-vault.ts`. */
export function legacyWorkspaceUserId(linearWorkspaceId: string): string {
  return `linear-workspace-${linearWorkspaceId}`;
}

/**
 * Outcome of a vault token request.
 *
 * Deliberately NOT `string | null`. Collapsing "the grant needs a fresh consent"
 * and "the call was throttled" into one null hid the only distinction the caller
 * cares about: the first means the workspace is dead and an operator must act, the
 * second is transient and self-heals. That is the silent-success-masking shape the
 * repo lints against, and it is why a revoked vault grant would otherwise be
 * indistinguishable from a blip (#812).
 */
export type VaultTokenResult =
  | { readonly kind: 'token'; readonly accessToken: string }
  /**
   * Carries the authorization URL rather than being a bare tag, so this verdict
   * cannot be constructed without the evidence for it. It latches the registry row
   * `revoked`, so it must not be reachable as the fall-through for any tokenless
   * response — an empty body or an unrecognised `sessionStatus` is malformed, not a
   * dead grant.
   */
  | { readonly kind: 'consent-required'; readonly authorizationUrl: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Mint a Linear access token via the vault. Never throws — a vault hiccup must
 * degrade to the Secrets-Manager fallback rather than break token resolution — but
 * the reason is returned so the caller can tell a dead grant from a transient
 * failure.
 */
export async function resolveLinearTokenViaVault(
  input: VaultTokenInput,
  workloadIdentityName: string,
): Promise<VaultTokenResult> {
  const region = input.region ?? process.env.AWS_REGION ?? 'us-east-1';
  // Recorded id wins; derive only for workspaces onboarded before it was stored.
  const userId = input.vaultUserId?.trim() || legacyWorkspaceUserId(input.linearWorkspaceId);

  // Client construction is INSIDE the try: this function's contract is that it never
  // throws, and a constructor is not obviously safe. If the runtime's bundled SDK ever
  // lacks a command this file names, the throw would otherwise escape the `unavailable`
  // classification and out of `resolveLinearOauthToken`, whose Step 1b has no try —
  // turning a degradable condition into a hard failure for every vault workspace.
  try {
    const client = input.client ?? makeClient(BedrockAgentCoreClient, { region });
    // Step 1: user-bound workload token (F2).
    const wat = await client.send(
      new GetWorkloadAccessTokenForUserIdCommand({
        workloadName: workloadIdentityName,
        userId,
      }),
    );
    const workloadIdentityToken = wat.workloadAccessToken;
    if (!workloadIdentityToken) {
      logger.warn('Vault returned no workload access token; falling back to SM', {
        linear_workspace_id: input.linearWorkspaceId,
      });
      return { kind: 'unavailable', reason: 'no_workload_access_token' };
    }

    // Step 2: exchange for the Linear access token (USER_FEDERATION).
    const resp = await client.send(
      new GetResourceOauth2TokenCommand({
        workloadIdentityToken,
        resourceCredentialProviderName: input.providerName,
        scopes: [...LINEAR_VAULT_SCOPES],
        oauth2Flow: 'USER_FEDERATION',
        resourceOauth2ReturnUrl: RESOLVER_RETURN_URL,
        // Part of the vault's cache key — omitting these turns every resolve into
        // a cache miss. See LINEAR_VAULT_CUSTOM_PARAMS.
        customParameters: LINEAR_VAULT_CUSTOM_PARAMS,
      }),
    );

    if (resp.accessToken) {
      logger.info('Resolved Linear token via AgentCore Identity vault', {
        linear_workspace_id: input.linearWorkspaceId,
        provider_name: input.providerName,
      });
      return { kind: 'token', accessToken: resp.accessToken };
    }

    // No token AND no authorization URL is not a verdict about the grant — it is a
    // response this code does not understand. Reporting it as "consent required"
    // would latch the row `revoked` on the strength of an empty body, so it is
    // classified transient instead: the SM fallback still runs, and the next event
    // retries the vault.
    const authorizationUrl = resp.authorizationUrl;
    if (!authorizationUrl) {
      logger.warn('Vault returned neither a token nor an authorization URL; treating as transient', {
        linear_workspace_id: input.linearWorkspaceId,
        provider_name: input.providerName,
        session_status: resp.sessionStatus,
      });
      return { kind: 'unavailable', reason: 'no_token_no_auth_url' };
    }

    // A token-less response WITH an authorization URL ⇒ the grant needs
    // (re-)consent, which cannot happen in this non-interactive path. Fall back to
    // the SM token.
    logger.warn('Vault requires consent (no cached grant); falling back to SM', {
      linear_workspace_id: input.linearWorkspaceId,
      provider_name: input.providerName,
      session_status: resp.sessionStatus,
    });
    return { kind: 'consent-required', authorizationUrl };
  } catch (err) {
    // Any error (permission, throttle, provider missing, service) → SM fallback.
    logger.warn('Vault token resolution failed; falling back to SM', {
      linear_workspace_id: input.linearWorkspaceId,
      provider_name: input.providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unavailable', reason: err instanceof Error ? err.name : 'unknown_error' };
  }
}

/** True when the runtime is configured to attempt vault resolution. */
export function isVaultEnabled(): boolean {
  return process.env.LINEAR_VAULT_ENABLED === 'true';
}

/** The workload identity name the resolver mints tokens against, or null. */
export function vaultWorkloadIdentityName(): string | null {
  return process.env.LINEAR_WORKLOAD_IDENTITY_NAME || null;
}
