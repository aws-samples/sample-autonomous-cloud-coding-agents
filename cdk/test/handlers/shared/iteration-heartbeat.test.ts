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

import { planHeartbeat, type HeartbeatTaskView } from '../../../src/handlers/shared/iteration-heartbeat';

const NOW = Date.parse('2026-06-29T13:30:00Z');

function task(overrides: Partial<HeartbeatTaskView> = {}): HeartbeatTaskView {
  return {
    taskId: 't-1',
    status: 'RUNNING',
    createdAt: '2026-06-29T13:20:00Z', // 10 min before NOW
    channelSource: 'linear',
    linearWorkspaceId: 'ws-1',
    iterationReplyCommentId: 'reply-1',
    triggerCommentId: 'cmt-1',
    triggerCommentIssueId: 'issue-1',
    isIteration: true,
    prNumber: 42,
    ...overrides,
  };
}

describe('planHeartbeat — eligibility', () => {
  test('a long-running linear iteration with a reply → a plan', () => {
    const plan = planHeartbeat(task(), NOW);
    expect(plan).not.toBeNull();
    expect(plan!.taskId).toBe('t-1');
    expect(plan!.replyId).toBe('reply-1');
    expect(plan!.parentCommentId).toBe('cmt-1');
    expect(plan!.issueId).toBe('issue-1');
    expect(plan!.elapsedS).toBe(600);
    expect(plan!.body).toContain('🔄 Working — updating PR #42…');
    expect(plan!.body).toContain('10m elapsed');
  });

  test('not RUNNING → no plan', () => {
    expect(planHeartbeat(task({ status: 'COMPLETED' }), NOW)).toBeNull();
    expect(planHeartbeat(task({ status: 'HYDRATING' }), NOW)).toBeNull();
  });

  test('a STANDALONE iteration (no orchestration marker) is STILL eligible — keys on the reply, not isIteration', () => {
    // The ABCA-483 black-box case was a standalone @bgagent iteration, which
    // omits orchestration_iteration but still has a maturing reply. It must
    // get a heartbeat. Eligibility is the reply-routing fields, not isIteration.
    const plan = planHeartbeat(task({ isIteration: false }), NOW);
    expect(plan).not.toBeNull();
    expect(plan!.replyId).toBe('reply-1');
  });

  test('a task with NO maturing reply (first run / non-PR) → no plan', () => {
    expect(planHeartbeat(task({ iterationReplyCommentId: undefined }), NOW)).toBeNull();
  });

  test('non-linear channel → no plan (reply edit only wired for linear)', () => {
    expect(planHeartbeat(task({ channelSource: 'slack' }), NOW)).toBeNull();
  });

  test('below the elapsed floor → no plan (fresh task, no nudge)', () => {
    // 30s elapsed < 90s floor
    expect(planHeartbeat(task({ createdAt: '2026-06-29T13:29:30Z' }), NOW)).toBeNull();
  });

  test('missing any reply-routing field → no plan (cannot edit)', () => {
    expect(planHeartbeat(task({ iterationReplyCommentId: undefined }), NOW)).toBeNull();
    expect(planHeartbeat(task({ triggerCommentId: undefined }), NOW)).toBeNull();
    expect(planHeartbeat(task({ triggerCommentIssueId: undefined }), NOW)).toBeNull();
    expect(planHeartbeat(task({ linearWorkspaceId: undefined }), NOW)).toBeNull();
  });

  test('unparseable / missing created_at → no plan', () => {
    expect(planHeartbeat(task({ createdAt: undefined }), NOW)).toBeNull();
    expect(planHeartbeat(task({ createdAt: 'not-a-date' }), NOW)).toBeNull();
  });
});

describe('planHeartbeat — body content', () => {
  test('a progress note is folded into the working line', () => {
    const plan = planHeartbeat(task({ latestProgressNote: 'running build verification' }), NOW);
    expect(plan!.body).toContain('10m elapsed · running build verification');
  });

  test('no PR number → generic working line still carries elapsed', () => {
    const plan = planHeartbeat(task({ prNumber: null }), NOW);
    expect(plan!.body).toContain('🔄 Working…');
    expect(plan!.body).toContain('10m elapsed');
  });

  test('a PR url makes the reference clickable', () => {
    const plan = planHeartbeat(task({ prUrl: 'https://gh/pull/42' }), NOW);
    expect(plan!.body).toContain('[PR #42](https://gh/pull/42)');
  });
});
