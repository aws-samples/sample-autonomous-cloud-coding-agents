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
 * Cedar approval requests answered inside a Linear agent session (#1066).
 *
 * The fan-out posts a pending request as an ``elicitation`` with Approve / Deny
 * buttons (``signal: select``) and a reply-by line, using the same notice text as
 * the comment channel (``approval-notifications.ts``, so the same redaction and
 * escaping). A reply in the session decides the task's open request through the
 * API's decision path (``recordApprovalForUser`` / ``recordDenialForUser``): only
 * the task's owner can decide, and a request that already timed out or was
 * answered is left alone. The open request is the task record's
 * ``awaiting_approval_request_id``, so a session needs no pointer rows.
 */

import { approvalNotificationMarkdown, type ApprovalNotification } from './approval-notifications';
import type { AgentActivityContent } from './linear-agent-session';
import { parseLinearApprovalReply, type LinearApprovalReply } from './linear-approval-thread';
import { progressActivityId } from './linear-session-progress';

/**
 * An answer from the session: approve once, or deny. ``requestId`` is set when the
 * answer came from a button, which names the request it was shown with.
 */
export type SessionApprovalAnswer = LinearApprovalReply & { readonly requestId?: string };

/** A button value names its request: ``approve request <id>``. Request ids are ULIDs. */
const BUTTON_REQUEST = /^(approve|deny) request ([0-9A-HJKMNP-TV-Z]{26})$/i;

/**
 * A reply that answers an approval request, or null: a button's value, or a typed
 * ``approve`` or ``deny [reason]``.
 * @param text - the reply.
 */
export function parseSessionApprovalAnswer(text: string): SessionApprovalAnswer | null {
  const button = BUTTON_REQUEST.exec(text.trim());
  if (button) return { decision: button[1].toLowerCase() === 'deny' ? 'deny' : 'approve', requestId: button[2] };
  return parseLinearApprovalReply(text);
}

/**
 * An answer with nothing left to answer: a button's value, or approve / deny alone.
 * ``deny <text>`` is not one, because with no request open it reads as an instruction
 * ("deny anonymous access to /admin").
 * @param text - the prompt.
 */
export function isBareApprovalAnswer(text: string): boolean {
  const answer = parseSessionApprovalAnswer(text);
  return answer !== null && !answer.reason;
}

/**
 * The session activity id of an approval notice: derived from the event and the
 * request, so a retried notice is the same activity and the reply handler can read
 * back when a request's choice was shown.
 * @param eventType - the approval event (``approval_requested`` for the choice).
 * @param requestId - the request.
 */
export function sessionApprovalNoticeId(eventType: string, requestId: string): string {
  return progressActivityId(`notified_linear_session_${eventType}#${requestId}`);
}

/** One activity plus the options ``emitAgentActivity`` takes. */
export interface SessionApprovalActivity {
  readonly content: AgentActivityContent;
  readonly signal?: 'select';
  readonly signalMetadata?: Readonly<Record<string, unknown>>;
}

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const ISO_CLOCK = { start: 11, end: 16 } as const;
const ISO_DATE_END = 10;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** ``in 30 min``, ``in 3 h``, ``in 2 days``, ``now``. */
function relativeTime(ms: number): string {
  const min = Math.round(ms / MINUTE_MS);
  if (min <= 0) return 'now';
  if (min < MINUTES_PER_HOUR * 2) return `in ${min} min`;
  const hours = Math.round(min / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY * 2) return `in ${hours} h`;
  return `in ${Math.round(hours / HOURS_PER_DAY)} days`;
}

/**
 * A deadline as a person reads it: ``21:40 UTC (in 30 min)``, with the date when it
 * is not today (``Tue 17 Nov, 09:40 UTC (in 12 h)``). Null for an unparseable time.
 * @param iso - the deadline.
 * @param now - the reference time.
 */
export function formatDeadline(iso: string, now: Date = new Date()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hhmm = at.toISOString().slice(ISO_CLOCK.start, ISO_CLOCK.end);
  const sameDay = at.toISOString().slice(0, ISO_DATE_END) === now.toISOString().slice(0, ISO_DATE_END);
  const day = sameDay ? '' : `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, `;
  return `${day}${hhmm} UTC (${relativeTime(at.getTime() - now.getTime())})`;
}

/**
 * The line that says the reader has to act, and by when.
 * @param deadline - when the request is denied unanswered (ISO), if it has one.
 * @param now - the reference time.
 */
export function waitingOnYouLine(deadline: string | undefined, now: Date = new Date()): string {
  const when = deadline ? formatDeadline(deadline, now) : null;
  return when
    ? `**Waiting on you.** Reply by ${when}, or it is denied and the agent carries on without it.`
    : '**Waiting on you.** The agent is paused until you answer.';
}

/**
 * The buttons for one request, as ``emitAgentActivity`` options. Each value names the
 * request, so a click on an older choice cannot decide a later request. A request
 * that cannot be approved in Linear gets no buttons: it is denied by a typed reply.
 */
function choice(body: string, requestId: string, refusal?: string): SessionApprovalActivity {
  if (refusal) return { content: { type: 'elicitation', body } };
  const option = (label: string, verb: string) => ({ label, value: `${verb} request ${requestId}` });
  const options = [option('Approve', 'approve'), option('Deny', 'deny')];
  return { content: { type: 'elicitation', body }, signal: 'select', signalMetadata: { options } };
}

/**
 * The session activity for an approval notice: a pending request is a choice with
 * buttons; a decision, a timeout or a stranded wait is a thought.
 * @param eventType - the approval event.
 * @param notification - the notice loaded for the ``linear_session`` channel.
 * @param now - the reference time for the deadline.
 */
export function sessionApprovalActivity(
  eventType: string, notification: ApprovalNotification, now: Date = new Date(),
): SessionApprovalActivity {
  const body = approvalNotificationMarkdown(notification);
  if (eventType === 'approval_requested') {
    return choice(`${body}\n\n${waitingOnYouLine(notification.deadline, now)}`, notification.requestId, notification.linearRefusal);
  }
  return { content: { type: 'thought', body } };
}

/**
 * The choice again, with a line above it. Posted when a reply could not decide the
 * request, so the request stays the session's last activity and Linear keeps
 * showing the session as waiting for input.
 * @param lead - why it is shown again.
 * @param requestId - the open request.
 * @param refusal - why it cannot be approved in Linear, if it cannot.
 */
export function repeatedApprovalChoice(lead: string, requestId: string, refusal?: string): SessionApprovalActivity {
  return refusal
    ? choice(`${lead}\n\n${refusal} You can deny it here: reply deny, with an optional reason.`, requestId, refusal)
    : choice(`${lead}\n\nChoose **Approve** or **Deny**, or reply deny with a reason.`, requestId);
}

/** What the decision handlers return. */
export interface DecisionResult { readonly statusCode: number }

const HTTP_OK_MIN = 200;
const HTTP_OK_END = 300;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;

/**
 * The note after a decision was attempted.
 * @param reply - the parsed answer.
 * @param result - the decision handler's result.
 */
export function sessionDecisionNote(reply: SessionApprovalAnswer, result: DecisionResult): string {
  if (result.statusCode >= HTTP_OK_MIN && result.statusCode < HTTP_OK_END) {
    return reply.decision === 'approve'
      ? 'Approved. The agent continues with this action.'
      : `Denied. The agent carries on without it${reply.reason ? ` (your reason: ${reply.reason})` : ''}.`;
  }
  if (result.statusCode === HTTP_CONFLICT || result.statusCode === HTTP_NOT_FOUND) {
    return 'That request was already answered or timed out, so nothing changed. The agent asks again if it still needs to.';
  }
  if (result.statusCode === HTTP_TOO_MANY) return 'Too many approval decisions in the last minute. Reply again in a moment.';
  return 'I couldn\'t record that decision. Reply again, or use `bgagent approve` / `bgagent deny`.';
}

/** The reply to an approve / deny when nothing in the session is waiting for one. */
export const NOTHING_TO_APPROVE_MESSAGE = 'Nothing is waiting for your approval here, so nothing was approved or denied. '
  + 'I haven\'t started or re-run anything. To ask for more work, say what you want done.';
