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
 * Timing contract (Linear docs): the webhook receiver acks within 5s; the
 * first activity must land within 10s of ``created`` or the session is marked
 * unresponsive; a session with no activity for 30 minutes goes ``stale`` (any
 * new activity recovers it).
 *
 * Helpers here never throw.
 */

import type { AgentSessionRequest } from './linear-agent-session-event';
import { graphqlData, graphqlRequest, type LinearPostResult } from './linear-feedback';
import { isLookupFailure, LOOKUP_ABSENT, lookupFound, type LookupResult } from './lookup-result';
import { MAX_IDEMPOTENCY_KEY_LENGTH, MAX_TASK_DESCRIPTION_LENGTH } from './validation';

/** Activity content ABCA emits. ``prompt`` is human-only and deliberately absent. */
export type AgentActivityContent =
  | { readonly type: 'thought'; readonly body: string }
  | { readonly type: 'action'; readonly action: string; readonly parameter: string; readonly result?: string }
  | { readonly type: 'elicitation'; readonly body: string }
  | { readonly type: 'response'; readonly body: string }
  | { readonly type: 'error'; readonly body: string };

const AGENT_ACTIVITY_CREATE_MUTATION = `
mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success }
}`;

const AGENT_SESSION_UPDATE_MUTATION = `
mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;

const SESSION_ISSUE_QUERY = `
query AgentSessionIssue($id: String!) {
  issue(id: $id) { id identifier title description project { id } }
}`;

/**
 * Emit one activity into a session. ``ephemeral`` (only valid for
 * ``thought``/``action``) shows it until the next activity replaces it.
 */
export async function emitAgentActivity(
  accessToken: string,
  agentSessionId: string,
  content: AgentActivityContent,
  options: { readonly ephemeral?: boolean } = {},
): Promise<LinearPostResult> {
  const ephemeral = options.ephemeral === true && (content.type === 'thought' || content.type === 'action');
  return graphqlRequest(accessToken, AGENT_ACTIVITY_CREATE_MUTATION, {
    input: { agentSessionId, content, ...(ephemeral && { ephemeral: true }) },
  });
}

/**
 * Attach a link (e.g. the pull request) to the session header. Uses
 * ``addedExternalUrls`` so earlier links are kept rather than replaced.
 */
export async function addAgentSessionExternalUrl(
  accessToken: string,
  agentSessionId: string,
  link: { readonly label: string; readonly url: string },
): Promise<LinearPostResult> {
  return graphqlRequest(accessToken, AGENT_SESSION_UPDATE_MUTATION, {
    id: agentSessionId,
    input: { addedExternalUrls: [{ label: link.label, url: link.url }] },
  });
}

export interface AgentSessionIssue {
  readonly id: string;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly projectId: string | null;
}

/**
 * Fetch the session's issue. The webhook's embedded issue does not reliably
 * carry the project.
 */
export async function fetchAgentSessionIssue(
  accessToken: string,
  issueId: string,
): Promise<LookupResult<AgentSessionIssue>> {
  const result = await graphqlData(accessToken, SESSION_ISSUE_QUERY, { id: issueId });
  if (isLookupFailure(result)) return result;
  if (!result.ok) return LOOKUP_ABSENT;
  const issue = result.value.issue as {
    id?: string; identifier?: string; title?: string; description?: string; project?: { id?: string } | null;
  } | null | undefined;
  if (!issue?.id) return LOOKUP_ABSENT;
  return lookupFound({
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
    description: issue.description ?? null,
    projectId: issue.project?.id ?? null,
  });
}

const SESSION_CONTEXT_PREFIX = '\n\n## Linear session context\n\n';
const CONTEXT_TRUNCATION_NOTICE = '\n\n_(session context truncated)_';

/**
 * Build the task description for a session-triggered task. Leads with the
 * human's directive (if any), then the issue heading, then ``promptContext``
 * when present, else the fetched issue description.
 *
 * Linear's ``promptContext`` already carries the issue (identifier, title,
 * description) with the thread and team guidance; ``prompted`` deliveries lack it.
 *
 * Never exceeds ``MAX_TASK_DESCRIPTION_LENGTH``.
 */
export function buildAgentSessionTaskDescription(
  issue: AgentSessionIssue,
  directive: string,
  promptContext: string | null,
): string {
  const parts: string[] = [];
  if (directive) parts.push(directive, '');
  const heading = issue.identifier && issue.title
    ? `${issue.identifier}: ${issue.title}`
    : issue.title ?? issue.identifier ?? 'Linear issue';
  parts.push(heading);
  const context = promptContext?.trim();
  if (!context && issue.description?.trim()) parts.push('', issue.description.trim());
  let out = parts.join('\n');
  if (out.length > MAX_TASK_DESCRIPTION_LENGTH) {
    return out.slice(0, MAX_TASK_DESCRIPTION_LENGTH);
  }
  if (context) {
    const section = `${SESSION_CONTEXT_PREFIX}${context}`;
    const budget = MAX_TASK_DESCRIPTION_LENGTH - out.length;
    if (section.length <= budget) {
      out += section;
    } else if (budget > CONTEXT_TRUNCATION_NOTICE.length + SESSION_CONTEXT_PREFIX.length) {
      out += section.slice(0, budget - CONTEXT_TRUNCATION_NOTICE.length) + CONTEXT_TRUNCATION_NOTICE;
    }
  }
  return out;
}

/**
 * Idempotency key for a session-triggered task: one task per delivery
 * (``created`` → session id, ``prompted`` → prompt activity id). Sanitised to
 * createTaskCore's key alphabet and length.
 */
export function agentSessionIdempotencyKey(request: AgentSessionRequest): string {
  return `linear-session-${request.action}-${request.deliveryId}`
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}
