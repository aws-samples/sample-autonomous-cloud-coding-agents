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
 * Scheduled Linear grant health probe (#1004).
 *
 * Revocation detection (#812) runs only when something needs a Linear token, which
 * means when a Linear event arrives. A workspace whose webhook stopped delivering, or
 * that nobody used for a while, therefore never re-detects a dead grant: observed
 * live, a workspace sat with an expired refresh token for months with one ERROR log
 * line. Linear refresh tokens also expire when unused, so the outage was preventable.
 *
 * The probe resolves a token for every active workspace on a schedule. That does two
 * jobs with the existing code path:
 *  - it refreshes expiring access tokens, which keeps an idle refresh token alive;
 *  - a grant Linear rejects goes through the resolver's revocation recorder, which
 *    latches the workspace and announces it on OperationalAlerts (once).
 */

import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** How often each workspace is probed. Linear access tokens last about a day. */
export const GRANT_HEALTH_PROBE_INTERVAL_HOURS = 12;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** Async invocation payload that selects probe mode in the webhook processor. */
export const GRANT_HEALTH_PROBE_EVENT = { grant_health_probe: true } as const;

export function isGrantHealthProbe(event: unknown): event is typeof GRANT_HEALTH_PROBE_EVENT {
  return typeof event === 'object' && event !== null
    && (event as Record<string, unknown>).grant_health_probe === true;
}

/**
 * True on exactly one tick per interval for a job that runs every `tickMinutes`:
 * the tick falling in the half-open window `[k * interval, k * interval + tick)`.
 * Ticks are `tick` apart, so each window holds exactly one. A nonsensical cadence
 * probes every tick rather than never, so a misconfiguration cannot silently
 * disable detection.
 */
export function isProbeTick(
  nowMs: number,
  tickMinutes: number,
  intervalHours: number = GRANT_HEALTH_PROBE_INTERVAL_HOURS,
): boolean {
  const tickMs = tickMinutes * MS_PER_MINUTE;
  const intervalMs = intervalHours * MS_PER_HOUR;
  if (!(tickMs > 0) || !(intervalMs > 0) || tickMs >= intervalMs) return true;
  return nowMs % intervalMs < tickMs;
}

export interface GrantHealthReport {
  readonly checked: number;
  readonly healthy: number;
  /** Slugs (or ids when a row has no slug) whose token could not be resolved. */
  readonly unhealthy: readonly string[];
  /** Rows already latched `revoked`; not re-probed, they were already announced. */
  readonly revoked: readonly string[];
}

interface RegistryRow {
  readonly linear_workspace_id?: string;
  readonly workspace_slug?: string;
  readonly status?: string;
}

/**
 * Resolve a token for every active registry row, sequentially (a handful of
 * workspaces; sequential keeps the probe gentle on Linear's token endpoint).
 */
export async function probeLinearGrants(
  ddb: DynamoDBDocumentClient,
  registryTableName: string,
  resolve: (linearWorkspaceId: string) => Promise<unknown | null>,
): Promise<GrantHealthReport> {
  const rows: RegistryRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: registryTableName,
      ProjectionExpression: 'linear_workspace_id, workspace_slug, #status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExclusiveStartKey: startKey,
    }));
    rows.push(...(page.Items ?? []) as RegistryRow[]);
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  let healthy = 0;
  const unhealthy: string[] = [];
  const revoked: string[] = [];
  let checked = 0;
  for (const row of rows) {
    if (!row.linear_workspace_id) continue;
    const label = row.workspace_slug ?? row.linear_workspace_id;
    if (row.status !== 'active') {
      revoked.push(label);
      continue;
    }
    checked++;
    try {
      if (await resolve(row.linear_workspace_id)) healthy++;
      else unhealthy.push(label);
    } catch {
      // One workspace's failure must not hide the others.
      unhealthy.push(label);
    }
  }
  return { checked, healthy, unhealthy, revoked };
}
