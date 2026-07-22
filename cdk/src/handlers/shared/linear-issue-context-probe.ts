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
 * paperclip attachments (linked resources) and project documents — surfaced
 * as a PRESENCE SIGNAL in the task description.
 *
 * ADR-016: the agent runs Linear deterministically and has no Linear MCP, so
 * it can't fetch these at runtime. This probe therefore just FLAGS that they
 * exist (titles + counts) so the agent knows the issue may reference material
 * it wasn't given, and can proceed with best judgment / note the gap rather
 * than assume the description is complete. It does NOT pre-fetch bodies, screen
 * content, or upload to S3 — description-embedded `uploads.linear.app` files are
 * pre-hydrated separately by `linear-attachments.ts`, and recent human comments
 * by `linear-feedback.fetchRecentComments`.
 *
 * The webhook payload itself does NOT carry attachments or project.documents,
 * so we ask Linear's GraphQL API once at task-creation time.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Cap on attachment titles listed inline in the task-description hint; any
 * beyond this are summarized as "(+N more)" so the prepended hint stays short.
 */
const MAX_HINTED_ATTACHMENT_TITLES = 5;

/** Cap on project documents whose CONTENT is pulled into the task context. */
const MAX_HYDRATED_PROJECT_DOCS = 5;

const ISSUE_CONTEXT_QUERY = `
query IssueContext($id: String!, $docs: Int!) {
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
    }
  }
}
`.trim();

/** A native paperclip attachment (title + url) from the `attachments` connection. */
export interface LinearProbeAttachment {
  readonly title: string;
  readonly url: string;
}

/** A project wiki document's title + markdown body (ADR-016 doc pre-hydration). */
export interface LinearProbeDocument {
  readonly title: string;
  readonly content: string;
}

export interface LinearIssueContextProbe {
  /** Paperclip attachment titles surfaced on the issue, if any (for the hint). */
  readonly attachmentTitles: readonly string[];
  /**
   * Native paperclip attachments with their URLs — the webhook processor
   * hydrates the `uploads.linear.app` ones through the attachment pipeline
   * (review finding #1). Distinct from description-embedded markdown links.
   */
  readonly attachments: readonly LinearProbeAttachment[];
  /** Project name (only present when the issue belongs to a project). */
  readonly projectName: string | null;
  /** True when the issue's project has at least one document attached. */
  readonly projectHasDocuments: boolean;
  /**
   * Project wiki documents WITH their content (ADR-016: pre-hydrated at
   * task-creation because the agent has no Linear MCP to fetch them). The
   * webhook processor screens these through the Bedrock Guardrail and folds them
   * into the task description. Capped at {@link MAX_HYDRATED_PROJECT_DOCS}.
   */
  readonly projectDocuments: readonly LinearProbeDocument[];
}

const EMPTY: LinearIssueContextProbe = {
  attachmentTitles: [],
  attachments: [],
  projectName: null,
  projectHasDocuments: false,
  projectDocuments: [],
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
        variables: { id: issueId, docs: MAX_HYDRATED_PROJECT_DOCS },
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
          attachments?: { nodes?: Array<{ id?: string; title?: string; url?: string }> };
          project?: {
            id?: string;
            name?: string;
            documents?: { nodes?: Array<{ id?: string; title?: string; content?: string }> };
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
    const attachmentNodes = issue.attachments?.nodes ?? [];
    const attachmentTitles = attachmentNodes
      .map((a) => (typeof a?.title === 'string' ? a.title.trim() : ''))
      .filter((t): t is string => t.length > 0);
    const attachments = attachmentNodes
      .filter((a): a is { title?: string; url: string } => typeof a?.url === 'string' && a.url.length > 0)
      .map((a) => ({ title: typeof a.title === 'string' ? a.title.trim() : '', url: a.url }));
    const project = issue.project ?? null;
    const projectName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null;
    const documentNodes = project?.documents?.nodes ?? [];
    const projectHasDocuments = documentNodes.length > 0;
    // Keep docs that actually have body text (an empty wiki page adds nothing but
    // noise + a guardrail round-trip). Title defaults to "Untitled document".
    const projectDocuments = documentNodes
      .filter((d): d is { title?: string; content: string } => typeof d?.content === 'string' && d.content.trim().length > 0)
      .map((d) => ({ title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : 'Untitled document', content: d.content }));
    return { attachmentTitles, attachments, projectName, projectHasDocuments, projectDocuments };
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
 * ADR-016: the agent has no Linear MCP, so this is a PRESENCE SIGNAL for the
 * material we could NOT hand it (a non-uploads paperclip like a Figma/GitHub
 * link; a project doc whose body was empty or beyond the hydration cap). Project
 * documents WITH content are pre-hydrated into the description separately
 * (see the processor's project-docs section), so they are NOT flagged here —
 * flagging included content would wrongly tell the agent to go find it. Names
 * what's missing WITHOUT pointing at any (now non-existent) fetch tool.
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
  // Only flag docs we did NOT hydrate content for (empty body, or over the cap).
  // Hydrated docs are in the description already, so don't tell the agent to go
  // hunt for them. (Default the array defensively — a hand-built probe object in
  // a test may omit it.)
  const hydratedDocCount = (probe.projectDocuments ?? []).length;
  const unhydratedDocs = probe.projectHasDocuments && hydratedDocCount === 0;
  if (unhydratedDocs && probe.projectName) {
    bits.push(`project "${probe.projectName}" has wiki documents`);
  } else if (unhydratedDocs) {
    bits.push('the project has wiki documents');
  }
  if (bits.length === 0) return '';
  return (
    `The Linear issue references additional context not included here: ${bits.join('; ')}. ` +
    'These live in Linear and are not attached to this task — work from the description and ' +
    'attachments you were given, and if one of these turns out to be essential, say so in the PR rather than guessing.'
  );
}
