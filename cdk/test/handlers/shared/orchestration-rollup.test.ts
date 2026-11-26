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

import { LOOKUP_ABSENT, isLookupFailure, lookupFound } from '../../../src/handlers/shared/lookup-result';
import type { IssueRef } from '../../../src/handlers/shared/orchestration-channel';
import { channelForSource, registerChannelFactory } from '../../../src/handlers/shared/orchestration-channel-factory';
import { makeSlackChannel, slackThreadRef } from '../../../src/handlers/shared/orchestration-channel-slack';
import {
  renderEpicPanel,
  buildPanelRows,
  cascadeNodeLabel,
  upsertEpicPanel,
  type EpicPanelRow,
} from '../../../src/handlers/shared/orchestration-rollup';
import type { OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';
import { DEFAULT_LABEL_FILTER } from '../../../src/handlers/shared/trigger-label';

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

const row = (sub: string, status: string): OrchestrationChildRow => ({
  orchestration_id: 'orch_1',
  sub_issue_id: sub,
  parent_issue_ref: 'PARENT',
  credentials_ref: 'WS',
  repo: 'o/r',
  depends_on: [],
  child_status: status as never,
  created_at: 'now',
  updated_at: 'now',
});

describe('upsertEpicPanel — the maturing panel + parent-state mirror', () => {
  beforeEach(() => {
    slackFetchMock.mockReset().mockResolvedValue(true);
    slackFetchTsMock.mockReset().mockResolvedValue(lookupFound('1700000000.002'));
    channel = makeFakeChannel();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  test('edits the existing panel comment in place when given its id', async () => {
    const id = await upsertEpicPanel({
      channel, parent, statusCommentId: 'panel-1', children: [row('a', 'running')],
    });
    expect(id).toEqual(lookupFound('cmt-1'));
    const [, , existing] = channel.upsertComment.mock.calls[0];
    expect(existing).toEqual({ commentId: 'panel-1' });
  });

  test('a surface that returns no usable comment id reports no panel id', async () => {
    channel.upsertComment.mockResolvedValue({ commentId: '' });
    expect(await upsertEpicPanel({ channel, parent, children: [row('a', 'running')] })).toEqual(LOOKUP_ABSENT);
  });

  test('in progress → re-opens the parent to running (regression allowed) + 👀', async () => {
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
    const slack = makeSlackChannel();
    const id = await upsertEpicPanel({
      channel: slack,
      parent: { issueId: slackThreadRef('C1', '1700000000.001'), credentialsRef: 'T1' },
      children: [row('a', 'succeeded')],
      inProgress: false,
      mirrorParentState: true,
    });
    expect(id).toEqual(lookupFound('1700000000.002'));
    expect(slackFetchTsMock).toHaveBeenCalled();
    const adds = slackFetchMock.mock.calls.filter((c) => c[1] === 'reactions.add');
    expect((adds[0][2] as { name: string }).name).toBe('white_check_mark');
    const methods = [
      ...slackFetchMock.mock.calls.map((c) => c[1]),
      ...slackFetchTsMock.mock.calls.map((c) => c[1]),
    ];
    expect(methods.every((m) => typeof m === 'string' && m.startsWith('chat.') || String(m).startsWith('reactions.'))).toBe(true);
  });

  test('a DOWNSTREAM surface the core never imports drives the panel end to end', async () => {
    const posted: Array<{ issue: string; body: string }> = [];
    const unregister = registerChannelFactory('acme-tracker', (registryTable) => ({
      kind: 'acme-tracker',
      postComment: async () => null,
      upsertComment: async (issue, body) => {
        expect(registryTable).toBe('AcmeRegistry');
        posted.push({ issue: issue.issueId, body });
        return { commentId: 'acme-panel-1' };
      },
      reportFailure: async () => undefined,
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
        mirrorParentState: true,
      });

      expect(id).toEqual(lookupFound('acme-panel-1'));
      expect(posted).toHaveLength(1);
      expect(posted[0].issue).toBe('acme-epic-1');
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
    expect(id).toEqual(lookupFound('cmt-1'));
  });

  test('a panel-comment failure is reported as a lookup failure', async () => {
    channel.upsertComment.mockRejectedValue(new Error('surface hiccup'));
    expect(isLookupFailure(await upsertEpicPanel({ channel, parent, children: [row('a', 'running')] }))).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  test('a mirror failure does not lose the panel id already obtained', async () => {
    channel.transitionState.mockRejectedValue(new Error('states query timed out'));
    const id = await upsertEpicPanel({
      channel, parent, children: [row('a', 'succeeded')], inProgress: false, mirrorParentState: true,
    });
    expect(id).toEqual(lookupFound('cmt-1'));
  });
});

describe('cascadeNodeLabel — the short name used inside a cascade reason', () => {
  test('integration node → "the integration" (not its raw synthetic title)', () => {
    const label = cascadeNodeLabel('orch_abc__integration', undefined, 'Integration — combine sub-issue results');
    expect(label).toBe('the integration');
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

  test('the retry hint leads with the comment and offers the label only as a fallback', () => {
    const body = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded'), panelRow('b', 'failed')] });
    expect(body).toContain('To retry:');
    expect(body).toContain('`@bgagent retry`');
    expect(body).toContain('re-applying the `bgagent` label');
    expect(body).not.toContain('either way');
    expect(body.indexOf('`@bgagent retry`')).toBeLessThan(body.indexOf('re-applying'));
  });

  test('the retry hint names the project\'s own trigger label, not a hardcoded one', () => {
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
    expect(renderEpicPanel({ inProgress: true, rows: [panelRow('a', 'released'), panelRow('b', 'failed')] }))
      .not.toContain('To retry:');
  });

  test('PR link shown ONLY when a PR exists (first run mid-flight has none)', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('a', 'released', { display_id: 'ENG-1', title: 'A' }),
        panelRow('b', 'succeeded', { display_id: 'ENG-2', title: 'B', pr_url: 'https://github.com/o/r/pull/9' }),
      ],
    });
    expect(body).toContain('🔄 ENG-1: A — running\n');
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
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('a', 'succeeded', { updatingReason: 'to include ENG-3\'s change' }),
        panelRow('b', 'succeeded'),
      ],
    });
    expect(body).toContain('· 1/2 complete');
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
    expect(body).toContain(`- ❌ Integration — combined result — failed\n    ↳ ${reason}`);
  });

  test('the sub-line is ONLY rendered for failed rows (not succeeded/skipped/running)', () => {
    const reason = 'should not appear';
    const succeeded = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'succeeded', { failureReason: reason })] });
    expect(succeeded).not.toContain('↳');
    expect(succeeded).not.toContain(reason);
    const skipped = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'skipped', { failureReason: reason })] });
    expect(skipped).not.toContain('↳');
  });

  test('a failed row with NO reason resolved still renders cleanly (no dangling ↳)', () => {
    const body = renderEpicPanel({ inProgress: false, rows: [panelRow('a', 'failed', { display_id: 'ENG-1' })] });
    expect(body).toContain('❌ ENG-1 — failed');
    expect(body).not.toContain('↳');
  });

  test('embeds the preview screenshot when present', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(body).toContain('🖼️ **Preview**');
    expect(body).toContain('![preview](https://cdn/x.png)');
  });

  test('labels it "Combined preview" only when an integration node merged the leaves', () => {
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
    expect(body).toContain('[![preview](https://cdn/x.png)](https://my-app-abc123.vercel.app)');
    expect(body).toContain('[Open the preview](https://my-app-abc123.vercel.app)');
  });

  test('percent-encodes parens in the preview URL so it cannot break out of the markdown link', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
      combinedPreviewUrl: 'https://preview.vercel.app/x)](https://evil/a.png)',
    });
    expect(body).not.toContain('x)](https://evil');
    expect(body).toContain('%29');
  });

  test('falls back to a plain embedded image when no preview URL is known', () => {
    const body = renderEpicPanel({
      inProgress: false,
      rows: [panelRow('a', 'succeeded')],
      combinedScreenshotUrl: 'https://cdn/x.png',
    });
    expect(body).toContain('![preview](https://cdn/x.png)');
    expect(body).not.toContain('[![preview]');
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

  const rowLines = (body: string) => body.split('\n').filter((line) => line.startsWith('- '));

  test('identifiers are sorted by their number: ENG-9 comes before ENG-10', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('c', 'released', { display_id: 'ENG-11' }),
        panelRow('b', 'blocked', { display_id: 'ENG-10' }),
        panelRow('a', 'succeeded', { display_id: 'ENG-9' }),
      ],
    });
    expect(rowLines(body)).toEqual([
      '- ✅ ENG-9 — succeeded',
      '- ⏳ ENG-10 — blocked',
      '- 🔄 ENG-11 — running',
    ]);
  });

  test('the integration row is the last one, whatever the team key', () => {
    const body = renderEpicPanel({
      inProgress: true,
      rows: [
        panelRow('orch_abc__integration', 'blocked'),
        panelRow('b', 'released', { display_id: 'WEB-2' }),
        panelRow('a', 'succeeded', { display_id: 'WEB-1' }),
      ],
    });
    expect(rowLines(body)).toEqual([
      '- ✅ WEB-1 — succeeded',
      '- 🔄 WEB-2 — running',
      '- ⏳ Integration — combined result — blocked',
    ]);
  });
});

describe('buildPanelRows — the failureReasons map lands on row.failureReason', () => {
  const child = (sub: string, status: string): OrchestrationChildRow => ({
    orchestration_id: 'orch_1',
    sub_issue_id: sub,
    parent_issue_ref: 'parent',
    credentials_ref: 'ws',
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
