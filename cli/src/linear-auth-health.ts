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
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient } from './dynamo-clients';
import { verifyLinearRefreshAndPersist } from './linear-oauth';
import { linearVaultUserId, mintLinearTokenFromVault, type VaultMintResult } from './linear-vault';
import { makeClient } from './ua';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

const VIEWER_PROBE_QUERY = '{ viewer { id } }';

export type LinearAuthState =
  /** Access token accepted — the workspace is fully working. */
  | 'active'
  /**
   * INDETERMINATE, and never reported as healthy. The access token is rejected
   * and expired and a refresh token is stored — which is both the normal
   * idle-workspace shape and the shape of a workspace whose refresh token has
   * been revoked. Pass ``verifyRefresh`` to resolve it — see
   * {@link CheckLinearAuthOptions.verifyRefresh}.
   */
  | 'expired_indeterminate'
  /**
   * Access token rejected while NOT expired, or no refresh token stored. The
   * authorization itself is gone (revoked upstream, app uninstalled) — events
   * are being dropped until someone re-authorizes.
   */
  | 'revoked'
  /** Registry row marked inactive by an operator — dropping events is intended. */
  | 'disabled'
  /** Couldn't determine (secret unreadable, network failure). Not a verdict. */
  | 'unknown';

export interface LinearWorkspaceAuthHealth {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly state: LinearAuthState;
  /** Operator-facing explanation, including the remedy when there is one. */
  readonly detail: string;
}

interface RegistryRow {
  readonly linear_workspace_id?: string;
  readonly workspace_slug?: string;
  readonly oauth_secret_arn?: string;
  readonly status?: string;
  readonly revoked_at?: string;
  readonly revoked_reason?: string;
  readonly provider_name?: string;
  readonly vault_user_id?: string;
}

interface StoredToken {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_at?: string;
  readonly workspace_slug?: string;
}

export type ProbeResult = 'accepted' | 'rejected' | 'error';

/**
 * Outcome of ATTEMPTING the refresh — the only way to settle
 * ``expired_indeterminate``.
 *
 * ``refreshed`` means the grant is alive AND the rotated token was persisted.
 * Linear rotates the refresh token on every use, so a verifier that cannot
 * persist must not refresh at all.
 */
export type RefreshVerifyResult = 'refreshed' | 'rejected' | 'error';

/** Attempt the refresh for one workspace and persist the rotation. */
export type LinearRefreshVerifier = (workspace: {
  readonly workspaceId: string;
  readonly oauthSecretArn: string;
}) => Promise<RefreshVerifyResult>;

/** Ask the surface whether an access token is still accepted. */
export type LinearProbe = (accessToken: string) => Promise<ProbeResult>;

const probeLinearAccessToken: LinearProbe = async (accessToken) => {
  try {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ query: VIEWER_PROBE_QUERY }),
    });
    if (response.status === 401 || response.status === 403) return 'rejected';
    if (!response.ok) return 'error';
    // Linear reports auth failures as 200 + an errors array as well as via 401.
    const body = await response.json() as { data?: { viewer?: { id?: string } } };
    return body?.data?.viewer?.id ? 'accepted' : 'rejected';
  } catch {
    return 'error';
  }
};

/** True when ``expiresAt`` is in the past (or absent or unparseable, which we
 *  treat as expired). */
export function isExpired(expiresAt: string | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return true;
  return now.getTime() >= ts;
}

export function classifyAuthState(
  probe: ProbeResult,
  token: { hasRefreshToken: boolean; expiresAt?: string },
  now: Date = new Date(),
): LinearAuthState {
  if (probe === 'accepted') return 'active';
  if (probe === 'error') return 'unknown';
  if (isExpired(token.expiresAt, now) && token.hasRefreshToken) return 'expired_indeterminate';
  return 'revoked';
}

export interface CheckLinearAuthOptions {
  readonly region: string;
  readonly registryTableName: string;
  readonly probe?: LinearProbe;
  /**
   * Supply this to RESOLVE ``expired_indeterminate`` instead of reporting it.
   * It performs a real token rotation and persists the new token.
   */
  readonly verifyRefresh?: LinearRefreshVerifier;
  /**
   * Mint the vault-managed token for one workspace. Omitted ⇒ vault-managed
   * workspaces are reported `unknown`.
   */
  readonly mintVaultToken?: (args: {
    readonly providerName: string;
    readonly userId?: string;
    readonly workspaceId: string;
  }) => Promise<VaultMintResult>;
  readonly now?: Date;
}

/**
 * Report the authorization health of every workspace in the registry.
 * A workspace that can't be assessed comes back ``unknown``; a failed read of
 * the registry throws.
 */
export async function checkLinearWorkspaceAuth(
  options: CheckLinearAuthOptions,
): Promise<LinearWorkspaceAuthHealth[]> {
  const { region, registryTableName } = options;
  const probe = options.probe ?? probeLinearAccessToken;
  const now = options.now ?? new Date();

  const ddb = documentClient(region);
  const rows: RegistryRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: registryTableName,
      ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey }),
    }));
    rows.push(...((page.Items ?? []) as RegistryRow[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const sm = makeClient(SecretsManagerClient, { region });
  const out: LinearWorkspaceAuthHealth[] = [];

  for (const row of rows) {
    const workspaceId = row.linear_workspace_id ?? '(unknown)';
    const slug = row.workspace_slug ?? workspaceId;

    if (row.status === 'revoked' && row.revoked_reason === 'admin_removed') {
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: 'disabled',
        detail: `Removed by an admin at ${row.revoked_at ?? 'an unknown time'} (\`bgagent linear remove-workspace\`) `
          + '— events for this workspace are dropped by design.',
      });
      continue;
    }
    if (row.status === 'revoked') {
      const staleLatchSuspected = row.revoked_reason === 'vault_consent_required'
        && Boolean(row.provider_name) && Boolean(options.mintVaultToken);
      if (staleLatchSuspected) {
        const reprobe = await options.mintVaultToken!({
          providerName: row.provider_name!,
          userId: row.vault_user_id,
          workspaceId,
        });
        if (reprobe.kind === 'token' && await probe(reprobe.accessToken) === 'accepted') {
          out.push({
            workspaceId,
            workspaceSlug: slug,
            state: 'active',
            detail: `Recorded revoked at ${row.revoked_at ?? 'an unknown time'} for 'vault_consent_required', `
              + 'but the vault mints a token Linear accepts — the record is stale. The platform clears it on '
              + 'the next event for this workspace; no re-authorization is needed.',
          });
          continue;
        }
      }
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: 'revoked',
        detail: describeState('revoked', undefined, row.revoked_at),
      });
      continue;
    }
    if (row.status && row.status !== 'active') {
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: 'disabled',
        detail: `Registry row status is '${row.status}' — events for this workspace are dropped by design.`,
      });
      continue;
    }
    if (row.provider_name) {
      if (!options.mintVaultToken) {
        out.push({
          workspaceId,
          workspaceSlug: slug,
          state: 'unknown',
          detail: 'Managed by the AgentCore Identity token vault, which this check was not given a way to '
            + 'query. Its Secrets Manager bundle is empty by design, so no verdict can be drawn from it.',
        });
        continue;
      }
      const minted = await options.mintVaultToken({
        providerName: row.provider_name,
        userId: row.vault_user_id,
        workspaceId,
      });
      if (minted.kind === 'unavailable') {
        out.push({
          workspaceId,
          workspaceSlug: slug,
          state: 'unknown',
          detail: `Could not ask the AgentCore Identity vault about this workspace (${minted.reason}), `
            + 'so its grant is unconfirmed rather than known bad.',
        });
        continue;
      }
      if (minted.kind === 'consent-required') {
        out.push({
          workspaceId,
          workspaceSlug: slug,
          state: 'revoked',
          detail: 'The AgentCore Identity vault reports this workspace needs a fresh consent. '
            + `Run \`bgagent linear setup ${slug}\`.`,
        });
        continue;
      }
      const vaultToken = minted.accessToken;
      const vaultState = classifyAuthState(await probe(vaultToken), { hasRefreshToken: false }, now);
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: vaultState,
        detail: `Managed by the AgentCore Identity token vault (provider ${row.provider_name}). `
          + (vaultState === 'active'
            ? 'The vault minted a token and Linear accepted it.'
            : `The vault minted a token but Linear rejected it. Run \`bgagent linear setup ${slug}\`.`),
      });
      continue;
    }

    if (!row.oauth_secret_arn) {
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: 'revoked',
        detail: 'Registry row has no oauth_secret_arn. Re-run `bgagent linear setup` for this workspace.',
      });
      continue;
    }

    let stored: StoredToken | null = null;
    try {
      const secret = await sm.send(new GetSecretValueCommand({ SecretId: row.oauth_secret_arn }));
      stored = secret.SecretString ? JSON.parse(secret.SecretString) as StoredToken : null;
    } catch (err) {
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: 'unknown',
        detail: `Could not read the OAuth secret: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!stored?.access_token) {
      out.push({
        workspaceId,
        workspaceSlug: slug,
        state: 'revoked',
        detail: 'Stored OAuth secret has no access token. Re-run `bgagent linear setup` for this workspace.',
      });
      continue;
    }

    let state = classifyAuthState(
      await probe(stored.access_token),
      { hasRefreshToken: Boolean(stored.refresh_token), expiresAt: stored.expires_at },
      now,
    );

    if (state === 'expired_indeterminate' && options.verifyRefresh) {
      const verified = await options.verifyRefresh({
        workspaceId,
        oauthSecretArn: row.oauth_secret_arn,
      });
      if (verified === 'refreshed') state = 'active';
      else if (verified === 'rejected') state = 'revoked';
    }

    out.push({
      workspaceId,
      workspaceSlug: stored.workspace_slug ?? slug,
      state,
      detail: describeState(state, stored.expires_at),
    });
  }

  return out;
}

function describeState(state: LinearAuthState, expiresAt?: string, revokedAt?: string): string {
  switch (state) {
    case 'active':
      return `Authorization is live (access token valid until ${expiresAt ?? 'unknown'}).`;
    case 'expired_indeterminate':
      return 'INDETERMINATE — the access token has expired. This is what a healthy idle workspace looks '
        + 'like AND what a revoked one looks like; the two are indistinguishable without attempting the '
        + 'refresh. Re-run with `--verify-refresh` for a definitive answer (it performs the same refresh '
        + 'the platform would, and persists the rotated token).';
    case 'revoked':
      return `Authorization was REVOKED${revokedAt ? ` at ${revokedAt}` : ''} — the platform cannot post `
        + 'to this workspace and is dropping its events. Re-authorize with `bgagent linear setup`.';
    case 'disabled':
      return 'Workspace is disabled in the registry.';
    case 'unknown':
    default:
      return 'Could not determine authorization state.';
  }
}

/**
 * The production vault minter for {@link CheckLinearAuthOptions.mintVaultToken}.
 *
 * Read-only with respect to the grant: `GetResourceOauth2Token` returns the cached
 * token and does not rotate or consume it.
 *
 * The subject falls back to the derived `linear-workspace-<orgId>` form for
 * workspaces onboarded before it was recorded on the row.
 */
export function makeLinearVaultTokenMinter(
  region: string,
  workloadName: string,
): NonNullable<CheckLinearAuthOptions['mintVaultToken']> {
  return async ({ providerName, userId, workspaceId }) => mintLinearTokenFromVault({
    region,
    workloadName,
    providerName,
    userId: userId?.trim() || linearVaultUserId(workspaceId),
  });
}

/**
 * The production {@link LinearRefreshVerifier}: binds Secrets Manager to
 * {@link verifyLinearRefreshAndPersist}, which owns the refresh-and-save
 * sequencing.
 */
export function makeLinearRefreshVerifier(region: string): LinearRefreshVerifier {
  const sm = makeClient(SecretsManagerClient, { region });
  return async ({ oauthSecretArn }) => verifyLinearRefreshAndPersist({
    readSecret: async () => {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: oauthSecretArn }));
      return res.SecretString;
    },
    writeSecret: async (secretString) => {
      await sm.send(new PutSecretValueCommand({ SecretId: oauthSecretArn, SecretString: secretString }));
    },
  });
}
