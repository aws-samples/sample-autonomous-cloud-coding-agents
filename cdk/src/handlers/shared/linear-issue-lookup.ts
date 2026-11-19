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

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { resolveLinearOauthToken } from './linear-oauth-resolver';
import { logger } from './logger';
import { type LookupResult, LOOKUP_ABSENT, isLookupFailure, lookupFailed, lookupFound } from './lookup-result';
import { makeDocClient } from './ua';

const ddb = makeDocClient();

/**
 * Time limit of one identifier query. Without one a Linear that accepts the
 * request and does not answer holds the caller until its own Lambda timeout.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Linear issue identifier shape, e.g. `ENG-42`. Linear identifiers are
 * `<TEAM_KEY>-<NUMBER>` where the key is uppercase letters and digits is
 * a positive integer. We bound the team key length [1,10] and number
 * length [1,8] to avoid pathological inputs.
 */
const LINEAR_IDENTIFIER_RE = /\b([A-Z][A-Z0-9]{0,9})-(\d{1,8})\b/g;

/**
 * Pull the first Linear issue identifier (e.g. `ENG-42`) found in
 * the given text. PR titles and bodies typically include this either
 * because the agent's task_description carries the identifier, or
 * because Linear's own GitHub integration auto-injects an
 * `ENG-42 <linear-url>` reference.
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
 * Pull the Linear identifier out of an ABCA-generated git branch name.
 *
 * This is the first identifier source the screenshot router tries for
 * a pull request that has no Linear task record, before PR title/body.
 * ABCA derives a task branch as `bgagent/{taskId}/{slug}` from the task
 * description; for a task started from an issue that is
 * `slugify("ENG-151: <title>")`, so the identifier leads the slug
 * (see `generateBranchName` / `slugify` in `gateway.ts`, and the
 * `${identifier}: ${title}` description built in
 * `linear-webhook-processor.ts` / `orchestration-release.ts`).
 *
 * The result is a candidate, not a fact. The branch is upper-cased as a
 * whole, so any word followed by a number matches (`upgrade-node-22`
 * gives `NODE-22`), and a task started from a comment has no identifier
 * in its branch at all. The router looks the candidate up and goes on to
 * title and body when no workspace has such an issue.
 *
 * Why branch-first matters: in a stacked sub-issue
 * orchestration, an agent's PR *body* commonly narrates the predecessor
 * issue ("cherry-picked from ENG-151 … Closes ENG-152") before the
 * issue the PR actually closes. `extractLinearIdentifier` returns the
 * first match in document order, so body-first routing misattributes the
 * screenshot to the predecessor. The branch name has no such ambiguity —
 * it encodes exactly one issue, the PR's own.
 *
 * The slug is lowercased by `slugify`, so we upper-case before matching
 * (the identifier regex anchors on `[A-Z]`). The ULID `taskId` segment
 * contains no `-`, so it can never produce a false `<KEY>-<n>` match
 * ahead of the real identifier.
 */
export function extractLinearIdentifierFromBranch(branchName: string | null | undefined): string | null {
  if (!branchName) return null;
  return extractLinearIdentifier(branchName.toUpperCase());
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
 * Look up a Linear issue by identifier (e.g. `ENG-42`).
 *
 * Routing strategy:
 * 1. Scan active workspaces (one round-trip — typical stacks have 1–2).
 * 2. Query the workspaces whose `team_keys` contain the identifier's team
 *    key (`ENG`) and return the one that has the issue.
 * 3. Otherwise fall back to the remaining active workspaces. This handles
 *    rows written before `team_keys` existed (it back-fills only on the next
 *    `setup` / `add-workspace` re-run) and the rare case where a team was
 *    added in Linear after the workspace was registered.
 *
 * In either step, two workspaces that both have the issue give no location: the
 * identifier does not say which one is meant.
 *
 * @param identifier `ENG-42`-style Linear issue identifier
 * @param registryTableName name of LinearWorkspaceRegistryTable
 * @returns the issue's location; absent when every active workspace answered and
 *   none has the issue; a failure when that cannot be said, because the registry
 *   or a workspace could not be asked, or because two workspaces have the issue
 */
export async function findLinearIssueByIdentifier(
  identifier: string,
  registryTableName: string,
): Promise<LookupResult<LinearIssueLocation>> {
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
    return lookupFailed(err);
  }

  if (active.length === 0) {
    logger.info('Linear issue lookup: no active workspaces in registry', { identifier });
    return LOOKUP_ABSENT;
  }

  // Identifier prefix is the part before the first dash (`ENG-42` → `ENG`).
  // Compare uppercase since Linear team keys are upper-case but inbound text
  // (PR titles, branch names) is mixed-case.
  const teamKey = identifier.split('-', 1)[0]?.toUpperCase();
  const listsTeam = (ws: (typeof active)[number]): boolean =>
    ws.team_keys?.some((k) => k.toUpperCase() === teamKey) ?? false;

  // Set when a workspace gave no answer: "no workspace has it" is then not known.
  let unanswered = false;

  // The workspaces that list the team first; the others (legacy rows without
  // `team_keys`, post-registration team adds) only when none of those has the
  // issue. Every workspace of a group is asked, because an identifier is unique
  // inside one workspace only: when two of them have it, nothing says which one
  // the caller means, and the first to answer may be another tenant's issue.
  for (const group of [active.filter(listsTeam), active.filter((ws) => !listsTeam(ws))]) {
    let hit: LinearIssueLocation | undefined;
    for (const ws of group) {
      const resolved = await resolveLinearOauthToken(ws.linear_workspace_id, registryTableName);
      if (!resolved) {
        unanswered = true;
        continue;
      }

      const found = await queryIssueByIdentifier(resolved.accessToken, identifier);
      if (!found.ok) {
        if (isLookupFailure(found)) unanswered = true;
        continue;
      }
      if (hit) {
        logger.warn('Linear issue lookup: identifier exists in more than one workspace — not guessing', {
          identifier,
          workspace_slugs: [hit.workspaceSlug, ws.workspace_slug],
        });
        return lookupFailed(new Error('The identifier exists in more than one workspace'));
      }
      hit = {
        issueId: found.value,
        linearWorkspaceId: ws.linear_workspace_id,
        workspaceSlug: ws.workspace_slug,
      };
    }
    if (hit) return lookupFound(hit);
  }
  return unanswered ? lookupFailed(new Error('Not every workspace could be asked')) : LOOKUP_ABSENT;
}

/**
 * Issue the GraphQL query to Linear; return the issue UUID on hit, absent
 * when Linear answers that no issue matches (it documents `null` for that),
 * and a failure when it gave no usable answer. Never throws and gives up
 * after {@link REQUEST_TIMEOUT_MS} — caller iterates onto the next workspace.
 *
 * Uses `issueVcsBranchSearch` because it accepts the human-readable
 * identifier directly (the regular `issue(id:)` query needs a UUID,
 * which we don't have yet). The branch-search API was designed for
 * exactly this — VCS integrations resolving `<key>-<n>` strings to
 * issue rows.
 */
async function queryIssueByIdentifier(accessToken: string, identifier: string): Promise<LookupResult<string>> {
  let body: {
    data?: { issueVcsBranchSearch?: { id?: string; identifier?: string } | null };
    errors?: unknown;
  };
  try {
    const resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: ISSUE_BY_IDENTIFIER_QUERY,
        variables: { identifier },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn('Linear issue lookup: graphql non-2xx', { identifier, status: resp.status });
      return lookupFailed(new Error(`Linear answered HTTP ${resp.status}`));
    }
    // Inside the try: a body that is not JSON rejects here.
    body = (await resp.json()) as typeof body;
  } catch (err) {
    logger.warn('Linear issue lookup: graphql request failed', {
      identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return lookupFailed(err);
  }

  if (body.errors) {
    logger.warn('Linear issue lookup: graphql errors', { identifier, errors: body.errors });
    return lookupFailed(body.errors);
  }
  const hit = body.data?.issueVcsBranchSearch;
  if (!hit?.id) return LOOKUP_ABSENT;
  // Sanity: the response identifier must match what we asked for.
  // `issueVcsBranchSearch` is a fuzzy match against branch-name patterns;
  // exact-match the identifier to avoid linking to a near-neighbor issue.
  if (hit.identifier && hit.identifier.toUpperCase() !== identifier.toUpperCase()) {
    return LOOKUP_ABSENT;
  }
  return lookupFound(hit.id);
}
