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
// null return.
//
// The flow (proven by the Phase-0 spike):
//   1. `GetWorkloadAccessTokenForUserId` mints a USER-BOUND workload token
//      (spike F2: USER_FEDERATION requires a user-bound token, not a plain one).
//      The user id is `linear-workspace-<organizationId>` — one bgagent[bot]
//      identity per workspace, as the registry-table design documents.
//   2. `GetResourceOauth2Token` (USER_FEDERATION) exchanges it for the Linear
//      access token from the credential provider `bgagent linear setup` created.
//
// In the resolver context there is no browser, so the grant must ALREADY be
// consented (done at setup time). If the vault returns an `authorizationUrl`
// instead of an `accessToken` — i.e. consent is required / the session is not
// complete — this returns null so the caller falls back to the SM token rather
// than blocking a task on an impossible interactive consent.
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { logger } from './logger';
import { makeClient } from './ua';

/** Linear agent-install scopes, mirrored from cli/src/linear-oauth.ts. */
export const LINEAR_VAULT_SCOPES = ['read', 'write', 'app:assignable', 'app:mentionable'] as const;

/**
 * Extra authorize-URL parameters for Linear's agent install.
 *
 * These are NOT optional at resolve time. AgentCore keys a cached grant by the
 * full token-request shape, `customParameters` included — live-proven: the same
 * user + provider returns the cached `accessToken` when these are passed and an
 * `authorizationUrl` ("needs consent") when they are omitted. So the runtime
 * resolvers must send the IDENTICAL set that `bgagent linear vault-setup` used at
 * consent time, or every resolve is a cache miss that silently degrades to the
 * Secrets-Manager fallback.
 *
 * Keep in sync with `cli/src/linear-vault.ts` (consent) and
 * `agent/src/config.py::_LINEAR_VAULT_CUSTOM_PARAMS` (agent-side resolve).
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
  /** AWS region for the SDK client. */
  readonly region?: string;
  /** Override client for testing. */
  readonly client?: BedrockAgentCoreClient;
}

/**
 * The per-workspace user id bound to the federation session. One bot identity
 * per workspace; all members' triggered tasks share it (matches the v1
 * personal-API-key semantics — see LinearWorkspaceRegistryTable docs).
 */
export function workspaceUserId(linearWorkspaceId: string): string {
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
  | { readonly kind: 'consent-required' }
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
  const client = input.client ?? makeClient(BedrockAgentCoreClient, { region });
  const userId = workspaceUserId(input.linearWorkspaceId);

  try {
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

    // No token but an authorization URL ⇒ the grant needs (re-)consent, which
    // cannot happen in this non-interactive path. Fall back to the SM token.
    logger.warn('Vault requires consent (no cached grant); falling back to SM', {
      linear_workspace_id: input.linearWorkspaceId,
      provider_name: input.providerName,
      session_status: resp.sessionStatus,
      has_authorization_url: Boolean(resp.authorizationUrl),
    });
    return { kind: 'consent-required' };
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
