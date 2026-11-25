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
  repeatedApprovalChoice,
  SESSION_APPROVAL_OPTIONS,
  sessionApprovalActivity,
  sessionDecisionNote,
  waitingOnYouLine,
} from '../../../src/handlers/shared/linear-session-approval';

const NOW = new Date('2026-11-25T21:10:00Z');
const notice = (deadline?: string): ApprovalNotification => ({
  title: 'Approval needed',
  text: 'Approval needed\nThe agent wants to run a shell command.',
  taskId: 't-1',
  requestId: 'r-1',
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
  expect(a.signalMetadata).toEqual({ options: SESSION_APPROVAL_OPTIONS });
  expect(SESSION_APPROVAL_OPTIONS.map((o) => o.value)).toEqual(['approve', 'deny']);
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
  const a = repeatedApprovalChoice('Only the task owner can decide this request.');
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
