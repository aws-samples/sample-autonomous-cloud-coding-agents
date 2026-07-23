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

/**
 * #247 Mode A + ADR-016 finding #1 (Mode A slice): a parent issue that carries
 * uploads.linear.app attachments (description links AND/OR native paperclips)
 * and has pre-existing sub-issues seeds its orchestration graph HERE in the
 * webhook processor — NOT through the reconciler's Mode-B seedDecomposedGraph.
 * So the parent's attachments must be hydrated at THIS seam and stamped on the
 * meta row (releaseContext.pre_screened_attachments) so every child inherits
 * them. Mode B / single-task are covered elsewhere; this file isolates the
 * Mode-A seed seam because it was previously blind to the parent's attachments.
 *
 * Separate file (not the sibling orchestration-routing test) because the
 * attachment screening clients are constructed at MODULE-EVAL time from
 * ATTACHMENTS_BUCKET_NAME / GUARDRAIL_ID / GUARDRAIL_VERSION — this file sets
 * them before import so the fail-closed "not configured" branch is not taken.
 */

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  BatchWriteCommand: jest.fn((input: unknown) => ({ _type: 'BatchWrite', input })),
}));
// The screening clients are never actually exercised (download is mocked), but
// their ctors must not blow up at module eval.
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({})),
  ApplyGuardrailCommand: jest.fn(),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const reportIssueFailureMock = jest.fn();
const swapIssueReactionMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
const fetchRecentCommentsMock = jest.fn();
const postIssueCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  reportIssueFailure: (...args: unknown[]) => reportIssueFailureMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  swapCommentReaction: jest.fn().mockResolvedValue(true),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  reactToComment: jest.fn().mockResolvedValue(true),
  replyToComment: jest.fn().mockResolvedValue(true),
  upsertThreadedReply: jest.fn().mockResolvedValue('r1'),
  fetchRecentComments: (...args: unknown[]) => fetchRecentCommentsMock(...args),
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  EMOJI_STARTED: 'eyes',
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const discoverOrchestrationMock = jest.fn();
jest.mock('../../src/handlers/shared/orchestration-discovery', () => ({
  discoverOrchestration: (...args: unknown[]) => discoverOrchestrationMock(...args),
}));

// The handler now fetches the sub-issue graph ONCE up front (to gate epic-
// attachment hydration on children actually existing — finding #1 double-screen
// fix) and reuses it for discoverOrchestration. Mock it to report a real graph so
// the epic-hydration path runs; discoverOrchestration itself is separately mocked.
const fetchSubIssueGraphMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-subissue-fetch', () => ({
  fetchSubIssueGraph: (...args: unknown[]) => fetchSubIssueGraphMock(...args),
  fetchIssueParentId: jest.fn().mockResolvedValue(null),
}));

const probeLinearIssueContextMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-issue-context-probe', () => ({
  probeLinearIssueContext: (...args: unknown[]) => probeLinearIssueContextMock(...args),
  renderIssueContextHint: jest.fn(() => ''),
}));

// Keep isLinearUploadsUrl / LinearAttachmentError real; stub only the network+S3
// side (download+screen+store) so we can assert the RECORDS get threaded.
const downloadMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-attachments', () => {
  const actual = jest.requireActual('../../src/handlers/shared/linear-attachments');
  return {
    ...actual,
    downloadScreenAndStoreLinearAttachments: (...args: unknown[]) => downloadMock(...args),
  };
});

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjects';
process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearUsers';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
// Enable attachment screening (module-eval-time gate) so the Mode-A hydrate
// takes the real path, not the fail-closed "not configured" branch.
process.env.ATTACHMENTS_BUCKET_NAME = 'attachments-bucket';
process.env.GUARDRAIL_ID = 'gr-1';
process.env.GUARDRAIL_VERSION = '1';

import { handler } from '../../src/handlers/linear-webhook-processor';

function eventWith(payload: Record<string, unknown>): { raw_body: string } {
  return { raw_body: JSON.stringify(payload) };
}

const PAPERCLIP_URL = 'https://uploads.linear.app/abc/spec.pdf';

function epicIssue(description = 'Parent epic.'): Record<string, unknown> {
  return {
    action: 'create',
    type: 'Issue',
    organizationId: 'org-1',
    actor: { id: 'user-1' },
    data: {
      id: 'issue-1',
      identifier: 'ABC-42',
      title: 'Epic: ship the thing',
      description,
      projectId: 'project-1',
      teamId: 'team-1',
      labels: [{ id: 'lbl-bg', name: 'bgagent' }],
    },
  };
}

/** A screened record as downloadScreenAndStoreLinearAttachments would return. */
const SCREENED_RECORD = {
  attachment_id: 'abc-spec-pdf',
  filename: 'spec.pdf',
  content_type: 'application/pdf',
  size_bytes: 1234,
  s3_key: 'attachments/platform-user-1/epic-issue-1/abc-spec-pdf/spec.pdf',
  s3_version_id: 'v1',
  checksum: 'deadbeef',
  screening: { status: 'passed' },
  source: 'linear',
};

describe('linear-webhook-processor — Mode A parent attachment hydration (finding #1)', () => {
  beforeEach(() => {
    ddbSend.mockReset().mockResolvedValue({ Items: [] });
    // preamble: project mapping + user mapping
    ddbSend
      .mockResolvedValueOnce({ Item: { status: 'active', repo: 'owner/repo', label_filter: 'bgagent' } })
      .mockResolvedValueOnce({ Item: { platform_user_id: 'platform-user-1' } });
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child' } }) });
    reportIssueFailureMock.mockReset().mockResolvedValue(undefined);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('cmt-1');
    fetchRecentCommentsMock.mockReset().mockResolvedValue([]);
    postIssueCommentMock.mockReset().mockResolvedValue({ ok: true });
    resolveLinearOauthTokenMock.mockReset().mockResolvedValue({
      accessToken: 'access-tok', oauthSecretArn: 'arn:secret', workspaceSlug: 'acme',
    });
    discoverOrchestrationMock.mockReset();
    // Default: the issue HAS sub-issues (graph fetch returns children) so the
    // epic-attachment hydration path runs. A single_task-fall-through test would
    // override this with { kind: 'no_children' }.
    fetchSubIssueGraphMock.mockReset().mockResolvedValue({
      kind: 'ok', parentIssueId: 'issue-1', children: [{ id: 'A', depends_on: [] }],
    });
    probeLinearIssueContextMock.mockReset().mockResolvedValue({
      attachmentTitles: [], attachments: [], projectName: null, projectHasDocuments: false,
    });
    downloadMock.mockReset().mockResolvedValue([]);
  });

  test('parent with a native paperclip → hydrated + stamped on releaseContext for children', async () => {
    // The probe surfaces a uploads.linear.app paperclip; the screener returns a
    // passed record; the parent has sub-issues (seeded).
    probeLinearIssueContextMock.mockResolvedValue({
      attachmentTitles: ['spec.pdf'],
      attachments: [{ title: 'spec.pdf', url: PAPERCLIP_URL }],
      projectName: null,
      projectHasDocuments: false,
    });
    downloadMock.mockResolvedValue([SCREENED_RECORD]);
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 2, rootSubIssueIds: ['A'], alreadyExisted: false,
    });

    await handler(eventWith(epicIssue()));

    // The parent's paperclip was fetched/screened/stored under the epic key.
    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [, , ctxArg, paperclipsArg] = downloadMock.mock.calls[0];
    expect((ctxArg as { taskId: string }).taskId).toBe('epic-issue-1');
    expect(paperclipsArg).toEqual([{ title: 'spec.pdf', url: PAPERCLIP_URL }]);

    // …and the passed record was stamped on the orchestration's release context
    // so releaseChild → createTaskCore hands it to every child.
    expect(discoverOrchestrationMock).toHaveBeenCalledTimes(1);
    const releaseContext = (discoverOrchestrationMock.mock.calls[0][0] as {
      releaseContext: { pre_screened_attachments?: unknown[] };
    }).releaseContext;
    expect(releaseContext.pre_screened_attachments).toEqual([SCREENED_RECORD]);
    expect(reportIssueFailureMock).not.toHaveBeenCalled();
  });

  test('parent with NO uploads → no hydrate, releaseContext carries no attachments', async () => {
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 2, rootSubIssueIds: ['A'], alreadyExisted: false,
    });

    await handler(eventWith(epicIssue()));

    expect(downloadMock).not.toHaveBeenCalled();
    const releaseContext = (discoverOrchestrationMock.mock.calls[0][0] as {
      releaseContext: { pre_screened_attachments?: unknown[] };
    }).releaseContext;
    expect(releaseContext.pre_screened_attachments).toBeUndefined();
  });

  test('parent attachment cannot be safely screened → epic rejected, NOT seeded blind', async () => {
    const { LinearAttachmentError } = jest.requireActual('../../src/handlers/shared/linear-attachments');
    probeLinearIssueContextMock.mockResolvedValue({
      attachmentTitles: ['spec.pdf'],
      attachments: [{ title: 'spec.pdf', url: PAPERCLIP_URL }],
      projectName: null,
      projectHasDocuments: false,
    });
    downloadMock.mockRejectedValue(new LinearAttachmentError('That PDF could not be read.'));

    await handler(eventWith(epicIssue()));

    // Fail-closed: we never seed children that would be blind to the spec.
    expect(discoverOrchestrationMock).not.toHaveBeenCalled();
    expect(reportIssueFailureMock).toHaveBeenCalledTimes(1);
    const [, issueId, message] = reportIssueFailureMock.mock.calls[0];
    expect(issueId).toBe('issue-1');
    expect(String(message)).toMatch(/could not be read/i);
  });

  test('description-embedded uploads link (no paperclip) is also hydrated', async () => {
    downloadMock.mockResolvedValue([SCREENED_RECORD]);
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 1, rootSubIssueIds: ['A'], alreadyExisted: false,
    });

    await handler(eventWith(epicIssue(`See the spec [spec.pdf](${PAPERCLIP_URL}).`)));

    expect(downloadMock).toHaveBeenCalledTimes(1);
    const releaseContext = (discoverOrchestrationMock.mock.calls[0][0] as {
      releaseContext: { pre_screened_attachments?: unknown[] };
    }).releaseContext;
    expect(releaseContext.pre_screened_attachments).toEqual([SCREENED_RECORD]);
  });

  test('child-own attachment reaches the released child EVEN IF the post-stamp reload is stale (race regression)', async () => {
    // Live-caught on abca-demo: the child ROW got its own attachment stamped, but
    // the released TASK had zero — because the post-stamp loadOrchestration Query
    // is eventually-consistent and read the pre-stamp replica. Fix: patch the
    // in-memory snapshot with the stamped records instead of reloading. Here the
    // ddbSend Query DELIBERATELY returns a child row WITHOUT pre_screened_attachments
    // (the stale replica); the released child's createTaskCore must STILL carry it.
    const CHILD_REC = { ...SCREENED_RECORD, attachment_id: 'own-abc', s3_key: 'attachments/u/child-A/own-abc/mock.png', filename: 'mock.png' };
    // Parent has NO uploads (so epic hydrate no-ops); the CHILD's probe surfaces one.
    probeLinearIssueContextMock
      .mockResolvedValueOnce({ attachmentTitles: [], attachments: [], projectName: null, projectHasDocuments: false }) // parent probe (entry)
      .mockResolvedValue({ attachmentTitles: ['mock.png'], attachments: [{ title: 'mock.png', url: PAPERCLIP_URL }], projectName: null, projectHasDocuments: false }); // per-child probe
    downloadMock.mockResolvedValue([CHILD_REC]);
    discoverOrchestrationMock.mockResolvedValueOnce({
      kind: 'seeded', orchestrationId: 'orch_abc', childCount: 1, rootSubIssueIds: ['sub-A'], alreadyExisted: false,
    });
    // Every loadOrchestration Query returns a ready child row with NO own
    // attachments (the stale replica the fix must NOT depend on).
    const staleSnapshot = {
      Items: [
        { sub_issue_id: '#meta', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo', child_count: 1, platform_user_id: 'platform-user-1' },
        { sub_issue_id: 'sub-A', orchestration_id: 'orch_abc', parent_linear_issue_id: 'issue-1', linear_workspace_id: 'org-1', repo: 'owner/repo', depends_on: [], child_status: 'ready' },
      ],
    };
    // preamble already queued 2 Get responses in beforeEach; subsequent Query/Update calls hit this.
    ddbSend.mockResolvedValue(staleSnapshot);

    await handler(eventWith(epicIssue()));

    // The child was released and createTaskCore got the own attachment despite the
    // stale reload — sourced from the in-memory patch, not the DB read.
    const childCreate = createTaskCoreMock.mock.calls.find(
      (c) => (c[1] as { preScreenedAttachments?: Array<{ attachment_id: string }> }).preScreenedAttachments
        ?.some((r) => r.attachment_id === 'own-abc'),
    );
    expect(childCreate).toBeDefined();
  });
});
