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
 * Wire shapes, parsing and the feature gate for Linear ``AgentSessionEvent``
 * webhooks (ADR-018 Phase 2). Deliberately free of I/O dependencies so the
 * webhook receiver can route on it without loading the GraphQL / token stack;
 * the activity-emitting helpers live in ``linear-agent-session.ts``.
 */

import { parseCommentTrigger } from './orchestration-comment-trigger';

/**
 * Runtime gate (ADR-006). Set to ``'true'`` on the webhook receiver, processor,
 * and fan-out consumer only when the stack is synthesized with
 * ``--context enableLinearAgentSessions=true``. Must be flipped together with
 * the Linear app's "Agent session events" webhook category — see ADR-018.
 */
export function isLinearAgentSessionsEnabled(): boolean {
  return process.env.LINEAR_AGENT_SESSIONS_ENABLED === 'true';
}

/** Webhook ``type`` for agent-session deliveries. */
export const AGENT_SESSION_EVENT_TYPE = 'AgentSessionEvent';

/** Actions ABCA acts on. Linear may add more; unknown actions are acked and ignored. */
export const AGENT_SESSION_ACTIONS = ['created', 'prompted'] as const;
export type AgentSessionAction = typeof AGENT_SESSION_ACTIONS[number];

export function isHandledAgentSessionAction(action: string | undefined): action is AgentSessionAction {
  return (AGENT_SESSION_ACTIONS as readonly string[]).includes(action ?? '');
}

/**
 * The subset of Linear's ``AgentSessionEventWebhookPayload`` ABCA reads. Every
 * field is optional: the Agents API is a Developer Preview and the parser must
 * degrade to "ignore" rather than crash on a shape change.
 */
export interface LinearAgentSessionEvent {
  readonly type?: string;
  readonly action?: string;
  readonly organizationId?: string;
  readonly appUserId?: string;
  readonly webhookTimestamp?: number;
  readonly agentSession?: {
    readonly id?: string;
    readonly issueId?: string;
    readonly issue?: { readonly id?: string; readonly identifier?: string; readonly title?: string };
    readonly commentId?: string;
    readonly comment?: { readonly id?: string; readonly body?: string };
    readonly creatorId?: string;
    readonly creator?: { readonly id?: string };
  };
  readonly agentActivity?: {
    readonly id?: string;
    readonly userId?: string;
    readonly user?: { readonly id?: string };
    readonly signal?: string;
    readonly body?: string;
    readonly content?: { readonly type?: string; readonly body?: string };
  };
  /** Linear-formatted issue + thread + guidance context (``created`` only). */
  readonly promptContext?: string;
}

/** The fields of an agent-session delivery the processor routes on, normalised. */
export interface AgentSessionRequest {
  readonly action: AgentSessionAction;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly issueId: string;
  /** Linear user who opened the session (``created``) or sent the prompt (``prompted``). */
  readonly actorId: string | null;
  /** Human instruction: the mention comment (``created``) or the prompt body (``prompted``). Trimmed; may be empty. */
  readonly directive: string;
  /** ``true`` when the prompt carries Linear's ``stop`` signal. */
  readonly stopRequested: boolean;
  /** Stable per-delivery id for idempotency: the prompt activity id, else the session id. */
  readonly deliveryId: string;
  readonly promptContext: string | null;
}

/**
 * Normalise an ``AgentSessionEvent`` payload. Returns ``null`` when a field
 * required to act (session id, workspace, issue, a handled action) is missing.
 */
export function parseAgentSessionEvent(payload: LinearAgentSessionEvent): AgentSessionRequest | null {
  if (payload.type !== AGENT_SESSION_EVENT_TYPE || !isHandledAgentSessionAction(payload.action)) return null;
  const session = payload.agentSession;
  const sessionId = session?.id;
  const workspaceId = payload.organizationId;
  const issueId = session?.issueId ?? session?.issue?.id;
  if (!sessionId || !workspaceId || !issueId) return null;

  if (payload.action === 'created') {
    return {
      action: 'created',
      sessionId,
      workspaceId,
      issueId,
      actorId: session?.creatorId ?? session?.creator?.id ?? null,
      directive: mentionDirective(session?.comment?.body),
      stopRequested: false,
      deliveryId: sessionId,
      promptContext: typeof payload.promptContext === 'string' && payload.promptContext.trim()
        ? payload.promptContext
        : null,
    };
  }

  const activity = payload.agentActivity;
  return {
    action: 'prompted',
    sessionId,
    workspaceId,
    issueId,
    actorId: activity?.userId ?? activity?.user?.id ?? null,
    directive: (activity?.content?.body ?? activity?.body ?? '').trim(),
    stopRequested: activity?.signal === 'stop',
    deliveryId: activity?.id ?? `${sessionId}-${payload.webhookTimestamp ?? ''}`,
    promptContext: null,
  };
}

/**
 * ``task_cancelled`` event metadata value (``cancelled_via``) for a cancel that
 * came from a session ``stop`` signal. The processor posts the stop
 * confirmation itself, so the fan-out dispatcher skips its own.
 */
export const SESSION_STOP_CANCELLED_VIA = 'linear_session_stop';

/**
 * The instruction in a mention comment, with the ``@bgagent`` handle removed —
 * a bare mention is no instruction at all. Uses the comment trigger's parser so
 * both channels read a mention the same way; a body that never names the
 * handle textually (Linear rendered the mention as a link) is kept as-is.
 */
function mentionDirective(body: string | undefined): string {
  const trimmed = (body ?? '').trim();
  const trigger = parseCommentTrigger(trimmed);
  return trigger.triggered ? trigger.instruction : trimmed;
}
