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

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/handlers/shared/logger', () => ({ logger: loggerMock }));

import { LOOKUP_ABSENT, isLookupFailure, lookupFound } from '../../../src/handlers/shared/lookup-result';
import type { IssueRef } from '../../../src/handlers/shared/orchestration-channel';
import { channelForSource, registerChannelFactory } from '../../../src/handlers/shared/orchestration-channel-factory';
import {
  renderEpicPanel,
  buildPanelRows,
  cascadeNodeLabel,
  upsertEpicPanel,
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
    // A blank id must not be persisted — the next edit would address a comment
    // that doesn't exist. "No id" is the honest answer.
    channel.upsertComment.mockResolvedValue({ commentId: '' });
    expect(await upsertEpicPanel({ channel, parent, children: [row('a', 'running')] })).toEqual(LOOKUP_ABSENT);
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

  test('a DOWNSTREAM surface the core never imports drives the panel end to end', async () => {
    // The extensibility claim, exercised rather than asserted about: this surface
    // exists only in this test, is resolved through the same registry lookup the
    // reconciler uses, and reaches the engine with no edit to the interface, the
    // lookup, or the rollup. It has reactions and no workflow state.
    const posted: Array<{ issue: string; body: string }> = [];
    const replaceIssueReaction = jest.fn<Promise<boolean>, unknown[]>().mockResolvedValue(true);
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
      // No transitionState: the engine skips the transition it is asked for.
      replaceIssueReaction,
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

      expect(id).toEqual(lookupFound('acme-panel-1'));
      expect(posted).toHaveLength(1);
      expect(posted[0].issue).toBe('acme-epic-1');
      // The panel body is the engine's own rendering — the surface supplied none of it.
      expect(posted[0].body).toContain('ABCA orchestration complete');
      // The marker is applied although there is no workflow state to move.
      expect(replaceIssueReaction).toHaveBeenCalledWith({ issueId: 'acme-epic-1', credentialsRef: 'acme-tenant-1' }, 'succeeded');
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

  /** The row lines of a panel body, in the order they are shown. */
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
    // The synthetic node has no identifier, so it was sorted by its id
    // (orch_<hash>__integration), which comes before WEB-1 and after ENG-1.
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
