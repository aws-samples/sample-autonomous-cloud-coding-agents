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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { logger } from './logger';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Linear issue identifier shape, e.g. `ABCA-42`. Linear identifiers are
 * `<TEAM_KEY>-<NUMBER>` where the key is uppercase letters and digits is
 * a positive integer. We bound the team key length [1,10] and number
 * length [1,8] to avoid pathological inputs.
 */
const LINEAR_IDENTIFIER_RE = /\b([A-Z][A-Z0-9]{0,9})-(\d{1,8})\b/g;

/**
 * Pull the first Linear issue identifier (e.g. `ABCA-42`) found in
 * the given text. PR titles and bodies typically include this either
 * because the agent's task_description carries the identifier, or
 * because Linear's own GitHub integration auto-injects an
 * `ABCA-42 <linear-url>` reference.
 *
 * Returns the first match in document order. If multiple distinct
 * identifiers are present we still return the first — multi-issue PRs
 * are unusual enough that single-screenshot-per-issue is acceptable.
 */
export function extractLinearIdentifier(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = LINEAR_IDENTIFIER_RE.exec(text);
  // The regex has the `g` flag for testability; reset lastIndex so
  // back-to-back calls behave correctly.
  LINEAR_IDENTIFIER_RE.lastIndex = 0;
  return match ? `${match[1]}-${match[2]}` : null;
}

/**
 * Resolved Linear issue location, paired with the workspace that owns
 * it. The screenshot processor uses these to construct a
 * LinearFeedbackContext + issueId for postIssueComment.
 */
export interface LinearIssueLocation {
  readonly issueId: string;
  readonly linearWorkspaceId: string;
  readonly workspaceSlug: string;
}

const ISSUE_BY_IDENTIFIER_QUERY = `
query IssueByIdentifier($identifier: String!) {
  issueVcsBranchSearch(branchName: $identifier) {
    id
    identifier
  }
}
`.trim();

/**
 * Look up a Linear issue by identifier (e.g. `ABCA-42`).
 *
 * Routing strategy:
 * 1. Scan active workspaces (one round-trip — typical stacks have 1–2).
 * 2. If any row's `team_keys` contains the identifier's team key (`ABCA`),
 *    query that workspace directly and return on hit.
 * 3. Otherwise fall back to iterating every active workspace until one
 *    returns a match. This handles legacy rows missing `team_keys` (the
 *    column was added in #96 and back-fills only on next `setup` /
 *    `add-workspace` re-run) and the rare case where a team was added in
 *    Linear after the workspace was registered.
 *
 * @param identifier `ABCA-42`-style Linear issue identifier
 * @param registryTableName name of LinearWorkspaceRegistryTable
 * @returns issue location, or null if no workspace contains the issue
 */
export async function findLinearIssueByIdentifier(
  identifier: string,
  registryTableName: string,
): Promise<LinearIssueLocation | null> {
  let active: Array<{
    linear_workspace_id: string;
    workspace_slug: string;
    team_keys: string[] | null;
  }> = [];
  try {
    const scanResp = await ddb.send(new ScanCommand({
      TableName: registryTableName,
      FilterExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'active' },
    }));
    active = (scanResp.Items ?? []).map((item) => ({
      linear_workspace_id: item.linear_workspace_id as string,
      workspace_slug: item.workspace_slug as string,
      team_keys: Array.isArray(item.team_keys) ? (item.team_keys as string[]) : null,
    }));
  } catch (err) {
    logger.warn('Linear issue lookup: failed to scan workspace registry', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (active.length === 0) {
    logger.info('Linear issue lookup: no active workspaces in registry', { identifier });
    return null;
  }

  // Identifier prefix is the part before the first dash (`ABCA-42` → `ABCA`).
  // Compare uppercase since Linear team keys are upper-case but inbound text
  // (PR titles, branch names) is mixed-case.
  const teamKey = identifier.split('-', 1)[0]?.toUpperCase();
  const prefixMatch = teamKey
    ? active.find((ws) => ws.team_keys?.some((k) => k.toUpperCase() === teamKey))
    : undefined;

  // Try the prefix-matched workspace first.
  if (prefixMatch) {
    const resolved = await resolveLinearOauthToken(prefixMatch.linear_workspace_id, registryTableName);
    if (resolved) {
      const found = await queryIssueByIdentifier(resolved.accessToken, identifier);
      if (found) {
        return {
          issueId: found,
          linearWorkspaceId: prefixMatch.linear_workspace_id,
          workspaceSlug: prefixMatch.workspace_slug,
        };
      }
    }
  }

  // Fallback: iterate workspaces NOT already tried via prefix-match.
  // Covers legacy rows without `team_keys` and post-registration team adds.
  for (const ws of active) {
    if (prefixMatch && ws.linear_workspace_id === prefixMatch.linear_workspace_id) continue;
    const resolved = await resolveLinearOauthToken(ws.linear_workspace_id, registryTableName);
    if (!resolved) continue;

    const found = await queryIssueByIdentifier(resolved.accessToken, identifier);
    if (found) {
      return {
        issueId: found,
        linearWorkspaceId: ws.linear_workspace_id,
        workspaceSlug: ws.workspace_slug,
      };
    }
  }
  return null;
}

/**
 * Issue the GraphQL query to Linear; return the issue UUID on hit, null
 * on miss. Never throws — caller iterates onto the next workspace.
 *
 * Uses `issueVcsBranchSearch` because it accepts the human-readable
 * identifier directly (the regular `issue(id:)` query needs a UUID,
 * which we don't have yet). The branch-search API was designed for
 * exactly this — VCS integrations resolving `<key>-<n>` strings to
 * issue rows.
 */
async function queryIssueByIdentifier(accessToken: string, identifier: string): Promise<string | null> {
  let resp: Response;
  try {
    resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: ISSUE_BY_IDENTIFIER_QUERY,
        variables: { identifier },
      }),
    });
  } catch (err) {
    logger.warn('Linear issue lookup: graphql request failed', {
      identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!resp.ok) {
    logger.warn('Linear issue lookup: graphql non-2xx', { identifier, status: resp.status });
    return null;
  }

  const body = (await resp.json()) as {
    data?: { issueVcsBranchSearch?: { id?: string; identifier?: string } | null };
    errors?: unknown;
  };
  if (body.errors) {
    logger.warn('Linear issue lookup: graphql errors', { identifier, errors: body.errors });
    return null;
  }
  const hit = body.data?.issueVcsBranchSearch;
  if (!hit?.id) return null;
  // Sanity: the response identifier must match what we asked for.
  // `issueVcsBranchSearch` is a fuzzy match against branch-name patterns;
  // exact-match the identifier to avoid linking to a near-neighbor issue.
  if (hit.identifier && hit.identifier.toUpperCase() !== identifier.toUpperCase()) {
    return null;
  }
  return hit.id;
}
