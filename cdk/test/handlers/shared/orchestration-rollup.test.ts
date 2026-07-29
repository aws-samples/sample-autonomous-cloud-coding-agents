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

const slackFetchMock = jest.fn();
const slackFetchTsMock = jest.fn();
jest.mock('../../../src/handlers/shared/slack-api', () => ({
  slackFetch: (...a: unknown[]) => slackFetchMock(...a),
  slackFetchTs: (...a: unknown[]) => slackFetchTsMock(...a),
}));
jest.mock('../../../src/handlers/shared/slack-verify', () => ({
  SLACK_SECRET_PREFIX: 'bgagent/slack/',
  getSlackSecret: async () => 'xoxb-token',
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

import type { IssueRef } from '../../../src/handlers/shared/orchestration-channel';
import { channelForSource, registerChannelFactory } from '../../../src/handlers/shared/orchestration-channel-factory';
import { makeSlackChannel, slackThreadRef } from '../../../src/handlers/shared/orchestration-channel-slack';
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
  upsertEpicPanel,
  type RollupChildView,
  type EpicPanelRow,
} from '../../../src/handlers/shared/orchestration-rollup';
import type { OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';
import { DEFAULT_LABEL_FILTER } from '../../../src/handlers/shared/trigger-label';

/**
 * A stand-in surface adapter. The rollup is exercised through the Channel it
 * actually calls, so these tests assert the neutral operations (and the
 * capability guards) rather than any one surface's API.
 */
type FakeChannel = ReturnType<typeof makeFakeChannel>;

function makeFakeChannel() {
  return {
    kind: 'linear' as const,
    postComment: jest.fn<Promise<{ commentId: string } | null>, unknown[]>()
      .mockResolvedValue({ commentId: '' }),
    upsertComment: jest.fn<Promise<{ commentId: string } | null>, unknown[]>()
      .mockResolvedValue({ commentId: 'cmt-1' }),
    reportFailure: jest.fn<Promise<void>, unknown[]>().mockResolvedValue(undefined),
    transitionState: jest.fn<Promise<boolean>, unknown[]>().mockResolvedValue(true),
    replaceIssueReaction: jest.fn<Promise<boolean>, unknown[]>().mockResolvedValue(true),
  };
}

const parent: IssueRef = { issueId: 'PARENT', credentialsRef: 'WS' };
let channel: FakeChannel;

const view = (sub: string, status: string, ident?: string, title?: string, pr_url?: string): RollupChildView => ({
  sub_issue_id: sub,
  child_status: status,
  ...(ident && { display_id: ident }),
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

  // Per-child PR links + integration-node combined-PR callout.
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

describe('renderStatusBlock — the live status block', () => {
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

  test('links a child PR in the live block when pr_url is known', () => {
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

describe('upsertEpicPanel — the maturing panel + parent-state mirror', () => {
  beforeEach(() => {
    slackFetchMock.mockReset().mockResolvedValue(true);
    slackFetchTsMock.mockReset().mockResolvedValue('1700000000.002');
    channel = makeFakeChannel();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  test('edits the existing panel comment in place when given its id', async () => {
    const id = await upsertEpicPanel({
      channel, parent, statusCommentId: 'panel-1', children: [row('a', 'running')],
    });
    expect(id).toBe('cmt-1');
    const [, , existing] = channel.upsertComment.mock.calls[0];
    expect(existing).toEqual({ commentId: 'panel-1' });
  });

  test('a surface that returns no usable comment id reports no panel id', async () => {
    // A blank id must not be persisted — the next edit would address a comment
    // that doesn't exist. "No id" is the honest answer.
    channel.upsertComment.mockResolvedValue({ commentId: '' });
    expect(await upsertEpicPanel({ channel, parent, children: [row('a', 'running')] })).toBeNull();
  });

  test('in progress → re-opens the parent to running (regression allowed) + 👀', async () => {
    // A settled epic sits in awaiting-review; re-opening moves backward WITHIN
    // the same state category, which the adapter refuses unless asked. Without
    // the opt-in the re-open is silently dropped and the epic reads finished
    // while children are running.
    await upsertEpicPanel({
      channel, parent, children: [row('a', 'running')], inProgress: true, mirrorParentState: true,
    });
    expect(channel.transitionState).toHaveBeenCalledWith(parent, 'started', { allowRegression: true });
    expect(channel.replaceIssueReaction).toHaveBeenCalledWith(parent, 'started');
  });

  test('all succeeded → advances to awaiting-review + ✅', async () => {
    await upsertEpicPanel({
      channel, parent, children: [row('a', 'succeeded')], inProgress: false, mirrorParentState: true,
    });
    expect(channel.transitionState).toHaveBeenCalledWith(parent, 'in_review');
    expect(channel.replaceIssueReaction).toHaveBeenCalledWith(parent, 'succeeded');
  });

  test('finished with failures → leaves the state, marks ❌', async () => {
    await upsertEpicPanel({
      channel,
      parent,
      children: [row('a', 'succeeded'), row('b', 'failed')],
      inProgress: false,
      mirrorParentState: true,
    });
    expect(channel.transitionState).not.toHaveBeenCalled();
    expect(channel.replaceIssueReaction).toHaveBeenCalledWith(parent, 'failed');
  });

  test('mirrorParentState: false edits the panel only — no state or reaction', async () => {
    await upsertEpicPanel({
      channel, parent, children: [row('a', 'succeeded')], inProgress: false, mirrorParentState: false,
    });
    expect(channel.upsertComment).toHaveBeenCalled();
    expect(channel.transitionState).not.toHaveBeenCalled();
    expect(channel.replaceIssueReaction).not.toHaveBeenCalled();
  });

  test('the REAL Slack adapter drives the epic panel, with its omitted ops skipped', async () => {
    // The engine claim under test: an unmodified rollup drives a genuinely
    // different surface. Slack omits transitionState/revertState (no workflow
    // state), so the capability guards must skip them and still deliver the
    // panel — proving the abstraction on a real adapter, not a fake.
    const slack = makeSlackChannel();
    const id = await upsertEpicPanel({
      channel: slack,
      parent: { issueId: slackThreadRef('C1', '1700000000.001'), credentialsRef: 'T1' },
      children: [row('a', 'succeeded')],
      inProgress: false,
      mirrorParentState: true, // asks for a state mirror Slack cannot do
    });
    // The panel landed...
    expect(id).toBe('1700000000.002');
    expect(slackFetchTsMock).toHaveBeenCalled();
    // ...the ✅ marker went on the thread root...
    const adds = slackFetchMock.mock.calls.filter((c) => c[1] === 'reactions.add');
    expect((adds[0][2] as { name: string }).name).toBe('white_check_mark');
    // ...and NOTHING attempted a state transition (there is no such Slack method).
    const methods = [
      ...slackFetchMock.mock.calls.map((c) => c[1]),
      ...slackFetchTsMock.mock.calls.map((c) => c[1]),
    ];
    expect(methods.every((m) => typeof m === 'string' && m.startsWith('chat.') || String(m).startsWith('reactions.'))).toBe(true);
  });

  test('a DOWNSTREAM surface the core never imports drives the panel end to end', async () => {
    // The extensibility claim, exercised rather than asserted about: this surface
    // exists only in this test, is resolved through the same registry lookup the
    // reconciler uses, and reaches the engine with no edit to the interface, the
    // lookup, or the rollup. Slack proves the interface fits a non-tracker, but it
    // ships in-tree — so it cannot show that nothing in the core has to know.
    const posted: Array<{ issue: string; body: string }> = [];
    const unregister = registerChannelFactory('acme-tracker', (registryTable) => ({
      kind: 'acme-tracker',
      postComment: async () => null,
      upsertComment: async (issue, body) => {
        // The per-surface credentials table reached the adapter, so a panel is
        // addressed with this tenant's credentials and not another surface's.
        expect(registryTable).toBe('AcmeRegistry');
        posted.push({ issue: issue.issueId, body });
        return { commentId: 'acme-panel-1' };
      },
      reportFailure: async () => undefined,
      // Reactions supported; workflow state deliberately NOT — a third capability
      // shape, different from both Linear (all of it) and Slack (none of it).
      replaceIssueReaction: async () => true,
    }));
    try {
      const channelFromRegistry = channelForSource('acme-tracker', { 'acme-tracker': 'AcmeRegistry' });
      expect(channelFromRegistry).toBeDefined();

      const id = await upsertEpicPanel({
        channel: channelFromRegistry!,
        parent: { issueId: 'acme-epic-1', credentialsRef: 'acme-tenant-1' },
        children: [row('a', 'succeeded')],
        inProgress: false,
        mirrorParentState: true, // asks for a transition this surface cannot do
      });

      expect(id).toBe('acme-panel-1');
      expect(posted).toHaveLength(1);
      expect(posted[0].issue).toBe('acme-epic-1');
      // The panel body is the engine's own rendering — the surface supplied none of it.
      expect(posted[0].body).toContain('ABCA orchestration complete');
    } finally {
      unregister();
    }
  });

  test('a surface without reactions or transitions still gets its panel', async () => {
    const commentOnly = makeFakeChannel();
    delete (commentOnly as Partial<FakeChannel>).transitionState;
    delete (commentOnly as Partial<FakeChannel>).replaceIssueReaction;
    const id = await upsertEpicPanel({
      channel: commentOnly, parent, children: [row('a', 'succeeded')], mirrorParentState: true,
    });
    expect(id).toBe('cmt-1');
  });

  test('a panel-comment failure is swallowed and reported as no id', async () => {
    channel.upsertComment.mockRejectedValue(new Error('surface hiccup'));
    expect(await upsertEpicPanel({ channel, parent, children: [row('a', 'running')] })).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  test('a mirror failure does not lose the panel id already obtained', async () => {
    channel.transitionState.mockRejectedValue(new Error('states query timed out'));
    const id = await upsertEpicPanel({
      channel, parent, children: [row('a', 'succeeded')], inProgress: false, mirrorParentState: true,
    });
    expect(id).toBe('cmt-1');
  });
});

describe('postRollup', () => {
  beforeEach(() => {
    channel = makeFakeChannel();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  test('success → posts comment + logs orch.rollup.posted', async () => {
    const ok = await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(ok).toBe(true);
    expect(channel.postComment).toHaveBeenCalledTimes(1);
    // The stable log event automated tests grep for.
    const posted = loggerMock.info.mock.calls.find((c) => c[1]?.event === ORCH_LOG.rollupPosted);
    expect(posted).toBeDefined();
    expect(posted![1]).toMatchObject({ orchestration_id: 'orch_1', parent_issue_id: 'PARENT', rollup_kind: 'complete' });
  });

  test('complete → advances parent to awaiting-review + ✅ reaction (mirrors children)', async () => {
    await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(channel.transitionState).toHaveBeenCalledWith(parent, 'in_review');
    expect(channel.replaceIssueReaction).toHaveBeenCalledWith(parent, 'succeeded');
  });

  test('partial_failure → does NOT advance state, swaps to ❌ reaction', async () => {
    await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'partial_failure',
      children: [row('a', 'failed')],
    });
    expect(channel.transitionState).not.toHaveBeenCalled();
    expect(channel.replaceIssueReaction).toHaveBeenCalledWith(parent, 'failed');
  });

  test('comment fails → does NOT transition state or react (state mirrors only on posted rollup)', async () => {
    channel.postComment.mockResolvedValue(null);
    await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(channel.transitionState).not.toHaveBeenCalled();
    expect(channel.replaceIssueReaction).not.toHaveBeenCalled();
  });

  test('post returns false → logs orch.rollup.failed, returns false', async () => {
    channel.postComment.mockResolvedValue(null);
    const ok = await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'partial_failure',
      children: [row('a', 'failed')],
    });
    expect(ok).toBe(false);
    expect(loggerMock.warn.mock.calls.some((c) => c[1]?.event === ORCH_LOG.rollupFailed)).toBe(true);
  });

  test('a surface without reactions or transitions still posts the rollup', async () => {
    // The capability guards must skip the mirror rather than throw, so a
    // comment-only surface gets the rollup comment and nothing else.
    const commentOnly = makeFakeChannel();
    delete (commentOnly as Partial<FakeChannel>).transitionState;
    delete (commentOnly as Partial<FakeChannel>).replaceIssueReaction;
    const ok = await postRollup({
      channel: commentOnly,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(ok).toBe(true);
    expect(commentOnly.postComment).toHaveBeenCalledTimes(1);
  });

  test('with statusCommentId → EDITS the live block in place (no fresh comment)', async () => {
    const ok = await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded')],
      statusCommentId: 'cmt-1',
    });
    expect(ok).toBe(true);
    // Edited the existing comment; did NOT post a fresh one.
    expect(channel.upsertComment).toHaveBeenCalledWith(parent, expect.any(String), { commentId: 'cmt-1' });
    expect(channel.postComment).not.toHaveBeenCalled();
  });

  test('threads prUrls → rendered comment links child PRs + combined PR', async () => {
    await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded'), row('orch_1__integration', 'succeeded')],
      prUrls: {
        a: 'https://github.com/o/r/pull/3',
        orch_1__integration: 'https://github.com/o/r/pull/9',
      },
    });
    const body = channel.postComment.mock.calls[0][1] as string;
    expect(body).toContain('[PR](https://github.com/o/r/pull/3)');
    expect(body).toContain('🔗 **Combined PR (all sub-issues merged):**');
    expect(body).toContain('https://github.com/o/r/pull/9');
  });

  test('without statusCommentId → posts a fresh comment', async () => {
    await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
      kind: 'complete',
      children: [row('a', 'succeeded')],
    });
    expect(channel.postComment).toHaveBeenCalledTimes(1);
    expect(channel.upsertComment).not.toHaveBeenCalled();
  });

  test('post throws → swallowed, logs orch.rollup.failed, returns false', async () => {
    channel.postComment.mockRejectedValue(new Error('surface down'));
    const ok = await postRollup({
      channel,
      parent,
      orchestrationId: 'orch_1',
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

describe('cascadeNodeLabel — the short name used inside a cascade reason', () => {
  test('integration node → "the integration" (not its raw synthetic title)', () => {
    // The raw integration-node title read clumsily
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

describe('renderEpicPanel — the single maturing panel', () => {
  // Named for its shape: an EpicPanelRow (what the panel renders), distinct from
  // the file-level `row`, which builds an OrchestrationChildRow (what is stored).
  const panelRow = (sub: string, status: string, opts: Partial<EpicPanelRow> = {}): EpicPanelRow => ({
    sub_issue_id: sub, child_status: status, ...opts,
  });

  test('in-progress header shows N/M complete', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('a', 'succeeded', { display_id: 'ENG-1', title: 'A' }),
        panelRow('b', 'released', { display_id: 'ENG-2', title: 'B' }),
        panelRow('c', 'blocked', { display_id: 'ENG-3', title: 'C' }),
      ],
    });
    expect(body).toContain('🔄 **ABCA orchestration** · 1/3 complete');
    expect(body).toContain('✅ ENG-1: A — succeeded');
    expect(body).toContain('🔄 ENG-2: B — running');
    expect(body).toContain('⏳ ENG-3: C — blocked');
  });

  test('all settled + ok → complete header; failures → ⚠️', () => {
    expect(renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded')] }))
      .toContain('✅ **ABCA orchestration complete**');
    expect(renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded'), panelRow('b', 'failed')] }))
      .toContain('⚠️ **ABCA orchestration finished with failures**');
  });

  // A SETTLED-with-failures panel tells the user how to retry. Not shown while
  // in-flight or on a clean complete.
  test('the retry hint leads with the comment and offers the label only as a fallback', () => {
    // Presenting the two as equivalent was wrong: re-applying the label is a
    // gesture with four possible meanings (add sub-issues / retry / still running /
    // already complete) resolved from graph state, so on an epic that gained a
    // sub-issue AND has a failure it does strictly more than a retry.
    const body = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded'), panelRow('b', 'failed')] });
    expect(body).toContain('To retry:');
    expect(body).toContain('`@bgagent retry`');
    // The label is still discoverable — just not billed as the same thing. It
    // must be the label that actually TRIGGERS: this assertion previously pinned
    // a hardcoded project-specific label, so the hint told users to re-apply
    // something the webhook does not filter on and nothing happened.
    expect(body).toContain('re-applying the `bgagent` label');
    expect(body).not.toContain('either way');
    // The comment must be named before the label, so the reliable route reads first.
    expect(body.indexOf('`@bgagent retry`')).toBeLessThan(body.indexOf('re-applying'));
  });

  test('the retry hint names the project\'s own trigger label, not a hardcoded one', () => {
    // The trigger label is per-project configurable, so a hint that hardcodes one
    // is wrong for every project that renamed it — the user follows the
    // instruction and nothing fires.
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded'), panelRow('b', 'failed')],
      labelFilter: 'ship',
    });
    expect(body).toContain('re-applying the `ship` label');
    expect(body).not.toContain('`bgagent` label');
  });

  test('the retry hint falls back to the platform default label when none is supplied', () => {
    const body = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded'), panelRow('b', 'failed')] });
    expect(body).toContain(`re-applying the \`${DEFAULT_LABEL_FILTER}\` label`);
  });

  test('no retry hint on a clean complete, or while still in progress', () => {
    expect(renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded')] }))
      .not.toContain('To retry:');
    // in-flight, even with a not-yet-terminal failed sibling shown: no hint until settled.
    expect(renderEpicPanel({ inProgress: true, rows: [panelRow('a', 'released'), panelRow('b', 'failed')] }))
      .not.toContain('To retry:');
  });

  test('PR link shown ONLY when a PR exists (first run mid-flight has none)', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('a', 'released', { display_id: 'ENG-1', title: 'A' }), // running, no PR yet
        panelRow('b', 'succeeded', { display_id: 'ENG-2', title: 'B', pr_url: 'https://github.com/o/r/pull/9' }),
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
        panelRow('a', 'succeeded', {
          display_id: 'ENG-1',
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
        panelRow('a', 'succeeded', { updatingReason: 'to include ENG-3\'s change' }),
        panelRow('b', 'succeeded'),
      ],
    });
    expect(body).toContain('· 1/2 complete'); // only b counts as done
  });

  test('integration node renders friendly, never its raw id', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [
        panelRow('a', 'succeeded', { display_id: 'ENG-1' }),
        panelRow('orch_x__integration', 'succeeded', { pr_url: 'https://github.com/o/r/pull/9' }),
      ],
      combinedPrUrl: 'https://github.com/o/r/pull/9',
    });
    expect(body).toContain('Integration — combined result');
    expect(body).not.toContain('orch_x__integration');
    expect(body).toContain('🔗 **Combined PR (all sub-issues merged):**');
  });

  test('a failed row renders an indented diagnostic sub-line (what failed + where to read it)', () => {
    const reason = 'Combined build failed after merging the sub-issue branches — see the build log in CloudWatch for task `t-int`.';
    const body = renderEpicPanel({
      inProgress: false,
      rows: [
        panelRow('a', 'succeeded', { display_id: 'ENG-1' }),
        panelRow('orch_x__integration', 'failed', { failureReason: reason }),
      ],
    });
    // The integration row + its sub-line on the very next line (indented ↳).
    expect(body).toContain(`- ❌ Integration — combined result — failed\n    ↳ ${reason}`);
  });

  test('the sub-line is ONLY rendered for failed rows (not succeeded/skipped/running)', () => {
    const reason = 'should not appear';
    const succeeded = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded', { failureReason: reason })] });
    expect(succeeded).not.toContain('↳');
    expect(succeeded).not.toContain(reason);
    // A skipped row (predecessor failed) gets no sub-line either — only the
    // node that actually failed carries the diagnostic.
    const skipped = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'skipped', { failureReason: reason })] });
    expect(skipped).not.toContain('↳');
  });

  test('a failed row with NO reason resolved still renders cleanly (no dangling ↳)', () => {
    const body = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'failed', { display_id: 'ENG-1' })] });
    expect(body).toContain('❌ ENG-1 — failed');
    expect(body).not.toContain('↳');
  });

  test('embeds the preview screenshot when present', () => {
    // No combinedPrUrl → no integration node merged anything, so this is the
    // final node's own preview and must NOT be labelled "combined".
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(body).toContain('🖼️ **Preview**');
    expect(body).toContain('![preview](https://cdn/x.png)');
  });

  test('labels it "Combined preview" only when an integration node merged the leaves', () => {
    // The combined PR callout is the signal that several leaves were merged.
    // Calling a chain's final-node preview "combined" would tell a reviewer
    // branches were merged when none were.
    const combined = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedPrUrl: 'https://github.com/o/r/pull/99',
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(combined).toContain('🖼️ **Combined preview**');
    const chain = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(chain).not.toContain('Combined preview');
  });

  test('makes the combined preview a clickable deep-link when the preview URL is known', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
      combinedPreviewUrl: 'https://my-app-abc123.vercel.app',
    });
    expect(body).toContain('🖼️ **Preview**');
    // Linked image: the embedded screenshot opens the running site.
    expect(body).toContain('[![preview](https://cdn/x.png)](https://my-app-abc123.vercel.app)');
    // Plain "open it" link too, for clients that don't render linked images.
    expect(body).toContain('[Open the preview](https://my-app-abc123.vercel.app)');
  });

  test('percent-encodes parens in the preview URL so it cannot break out of the markdown link', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
      combinedPreviewUrl: 'https://preview.vercel.app/x)](https://evil/a.png)',
    });
    // No raw `](` breakout delimiter from the attacker-controlled preview URL.
    expect(body).not.toContain('x)](https://evil');
    expect(body).toContain('%29'); // encoded paren survives
  });

  test('falls back to a plain embedded image when no preview URL is known', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(body).toContain('![preview](https://cdn/x.png)');
    expect(body).not.toContain('[![preview]'); // not a linked image
    expect(body).not.toContain('Open the preview');
  });

  test('rows are sorted by identifier for a stable edited body', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('z', 'released', { display_id: 'ENG-9' }),
        panelRow('a', 'released', { display_id: 'ENG-1' }),
      ],
    });
    expect(body.indexOf('ENG-1')).toBeLessThan(body.indexOf('ENG-9'));
  });
});

describe('buildPanelRows — the failureReasons map lands on row.failureReason', () => {
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
