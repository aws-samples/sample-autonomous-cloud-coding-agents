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

import type { ApprovalNotification } from '../../../src/handlers/shared/approval-notifications';
import {
  formatDeadline,
  parseSessionApprovalAnswer,
  repeatedApprovalChoice,
  sessionApprovalActivity,
  sessionDecisionNote,
  waitingOnYouLine,
} from '../../../src/handlers/shared/linear-session-approval';

const NOW = new Date('2026-11-25T21:10:00Z');
const REQ = '01M89PC2Y1YDH7SJEVVYR0VCAX';
const values = (a: { signalMetadata?: unknown }) => (a.signalMetadata as { options: Array<{ label: string; value: string }> }).options;
const notice = (deadline?: string): ApprovalNotification => ({
  title: 'Approval needed',
  text: 'Approval needed\nThe agent wants to run a shell command.',
  taskId: 't-1',
  requestId: REQ,
  userId: 'u-1',
  marker: 'notified_linear_session_approval_requested',
  ...(deadline && { deadline }),
});

test('a deadline reads as a clock time and how long is left, with the date when it is not today', () => {
  expect(formatDeadline('2026-11-25T21:40:00Z', NOW)).toBe('21:40 UTC (in 30 min)');
  expect(formatDeadline('2026-11-26T09:40:00Z', NOW)).toBe('Thu 26 Nov, 09:40 UTC (in 13 h)');
  expect(formatDeadline('not a date', NOW)).toBeNull();
});

test('the waiting line says what happens if nobody answers', () => {
  expect(waitingOnYouLine('2026-11-25T21:40:00Z', NOW))
    .toBe('**Waiting on you.** Reply by 21:40 UTC (in 30 min), or it is denied and the agent carries on without it.');
  expect(waitingOnYouLine(undefined, NOW)).toBe('**Waiting on you.** The agent is paused until you answer.');
});

test('a pending request is a choice with Approve / Deny buttons and the waiting line', () => {
  const a = sessionApprovalActivity('approval_requested', notice('2026-11-25T21:40:00Z'), NOW);
  expect(a.content.type).toBe('elicitation');
  expect(a.signal).toBe('select');
  // Each button names its request, so a late click on it cannot decide a later one.
  expect(values(a)).toEqual([
    { label: 'Approve once', value: `approve request ${REQ}` },
    { label: 'Deny', value: `deny request ${REQ}` },
  ]);
  const body = (a.content as { body: string }).body;
  expect(body).toContain('The agent wants to run a shell command.');
  expect(body.endsWith('Reply by 21:40 UTC (in 30 min), or it is denied and the agent carries on without it.')).toBe(true);
});

test('a decision, timeout or stranded wait is a note without buttons', () => {
  for (const type of ['approval_decision_recorded', 'approval_timed_out', 'approval_stranded']) {
    const a = sessionApprovalActivity(type, notice(), NOW);
    expect(a.content.type).toBe('thought');
    expect(a.signal).toBeUndefined();
  }
});

test('the repeated choice keeps the buttons', () => {
  const a = repeatedApprovalChoice('Only the task owner can decide this request.', REQ);
  expect(values(a).map((o) => o.label)).toEqual(['Approve once', 'Deny']);
  expect(a.content).toEqual({ type: 'elicitation', body: expect.stringMatching(/^Only the task owner can decide this request\./) });
  expect(a.signal).toBe('select');
});

test('the note after a decision says what happened', () => {
  expect(sessionDecisionNote({ decision: 'approve' }, { statusCode: 202 })).toBe('Approved. The agent continues with this action.');
  expect(sessionDecisionNote({ decision: 'deny', reason: 'use staging' }, { statusCode: 202 }))
    .toBe('Denied. The agent carries on without it (your reason: use staging).');
  expect(sessionDecisionNote({ decision: 'approve' }, { statusCode: 409 })).toContain('already answered or timed out');
  expect(sessionDecisionNote({ decision: 'approve' }, { statusCode: 404 })).toContain('already answered or timed out');
  expect(sessionDecisionNote({ decision: 'deny' }, { statusCode: 429 })).toContain('Too many');
  expect(sessionDecisionNote({ decision: 'deny' }, { statusCode: 500 })).toContain('bgagent approve');
});

test('the choice is Approve / Deny only: a rule approval for the rest of the task is not offered in Linear', () => {
  // The agent lets a later call through when the approved rule is among its matches,
  // so one click would also pass calls that match a stricter rule as well.
  const labels = (a: { signalMetadata?: unknown }) => values(a).map((o) => o.label);
  expect(labels(sessionApprovalActivity('approval_requested', notice(), NOW))).toEqual(['Approve once', 'Deny']);
  expect(labels(repeatedApprovalChoice('Again.', REQ))).toEqual(['Approve once', 'Deny']);
  expect(parseSessionApprovalAnswer('approve for this task')).toBeNull();
  expect(parseSessionApprovalAnswer(`approve for this task request ${REQ}`)).toBeNull();
  expect(parseSessionApprovalAnswer('approve')).toEqual({ decision: 'approve' });
});

test('a button value carries its request; typed answers do not', () => {
  expect(parseSessionApprovalAnswer(`approve request ${REQ}`)).toEqual({ decision: 'approve', requestId: REQ });
  expect(parseSessionApprovalAnswer(`deny request ${REQ}`)).toEqual({ decision: 'deny', requestId: REQ });
  expect(parseSessionApprovalAnswer('deny request a refund')).toEqual({ decision: 'deny', reason: 'request a refund' });
});

test('a request that cannot be approved in Linear is asked without buttons', () => {
  const refusal = 'Part of this action looks like a credential, so it is hidden here.';
  const a = sessionApprovalActivity('approval_requested', { ...notice('2026-11-25T21:40:00Z'), linearRefusal: refusal }, NOW);
  expect(a.content.type).toBe('elicitation');
  expect(a.signal).toBeUndefined();
  const again = repeatedApprovalChoice('That isn\'t an answer.', REQ, refusal);
  expect(again.signal).toBeUndefined();
  expect((again.content as { body: string }).body).toContain(refusal);
});

test('a button\'s label read back as the prompt decides no request', () => {
  // Linear's docs say a choice comes back as a prompt, not whether its body is the
  // option's value or its label. The value names the request; the Approve label is
  // no typed answer, so a label cannot approve a request it was not shown with.
  // A Deny label reads as a typed deny, which never lets anything through.
  const [approve, deny] = values(sessionApprovalActivity('approval_requested', notice(), NOW));
  expect(parseSessionApprovalAnswer(approve.value)).toEqual({ decision: 'approve', requestId: REQ });
  expect(parseSessionApprovalAnswer(approve.label)).toBeNull();
  expect(parseSessionApprovalAnswer(deny.label)).toEqual({ decision: 'deny' });
});
