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

import { logger } from './logger';

/**
 * Best-effort probe for additional Linear context attached to an issue —
 * paperclip attachments and project documents — that the agent should
 * fetch on demand via the Linear MCP at runtime.
 *
 * The webhook payload itself does NOT carry attachments or
 * project.documents, so we ask Linear's GraphQL API once at task-creation
 * time. The result is a tiny presence signal (titles + counts) that lets
 * the webhook processor prepend a hint to the task description; it does
 * NOT pre-fetch bodies, screen content, or upload to S3 — that path is
 * still owned by `extractImageUrlAttachments` for description-embedded
 * markdown images.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 5000;

const ISSUE_CONTEXT_QUERY = `
query IssueContext($id: String!) {
  issue(id: $id) {
    id
    attachments(first: 25) {
      nodes {
        id
        title
      }
    }
    project {
      id
      name
      documents(first: 1) {
        nodes { id }
      }
    }
  }
}
`.trim();

export interface LinearIssueContextProbe {
  /** Paperclip attachment titles surfaced on the issue, if any. */
  readonly attachmentTitles: readonly string[];
  /** Project name (only present when the issue belongs to a project). */
  readonly projectName: string | null;
  /** True when the issue's project has at least one document attached. */
  readonly projectHasDocuments: boolean;
}

const EMPTY: LinearIssueContextProbe = {
  attachmentTitles: [],
  projectName: null,
  projectHasDocuments: false,
};

/**
 * Issue the GraphQL query. Returns an empty probe on any failure
 * (network, auth, GraphQL errors). Never throws — the caller treats
 * absence of context the same as no extra context being available.
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
        variables: { id: issueId },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('Linear issue context probe non-2xx', { status: resp.status, issue_id: issueId });
      return EMPTY;
    }
    const body = (await resp.json()) as {
      data?: {
        issue?: {
          attachments?: { nodes?: Array<{ id?: string; title?: string }> };
          project?: {
            id?: string;
            name?: string;
            documents?: { nodes?: Array<{ id?: string }> };
          } | null;
        };
      };
      errors?: unknown;
    };
    if (body.errors) {
      logger.warn('Linear issue context probe graphql errors', { issue_id: issueId, errors: body.errors });
      return EMPTY;
    }
    const issue = body.data?.issue;
    if (!issue) return EMPTY;
    const attachmentTitles = (issue.attachments?.nodes ?? [])
      .map((a) => (typeof a?.title === 'string' ? a.title.trim() : ''))
      .filter((t): t is string => t.length > 0);
    const project = issue.project ?? null;
    const projectName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null;
    const projectHasDocuments = (project?.documents?.nodes ?? []).length > 0;
    return { attachmentTitles, projectName, projectHasDocuments };
  } catch (err) {
    logger.warn('Linear issue context probe request failed', {
      issue_id: issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render a one-paragraph hint the webhook processor prepends to the task
 * description when the probe surfaced anything worth flagging. Returns
 * an empty string when there's nothing to hint about — the processor
 * skips the prepend in that case.
 *
 * The wording deliberately points at MCP tool names so the agent's
 * channel-prompt addendum reinforces (and is reinforced by) the same
 * vocabulary.
 */
export function renderIssueContextHint(probe: LinearIssueContextProbe): string {
  const bits: string[] = [];
  if (probe.attachmentTitles.length > 0) {
    const titles = probe.attachmentTitles.slice(0, 5).map((t) => `"${t}"`).join(', ');
    const more = probe.attachmentTitles.length > 5 ? ` (+${probe.attachmentTitles.length - 5} more)` : '';
    bits.push(`paperclip attachments — ${titles}${more} (fetch via \`mcp__linear-server__get_issue\` then \`mcp__linear-server__get_attachment\`)`);
  }
  if (probe.projectHasDocuments && probe.projectName) {
    bits.push(`project "${probe.projectName}" has wiki documents (browse with \`mcp__linear-server__list_documents\` if the task is ambiguous)`);
  } else if (probe.projectHasDocuments) {
    bits.push('the project has wiki documents (browse with `mcp__linear-server__list_documents` if the task is ambiguous)');
  }
  if (bits.length === 0) return '';
  return `Linear may have additional context for this issue: ${bits.join('; ')}.`;
}
