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
const linearSwapCommentReaction = jest.fn();
const linearTransitionIssueState = jest.fn();
jest.mock('../../../src/handlers/shared/linear-feedback', () => ({
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
  postIssueComment: (...a: unknown[]) => linearPostIssueComment(...a),
  upsertStatusComment: (...a: unknown[]) => linearUpsertStatusComment(...a),
  reportIssueFailure: (...a: unknown[]) => linearReportIssueFailure(...a),
  swapCommentReaction: (...a: unknown[]) => linearSwapCommentReaction(...a),
  transitionIssueState: (...a: unknown[]) => linearTransitionIssueState(...a),
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
jest.mock('../../../src/handlers/shared/jira-feedback', () => ({
  postIssueComment: (...a: unknown[]) => jiraPostIssueComment(...a),
  reportIssueFailure: (...a: unknown[]) => jiraReportIssueFailure(...a),
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

  test('reactToComment maps the neutral Reaction to the Linear emoji', async () => {
    await ch.reactToComment!({ commentId: 'c1' }, linearIssue, 'succeeded');
    expect(linearSwapCommentReaction.mock.calls[0][2]).toBe('white_check_mark');
    await ch.reactToComment!({ commentId: 'c1' }, linearIssue, 'needs_input');
    expect(linearSwapCommentReaction.mock.calls[1][2]).toBe('question');
  });

  test('transitionState maps intent to the Linear target type', async () => {
    await ch.transitionState!(linearIssue, 'completed');
    expect(linearTransitionIssueState.mock.calls[0][2]).toBe('completed');
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
    jiraPostIssueComment.mockResolvedValue(true);
    const res = await ch.postComment(jiraIssue, 'hello');
    expect(res).not.toBeNull();
    const [ctx, id, body] = jiraPostIssueComment.mock.calls[0];
    expect(ctx).toEqual({ cloudId: 'cloud-1', registryTableName: 'JiraRegistry' });
    expect(id).toBe('ABC-1');
    expect(body).toBe('hello');
  });

  test('reportFailure routes to the Jira failure helper', async () => {
    await ch.reportFailure(jiraIssue, '❌ nope');
    expect(jiraReportIssueFailure).toHaveBeenCalledWith(
      { cloudId: 'cloud-1', registryTableName: 'JiraRegistry' }, 'ABC-1', '❌ nope',
    );
  });

  test('OMITS the optional capabilities Jira lacks (reactions / state / graph) — the engine no-ops them', () => {
    // Check presence via the key, not the bound method, so the engine's
    // `if (channel.reactToComment)` capability guard is what's exercised.
    expect('reactToComment' in ch).toBe(false);
    expect('transitionState' in ch).toBe(false);
    expect('fetchChildGraph' in ch).toBe(false);
  });
});
