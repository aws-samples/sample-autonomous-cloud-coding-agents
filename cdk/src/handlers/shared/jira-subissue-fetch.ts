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

import { extractDescriptionMarkdown } from './jira-adf';
import type { SubIssueNode } from './linear-subissue-fetch';
import { logger } from './logger';

const JIRA_API_BASE = 'https://api.atlassian.com/ex/jira';
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

interface JiraLinkedIssue {
  readonly key?: string;
}

interface JiraIssueLink {
  readonly type?: {
    readonly inward?: string;
    readonly outward?: string;
  };
  readonly inwardIssue?: JiraLinkedIssue;
  readonly outwardIssue?: JiraLinkedIssue;
}

interface JiraSearchIssue {
  readonly id?: string;
  readonly key?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly description?: unknown;
    readonly project?: { readonly key?: string };
    readonly issuelinks?: readonly JiraIssueLink[];
  };
}

interface JiraSearchPage {
  readonly issues?: readonly JiraSearchIssue[];
  readonly nextPageToken?: string;
  readonly isLast?: boolean;
}

export interface JiraSubIssueNode extends SubIssueNode {
  readonly issue_id: string;
  readonly project_key: string;
}

export type FetchJiraSubIssueGraphResult =
  | { readonly kind: 'ok'; readonly children: readonly JiraSubIssueNode[] }
  | { readonly kind: 'no_children' }
  | { readonly kind: 'error'; readonly message: string };

export interface FetchJiraSubIssueGraphOptions {
  readonly fetchImpl?: typeof fetch;
}

function isBlocks(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'blocks';
}

function isBlockedBy(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'is blocked by';
}

function pageUrl(cloudId: string, parentIssueKey: string, nextPageToken?: string): string {
  const query = new URLSearchParams({
    jql: `parent = "${parentIssueKey.replaceAll('"', '\\"')}"`,
    fields: 'id,key,summary,description,project,issuelinks',
    maxResults: String(PAGE_SIZE),
  });
  if (nextPageToken) query.set('nextPageToken', nextPageToken);
  return `${JIRA_API_BASE}/${encodeURIComponent(cloudId)}/rest/api/3/search/jql?${query.toString()}`;
}

async function fetchPage(
  accessToken: string,
  cloudId: string,
  parentIssueKey: string,
  nextPageToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ readonly ok: true; readonly page: JiraSearchPage } | { readonly ok: false; readonly message: string }> {
  const url = pageUrl(cloudId, parentIssueKey, nextPageToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('Jira subtask search returned non-2xx', {
        jira_cloud_id: cloudId,
        parent_issue_key: parentIssueKey,
        status: response.status,
      });
      return {
        ok: false,
        message: `Jira returned status ${response.status} while reading authored subtasks.`,
      };
    }
    return { ok: true, page: await response.json() as JiraSearchPage };
  } catch (error) {
    logger.warn('Jira subtask search failed', {
      jira_cloud_id: cloudId,
      parent_issue_key: parentIssueKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: 'Jira subtasks could not be read. Check the Jira connection and re-apply the trigger label.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a Jira parent's authored subtasks and standard blocker links.
 *
 * Standard blocker links must remain inside the authored child set; an external
 * blocker would make the persisted graph permanently unreleasable, so it is
 * rejected before any rows are written.
 */
export async function fetchJiraSubIssueGraph(
  accessToken: string,
  cloudId: string,
  parentIssueKey: string,
  options: FetchJiraSubIssueGraphOptions = {},
): Promise<FetchJiraSubIssueGraphResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const issues: JiraSearchIssue[] = [];
  let nextPageToken: string | undefined;
  const seenTokens = new Set<string>();

  do {
    const result = await fetchPage(accessToken, cloudId, parentIssueKey, nextPageToken, fetchImpl);
    if (!result.ok) return { kind: 'error', message: result.message };
    issues.push(...(result.page.issues ?? []));
    const next = result.page.nextPageToken;
    if (!next || result.page.isLast === true) break;
    if (seenTokens.has(next)) {
      return { kind: 'error', message: 'Jira returned a repeated pagination token while reading subtasks.' };
    }
    seenTokens.add(next);
    nextPageToken = next;
  } while (nextPageToken);

  if (issues.length === 0) return { kind: 'no_children' };

  const malformed = issues.find((issue) =>
    !issue.id || !issue.key || !issue.fields?.project?.key || typeof issue.fields.summary !== 'string');
  if (malformed) {
    return {
      kind: 'error',
      message: 'A Jira subtask is missing its key, project, or summary, so no orchestration was created.',
    };
  }

  const childKeys = new Set(issues.map((issue) => issue.key as string));
  const dependencies = new Map<string, Set<string>>(
    [...childKeys].map((key) => [key, new Set<string>()]),
  );

  for (const issue of issues) {
    const currentKey = issue.key as string;
    for (const link of issue.fields?.issuelinks ?? []) {
      if (isBlockedBy(link.type?.inward) && link.inwardIssue?.key) {
        const predecessor = link.inwardIssue.key;
        if (!childKeys.has(predecessor)) {
          return {
            kind: 'error',
            message: `${currentKey} is blocked by ${predecessor}, which is not an executable subtask of ${parentIssueKey}.`,
          };
        }
        dependencies.get(currentKey)!.add(predecessor);
      }
      if (isBlocks(link.type?.outward) && link.outwardIssue?.key) {
        const dependent = link.outwardIssue.key;
        if (!childKeys.has(dependent)) {
          return {
            kind: 'error',
            message: `${currentKey} blocks ${dependent}, which is not an executable subtask of ${parentIssueKey}.`,
          };
        }
        dependencies.get(dependent)!.add(currentKey);
      }
    }
  }

  return {
    kind: 'ok',
    children: issues.map((issue) => {
      const key = issue.key as string;
      return {
        id: key,
        identifier: key,
        issue_id: issue.id as string,
        title: issue.fields!.summary!,
        description: extractDescriptionMarkdown(issue.fields?.description),
        project_key: issue.fields!.project!.key as string,
        depends_on: [...dependencies.get(key)!].sort(),
      };
    }),
  };
}
