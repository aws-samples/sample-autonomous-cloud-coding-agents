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

const postIssueCommentMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const addIssueReactionMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  addIssueReaction: (...args: unknown[]) => addIssueReactionMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  EMOJI_SUCCESS: 'white_check_mark',
}));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

import {
  renderRollupComment,
  renderStatusBlock,
  rollupKindFromChildren,
  postRollup,
  type RollupChildView,
} from '../../../src/handlers/shared/orchestration-rollup';
import { ORCH_LOG } from '../../../src/handlers/shared/orchestration-log-events';
import type { OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';

const view = (sub: string, status: string, ident?: string, title?: string): RollupChildView => ({
  sub_issue_id: sub, child_status: status,
  ...(ident && { linear_identifier: ident }), ...(title && { title }),
});

describe('renderRollupComment', () => {
  test('complete: all succeeded → completion heading + counts', () => {
    const body = renderRollupComment('complete', [
      view('a', 'succeeded', 'ENG-1', 'Step A'),
      view('b', 'succeeded', 'ENG-2', 'Step B'),
    ]);
    expect(body).toContain('orchestration complete');
    expect(body).toContain('2 succeeded, 0 failed, 0 skipped');
    expect(body).toContain('✅ ENG-1: Step A');
  });

  test('partial_failure: shows failed + skipped with icons + summary', () => {
    const body = renderRollupComment('partial_failure', [
      view('a', 'failed', 'ENG-1'),
      view('b', 'skipped', 'ENG-2'),
      view('c', 'succeeded', 'ENG-3'),
    ]);
    expect(body).toContain('finished with failures');
    expect(body).toContain('1 succeeded, 1 failed, 1 skipped');
    expect(body).toContain('❌ ENG-1');
    expect(body).toContain('⏭️ ENG-2');
  });

  test('cancelled: cancellation heading', () => {
    const body = renderRollupComment('cancelled', [view('a', 'failed', 'ENG-1')]);
    expect(body).toContain('cancelled');
  });

  test('children are sorted by identifier (deterministic comment)', () => {
    const body = renderRollupComment('complete', [
      view('z', 'succeeded', 'ENG-9'),
      view('a', 'succeeded', 'ENG-1'),
    ]);
    expect(body.indexOf('ENG-1')).toBeLessThan(body.indexOf('ENG-9'));
  });
});

describe('renderStatusBlock (#3 live status)', () => {
  test('header shows N/M complete (terminal children only)', () => {
    const body = renderStatusBlock([
      view('a', 'succeeded', 'ENG-1', 'Guide'),
      view('b', 'released', 'ENG-2', 'Cards'),
      view('c', 'blocked', 'ENG-3', 'Quiz'),
    ]);
    expect(body).toContain('1/3 complete');
    expect(body).toContain('🔄 **ABCA orchestration**');
  });

  test('maps in-flight statuses to human words (running / blocked)', () => {
    const body = renderStatusBlock([
      view('a', 'released', 'ENG-1', 'A'),
      view('b', 'blocked', 'ENG-2', 'B'),
    ]);
    expect(body).toContain('ENG-1: A — running');
    expect(body).toContain('ENG-2: B — blocked');
  });

  test('terminal statuses keep their word + icon', () => {
    const body = renderStatusBlock([
      view('a', 'succeeded', 'ENG-1'),
      view('b', 'failed', 'ENG-2'),
      view('c', 'skipped', 'ENG-3'),
    ]);
    expect(body).toContain('✅ ENG-1 — succeeded');
    expect(body).toContain('❌ ENG-2 — failed');
    expect(body).toContain('⏭️ ENG-3 — skipped');
    expect(body).toContain('3/3 complete');
  });

  test('children sorted by identifier (stable edit-in-place body)', () => {
    const body = renderStatusBlock([view('z', 'released', 'ENG-9'), view('a', 'released', 'ENG-1')]);
    expect(body.indexOf('ENG-1')).toBeLessThan(body.indexOf('ENG-9'));
  });
});

describe('rollupKindFromChildren', () => {
  test('all succeeded → complete', () => {
    expect(rollupKindFromChildren([view('a', 'succeeded'), view('b', 'succeeded')])).toBe('complete');
  });
  test('any failed → partial_failure', () => {
    expect(rollupKindFromChildren([view('a', 'succeeded'), view('b', 'failed')])).toBe('partial_failure');
  });
  test('any skipped → partial_failure', () => {
    expect(rollupKindFromChildren([view('a', 'succeeded'), view('b', 'skipped')])).toBe('partial_failure');
  });
});

const row = (sub: string, status: string): OrchestrationChildRow => ({
  orchestration_id: 'orch_1', sub_issue_id: sub, parent_linear_issue_id: 'PARENT',
  linear_workspace_id: 'WS', repo: 'o/r', depends_on: [], child_status: status as never,
  created_at: 'now', updated_at: 'now',
});

describe('postRollup', () => {
  beforeEach(() => {
    postIssueCommentMock.mockReset();
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    addIssueReactionMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-1');
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  test('success → posts comment + logs orch.rollup.posted', async () => {
    postIssueCommentMock.mockResolvedValue(true);
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
    });
    expect(ok).toBe(true);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    // The stable log event automated tests grep for.
    const posted = loggerMock.info.mock.calls.find((c) => c[1]?.event === ORCH_LOG.rollupPosted);
    expect(posted).toBeDefined();
    expect(posted![1]).toMatchObject({ orchestration_id: 'orch_1', parent_linear_issue_id: 'PARENT', rollup_kind: 'complete' });
  });

  test('complete → advances parent to In Review + ✅ reaction (mirrors children)', async () => {
    postIssueCommentMock.mockResolvedValue(true);
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
    });
    expect(transitionIssueStateMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', 'started', ['In Review'],
    );
    expect(addIssueReactionMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', 'white_check_mark',
    );
  });

  test('partial_failure → does NOT advance state, drops ❌ reaction (undefined = default failure)', async () => {
    postIssueCommentMock.mockResolvedValue(true);
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'partial_failure', children: [row('a', 'failed')],
    });
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(addIssueReactionMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', undefined,
    );
  });

  test('comment fails → does NOT transition state or react (state mirrors only on posted rollup)', async () => {
    postIssueCommentMock.mockResolvedValue(false);
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
    });
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(addIssueReactionMock).not.toHaveBeenCalled();
  });

  test('post returns false → logs orch.rollup.failed, returns false', async () => {
    postIssueCommentMock.mockResolvedValue(false);
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'partial_failure', children: [row('a', 'failed')],
    });
    expect(ok).toBe(false);
    expect(loggerMock.warn.mock.calls.some((c) => c[1]?.event === ORCH_LOG.rollupFailed)).toBe(true);
  });

  test('non-linear channelSource → no Linear post/transition/reaction, returns false (#247 seam)', async () => {
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
      channelSource: 'slack',
    });
    expect(ok).toBe(false);
    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(addIssueReactionMock).not.toHaveBeenCalled();
  });

  test('explicit linear channelSource behaves like the default', async () => {
    postIssueCommentMock.mockResolvedValue(true);
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
      channelSource: 'linear',
    });
    expect(ok).toBe(true);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
  });

  test('with statusCommentId → EDITS the live block in place (no fresh comment) (#3)', async () => {
    upsertStatusCommentMock.mockResolvedValue('cmt-1');
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
      statusCommentId: 'cmt-1',
    });
    expect(ok).toBe(true);
    // Edited the existing comment; did NOT post a fresh one.
    expect(upsertStatusCommentMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', expect.any(String), 'cmt-1',
    );
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('without statusCommentId → posts a fresh comment (back-compat)', async () => {
    postIssueCommentMock.mockResolvedValue(true);
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
    });
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(upsertStatusCommentMock).not.toHaveBeenCalled();
  });

  test('post throws → swallowed, logs orch.rollup.failed, returns false', async () => {
    postIssueCommentMock.mockRejectedValue(new Error('linear down'));
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1', parentLinearIssueId: 'PARENT',
      kind: 'complete', children: [row('a', 'succeeded')],
    });
    expect(ok).toBe(false);
    expect(loggerMock.warn.mock.calls.some((c) => c[1]?.event === ORCH_LOG.rollupFailed)).toBe(true);
  });
});
