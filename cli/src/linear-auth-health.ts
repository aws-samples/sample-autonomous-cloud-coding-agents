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

/**
 * Is each onboarded Linear workspace's OAuth authorization still usable?
 *
 * Why this needs its own check: when a workspace's authorization dies, the
 * platform goes SILENT rather than loud. The webhook processor can't resolve a
 * token, logs "workspace not resolvable — dropping event", and returns — so a
 * user applies the trigger label and gets nothing at all: no comment, no
 * reaction, no state change. The only evidence is a CloudWatch line nobody is
 * watching. Observed 2026-07-25: a workspace's authorization was revoked
 * upstream and every event silently dropped for over an hour.
 *
 * The distinction this check exists to make: an EXPIRED access token is normal
 * and self-healing (the resolver refreshes it on the next call), whereas a
 * REVOKED authorization needs a human to re-authorize. Both look like "auth
 * broken" from the outside, so reporting "expired" as a failure would cry wolf
 * on every idle workspace, and reporting "revoked" as fine would hide a total
 * outage. So we ask the surface, and only treat a rejected REFRESH as a failure.
 *
 * Read-only: this never consumes a refresh token (which would rotate it and
 * disrupt the very thing being diagnosed). It probes with the stored access
 * token, and only when that is rejected does it distinguish expiry from
 * revocation using the locally-known expiry.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient } from './dynamo-clients';

/** Linear's GraphQL endpoint — a cheap authenticated probe target. */
const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** Smallest authenticated query that proves a token is live. */
const VIEWER_PROBE_QUERY = '{ viewer { id } }';

/** How each workspace's authorization looks right now. */
export type LinearAuthState =
  /** Access token accepted — the workspace is fully working. */
  | 'active'
  /**
   * Access token rejected and already expired, with a refresh token stored. This
   * check does NOT prove the refresh will succeed — verifying that would consume
   * the one-shot refresh token and rotate it, breaking the thing being
   * diagnosed. So this is "probably fine, refreshes on next event", and the
   * authoritative answer comes from the platform recording ``revoked`` on the
   * registry row when a refresh actually fails.
   */
  | 'expired_untested'
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

/** Registry row fields this check reads. */
interface RegistryRow {
  readonly linear_workspace_id?: string;
  readonly workspace_slug?: string;
  readonly oauth_secret_arn?: string;
  readonly status?: string;
  /** Stamped by the platform when it detected the authorization was dead. */
  readonly revoked_at?: string;
  readonly revoked_reason?: string;
}

/** The stored-secret fields this check reads. Deliberately narrow: the token
 *  values are used only to make one probe call and are never returned. */
interface StoredToken {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_at?: string;
  readonly workspace_slug?: string;
}

/** Probe outcome, kept separate from the verdict so the mapping is testable. */
export type ProbeResult = 'accepted' | 'rejected' | 'error';

/** Ask the surface whether an access token is still accepted. Injectable so
 *  tests don't reach the network. */
export type LinearProbe = (accessToken: string) => Promise<ProbeResult>;

/** Default probe: a minimal authenticated GraphQL query. */
export const probeLinearAccessToken: LinearProbe = async (accessToken) => {
  try {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ query: VIEWER_PROBE_QUERY }),
    });
    if (response.status === 401 || response.status === 403) return 'rejected';
    if (!response.ok) return 'error';
    // Linear reports auth failures as 200 + an errors array as well as via 401,
    // so a body check is needed — treating a 200 as proof would report a dead
    // token as healthy.
    const body = await response.json() as { data?: { viewer?: { id?: string } } };
    return body?.data?.viewer?.id ? 'accepted' : 'rejected';
  } catch {
    return 'error';
  }
};

/** True when ``expiresAt`` is in the past (or unparseable, which we treat as
 *  expired — the resolver does the same, preferring an extra refresh). */
export function isExpired(expiresAt: string | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return true;
  return now.getTime() >= ts;
}

/**
 * Map a probe result + stored-token facts to a verdict. Pure, so the
 * expired-vs-revoked distinction — the whole point of the check — is testable
 * without a network or a live workspace.
 */
export function classifyAuthState(
  probe: ProbeResult,
  token: { hasRefreshToken: boolean; expiresAt?: string },
  now: Date = new Date(),
): LinearAuthState {
  if (probe === 'accepted') return 'active';
  if (probe === 'error') return 'unknown';
  // Rejected. An expired token with a refresh token in hand is the normal
  // idle-workspace case and heals itself on the next resolve.
  if (isExpired(token.expiresAt, now) && token.hasRefreshToken) return 'expired_untested';
  return 'revoked';
}

export interface CheckLinearAuthOptions {
  readonly region: string;
  readonly registryTableName: string;
  /** Injectable for tests. */
  readonly probe?: LinearProbe;
  readonly now?: Date;
}

/**
 * Report the authorization health of every workspace in the registry.
 * Never throws: a workspace that can't be assessed comes back ``unknown`` so
 * one broken row doesn't hide the others.
 */
export async function checkLinearWorkspaceAuth(
  options: CheckLinearAuthOptions,
): Promise<LinearWorkspaceAuthHealth[]> {
  const { region, registryTableName } = options;
  const probe = options.probe ?? probeLinearAccessToken;
  const now = options.now ?? new Date();

  const ddb = documentClient(region);
  const scanned = await ddb.send(new ScanCommand({ TableName: registryTableName }));
  const rows = (scanned.Items ?? []) as RegistryRow[];

  const sm = new SecretsManagerClient({ region });
  const out: LinearWorkspaceAuthHealth[] = [];

  for (const row of rows) {
    const workspaceId = row.linear_workspace_id ?? '(unknown)';
    const slug = row.workspace_slug ?? workspaceId;

    if (row.status === 'revoked') {
      // The platform itself recorded this when a refresh was rejected, which is
      // the authoritative signal — more reliable than anything this check can
      // infer from a token, and it carries when it happened.
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

    const state = classifyAuthState(
      await probe(stored.access_token),
      { hasRefreshToken: Boolean(stored.refresh_token), expiresAt: stored.expires_at },
      now,
    );
    out.push({
      workspaceId,
      workspaceSlug: stored.workspace_slug ?? slug,
      state,
      detail: describeState(state, stored.expires_at),
    });
  }

  return out;
}

/** Operator-facing wording per state, remedy included where one applies. */
function describeState(state: LinearAuthState, expiresAt?: string, revokedAt?: string): string {
  switch (state) {
    case 'active':
      return `Authorization is live (access token valid until ${expiresAt ?? 'unknown'}).`;
    case 'expired_untested':
      return 'Access token has expired. The platform should refresh it on the next event — but whether '
        + 'the stored refresh token is still valid cannot be checked without consuming it. If Linear '
        + 'events are being ignored, this is the first thing to re-authorize.';
    case 'revoked':
      return `Authorization was REVOKED${revokedAt ? ` at ${revokedAt}` : ''} — the platform cannot post `
        + 'to this workspace and is dropping its events. Re-authorize with `bgagent linear setup` '
        + '(or `bgagent linear add-workspace` for an additional workspace).';
    case 'disabled':
      return 'Workspace is disabled in the registry.';
    case 'unknown':
    default:
      return 'Could not determine authorization state.';
  }
}
