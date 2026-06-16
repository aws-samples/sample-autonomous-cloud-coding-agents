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

import { renderFailureReply } from '../../../src/handlers/shared/failure-reply';
import { TaskStatus } from '../../../src/constructs/task-status';

describe('renderFailureReply (#247 UX.5 — failure is a conversation)', () => {
  describe('build/test failure (agent completed, PR exists, checks red)', () => {
    const body = renderFailureReply({ status: TaskStatus.COMPLETED, buildPassed: false, taskId: 't1' });

    test('points at the PR checks, not a raw dump', () => {
      expect(body).toMatch(/^❌/);
      expect(body).toMatch(/build\/tests didn't pass/i);
      expect(body).toMatch(/PR's checks/i);
    });

    test('invites a reply (the retry seam)', () => {
      expect(body).toMatch(/reply with guidance/i);
    });

    test('does NOT surface a CloudWatch task pointer (that is for agent failures)', () => {
      expect(body).not.toMatch(/CloudWatch/i);
    });
  });

  describe('agent-itself failure (crash / cap / timeout before a clean terminal)', () => {
    test('max-turns crash → classified title + CloudWatch task id + retry invite', () => {
      const body = renderFailureReply({
        status: TaskStatus.FAILED,
        errorMessage: 'Task did not succeed: agent_status="error_max_turns"',
        taskId: 'task-xyz',
      });
      expect(body).toMatch(/^❌/);
      expect(body).toMatch(/Exceeded max turns/i); // classified title
      expect(body).toMatch(/CloudWatch for task `task-xyz`/);
      expect(body).toMatch(/reply with guidance/i);
    });

    test('truncates a long raw error to an excerpt with an ellipsis', () => {
      const longErr = 'boom '.repeat(200); // 1000 chars
      const body = renderFailureReply({ status: TaskStatus.FAILED, errorMessage: longErr, taskId: 't2' });
      expect(body).toContain('…');
      // The reply stays compact — nowhere near the 1000-char raw error.
      expect(body.length).toBeLessThan(400);
    });

    test('unclassifiable error → generic fallback title, still points at CloudWatch', () => {
      const body = renderFailureReply({ status: TaskStatus.FAILED, errorMessage: 'weird thing', taskId: 't3' });
      // UNKNOWN_CLASSIFICATION title is "Unexpected error".
      expect(body).toMatch(/Unexpected error/i);
      expect(body).toMatch(/CloudWatch for task `t3`/);
    });

    test('no error_message at all → still a coherent agent-failure reply', () => {
      const body = renderFailureReply({ status: TaskStatus.FAILED, taskId: 't4' });
      expect(body).toMatch(/^❌/);
      expect(body).toMatch(/CloudWatch for task `t4`/);
    });

    test('COMPLETED with build_passed=false BUT an error_message present → agent failure (not build)', () => {
      // A crash that also left build_passed false should read as the crash,
      // with the CloudWatch pointer — not the softer build-fail copy.
      const body = renderFailureReply({
        status: TaskStatus.COMPLETED,
        buildPassed: false,
        errorMessage: 'agent_status="error_during_execution"',
        taskId: 't5',
      });
      expect(body).toMatch(/CloudWatch for task `t5`/);
      expect(body).not.toMatch(/PR's checks/i);
    });
  });
});
