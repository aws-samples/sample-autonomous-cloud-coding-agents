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

// Mock the per-surface feedback + graph helpers so the adapter tests exercise the
// mapping (channel op → surface call) without any network.
const linearPostIssueComment = jest.fn();
const linearUpsertStatusComment = jest.fn();
const linearReportIssueFailure = jest.fn();
const linearAddCommentReaction = jest.fn();
const linearSwapCommentReaction = jest.fn();
const linearSwapIssueReaction = jest.fn();
const linearTransitionIssueState = jest.fn();
const linearRevertIssueToNotStarted = jest.fn();
const linearReplyToComment = jest.fn();
const linearUpsertThreadedReply = jest.fn();
const linearSweepDecompositionNotes = jest.fn();
jest.mock('../../../src/handlers/shared/linear-feedback', () => ({
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
  postIssueComment: (...a: unknown[]) => linearPostIssueComment(...a),
  upsertStatusComment: (...a: unknown[]) => linearUpsertStatusComment(...a),
  reportIssueFailure: (...a: unknown[]) => linearReportIssueFailure(...a),
  reactToComment: (...a: unknown[]) => linearAddCommentReaction(...a),
  swapCommentReaction: (...a: unknown[]) => linearSwapCommentReaction(...a),
  swapIssueReaction: (...a: unknown[]) => linearSwapIssueReaction(...a),
  transitionIssueState: (...a: unknown[]) => linearTransitionIssueState(...a),
  revertIssueToNotStarted: (...a: unknown[]) => linearRevertIssueToNotStarted(...a),
  replyToComment: (...a: unknown[]) => linearReplyToComment(...a),
  upsertThreadedReply: (...a: unknown[]) => linearUpsertThreadedReply(...a),
  sweepDecompositionNotes: (...a: unknown[]) => linearSweepDecompositionNotes(...a),
}));

const resolveLinearOauthToken = jest.fn();
jest.mock('../../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...a: unknown[]) => resolveLinearOauthToken(...a),
}));

const fetchSubIssueGraph = jest.fn();
jest.mock('../../../src/handlers/shared/linear-subissue-fetch', () => ({
  fetchSubIssueGraph: (...a: unknown[]) => fetchSubIssueGraph(...a),
}));

const jiraPostIssueComment = jest.fn();
const jiraReportIssueFailure = jest.fn();
const jiraTransitionIssueState = jest.fn();
const jiraUpdateIssueComment = jest.fn();
jest.mock('../../../src/handlers/shared/jira-feedback', () => ({
  postIssueComment: (...a: unknown[]) => jiraPostIssueComment(...a),
  reportIssueFailure: (...a: unknown[]) => jiraReportIssueFailure(...a),
  transitionIssueState: (...a: unknown[]) => jiraTransitionIssueState(...a),
  updateIssueComment: (...a: unknown[]) => jiraUpdateIssueComment(...a),
}));

import { type IssueRef } from '../../../src/handlers/shared/orchestration-channel';
import { makeJiraChannel } from '../../../src/handlers/shared/orchestration-channel-jira';
import { makeLinearChannel } from '../../../src/handlers/shared/orchestration-channel-linear';

const linearIssue: IssueRef = { issueId: 'lin-issue-1', credentialsRef: 'org-1', displayId: 'ENG-1' };
const jiraIssue: IssueRef = { issueId: 'ABC-1', credentialsRef: 'cloud-1' };

beforeEach(() => jest.clearAllMocks());

describe('Linear channel adapter', () => {
  const ch = makeLinearChannel('LinearRegistry');

  test('kind is linear', () => expect(ch.kind).toBe('linear'));

  test('postComment builds the LinearFeedbackContext from the issue and returns ok', async () => {
    linearPostIssueComment.mockResolvedValue({ ok: true });
    const res = await ch.postComment(linearIssue, 'hi');
    expect(res).not.toBeNull();
    const [ctx, id, body] = linearPostIssueComment.mock.calls[0];
    expect(ctx).toEqual({ linearWorkspaceId: 'org-1', registryTableName: 'LinearRegistry' });
    expect(id).toBe('lin-issue-1');
    expect(body).toBe('hi');
  });

  test('upsertComment threads the existing comment id + returns the new id', async () => {
    linearUpsertStatusComment.mockResolvedValue('cmt-99');
    const res = await ch.upsertComment(linearIssue, 'panel', { commentId: 'cmt-7' });
    expect(res).toEqual({ commentId: 'cmt-99' });
    expect(linearUpsertStatusComment.mock.calls[0][3]).toBe('cmt-7'); // existing id passed through
  });

  test('reactToComment ADDS a reaction without clearing existing ones', async () => {
    // The receipt ack must not disturb other markers, so it maps to the
    // add-only helper — never the swap helper, which deletes prior markers.
    await ch.reactToComment!({ commentId: 'c1' }, linearIssue, 'started');
    expect(linearAddCommentReaction.mock.calls[0][2]).toBe('eyes');
    expect(linearSwapCommentReaction).not.toHaveBeenCalled();
  });

  test('replaceCommentReaction clears prior markers via the swap helper', async () => {
    await ch.replaceCommentReaction!({ commentId: 'c1' }, linearIssue, 'succeeded');
    expect(linearSwapCommentReaction.mock.calls[0][1]).toBe('c1');
    expect(linearSwapCommentReaction.mock.calls[0][2]).toBe('white_check_mark');
    expect(linearAddCommentReaction).not.toHaveBeenCalled();
  });

  test('replaceIssueReaction targets the ISSUE, not a comment', async () => {
    await ch.replaceIssueReaction!(linearIssue, 'failed');
    expect(linearSwapIssueReaction.mock.calls[0][1]).toBe('lin-issue-1');
    expect(linearSwapIssueReaction.mock.calls[0][2]).toBe('x');
    expect(linearSwapCommentReaction).not.toHaveBeenCalled();
  });

  test('transitionState distinguishes running from awaiting-review by state name', async () => {
    // Linear types both as `started`, so the preferred NAME is what separates
    // them; dropping it would collapse the two intents into one move.
    await ch.transitionState!(linearIssue, 'started');
    expect(linearTransitionIssueState.mock.calls[0][2]).toBe('started');
    expect(linearTransitionIssueState.mock.calls[0][3]).toEqual(['In Progress']);

    await ch.transitionState!(linearIssue, 'in_review');
    expect(linearTransitionIssueState.mock.calls[1][2]).toBe('started');
    expect(linearTransitionIssueState.mock.calls[1][3]).toEqual(['In Review']);

    await ch.transitionState!(linearIssue, 'completed');
    expect(linearTransitionIssueState.mock.calls[2][2]).toBe('completed');
  });

  test('transitionState only permits a same-category re-open when asked', async () => {
    await ch.transitionState!(linearIssue, 'started');
    expect(linearTransitionIssueState.mock.calls[0][4]).toBe(false);
    await ch.transitionState!(linearIssue, 'started', { allowRegression: true });
    expect(linearTransitionIssueState.mock.calls[1][4]).toBe(true);
  });

  test('revertState routes to the guarded backward move', async () => {
    linearRevertIssueToNotStarted.mockResolvedValue(true);
    expect(await ch.revertState!(linearIssue)).toBe(true);
    expect(linearRevertIssueToNotStarted.mock.calls[0][1]).toBe('lin-issue-1');
  });

  test('postThreadedReply carries both the issue and the parent comment', async () => {
    // Linear rejects a reply that names only the parent comment, so the issue
    // id must travel with it.
    linearReplyToComment.mockResolvedValue('reply-1');
    const res = await ch.postThreadedReply!(linearIssue, { commentId: 'parent-1' }, 'done');
    expect(res).toEqual({ commentId: 'reply-1' });
    const [, issueId, parentId, body] = linearReplyToComment.mock.calls[0];
    expect(issueId).toBe('lin-issue-1');
    expect(parentId).toBe('parent-1');
    expect(body).toBe('done');
  });

  test('postThreadedReply returns null when the reply fails', async () => {
    linearReplyToComment.mockResolvedValue(null);
    expect(await ch.postThreadedReply!(linearIssue, { commentId: 'p' }, 'x')).toBeNull();
  });

  test('upsertThreadedReply edits the existing reply and preserves a preview link on request', async () => {
    linearUpsertThreadedReply.mockResolvedValue('reply-9');
    const res = await ch.upsertThreadedReply!(
      linearIssue, { commentId: 'parent-1' }, 'settled', { commentId: 'reply-9' },
      { preservePreview: true },
    );
    expect(res).toEqual({ commentId: 'reply-9' });
    const [, issueId, parentId, body, existingId, options] = linearUpsertThreadedReply.mock.calls[0];
    expect(issueId).toBe('lin-issue-1');
    expect(parentId).toBe('parent-1');
    expect(body).toBe('settled');
    expect(existingId).toBe('reply-9');
    // The adapter forwards EVERY convergence flag explicitly, so the surface
    // helper never has to guess a default.
    expect(options).toEqual({ preservePreview: true, skipIfSettled: false, repairIfOverwritten: false });
  });

  test('upsertThreadedReply defaults to not preserving a preview link', async () => {
    linearUpsertThreadedReply.mockResolvedValue('reply-2');
    await ch.upsertThreadedReply!(linearIssue, { commentId: 'p' }, 'body');
    expect(linearUpsertThreadedReply.mock.calls[0][4]).toBeUndefined();
    expect(linearUpsertThreadedReply.mock.calls[0][5])
      .toEqual({ preservePreview: false, skipIfSettled: false, repairIfOverwritten: false });
  });

  test('sweepNotes passes the comment to keep through and returns the deleted count', async () => {
    linearSweepDecompositionNotes.mockResolvedValue(3);
    expect(await ch.sweepNotes!(linearIssue, { commentId: 'keep-1' })).toBe(3);
    expect(linearSweepDecompositionNotes.mock.calls[0][1]).toBe('lin-issue-1');
    expect(linearSweepDecompositionNotes.mock.calls[0][2]).toBe('keep-1');
  });

  test('sweepNotes with nothing to keep passes no keep id', async () => {
    linearSweepDecompositionNotes.mockResolvedValue(0);
    expect(await ch.sweepNotes!(linearIssue)).toBe(0);
    expect(linearSweepDecompositionNotes.mock.calls[0][2]).toBeUndefined();
  });

  test('fetchChildGraph maps blocks-derived depends_on to the neutral node shape', async () => {
    resolveLinearOauthToken.mockResolvedValue({ accessToken: 'tok' });
    fetchSubIssueGraph.mockResolvedValue({
      kind: 'ok',
      parentIssueId: 'lin-issue-1',
      children: [
        { id: 'a', identifier: 'ENG-2', title: 'A', depends_on: [] },
        { id: 'b', identifier: 'ENG-3', title: 'B', depends_on: ['a'] },
      ],
    });
    const nodes = await ch.fetchChildGraph!(linearIssue);
    expect(nodes).toEqual([
      { issueId: 'a', displayId: 'ENG-2', title: 'A', dependsOn: [] },
      { issueId: 'b', displayId: 'ENG-3', title: 'B', dependsOn: ['a'] },
    ]);
  });

  test('fetchChildGraph returns [] when the graph is unavailable (best-effort)', async () => {
    resolveLinearOauthToken.mockResolvedValue({ accessToken: 'tok' });
    fetchSubIssueGraph.mockResolvedValue({ kind: 'error', message: 'boom' });
    expect(await ch.fetchChildGraph!(linearIssue)).toEqual([]);
  });
});

describe('Jira channel adapter (capability-limited surface)', () => {
  const ch = makeJiraChannel('JiraRegistry');

  test('kind is jira', () => expect(ch.kind).toBe('jira'));

  test('postComment builds the JiraFeedbackContext (cloudId) from the issue', async () => {
    jiraPostIssueComment.mockResolvedValue('cmt-42');
    const res = await ch.postComment(jiraIssue, 'hello');
    expect(res).toEqual({ commentId: 'cmt-42' });
    const [ctx, id, body] = jiraPostIssueComment.mock.calls[0];
    expect(ctx).toEqual({ cloudId: 'cloud-1', registryTableName: 'JiraRegistry' });
    expect(id).toBe('ABC-1');
    expect(body).toBe('hello');
  });

  test('upsertComment edits an existing Jira comment instead of posting another', async () => {
    jiraUpdateIssueComment.mockResolvedValue(true);

    const res = await ch.upsertComment(jiraIssue, 'working', { commentId: 'cmt-42' });

    expect(res).toEqual({ commentId: 'cmt-42' });
    expect(jiraUpdateIssueComment).toHaveBeenCalledWith(
      { cloudId: 'cloud-1', registryTableName: 'JiraRegistry' },
      'ABC-1',
      'cmt-42',
      'working',
    );
    expect(jiraPostIssueComment).not.toHaveBeenCalled();
  });

  test('upsertComment creates when there is no existing Jira comment', async () => {
    jiraPostIssueComment.mockResolvedValue('cmt-new');
    await expect(ch.upsertComment(jiraIssue, 'on it')).resolves.toEqual({
      commentId: 'cmt-new',
    });
    expect(jiraUpdateIssueComment).not.toHaveBeenCalled();
  });

  test('reportFailure routes to the Jira failure helper', async () => {
    await ch.reportFailure(jiraIssue, '❌ nope');
    expect(jiraReportIssueFailure).toHaveBeenCalledWith(
      { cloudId: 'cloud-1', registryTableName: 'JiraRegistry' }, 'ABC-1', '❌ nope',
    );
  });

  test('implements workflow transitions and omits unsupported capabilities', async () => {
    jiraTransitionIssueState.mockResolvedValue(true);
    const issue: IssueRef = {
      ...jiraIssue,
      stateOverrides: { started: 'Doing', inReview: 'Review' },
    };
    await expect(ch.transitionState!(issue, 'started', { allowRegression: true }))
      .resolves.toBe(true);
    expect(jiraTransitionIssueState).toHaveBeenCalledWith(
      { cloudId: 'cloud-1', registryTableName: 'JiraRegistry' },
      'ABC-1',
      'started',
      { started: 'Doing', inReview: 'Review' },
      { allowRegression: true },
    );

    // Check presence via the key, not the bound method, so the engine's
    // `if (channel.reactToComment)` capability guard is what's exercised.
    for (const capability of [
      'reactToComment',
      'replaceCommentReaction',
      'replaceIssueReaction',
      'revertState',
      'postThreadedReply',
      'upsertThreadedReply',
      'sweepNotes',
      'fetchChildGraph',
    ]) {
      expect(capability in ch).toBe(false);
    }
  });

  test('still satisfies the required feedback contract every surface must support', () => {
    // The point of the capability split: omitting the optional ops must not make
    // Jira an incomplete Channel.
    expect(typeof ch.postComment).toBe('function');
    expect(typeof ch.upsertComment).toBe('function');
    expect(typeof ch.reportFailure).toBe('function');
  });
});
