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

import { TaskStatus } from '../../../src/constructs/task-status';
import { renderFailureReply, renderPanelFailureReason } from '../../../src/handlers/shared/failure-reply';

describe('renderFailureReply (#247 UX.5 — failure is a conversation)', () => {
  describe('build/test failure — the REAL live-verified gating shape', () => {
    // Live-verified 2026-06-16: a build/test regression persists as
    // status=FAILED, build_passed=null, error_message="Task did not succeed
    // (agent_status='success', build_ok=False)". The agent finished fine; only
    // the build gate failed. (The previous COMPLETED+build_passed===false
    // assumption NEVER occurs live — that bug shipped to dev and was caught by
    // forcing a regression in UX.6.)
    const body = renderFailureReply({
      status: TaskStatus.FAILED,
      buildPassed: null,
      errorMessage: "Task did not succeed (agent_status='success', build_ok=False)",
      taskId: 't1',
    });

    // K2: the agent runs the configured build INSIDE the
    // microVM, so the failing output is in CloudWatch — NOT the PR's GitHub
    // checks (the repo may have no CI). The old "see the PR's checks" copy
    // pointed the user at an empty surface. Point at the build log by task id.
    test('points at the CloudWatch build log by task id, not the PR checks', () => {
      expect(body).toMatch(/^❌/);
      expect(body).toMatch(/build\/tests didn't pass/i);
      expect(body).toMatch(/build log in CloudWatch for task `t1`/);
      expect(body).not.toMatch(/PR's checks/i);
    });

    test('invites a reply (the retry seam)', () => {
      expect(body).toMatch(/reply with guidance/i);
    });

    test('also matches the end_turn variant of the gating message', () => {
      const b = renderFailureReply({
        status: TaskStatus.FAILED,
        errorMessage: "Task did not succeed (agent_status='end_turn', build_ok=False)",
        taskId: 't1b',
      });
      expect(b).toMatch(/build\/tests didn't pass/i);
      expect(b).toMatch(/build log in CloudWatch for task `t1b`/);
    });

    test('defensive: explicit build_passed=false with no error_message still reads as build failure', () => {
      const b = renderFailureReply({ status: TaskStatus.FAILED, buildPassed: false, taskId: 't1c' });
      expect(b).toMatch(/build\/tests didn't pass/i);
      expect(b).toMatch(/build log in CloudWatch for task `t1c`/);
    });
  });

  describe('build TIMEOUT — distinct from a red build (user 2026-06-29)', () => {
    // The agent finished cleanly but the build verify exceeded its wall-clock
    // limit and was killed → error_message carries build_ok=timeout. This is a
    // different diagnosis (slow build / cap too low), NOT "your code is broken".
    const body = renderFailureReply({
      status: TaskStatus.FAILED,
      errorMessage: "Task did not succeed (agent_status='success', build_ok=timeout)",
      taskId: 't-to',
    });

    test('reads as "timed out / didn\'t finish in time", not "didn\'t pass"', () => {
      expect(body).toMatch(/^❌/);
      expect(body).toMatch(/didn't finish in time|timed out/i);
      expect(body).not.toMatch(/didn't pass/i);
      expect(body).toMatch(/build log in CloudWatch for task `t-to`/);
    });

    test('still invites a reply (retry seam)', () => {
      expect(body).toMatch(/reply with guidance/i);
    });

    test('a timeout is NOT misread as an agent crash (no classified-title path)', () => {
      // It must take the build branch, not the classifyError/CloudWatch-crash branch.
      expect(body).not.toMatch(/Unexpected error|didn't complete/i);
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

    test('a genuine agent crash (agent_status=error_*) reads as agent failure, NOT build', () => {
      // An agent crash mid-execution — distinct from the build-gate-failed
      // shape (which carries agent_status='success'). Must get the CloudWatch
      // pointer, not the softer "PR's checks" build copy.
      const body = renderFailureReply({
        status: TaskStatus.FAILED,
        errorMessage: 'Task did not succeed (agent_status=\'error_during_execution\', build_ok=False)',
        taskId: 't5',
      });
      expect(body).toMatch(/CloudWatch for task `t5`/);
      expect(body).not.toMatch(/PR's checks/i);
    });
  });
});

describe('renderPanelFailureReason (K1 — failed-node sub-line on the epic panel)', () => {
  test('integration-node build failure names the combined merge + points at CloudWatch', () => {
    const reason = renderPanelFailureReason({
      errorMessage: "Task did not succeed (agent_status='success', build_ok=False)",
      taskId: 't-int',
      isIntegration: true,
    });
    expect(reason).toMatch(/combined build failed after merging the sub-issue branches/i);
    expect(reason).toMatch(/build log in CloudWatch for task `t-int`/);
    // No raw build output leaks into the panel.
    expect(reason).not.toMatch(/build_ok/i);
  });

  test('a regular sub-issue build failure reads generically (no merge wording)', () => {
    const reason = renderPanelFailureReason({ buildPassed: false, taskId: 't-leaf' });
    expect(reason).toMatch(/^Build\/tests failed/);
    expect(reason).not.toMatch(/merging/i);
    expect(reason).toMatch(/CloudWatch for task `t-leaf`/);
  });

  test('an agent crash surfaces the classified title + CloudWatch pointer', () => {
    const reason = renderPanelFailureReason({
      errorMessage: 'Task did not succeed: agent_status="error_max_turns"',
      taskId: 't-crash',
      isIntegration: true,
    });
    expect(reason).toMatch(/Exceeded max turns/i);
    expect(reason).toMatch(/CloudWatch for task `t-crash`/);
    // An agent crash is NOT a build failure — no combined-build wording.
    expect(reason).not.toMatch(/combined build/i);
  });

  test('null when there is no task id to point at (nothing actionable to render)', () => {
    expect(renderPanelFailureReason({ buildPassed: false })).toBeNull();
  });

  test('a build TIMEOUT on the integration node reads "timed out", not "failed"', () => {
    const reason = renderPanelFailureReason({
      errorMessage: "Task did not succeed (agent_status='success', build_ok=timeout)",
      taskId: 't-int-to',
      isIntegration: true,
    });
    expect(reason).toMatch(/Combined build timed out after merging the sub-issue branches/i);
    expect(reason).not.toMatch(/failed/i);
    expect(reason).toMatch(/CloudWatch for task `t-int-to`/);
  });

  test('a build TIMEOUT on a regular leaf reads "Build/tests timed out"', () => {
    const reason = renderPanelFailureReason({
      errorMessage: "Task did not succeed (agent_status='end_turn', build_ok=timeout)",
      taskId: 't-leaf-to',
    });
    expect(reason).toMatch(/^Build\/tests timed out/);
    expect(reason).not.toMatch(/failed/i);
  });
});
