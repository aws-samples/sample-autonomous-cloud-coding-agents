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
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { logger } from './logger';
import { makeClient } from './ua';

/**
 * Linear agent-install scopes.
 */
export const LINEAR_VAULT_SCOPES = ['read', 'write', 'app:assignable', 'app:mentionable'] as const;

/**
 * Extra authorize-URL parameters for Linear's agent install.
 *
 * AgentCore keys a cached grant by the
 * full token-request shape, `customParameters` included: the same
 * user + provider returns the cached `accessToken` when these are passed and an
 * `authorizationUrl` ("needs consent") when they are omitted. So the runtime
 * resolvers must send the IDENTICAL set that `bgagent linear setup` used at
 * consent time.
 */
export const LINEAR_VAULT_CUSTOM_PARAMS: Record<string, string> = {
  actor: 'app',
  prompt: 'consent',
};

/**
 * Return URL required by USER_FEDERATION: the API rejects the call without one,
 * and it must be on the workload identity's allowlist.
 */
const RESOLVER_RETURN_URL = 'http://localhost:8080/oauth/callback';

export interface VaultTokenInput {
  /** Linear organization UUID (from the inbound webhook / registry row). */
  readonly linearWorkspaceId: string;
  /** Credential-provider name recorded by `bgagent linear setup`. */
  readonly providerName: string;
  /**
   * The user id the grant was actually bound to, as recorded at consent time.
   * Absent on workspaces onboarded before this
   * was recorded; those fall back to the derived form their grant is under.
   */
  readonly vaultUserId?: string;
  readonly region?: string;
  /** Override client for testing. */
  readonly client?: BedrockAgentCoreClient;
}

/** Subject for workspaces onboarded before `vault_user_id` was recorded on the
 *  registry row. */
export function legacyWorkspaceUserId(linearWorkspaceId: string): string {
  return `linear-workspace-${linearWorkspaceId}`;
}

export type VaultTokenResult =
  | { readonly kind: 'token'; readonly accessToken: string }
  | { readonly kind: 'consent-required'; readonly authorizationUrl: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Mint a Linear access token via the vault. Never throws;
 * the reason is returned so the caller can tell a dead grant from a transient
 * failure.
 */
export async function resolveLinearTokenViaVault(
  input: VaultTokenInput,
  workloadIdentityName: string,
): Promise<VaultTokenResult> {
  const region = input.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const userId = input.vaultUserId?.trim() || legacyWorkspaceUserId(input.linearWorkspaceId);

  try {
    const client = input.client ?? makeClient(BedrockAgentCoreClient, { region });
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

    const resp = await client.send(
      new GetResourceOauth2TokenCommand({
        workloadIdentityToken,
        resourceCredentialProviderName: input.providerName,
        scopes: [...LINEAR_VAULT_SCOPES],
        oauth2Flow: 'USER_FEDERATION',
        resourceOauth2ReturnUrl: RESOLVER_RETURN_URL,
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

    const authorizationUrl = resp.authorizationUrl;
    if (!authorizationUrl) {
      logger.warn('Vault returned neither a token nor an authorization URL; treating as transient', {
        linear_workspace_id: input.linearWorkspaceId,
        provider_name: input.providerName,
        session_status: resp.sessionStatus,
      });
      return { kind: 'unavailable', reason: 'no_token_no_auth_url' };
    }

    logger.warn('Vault requires consent (no cached grant); falling back to SM', {
      linear_workspace_id: input.linearWorkspaceId,
      provider_name: input.providerName,
      session_status: resp.sessionStatus,
    });
    return { kind: 'consent-required', authorizationUrl };
  } catch (err) {
    logger.warn('Vault token resolution failed; falling back to SM', {
      linear_workspace_id: input.linearWorkspaceId,
      provider_name: input.providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unavailable', reason: err instanceof Error ? err.name : 'unknown_error' };
  }
}

export function isVaultEnabled(): boolean {
  return process.env.LINEAR_VAULT_ENABLED === 'true';
}

export function vaultWorkloadIdentityName(): string | null {
  return process.env.LINEAR_WORKLOAD_IDENTITY_NAME || null;
}
