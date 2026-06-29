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
const swapIssueReactionMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
}));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

import { ORCH_LOG } from '../../../src/handlers/shared/orchestration-log-events';
import {
  renderRollupComment,
  renderStatusBlock,
  renderEpicPanel,
  buildPanelRows,
  truncateQuote,
  cascadeNodeLabel,
  rollupKindFromChildren,
  postRollup,
  type RollupChildView,
  type EpicPanelRow,
} from '../../../src/handlers/shared/orchestration-rollup';
import type { OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';

const view = (sub: string, status: string, ident?: string, title?: string, pr_url?: string): RollupChildView => ({
  sub_issue_id: sub,
  child_status: status,
  ...(ident && { linear_identifier: ident }),
  ...(title && { title }),
  ...(pr_url && { pr_url }),
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

  // #323: per-child PR links + integration-node combined-PR callout.
  test('renders a PR link on a child line when pr_url is present', () => {
    const body = renderRollupComment('complete', [
      view('a', 'succeeded', 'ENG-1', 'Step A', 'https://github.com/o/r/pull/10'),
      view('b', 'succeeded', 'ENG-2', 'Step B'), // no PR
    ]);
    expect(body).toContain('✅ ENG-1: Step A — succeeded — [PR](https://github.com/o/r/pull/10)');
    // A child without a PR renders no link (no broken markdown).
    expect(body).toContain('✅ ENG-2: Step B — succeeded');
    expect(body).not.toContain('ENG-2: Step B — succeeded — [PR]');
  });

  test('surfaces the integration node combined PR as a prominent callout', () => {
    const body = renderRollupComment('complete', [
      view('a', 'succeeded', 'ENG-1', 'Leaf A', 'https://github.com/o/r/pull/1'),
      view('b', 'succeeded', 'ENG-2', 'Leaf B', 'https://github.com/o/r/pull/2'),
      view('orch_x__integration', 'succeeded', undefined, 'Integration — combine sub-issue results', 'https://github.com/o/r/pull/9'),
    ]);
    expect(body).toContain('🔗 **Combined PR (all sub-issues merged):** [https://github.com/o/r/pull/9](https://github.com/o/r/pull/9)');
    // The callout appears BEFORE the per-child list.
    expect(body.indexOf('Combined PR')).toBeLessThan(body.indexOf('ENG-1'));
  });

  test('no combined-PR callout when the integration node opened no PR', () => {
    const body = renderRollupComment('partial_failure', [
      view('a', 'succeeded', 'ENG-1', 'Leaf A', 'https://github.com/o/r/pull/1'),
      view('orch_x__integration', 'skipped', undefined, 'Integration — combine sub-issue results'), // no PR (skipped)
    ]);
    expect(body).not.toContain('Combined PR');
  });

  test('no combined-PR callout for a plain chain (no integration node)', () => {
    const body = renderRollupComment('complete', [
      view('a', 'succeeded', 'ENG-1', 'A', 'https://github.com/o/r/pull/1'),
      view('b', 'succeeded', 'ENG-2', 'B', 'https://github.com/o/r/pull/2'),
    ]);
    expect(body).not.toContain('Combined PR');
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

  test('links a child PR in the live block when pr_url is known (#323)', () => {
    const body = renderStatusBlock([
      view('a', 'released', 'ENG-1', 'A', 'https://github.com/o/r/pull/7'),
      view('b', 'blocked', 'ENG-2', 'B'),
    ]);
    expect(body).toContain('ENG-1: A — running — [PR](https://github.com/o/r/pull/7)');
    expect(body).toContain('ENG-2: B — blocked');
    expect(body).not.toContain('ENG-2: B — blocked — [PR]');
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
  orchestration_id: 'orch_1',
  sub_issue_id: sub,
  parent_linear_issue_id: 'PARENT',
  linear_workspace_id: 'WS',
  repo: 'o/r',
  depends_on: [],
  child_status: status as never,
  created_at: 'now',
  updated_at: 'now',
});

describe('postRollup', () => {
  beforeEach(() => {
    postIssueCommentMock.mockReset();
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-1');
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  test('success → posts comment + logs orch.rollup.posted', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: true });
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(ok).toBe(true);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    // The stable log event automated tests grep for.
    const posted = loggerMock.info.mock.calls.find((c) => c[1]?.event === ORCH_LOG.rollupPosted);
    expect(posted).toBeDefined();
    expect(posted![1]).toMatchObject({ orchestration_id: 'orch_1', parent_linear_issue_id: 'PARENT', rollup_kind: 'complete' });
  });

  test('complete → advances parent to In Review + ✅ reaction (mirrors children)', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: true });
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(transitionIssueStateMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', 'started', ['In Review'],
    );
    expect(swapIssueReactionMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', 'white_check_mark',
    );
  });

  test('partial_failure → does NOT advance state, swaps to ❌ reaction', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: true });
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'partial_failure',
      children: [row('a', 'failed')],
    });
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', 'x',
    );
  });

  test('comment fails → does NOT transition state or react (state mirrors only on posted rollup)', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: false, retryable: false });
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).not.toHaveBeenCalled();
  });

  test('post returns false → logs orch.rollup.failed, returns false', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: false, retryable: false });
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'partial_failure',
      children: [row('a', 'failed')],
    });
    expect(ok).toBe(false);
    expect(loggerMock.warn.mock.calls.some((c) => c[1]?.event === ORCH_LOG.rollupFailed)).toBe(true);
  });

  test('non-linear channelSource → no Linear post/transition/reaction, returns false (#247 seam)', async () => {
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
      channelSource: 'slack',
    });
    expect(ok).toBe(false);
    expect(postIssueCommentMock).not.toHaveBeenCalled();
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
    expect(swapIssueReactionMock).not.toHaveBeenCalled();
  });

  test('explicit linear channelSource behaves like the default', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: true });
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
      channelSource: 'linear',
    });
    expect(ok).toBe(true);
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
  });

  test('with statusCommentId → EDITS the live block in place (no fresh comment) (#3)', async () => {
    upsertStatusCommentMock.mockResolvedValue('cmt-1');
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
      statusCommentId: 'cmt-1',
    });
    expect(ok).toBe(true);
    // Edited the existing comment; did NOT post a fresh one.
    expect(upsertStatusCommentMock).toHaveBeenCalledWith(
      { linearWorkspaceId: 'WS', registryTableName: 'REG' }, 'PARENT', expect.any(String), 'cmt-1',
    );
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('threads prUrls → rendered comment links child PRs + combined PR (#323)', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: true });
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded'), row('orch_1__integration', 'succeeded')],
      prUrls: {
        a: 'https://github.com/o/r/pull/3',
        orch_1__integration: 'https://github.com/o/r/pull/9',
      },
    });
    const body = postIssueCommentMock.mock.calls[0][2] as string;
    expect(body).toContain('[PR](https://github.com/o/r/pull/3)');
    expect(body).toContain('🔗 **Combined PR (all sub-issues merged):**');
    expect(body).toContain('https://github.com/o/r/pull/9');
  });

  test('without statusCommentId → posts a fresh comment (back-compat)', async () => {
    postIssueCommentMock.mockResolvedValue({ ok: true });
    await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(postIssueCommentMock).toHaveBeenCalledTimes(1);
    expect(upsertStatusCommentMock).not.toHaveBeenCalled();
  });

  test('post throws → swallowed, logs orch.rollup.failed, returns false', async () => {
    postIssueCommentMock.mockRejectedValue(new Error('linear down'));
    const ok = await postRollup({
      ctx: { linearWorkspaceId: 'WS', registryTableName: 'REG' },
      orchestrationId: 'orch_1',
      parentLinearIssueId: 'PARENT',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(ok).toBe(false);
    expect(loggerMock.warn.mock.calls.some((c) => c[1]?.event === ORCH_LOG.rollupFailed)).toBe(true);
  });
});

describe('truncateQuote', () => {
  test('short text passes through, trimmed + whitespace-collapsed', () => {
    expect(truncateQuote('  the button   doesnt work ')).toBe('the button doesnt work');
  });
  test('long text is truncated with an ellipsis', () => {
    const out = truncateQuote('a'.repeat(60), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('cascadeNodeLabel (#247 — short name inside the cascade reason)', () => {
  test('integration node → "the integration" (not its raw synthetic title)', () => {
    // Live-caught under UX.6 stress: the integration node title read clumsily
    // in the possessive reason "Integration — combine sub-issue results's change".
    const label = cascadeNodeLabel('orch_abc__integration', undefined, 'Integration — combine sub-issue results');
    expect(label).toBe('the integration');
    // Reads cleanly in the possessive: "the integration's change".
    expect(`updating to include ${label}'s change`).toBe("updating to include the integration's change");
  });

  test('real node prefers the Linear identifier', () => {
    expect(cascadeNodeLabel('uuid-1', 'ABCA-42', 'Some title')).toBe('ABCA-42');
  });

  test('real node with no identifier falls back to title, then a generic name', () => {
    expect(cascadeNodeLabel('uuid-1', undefined, 'Some title')).toBe('Some title');
    expect(cascadeNodeLabel('uuid-1')).toBe('a predecessor');
  });
});

describe('renderEpicPanel (#247 UX — the single maturing panel)', () => {
  const row = (sub: string, status: string, opts: Partial<EpicPanelRow> = {}): EpicPanelRow => ({
    sub_issue_id: sub, child_status: status, ...opts,
  });

  test('in-progress header shows N/M complete', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        row('a', 'succeeded', { linear_identifier: 'ENG-1', title: 'A' }),
        row('b', 'released', { linear_identifier: 'ENG-2', title: 'B' }),
        row('c', 'blocked', { linear_identifier: 'ENG-3', title: 'C' }),
      ],
    });
    expect(body).toContain('🔄 **ABCA orchestration** · 1/3 complete');
    expect(body).toContain('✅ ENG-1: A — succeeded');
    expect(body).toContain('🔄 ENG-2: B — running');
    expect(body).toContain('⏳ ENG-3: C — blocked');
  });

  test('all settled + ok → complete header; failures → ⚠️', () => {
    expect(renderEpicPanel({ inProgress: false, rows: [row('a', 'succeeded')] }))
      .toContain('✅ **ABCA orchestration complete**');
    expect(renderEpicPanel({ inProgress: false, rows: [row('a', 'succeeded'), row('b', 'failed')] }))
      .toContain('⚠️ **ABCA orchestration finished with failures**');
  });

  test('PR link shown ONLY when a PR exists (first run mid-flight has none)', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        row('a', 'released', { linear_identifier: 'ENG-1', title: 'A' }), // running, no PR yet
        row('b', 'succeeded', { linear_identifier: 'ENG-2', title: 'B', pr_url: 'https://github.com/o/r/pull/9' }),
      ],
    });
    expect(body).toContain('🔄 ENG-1: A — running\n'); // no — [PR] suffix
    expect(body).not.toContain('ENG-1: A — running — [PR]');
    expect(body).toContain('✅ ENG-2: B — succeeded — [PR](https://github.com/o/r/pull/9)');
  });

  test('a row with updatingReason renders 🔄 updating <reason>, even when status is succeeded', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        row('a', 'succeeded', {
          linear_identifier: 'ENG-1',
          title: 'UI',
          pr_url: 'https://github.com/o/r/pull/7',
          updatingReason: 'per ENG-2\'s "button doesnt work"',
        }),
      ],
    });
    expect(body).toContain('🔄 ENG-1: UI — updating per ENG-2\'s "button doesnt work" — [PR](https://github.com/o/r/pull/7)');
  });

  test('a mid-update row keeps the header in-progress (does NOT count as done)', () => {
    // inProgress is passed true by the caller when any row is updating; the
    // updating row is excluded from the done count.
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        row('a', 'succeeded', { updatingReason: 'to include ENG-3\'s change' }),
        row('b', 'succeeded'),
      ],
    });
    expect(body).toContain('· 1/2 complete'); // only b counts as done
  });

  test('integration node renders friendly, never its raw id', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [
        row('a', 'succeeded', { linear_identifier: 'ENG-1' }),
        row('orch_x__integration', 'succeeded', { pr_url: 'https://github.com/o/r/pull/9' }),
      ],
      combinedPrUrl: 'https://github.com/o/r/pull/9',
    });
    expect(body).toContain('Integration — combined result');
    expect(body).not.toContain('orch_x__integration');
    expect(body).toContain('🔗 **Combined PR (all sub-issues merged):**');
  });

  test('K1: a failed row renders an indented diagnostic sub-line (what failed + where to read it)', () => {
    const reason = 'Combined build failed after merging the sub-issue branches — see the build log in CloudWatch for task `t-int`.';
    const body = renderEpicPanel({
      inProgress: false,
      rows: [
        row('a', 'succeeded', { linear_identifier: 'ENG-1' }),
        row('orch_x__integration', 'failed', { failureReason: reason }),
      ],
    });
    // The integration row + its sub-line on the very next line (indented ↳).
    expect(body).toContain(`- ❌ Integration — combined result — failed\n    ↳ ${reason}`);
  });

  test('K1: the sub-line is ONLY rendered for failed rows (not succeeded/skipped/running)', () => {
    const reason = 'should not appear';
    const succeeded = renderEpicPanel({ inProgress: false, rows: [row('a', 'succeeded', { failureReason: reason })] });
    expect(succeeded).not.toContain('↳');
    expect(succeeded).not.toContain(reason);
    // A skipped row (predecessor failed) gets no sub-line either — only the
    // node that actually failed carries the diagnostic.
    const skipped = renderEpicPanel({ inProgress: false, rows: [row('a', 'skipped', { failureReason: reason })] });
    expect(skipped).not.toContain('↳');
  });

  test('K1: a failed row with NO reason resolved still renders cleanly (no dangling ↳)', () => {
    const body = renderEpicPanel({ inProgress: false, rows: [row('a', 'failed', { linear_identifier: 'ENG-1' })] });
    expect(body).toContain('❌ ENG-1 — failed');
    expect(body).not.toContain('↳');
  });

  test('embeds the combined preview screenshot when present', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [row('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(body).toContain('🖼️ **Combined preview**');
    expect(body).toContain('![combined preview](https://cdn/x.png)');
  });

  test('#247 UX.17: makes the combined preview a clickable deep-link when the preview URL is known', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [row('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
      combinedPreviewUrl: 'https://my-app-abc123.vercel.app',
    });
    expect(body).toContain('🖼️ **Combined preview**');
    // Linked image: the embedded screenshot opens the running combined site.
    expect(body).toContain('[![combined preview](https://cdn/x.png)](https://my-app-abc123.vercel.app)');
    // Plain "open it" link too, for clients that don't render linked images.
    expect(body).toContain('[Open the combined preview](https://my-app-abc123.vercel.app)');
  });

  test('#247 UX.17: percent-encodes parens in the preview URL so it cannot break out of the markdown link', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [row('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
      combinedPreviewUrl: 'https://preview.vercel.app/x)](https://evil/a.png)',
    });
    // No raw `](` breakout delimiter from the attacker-controlled preview URL.
    expect(body).not.toContain('x)](https://evil');
    expect(body).toContain('%29'); // encoded paren survives
  });

  test('#247 UX.17: falls back to a plain embedded image when no preview URL is known', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [row('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(body).toContain('![combined preview](https://cdn/x.png)');
    expect(body).not.toContain('[![combined preview]'); // not a linked image
    expect(body).not.toContain('Open the combined preview');
  });

  test('rows are sorted by identifier for a stable edited body', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        row('z', 'released', { linear_identifier: 'ENG-9' }),
        row('a', 'released', { linear_identifier: 'ENG-1' }),
      ],
    });
    expect(body.indexOf('ENG-1')).toBeLessThan(body.indexOf('ENG-9'));
  });
});

describe('buildPanelRows (K1 — failureReasons map → row.failureReason)', () => {
  const child = (sub: string, status: string): OrchestrationChildRow => ({
    orchestration_id: 'orch_1',
    sub_issue_id: sub,
    parent_linear_issue_id: 'parent',
    linear_workspace_id: 'ws',
    repo: 'o/r',
    depends_on: [],
    child_status: status as OrchestrationChildRow['child_status'],
    created_at: 'now',
    updated_at: 'now',
  });

  test('attaches the reason to the matching failed row, and only that row', () => {
    const rows = buildPanelRows(
      [child('a', 'succeeded'), child('orch_1__integration', 'failed')],
      {},
      {},
      { orch_1__integration: 'Combined build failed — see CloudWatch for task `t-int`.' },
    );
    expect(rows.find((r) => r.sub_issue_id === 'a')?.failureReason).toBeUndefined();
    expect(rows.find((r) => r.sub_issue_id === 'orch_1__integration')?.failureReason)
      .toMatch(/Combined build failed/);
  });

  test('omits failureReason when no map is supplied (back-compat)', () => {
    const rows = buildPanelRows([child('a', 'failed')]);
    expect(rows[0].failureReason).toBeUndefined();
  });
});
