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

// Mock at the Slack transport so the adapter's real mapping (channel op → Slack
// method + params) is what's asserted, with no network.
const slackFetchMock = jest.fn();
const slackFetchTsMock = jest.fn();
jest.mock('../../../src/handlers/shared/slack-api', () => ({
  slackFetch: (...a: unknown[]) => slackFetchMock(...a),
  slackFetchTs: (...a: unknown[]) => slackFetchTsMock(...a),
}));

const getSlackSecretMock = jest.fn();
jest.mock('../../../src/handlers/shared/slack-verify', () => ({
  SLACK_SECRET_PREFIX: 'bgagent/slack/',
  getSlackSecret: (...a: unknown[]) => getSlackSecretMock(...a),
}));

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { type IssueRef } from '../../../src/handlers/shared/orchestration-channel';
import { makeSlackChannel, slackThreadRef } from '../../../src/handlers/shared/orchestration-channel-slack';

/** A Slack "issue" is a thread: channel + thread_ts, keyed by team_id. */
const thread: IssueRef = { issueId: slackThreadRef('C123', '1700000000.001'), credentialsRef: 'T99' };

beforeEach(() => {
  jest.clearAllMocks();
  getSlackSecretMock.mockResolvedValue('xoxb-token');
  slackFetchMock.mockResolvedValue(true);
  slackFetchTsMock.mockResolvedValue('1700000000.002');
});

describe('Slack channel adapter — the capability-gated surface', () => {
  const ch = makeSlackChannel();

  test('kind is slack', () => expect(ch.kind).toBe('slack'));

  test('OMITS the workflow-state ops, because Slack has no workflow state', () => {
    // The point of the whole capability split: these must be ABSENT, not stubbed
    // to a silent success. A no-op that returns true would tell the engine the
    // platform mirrored a state it never moved.
    expect('transitionState' in ch).toBe(false);
    expect('revertState' in ch).toBe(false);
    // Slack has no dependency model, so a DAG can't be read from it.
    expect('fetchChildGraph' in ch).toBe(false);
    // Bulk-deleting messages in a shared channel needs its own decision.
    expect('sweepNotes' in ch).toBe(false);
  });

  test('still satisfies the required contract every surface must support', () => {
    expect(typeof ch.postComment).toBe('function');
    expect(typeof ch.upsertComment).toBe('function');
    expect(typeof ch.reportFailure).toBe('function');
  });

  test('resolves the bot token per WORKSPACE, from the ref credentials', () => {
    // A wrong token would post into a different customer's Slack.
    return ch.postComment(thread, 'hi').then(() => {
      expect(getSlackSecretMock).toHaveBeenCalledWith('bgagent/slack/T99');
    });
  });

  test('postComment posts INTO the thread and returns the new message ts', async () => {
    const res = await ch.postComment(thread, 'hello');
    expect(res).toEqual({ commentId: '1700000000.002' });
    const [token, method, body] = slackFetchTsMock.mock.calls[0];
    expect(token).toBe('xoxb-token');
    expect(method).toBe('chat.postMessage');
    expect(body).toMatchObject({ channel: 'C123', thread_ts: '1700000000.001', text: 'hello' });
  });

  test('upsertComment EDITS the given message in place — the maturing panel', async () => {
    // Without edit-in-place a Slack epic would stream a new message per
    // transition, which is the surface this design exists to avoid.
    slackFetchTsMock.mockResolvedValue('1700000000.005');
    const res = await ch.upsertComment(thread, 'panel v2', { commentId: '1700000000.005' });
    expect(res).toEqual({ commentId: '1700000000.005' });
    const [, method, body] = slackFetchTsMock.mock.calls[0];
    expect(method).toBe('chat.update');
    expect(body).toMatchObject({ channel: 'C123', ts: '1700000000.005', text: 'panel v2' });
    expect(body).not.toHaveProperty('thread_ts'); // an edit targets a ts, not a thread
  });

  test('upsertComment with no existing ref posts a fresh in-thread message', async () => {
    await ch.upsertComment(thread, 'panel v1');
    expect(slackFetchTsMock.mock.calls[0][1]).toBe('chat.postMessage');
  });

  test('reactToComment ADDS without clearing anything', async () => {
    await ch.reactToComment!({ commentId: '1700000000.009' }, thread, 'started');
    const calls = slackFetchMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('reactions.add');
    expect(calls[0][2]).toMatchObject({ channel: 'C123', timestamp: '1700000000.009', name: 'eyes' });
  });

  test('replaceCommentReaction clears only its OWN prior markers, then adds the target', async () => {
    // Slack has no atomic swap. Removing every emoji would strip a human's
    // reaction; removing none would leave contradictory markers on a settled
    // message. So: remove this adapter's own set, minus the target, then add.
    await ch.replaceCommentReaction!({ commentId: '1700000000.009' }, thread, 'succeeded');
    const removes = slackFetchMock.mock.calls.filter((c) => c[1] === 'reactions.remove');
    const adds = slackFetchMock.mock.calls.filter((c) => c[1] === 'reactions.add');
    expect(removes.map((c) => (c[2] as { name: string }).name).sort())
      .toEqual(['eyes', 'question', 'x']); // own markers, excluding the target
    expect(adds).toHaveLength(1);
    expect((adds[0][2] as { name: string }).name).toBe('white_check_mark');
  });

  test('replaceIssueReaction marks the THREAD ROOT — the nearest thing to an issue', async () => {
    await ch.replaceIssueReaction!(thread, 'failed');
    const adds = slackFetchMock.mock.calls.filter((c) => c[1] === 'reactions.add');
    expect((adds[0][2] as { timestamp: string }).timestamp).toBe('1700000000.001');
    expect((adds[0][2] as { name: string }).name).toBe('x');
  });

  test('postThreadedReply replies under the parent message', async () => {
    const res = await ch.postThreadedReply!(thread, { commentId: '1700000000.077' }, 'done');
    expect(res).toEqual({ commentId: '1700000000.002' });
    const [, method, body] = slackFetchTsMock.mock.calls[0];
    expect(method).toBe('chat.postMessage');
    expect(body).toMatchObject({ thread_ts: '1700000000.077', text: 'done' });
  });

  test('upsertThreadedReply edits the existing reply, else creates one', async () => {
    await ch.upsertThreadedReply!(thread, { commentId: 'p' }, 'settled', { commentId: '1700000000.088' });
    expect(slackFetchTsMock.mock.calls[0][1]).toBe('chat.update');
    slackFetchTsMock.mockClear();
    await ch.upsertThreadedReply!(thread, { commentId: 'p' }, 'settled');
    expect(slackFetchTsMock.mock.calls[0][1]).toBe('chat.postMessage');
  });

  test('an uninstalled workspace skips cleanly instead of throwing', async () => {
    // Feedback is advisory and must never gate the orchestration.
    getSlackSecretMock.mockResolvedValue(null);
    await expect(ch.postComment(thread, 'x')).resolves.toBeNull();
    await expect(ch.reportFailure(thread, 'x')).resolves.toBeUndefined();
    expect(slackFetchTsMock).not.toHaveBeenCalled();
  });

  test('a malformed thread ref is refused rather than posting to a guessed channel', async () => {
    // Posting into the wrong channel is worse than posting nowhere.
    const bad: IssueRef = { issueId: 'no-separator', credentialsRef: 'T99' };
    await expect(ch.postComment(bad, 'x')).resolves.toBeNull();
    expect(slackFetchTsMock).not.toHaveBeenCalled();
    expect(getSlackSecretMock).not.toHaveBeenCalled();
  });

  test('a failed Slack call reports null rather than a bogus ref', async () => {
    slackFetchTsMock.mockResolvedValue(null);
    await expect(ch.postComment(thread, 'x')).resolves.toBeNull();
  });
});

describe('slackThreadRef', () => {
  test('round-trips through the adapter that parses it', async () => {
    // The seeding side and the adapter must agree on the ref format, or every
    // Slack orchestration silently posts nowhere.
    const ch = makeSlackChannel();
    await ch.postComment({ issueId: slackThreadRef('CABC', '123.456'), credentialsRef: 'T1' }, 'x');
    expect(slackFetchTsMock.mock.calls[0][2]).toMatchObject({ channel: 'CABC', thread_ts: '123.456' });
  });
});
