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

import { isLinearUploadsUrl } from './linear-attachments';
import { logger } from './logger';

/**
 * The webhook payload itself does NOT carry attachments or project.documents,
 * so we ask Linear's GraphQL API once at task-creation time.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 5000;

const MAX_HINTED_ATTACHMENT_TITLES = 5;

const MAX_HYDRATED_PROJECT_DOCS = 5;

const MAX_COUNTED_PROJECT_DOCS = 50;

const ISSUE_CONTEXT_QUERY = `
query IssueContext($id: String!, $docs: Int!, $docCount: Int!) {
  issue(id: $id) {
    id
    attachments(first: 25) {
      nodes {
        id
        title
        url
      }
    }
    project {
      id
      name
      documents(first: $docs) {
        nodes { id title content }
      }
      documentsForCount: documents(first: $docCount) {
        nodes { id }
      }
    }
  }
}
`.trim();

/** A native paperclip attachment (title + url) from the `attachments` connection. */
export interface LinearProbeAttachment {
  readonly title: string;
  readonly url: string;
}

/** A project wiki document's title + markdown body. */
export interface LinearProbeDocument {
  readonly title: string;
  readonly content: string;
}

export interface LinearIssueContextProbe {
  /**
   * Titles of the paperclip attachments the task does NOT carry (external links
   * such as Figma or GitHub), for the hint. The `uploads.linear.app` ones are
   * not listed.
   */
  readonly attachmentTitles: readonly string[];
  /** Native paperclip attachments with their URLs. Distinct from description-embedded markdown links. */
  readonly attachments: readonly LinearProbeAttachment[];
  /** Project name (only present when the issue belongs to a project). */
  readonly projectName: string | null;
  readonly projectHasDocuments: boolean;
  /** Project wiki documents WITH their content. Capped at {@link MAX_HYDRATED_PROJECT_DOCS}. */
  readonly projectDocuments: readonly LinearProbeDocument[];
  /**
   * Whether the probe actually reached Linear and parsed a result. `false` on a
   * non-2xx / GraphQL error / network failure / timeout — in which case the
   * empty arrays mean "we don't KNOW", not "there is nothing".
   */
  readonly ok: boolean;
  /**
   * Total project documents Linear reported (incl. empty-body / over-cap ones NOT
   * in `projectDocuments`).
   */
  readonly projectDocumentCount: number;
}

const EMPTY: LinearIssueContextProbe = {
  attachmentTitles: [],
  attachments: [],
  projectName: null,
  projectHasDocuments: false,
  projectDocuments: [],
  ok: true,
  projectDocumentCount: 0,
};

const PROBE_FAILED: LinearIssueContextProbe = { ...EMPTY, ok: false };

/**
 * Issue the GraphQL query. Never throws. On failure (network, auth, GraphQL
 * errors, timeout) returns a probe with `ok:false` + empty arrays; on a genuine
 * empty result (2xx, issue has no attachments/docs) returns `ok:true`.
 */
export async function probeLinearIssueContext(
  accessToken: string,
  issueId: string,
): Promise<LinearIssueContextProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: ISSUE_CONTEXT_QUERY,
        variables: { id: issueId, docs: MAX_HYDRATED_PROJECT_DOCS, docCount: MAX_COUNTED_PROJECT_DOCS },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('Linear issue context probe non-2xx', { status: resp.status, issue_id: issueId });
      return PROBE_FAILED;
    }
    const body = (await resp.json()) as {
      data?: {
        issue?: {
          attachments?: { nodes?: Array<{ id?: string; title?: string; url?: string }> };
          project?: {
            id?: string;
            name?: string;
            documents?: { nodes?: Array<{ id?: string; title?: string; content?: string }> };
            documentsForCount?: { nodes?: Array<{ id?: string }> };
          } | null;
        };
      };
      errors?: unknown;
    };
    if (body.errors) {
      logger.warn('Linear issue context probe graphql errors', { issue_id: issueId, errors: body.errors });
      return PROBE_FAILED;
    }
    const issue = body.data?.issue;
    if (!issue) return EMPTY;
    const attachmentNodes = issue.attachments?.nodes ?? [];
    const attachmentTitles = attachmentNodes
      .filter((a) => !isLinearUploadsUrl(a?.url ?? ''))
      .map((a) => (typeof a?.title === 'string' ? a.title.trim() : ''))
      .filter((t): t is string => t.length > 0);
    const attachments = attachmentNodes
      .filter((a): a is { title?: string; url: string } => typeof a?.url === 'string' && a.url.length > 0)
      .map((a) => ({ title: typeof a.title === 'string' ? a.title.trim() : '', url: a.url }));
    const project = issue.project ?? null;
    const projectName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null;
    const documentNodes = project?.documents?.nodes ?? [];
    const projectHasDocuments = documentNodes.length > 0;
    const projectDocuments = documentNodes
      .filter((d): d is { title?: string; content: string } => typeof d?.content === 'string' && d.content.trim().length > 0)
      .map((d) => ({ title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : 'Untitled document', content: d.content }));
    const countNodes = project?.documentsForCount?.nodes;
    const projectDocumentCount = Array.isArray(countNodes) ? countNodes.length : documentNodes.length;
    return {
      attachmentTitles,
      attachments,
      projectName,
      projectHasDocuments: projectHasDocuments || projectDocumentCount > 0,
      projectDocuments,
      ok: true,
      projectDocumentCount,
    };
  } catch (err) {
    logger.warn('Linear issue context probe request failed', {
      issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return PROBE_FAILED;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render a one-paragraph hint the webhook processor prepends to the task
 * description when the probe surfaced anything worth flagging. Returns
 * an empty string when there's nothing to hint about. Names only the material
 * the task does NOT carry; project documents hydrated with content are not flagged.
 */
export function renderIssueContextHint(probe: LinearIssueContextProbe): string {
  const bits: string[] = [];
  if (probe.attachmentTitles.length > 0) {
    const titles = probe.attachmentTitles
      .slice(0, MAX_HINTED_ATTACHMENT_TITLES).map((t) => `"${t}"`).join(', ');
    const more = probe.attachmentTitles.length > MAX_HINTED_ATTACHMENT_TITLES
      ? ` (+${probe.attachmentTitles.length - MAX_HINTED_ATTACHMENT_TITLES} more)` : '';
    bits.push(`paperclip attachments — ${titles}${more}`);
  }
  const hydratedDocCount = (probe.projectDocuments ?? []).length;
  const totalDocCount = typeof probe.projectDocumentCount === 'number'
    ? probe.projectDocumentCount
    : (hydratedDocCount > 0 ? hydratedDocCount : (probe.projectHasDocuments ? 1 : 0));
  const unhydratedDocCount = Math.max(0, totalDocCount - hydratedDocCount);
  if (unhydratedDocCount > 0) {
    const noun = unhydratedDocCount === 1 ? 'wiki document' : `${unhydratedDocCount} wiki documents`;
    const qualifier = hydratedDocCount > 0 ? ' (empty or beyond the included set)' : '';
    if (probe.projectName) {
      bits.push(`project "${probe.projectName}" has ${noun}${qualifier} not included here`);
    } else {
      bits.push(`the project has ${noun}${qualifier} not included here`);
    }
  }
  if (bits.length === 0) return '';
  return (
    `The Linear issue references additional context not included here: ${bits.join('; ')}. ` +
    'These live in Linear and are not attached to this task — work from the description and ' +
    'attachments you were given, and if one of these turns out to be essential, say so in the PR rather than guessing.'
  );
}
