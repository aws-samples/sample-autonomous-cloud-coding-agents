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

import type { DynamoDBRecord } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  BatchGetCommand: jest.fn((input: unknown) => ({ _type: 'BatchGet', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

// #299 agent-native decompose: the reconciler reads the plan artifact from S3.
const s3SendMock = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: s3SendMock })),
  GetObjectCommand: jest.fn((input: unknown) => ({ _type: 'S3Get', input })),
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const postIssueCommentMock = jest.fn();
const upsertStatusCommentMock = jest.fn();
const swapIssueReactionMock = jest.fn();
const swapCommentReactionMock = jest.fn();
const transitionIssueStateMock = jest.fn();
const revertIssueToNotStartedMock = jest.fn();
const replyToCommentMock = jest.fn();
const upsertThreadedReplyMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
  upsertStatusComment: (...args: unknown[]) => upsertStatusCommentMock(...args),
  swapIssueReaction: (...args: unknown[]) => swapIssueReactionMock(...args),
  swapCommentReaction: (...args: unknown[]) => swapCommentReactionMock(...args),
  transitionIssueState: (...args: unknown[]) => transitionIssueStateMock(...args),
  revertIssueToNotStarted: (...args: unknown[]) => revertIssueToNotStartedMock(...args),
  replyToComment: (...args: unknown[]) => replyToCommentMock(...args),
  upsertThreadedReply: (...args: unknown[]) => upsertThreadedReplyMock(...args),
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// The decompose seed path probes the parent for attachments; review #1 makes it
// fail-CLOSED (throw) when the probe errors (ok:false). Mock a healthy empty
// probe (ok:true, no attachments) so these non-attachment reconciler tests take
// the normal path — otherwise the real probe's in-test fetch failure would
// (correctly) reject every decompose as attachment-unreadable.
jest.mock('../../src/handlers/shared/linear-issue-context-probe', () => ({
  probeLinearIssueContext: jest.fn().mockResolvedValue({
    attachmentTitles: [],
    attachments: [],
    projectName: null,
    projectHasDocuments: false,
    projectDocuments: [],
    ok: true,
    projectDocumentCount: 0,
  }),
  renderIssueContextHint: jest.fn(() => ''),
}));

process.env.ORCHESTRATION_TABLE_NAME = 'OrchestrationTable';
process.env.TASK_TABLE_NAME = 'TaskTable';
// A6 surfacing (#34/#35): the cascade posts Linear comments only when the
// workspace registry is configured. Set it so the surfacing path is exercised.
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'WorkspaceRegistry';
// #299 agent-native decompose: the reconciler reads the plan artifact from here.
process.env.ARTIFACTS_BUCKET_NAME = 'ArtifactsBucket';

import { handler, parseDecomposePlanRecord, parseTerminalTaskRecord } from '../../src/handlers/orchestration-reconciler';

/** Build a TaskTable stream MODIFY record. */
function taskRecord(fields: {
  task_id?: string;
  status?: string;
  build_passed?: boolean;
  orchestration_id?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  // A6 cascade markers (channel_metadata fields on an iteration/restack task).
  orchestration_sub_issue_id?: string;
  restack_predecessor_sub_issue_id?: string;
  orchestration_iteration?: boolean;
  // #247 UX.3: the human comment that triggered an iteration.
  trigger_comment_id?: string;
  // #247 UX.19: the issue that trigger comment lives on (parent epic when routed).
  trigger_comment_issue_id?: string;
  // #247 UX.5: raw agent error_message (drives the failure-reply detail).
  error_message?: string;
}): DynamoDBRecord {
  const img: Record<string, unknown> = {};
  if (fields.task_id) img.task_id = { S: fields.task_id };
  if (fields.status) img.status = { S: fields.status };
  if (fields.build_passed !== undefined) img.build_passed = { BOOL: fields.build_passed };
  if (fields.error_message) img.error_message = { S: fields.error_message };
  // PRODUCTION SHAPE: createTaskCore persists orchestration_id INSIDE the
  // nested channel_metadata MAP, not as a top-level attribute. The stream
  // image must mirror that or the reconciler skips every orchestration
  // child. (Regression: the first dev smoke had orchestration_id only in
  // channel_metadata and the reconciler — reading it top-level — ignored
  // all completions, so dependents never released.)
  const cm: Record<string, unknown> = {};
  if (fields.orchestration_id) cm.orchestration_id = { S: fields.orchestration_id };
  if (fields.orchestration_sub_issue_id) cm.orchestration_sub_issue_id = { S: fields.orchestration_sub_issue_id };
  if (fields.restack_predecessor_sub_issue_id) {
    cm.restack_predecessor_sub_issue_id = { S: fields.restack_predecessor_sub_issue_id };
  }
  if (fields.orchestration_iteration) cm.orchestration_iteration = { S: 'true' };
  if (fields.trigger_comment_id) cm.trigger_comment_id = { S: fields.trigger_comment_id };
  if (fields.trigger_comment_issue_id) cm.trigger_comment_issue_id = { S: fields.trigger_comment_issue_id };
  if (Object.keys(cm).length > 0) img.channel_metadata = { M: cm };
  return {
    eventName: fields.eventName ?? 'MODIFY',
    dynamodb: { NewImage: img as never },
  } as DynamoDBRecord;
}

describe('parseTerminalTaskRecord', () => {
  test('extracts a terminal orchestration child event', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', build_passed: true, orchestration_id: 'orch_1',
    }));
    expect(evt).toEqual({ taskId: 'T1', status: 'COMPLETED', buildPassed: true, orchestrationId: 'orch_1' });
  });

  test('skips non-terminal status', () => {
    expect(parseTerminalTaskRecord(taskRecord({ task_id: 'T1', status: 'RUNNING', orchestration_id: 'orch_1' }))).toBeNull();
  });

  test('skips tasks with no orchestration_id (non-orchestration tasks)', () => {
    expect(parseTerminalTaskRecord(taskRecord({ task_id: 'T1', status: 'COMPLETED' }))).toBeNull();
  });

  test('skips REMOVE events', () => {
    expect(parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', orchestration_id: 'orch_1', eventName: 'REMOVE',
    }))).toBeNull();
  });

  test('skips records with no NewImage', () => {
    expect(parseTerminalTaskRecord({ eventName: 'MODIFY', dynamodb: {} } as DynamoDBRecord)).toBeNull();
  });

  test('skips a coding/decompose-v1 planning task (it has no orchestration_id — routed elsewhere)', () => {
    // The decompose planning task is NOT an orchestration child; it must fall
    // through parseTerminalTaskRecord (no orchestration_id) so the dedicated
    // decompose branch handles it. Guards against it being mis-gated as a child.
    expect(parseTerminalTaskRecord(decomposeRecord({ task_id: 'P1', status: 'COMPLETED', mode: 'decompose' }))).toBeNull();
  });
});

/** Build a terminal ``coding/decompose-v1`` planning-task stream record. */
function decomposeRecord(fields: {
  task_id?: string;
  status?: string;
  workflow_id?: string;
  mode?: 'decompose' | 'auto' | string;
  parent_issue_id?: string;
  workspace_id?: string;
  project_id?: string;
  max_sub_issues?: string;
  decompose_allowed?: string;
  max_parent_budget_usd?: string;
  artifact_uri?: string;
  task_description?: string;
  revision_round?: string;
  revising_feedback_comment_id?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
}): DynamoDBRecord {
  const img: Record<string, unknown> = {};
  if (fields.task_id) img.task_id = { S: fields.task_id };
  if (fields.status) img.status = { S: fields.status };
  img.resolved_workflow = { M: { id: { S: fields.workflow_id ?? 'coding/decompose-v1' }, version: { S: '1.0.0' } } };
  img.user_id = { S: 'user-1' };
  img.repo = { S: 'o/r' };
  if (fields.artifact_uri) img.artifact_uri = { S: fields.artifact_uri };
  if (fields.task_description) img.task_description = { S: fields.task_description };
  const cm: Record<string, unknown> = {};
  cm.linear_workspace_id = { S: fields.workspace_id ?? 'WS' };
  cm.linear_project_id = { S: fields.project_id ?? 'PROJ' };
  cm.decompose_parent_issue_id = { S: fields.parent_issue_id ?? 'PARENT' };
  if (fields.mode) cm.decompose_mode = { S: fields.mode };
  if (fields.max_sub_issues) cm.decompose_caps_max_sub_issues = { S: fields.max_sub_issues };
  if (fields.decompose_allowed) cm.decompose_caps_allowed = { S: fields.decompose_allowed };
  if (fields.max_parent_budget_usd) cm.decompose_caps_max_parent_budget_usd = { S: fields.max_parent_budget_usd };
  if (fields.revision_round) cm.decompose_revision_round = { S: fields.revision_round };
  if (fields.revising_feedback_comment_id) cm.decompose_revising_feedback_comment_id = { S: fields.revising_feedback_comment_id };
  img.channel_metadata = { M: cm };
  return {
    eventName: fields.eventName ?? 'MODIFY',
    dynamodb: { NewImage: img as never },
  } as DynamoDBRecord;
}

describe('parseDecomposePlanRecord', () => {
  test('extracts a terminal decompose-planning task with mode + caps + artifact', () => {
    const evt = parseDecomposePlanRecord(decomposeRecord({
      task_id: 'P1',
      status: 'COMPLETED',
      mode: 'decompose',
      max_sub_issues: '5',
      decompose_allowed: 'true',
      max_parent_budget_usd: '20',
      artifact_uri: 's3://bucket/artifacts/P1/result.md',
      task_description: 'ENG-1: do it',
    }));
    expect(evt).toEqual({
      taskId: 'P1',
      status: 'COMPLETED',
      parentIssueId: 'PARENT',
      workspaceId: 'WS',
      repo: 'o/r',
      projectId: 'PROJ',
      platformUserId: 'user-1',
      mode: 'decompose',
      maxSubIssues: 5,
      decomposeAllowed: true,
      maxParentBudgetUsd: 20,
      artifactUri: 's3://bucket/artifacts/P1/result.md',
      taskDescription: 'ENG-1: do it',
    });
  });

  test('captures :auto mode and defaults caps (max_sub_issues → 8) when unstamped', () => {
    const evt = parseDecomposePlanRecord(decomposeRecord({ task_id: 'P2', status: 'COMPLETED', mode: 'auto' }));
    expect(evt?.mode).toBe('auto');
    expect(evt?.maxSubIssues).toBe(8);
    expect(evt?.decomposeAllowed).toBe(true);
    expect(evt?.maxParentBudgetUsd).toBeUndefined();
  });

  test('returns the event on a FAILED planning task (the handler posts the error note)', () => {
    const evt = parseDecomposePlanRecord(decomposeRecord({ task_id: 'P3', status: 'FAILED', mode: 'decompose' }));
    expect(evt?.status).toBe('FAILED');
  });

  test('null for a non-decompose workflow (a normal coding task)', () => {
    expect(parseDecomposePlanRecord(decomposeRecord({ task_id: 'P4', status: 'COMPLETED', mode: 'decompose', workflow_id: 'coding/new-task-v1' }))).toBeNull();
  });

  test('null for a non-terminal status', () => {
    expect(parseDecomposePlanRecord(decomposeRecord({ task_id: 'P5', status: 'RUNNING', mode: 'decompose' }))).toBeNull();
  });

  test('#299 F-revise-in-place: extracts revisionRound + revisingFeedbackCommentId on a revision', () => {
    const evt = parseDecomposePlanRecord(decomposeRecord({
      task_id: 'P6',
      status: 'COMPLETED',
      mode: 'decompose',
      revision_round: '1',
      revising_feedback_comment_id: 'feedback-cmt-1',
    }));
    expect(evt?.revisionRound).toBe(1);
    expect(evt?.revisingFeedbackCommentId).toBe('feedback-cmt-1');
  });

  test('#299 F-revise-in-place: revisingFeedbackCommentId absent on round 0', () => {
    const evt = parseDecomposePlanRecord(decomposeRecord({ task_id: 'P7', status: 'COMPLETED', mode: 'decompose' }));
    expect(evt?.revisingFeedbackCommentId).toBeUndefined();
  });

  test('null when the decompose_mode is missing/invalid (not a Mode B task)', () => {
    expect(parseDecomposePlanRecord(decomposeRecord({ task_id: 'P6', status: 'COMPLETED', mode: 'bogus' }))).toBeNull();
  });
});

describe('reconcileDecomposePlan — idempotency (live-caught: ABCA-498 3 duplicate proposals)', () => {
  // The TaskTable stream is at-least-once AND the agent writes the terminal row
  // several times (status, then artifact_uri, then cost/duration), so the same
  // terminal decompose event re-delivers. Without a claim, each delivery re-runs
  // the handler and posts a fresh :decompose proposal. Assert the claim gates the
  // whole handler: proposal posted exactly ONCE across two identical deliveries.
  const PLAN_JSON = JSON.stringify({
    decompose: true,
    reasoning: 'two separable slices',
    sub_issues: [
      { title: 'A', description: 'a', size: 'S', depends_on: [] },
      { title: 'B', description: 'b', size: 'M', depends_on: [0] },
    ],
  });

  beforeEach(() => {
    ddbSend.mockReset();
    s3SendMock.mockReset();
    upsertStatusCommentMock.mockReset();
    resolveLinearOauthTokenMock.mockReset();
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    // The plan artifact S3 read returns the agent's plan JSON.
    s3SendMock.mockImplementation(async () => ({
      Body: { transformToString: async () => PLAN_JSON },
    }));
    upsertStatusCommentMock.mockResolvedValue('proposal-comment-1');
    resolveLinearOauthTokenMock.mockResolvedValue({
      accessToken: 't', oauthSecretArn: 'arn:secret', workspaceSlug: 'ws',
    });
  });

  test(':decompose proposal is posted exactly once across a redelivered terminal event', async () => {
    // ddb: the ack-claim (Update w/ attribute_not_exists) wins ONCE; a redelivery
    // hits ConditionalCheckFailedException. putPendingPlan (Put) succeeds. No
    // reads reached on the losing delivery.
    let ackClaims = 0;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Update' && String(cmd.input.ConditionExpression ?? '').includes('attribute_not_exists')) {
        ackClaims += 1;
        if (ackClaims > 1) {
          const err = new Error('conditional'); (err as { name?: string }).name = 'ConditionalCheckFailedException'; throw err;
        }
        return {};
      }
      if (cmd._type === 'Put') return {}; // putPendingPlan create-once
      return {};
    });

    const rec = decomposeRecord({
      task_id: 'PLAN-1',
      status: 'COMPLETED',
      mode: 'decompose',
      artifact_uri: 's3://ArtifactsBucket/artifacts/PLAN-1/result.md',
      max_sub_issues: '6',
    });
    // Two identical terminal deliveries of the SAME task (the bug repro).
    await handler({ Records: [rec] } as never);
    await handler({ Records: [rec] } as never);

    // Proposal comment posted exactly once (the fix). Before the claim it was 2.
    const proposals = upsertStatusCommentMock.mock.calls.filter(
      (c) => typeof c[2] === 'string' && (c[2] as string).includes('Proposed breakdown'),
    );
    expect(proposals).toHaveLength(1);
    // The losing redelivery never reached the S3 plan fetch.
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    // F-decompose-inprogress: a round-0 plan awaiting approval reverts the issue
    // from In Progress (set by the webhook at dispatch) back to a not-started
    // state — In Progress would mislead as "working" while it's just pending.
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'PARENT');
  });

  test('F-decompose-inprogress: an ESCALATED REVISION round also reverts In Progress once the revised plan is handled', async () => {
    // PM-stress follow-on: the webhook's escalated-revise path now flips the issue
    // to In Progress (visibility fix) — so the reconciler must revert it when the
    // revised plan lands, not just on round 0. Only the escalated revise reaches
    // this handler (the deterministic revise settles inline), so reverting on a
    // revision round is correct and doesn't flicker the board.
    ddbSend.mockImplementation(async () => ({})); // replacePendingPlan upsert + ack claim
    await handler({
      Records: [decomposeRecord({
        task_id: 'PLAN-REV-1',
        status: 'COMPLETED',
        mode: 'decompose',
        artifact_uri: 's3://ArtifactsBucket/artifacts/PLAN-REV-1/result.md',
        max_sub_issues: '6',
        revision_round: '1',
        revising_feedback_comment_id: 'feedback-1',
      })],
    } as never);

    // The revised plan is HANDLED (awaiting approval) → revert to not-started.
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'PARENT');
  });

  test('CONFUSING-3: an :auto single-task dispatch carries the full Linear OAuth metadata', async () => {
    // Root of the ~9.5-min "zero output" :auto run the QA tester hit: the
    // single-task createTaskCore was missing linear_oauth_secret_arn /
    // linear_workspace_slug, so the agent couldn't authenticate to Linear and
    // never posted "🤖 Starting" / transitioned state / reacted. Assert the
    // dispatched task now carries the freshly-resolved OAuth metadata.
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    // A single-node plan collapses to single_task; :auto trusts the decline + runs.
    s3SendMock.mockImplementation(async () => ({
      Body: {
        transformToString: async () => JSON.stringify({
          decompose: false,
          reasoning: 'one cohesive change',
          sub_issues: [{ title: 'Only', description: 'x', size: 'S', depends_on: [] }],
        }),
      },
    }));
    ddbSend.mockImplementation(async () => ({}));

    await handler({
      Records: [decomposeRecord({
        task_id: 'PLAN-AUTO-1',
        status: 'COMPLETED',
        mode: 'auto',
        artifact_uri: 's3://ArtifactsBucket/artifacts/PLAN-AUTO-1/result.md',
        max_sub_issues: '6',
      })],
    } as never);

    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const ctx = createTaskCoreMock.mock.calls[0][1];
    expect(ctx.channelMetadata.linear_oauth_secret_arn).toBe('arn:secret');
    expect(ctx.channelMetadata.linear_workspace_slug).toBe('ws');
    expect(ctx.channelSource).toBe('linear');
  });
});

/** Mock the GSI lookup + loadOrchestration Query for a child set. */
function mockOrchestration(opts: {
  subIssueId: string;
  children: Array<{ sub_issue_id: string; depends_on?: string[]; child_status: string }>;
}): void {
  // Stateful, query-type-aware mock (robust to the reconciler's read
  // pattern: GSI lookup + possibly-repeated loadOrchestration + status
  // Updates). Status Updates mutate the in-memory rows so a subsequent
  // fresh loadOrchestration reflects them — which is exactly what the
  // concurrency-safe re-read relies on.
  const meta = {
    sub_issue_id: '#meta',
    orchestration_id: 'orch_1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: opts.children.length,
    platform_user_id: 'user-1',
  };
  const rows: Record<string, Record<string, unknown>> = {};
  for (const c of opts.children) {
    rows[c.sub_issue_id] = {
      orchestration_id: 'orch_1',
      sub_issue_id: c.sub_issue_id,
      depends_on: c.depends_on ?? [],
      child_status: c.child_status,
      repo: 'o/r',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
    };
  }
  ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
    const { _type, input } = cmd;
    if (_type === 'Query' && input.IndexName === 'ChildTaskIndex') {
      return { Items: [{ ...rows[opts.subIssueId], sub_issue_id: opts.subIssueId }] };
    }
    if (_type === 'Query') { // loadOrchestration
      return { Items: [meta, ...Object.values(rows)] };
    }
    if (_type === 'Update') {
      const sk = (input.Key as { sub_issue_id: string }).sub_issue_id;
      const vals = input.ExpressionAttributeValues as Record<string, unknown>;
      const row = rows[sk];
      if (row) {
        if (vals[':s'] !== undefined) row.child_status = vals[':s'];
        if (vals[':released'] !== undefined) { row.child_status = 'released'; row.child_task_id = vals[':tid']; }
      }
      return {};
    }
    return {};
  });
}

describe('orchestration-reconciler handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: 'child-task' } }) });
  });

  test('A succeeds → releases blocked dependent B', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);

    // B released via createTaskCore.
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const ctx = createTaskCoreMock.mock.calls[0][1];
    expect(ctx.idempotencyKey).toBe('orch_1_B');
  });

  test('A fails → no release, B skipped (createTaskCore not called)', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });

    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })] } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('COMPLETED with build_passed=false → treated as failure, B not released', async () => {
    mockOrchestration({
      subIssueId: 'A',
      children: [
        { sub_issue_id: 'A', child_status: 'released' },
        { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' },
      ],
    });

    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', build_passed: false, orchestration_id: 'orch_1' })],
    } as never);

    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('ABCA-659: build-gate-failed child (COMPLETED, build_passed=false) reverts state AND swaps its ✅ reaction to ❌', async () => {
    // The agent moves a writeable child to "In Review" + reacts ✅ on agent-success
    // (regression-only build gate), but the platform gate independently marks it
    // failed. Left alone, the graph says failed while Linear reads "In Review" with
    // a ✅ reaction + PR link (the user's inconsistency). The reconciler pulls the
    // child back to not-started AND settles the reaction ✅→❌.
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', build_passed: false, orchestration_id: 'orch_1' })],
    } as never);
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'A');
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), 'A', 'x');
  });

  test('ABCA-659: a genuinely FAILED child also reverts state + swaps reaction to ❌', async () => {
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'FAILED', orchestration_id: 'orch_1' })],
    } as never);
    expect(revertIssueToNotStartedMock).toHaveBeenCalledWith(expect.anything(), 'A');
    expect(swapIssueReactionMock).toHaveBeenCalledWith(expect.anything(), 'A', 'x');
  });

  test('ABCA-659: a SUCCEEDING child is never reverted or ❌-reacted (leaves ✅ + In Review intact)', async () => {
    revertIssueToNotStartedMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockOrchestration({
      subIssueId: 'A',
      children: [{ sub_issue_id: 'A', child_status: 'released' }],
    });
    await handler({
      Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })],
    } as never);
    expect(revertIssueToNotStartedMock).not.toHaveBeenCalledWith(expect.anything(), 'A');
    expect(swapIssueReactionMock).not.toHaveBeenCalledWith(expect.anything(), 'A', 'x');
  });

  test('non-orchestration / non-terminal records are skipped entirely', async () => {
    await handler({
      Records: [
        taskRecord({ task_id: 'T1', status: 'RUNNING', orchestration_id: 'orch_1' }),
        taskRecord({ task_id: 'T2', status: 'COMPLETED' }), // no orchestration_id
      ],
    } as never);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('unresolvable sub_issue_id (GSI miss) → skip, no throw', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] }); // GSI miss
    await handler({ Records: [taskRecord({ task_id: 'TA', status: 'COMPLETED', orchestration_id: 'orch_1' })] } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('#57: all-terminal epic with an integration node → embeds its combined screenshot in the panel', async () => {
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    const meta = {
      sub_issue_id: '#meta',
      orchestration_id: 'orch_1',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
      repo: 'o/r',
      child_count: 2,
      platform_user_id: 'u1',
      status_comment_id: 'panel-1',
    };
    // A (real leaf) + integration node, BOTH succeeded → all-terminal. The
    // integration node's task record carries a screenshot_url.
    const rows = [
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'A',
        depends_on: [],
        child_status: 'succeeded',
        child_task_id: 'task-A',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
        linear_identifier: 'ENG-1',
      },
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'orch_1__integration',
        depends_on: ['A'],
        child_status: 'succeeded',
        child_task_id: 'task-int',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
      },
    ];
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'ChildTaskIndex') {
        return { Items: [{ ...rows[1] }] }; // the integration node just completed
      }
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') { // resolveChildPrUrls
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>;
        const tbl = Object.keys(keys)[0];
        return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
      }
      if (cmd._type === 'Get') { // resolveCombinedScreenshotUrl(task-int)
        const tid = (cmd.input.Key as { task_id: string }).task_id;
        return {
          Item: tid === 'task-int'
            ? { screenshot_url: 'https://cdn.example/combined.png', screenshot_preview_url: 'https://combined.vercel.app' }
            : {},
        };
      }
      return {};
    });

    await handler({
      Records: [taskRecord({
        task_id: 'task-int', status: 'COMPLETED', orchestration_id: 'orch_1',
      })],
    } as never);

    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('✅'); // complete
    // #247 UX.17: the panel embeds the image AND deep-links to the live combined deploy.
    expect(body).toContain('[![combined preview](https://cdn.example/combined.png)](https://combined.vercel.app)');
    expect(body).toContain('[Open the combined preview](https://combined.vercel.app)');
  });

  test('K1: a FAILED integration node surfaces its build-failure reason + CloudWatch pointer on the panel', async () => {
    // the synthetic integration node has no Linear sub-issue,
    // so a failed combined build previously surfaced as a bare "❌ … failed" with
    // NO reason and NO log pointer. The reconciler must now resolve the reason
    // from the failed task's record and render it as a panel sub-line.
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    const meta = {
      sub_issue_id: '#meta',
      orchestration_id: 'orch_1',
      parent_linear_issue_id: 'PARENT',
      linear_workspace_id: 'WS',
      repo: 'o/r',
      child_count: 2,
      platform_user_id: 'u1',
      status_comment_id: 'panel-1',
    };
    // A succeeded leaf + a FAILED integration node → all-terminal (with failures).
    const rows = [
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'A',
        depends_on: [],
        child_status: 'succeeded',
        child_task_id: 'task-A',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
        linear_identifier: 'ENG-1',
      },
      {
        orchestration_id: 'orch_1',
        sub_issue_id: 'orch_1__integration',
        depends_on: ['A'],
        child_status: 'failed',
        child_task_id: 'task-int',
        repo: 'o/r',
        parent_linear_issue_id: 'PARENT',
        linear_workspace_id: 'WS',
      },
    ];
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Query' && cmd.input.IndexName === 'ChildTaskIndex') {
        return { Items: [{ ...rows[1] }] }; // the integration node just went terminal (failed)
      }
      if (cmd._type === 'Query') return { Items: [meta, ...rows] };
      if (cmd._type === 'BatchGet') {
        const keys = cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }>; ProjectionExpression?: string }>;
        const tbl = Object.keys(keys)[0];
        const proj = keys[tbl].ProjectionExpression ?? '';
        // resolveChildFailureReasons projects error_message/build_passed; the
        // failed integration task carries the live build-gate error shape.
        if (proj.includes('error_message')) {
          return {
            Responses: {
              [tbl]: keys[tbl].Keys.map((k) => (
                k.task_id === 'task-int'
                  ? { task_id: k.task_id, error_message: "Task did not succeed (agent_status='success', build_ok=False)" }
                  : { task_id: k.task_id }
              )),
            },
          };
        }
        // resolveChildPrUrls projects task_id/pr_url.
        return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
      }
      return {};
    });

    await handler({
      Records: [taskRecord({ task_id: 'task-int', status: 'FAILED', orchestration_id: 'orch_1' })],
    } as never);

    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('⚠️ **ABCA orchestration finished with failures**');
    // The diagnostic sub-line: names the combined merge build + points at CloudWatch by task id.
    expect(body).toMatch(/↳ Combined build failed after merging the sub-issue branches/);
    expect(body).toContain('CloudWatch for task `task-int`');
    // Never leaks raw build output (untrusted repo content).
    expect(body).not.toContain('build_ok');
  });
});

/** Detect a cascade marker in parseTerminalTaskRecord. */
describe('parseTerminalTaskRecord — A6 cascade marker', () => {
  test('a restack task (carries restack_predecessor) → cascadeSubIssueId set', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'TR',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'B',
      restack_predecessor_sub_issue_id: 'A',
    }));
    expect(evt?.cascadeSubIssueId).toBe('B');
  });

  test('an iteration task (orchestration_iteration=true) → cascadeSubIssueId set', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'TI',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A',
      orchestration_iteration: true,
    }));
    expect(evt?.cascadeSubIssueId).toBe('A');
  });

  test('a normal child task (no markers) → cascadeSubIssueId undefined', () => {
    const evt = parseTerminalTaskRecord(taskRecord({
      task_id: 'T1', status: 'COMPLETED', orchestration_id: 'orch_1',
    }));
    expect(evt?.cascadeSubIssueId).toBeUndefined();
  });
});

/** Mock for the cascade path: loadOrchestration + per-dependent GetCommand pr_url. */
function mockCascade(children: Array<{
  sub_issue_id: string;
  depends_on?: string[];
  child_status: string;
  child_task_id?: string;
  child_branch_name?: string;
  linear_identifier?: string;
}>): void {
  const meta = {
    sub_issue_id: '#meta',
    orchestration_id: 'orch_1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'o/r',
    child_count: children.length,
    platform_user_id: 'user-1',
    // A panel comment exists → the cascade EDITS it (UX.2), rather than posting fresh.
    status_comment_id: 'panel-cmt-1',
  };
  const rows = children.map((c) => ({
    orchestration_id: 'orch_1',
    sub_issue_id: c.sub_issue_id,
    depends_on: c.depends_on ?? [],
    child_status: c.child_status,
    repo: 'o/r',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    ...(c.child_task_id && { child_task_id: c.child_task_id }),
    ...(c.child_branch_name && { child_branch_name: c.child_branch_name }),
    ...(c.linear_identifier && { linear_identifier: c.linear_identifier }),
  }));
  ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Query') return { Items: [meta, ...rows] }; // loadOrchestration
    if (cmd._type === 'Get') { // resolvePrNumber for a dependent task
      const tid = (cmd.input.Key as { task_id: string }).task_id;
      return { Item: { task_id: tid, pr_url: `https://github.com/o/r/pull/${tid.length}` } };
    }
    if (cmd._type === 'BatchGet') { // resolveChildPrUrls for the panel
      const keys = (cmd.input.RequestItems as Record<string, { Keys: Array<{ task_id: string }> }>);
      const tbl = Object.keys(keys)[0];
      return { Responses: { [tbl]: keys[tbl].Keys.map((k) => ({ task_id: k.task_id, pr_url: `https://github.com/o/r/pull/${k.task_id.length}` })) } };
    }
    return {};
  });
}

describe('orchestration-reconciler handler — A6 cascade', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset();
    createTaskCoreMock.mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
  });

  test('restack on B completes → re-stacks B\'s direct dependent C (one hop)', async () => {
    // chain A→B→C, all started; the just-completed task re-stacked B.
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
      { sub_issue_id: 'C', depends_on: ['B'], child_status: 'succeeded', child_task_id: 'task-C', child_branch_name: 'branch-C' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'restack-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    // Exactly one restack spawned — for C (B's direct dependent), NOT A.
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [body, ctx] = createTaskCoreMock.mock.calls[0];
    expect(body.workflow_ref).toBe('coding/restack-v1');
    expect(ctx.channelMetadata.orchestration_sub_issue_id).toBe('C');
    expect(ctx.channelMetadata.restack_predecessor_sub_issue_id).toBe('B');
    expect(ctx.channelMetadata.orchestration_merge_branches).toBe(JSON.stringify(['branch-B']));
    // Idempotency keyed on the SOURCE task id (converges, no loop).
    expect(ctx.idempotencyKey).toContain('restack-task-1');
  });

  test('iteration on A completes → re-stacks A\'s direct dependent B', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    expect(createTaskCoreMock.mock.calls[0][1].channelMetadata.orchestration_sub_issue_id).toBe('B');
  });

  test('UX.15: a cascade that RE-OPENS the epic clears rollup_posted_at (so parent state can re-settle)', async () => {
    // A comment on an already-completed epic re-opens it. The first
    // completion's rollup_posted_at stamp must be cleared, or claimRollup stays
    // failed forever and the parent reaction/state never re-mirror (👀→✅).
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    // An Update issued a `REMOVE rollup_posted_at` on the meta row.
    const clears = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?._type === 'Update'
        && typeof cmd.input?.UpdateExpression === 'string'
        && cmd.input.UpdateExpression.includes('REMOVE rollup_posted_at'));
    expect(clears.length).toBeGreaterThan(0);
  });

  test('FAILED iteration → no cascade', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-fail',
        status: 'FAILED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('cascade source with no started dependents → no restack', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'blocked' }, // not started
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('UX.15 regression: a re-stack of a NO-DEPENDENTS node still refreshes the panel + settles (not stuck)', async () => {
    // The stress-caught hang: a cascade source with no dependents returned
    // early without refreshing → the node's '🔄 updating' row never cleared and
    // the epic never re-settled to ✅. Here every child is already terminal, so
    // the completion settle must fire: panel edited + parent state mirrored.
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      // B is a leaf (nothing depends on it) AND has no dependents → planDirectRestack=0.
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    // A re-stack of B (the no-dependents leaf) completes.
    await handler({
      Records: [taskRecord({
        task_id: 'restack-B',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'B',
        restack_predecessor_sub_issue_id: 'A',
      })],
    } as never);

    // No further restack (B has no dependents).
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // But the panel WAS refreshed (settle) — and since all children are
    // terminal, it shows complete + mirrors parent state.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/complete/i);
    expect(body).not.toMatch(/updating/i); // the stale updating row is gone
    expect(transitionIssueStateMock).toHaveBeenCalled(); // parent settled
  });

  test('a cascade source does NOT run normal child gating (no GSI sub-issue lookup)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
      })],
    } as never);
    // Never queried ChildTaskIndex (that's the normal-gating path).
    const gsiCalls = ddbSend.mock.calls.filter(
      (c) => c[0]?._type === 'Query' && c[0]?.input?.IndexName === 'ChildTaskIndex');
    expect(gsiCalls).toHaveLength(0);
  });
});

describe('orchestration-reconciler handler — A6 cascade surfacing via the panel (#247 UX.2)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
  });

  const iterEvent = (sub: string) => ({
    Records: [taskRecord({
      task_id: 'iter-task-1',
      status: 'COMPLETED',
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: sub,
      orchestration_iteration: true,
    })],
  }) as never;

  test('refreshes the panel with the impacted row as "updating per comment" — NO standalone parent/sub-issue comments', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler(iterEvent('A'));
    // The panel is edited (upsertStatusComment), NOT a stream of new comments.
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    // Impacted dependent B shows '🔄 … updating per ENG-1's comment'.
    expect(body).toMatch(/ENG-2.*updating per ENG-1's comment/);
    // The retired standalone '🔄 Re-stacked' / 'revised' parent comments are GONE.
    expect(postIssueCommentMock).not.toHaveBeenCalled();
  });

  test('idempotent replay (200, NOT 201) does NOT re-mark the panel as updating', async () => {
    createTaskCoreMock.mockResolvedValue({ statusCode: 200, body: '{}' });
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler(iterEvent('A'));
    // No NEW restack task created → no panel "updating" refresh from the cascade.
    expect(upsertStatusCommentMock).not.toHaveBeenCalled();
  });

  test('integration-node dependent renders friendly in the panel (never raw id)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'orch_1__integration', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-int', child_branch_name: 'branch-int' },
    ]);
    await handler(iterEvent('A'));
    expect(upsertStatusCommentMock).toHaveBeenCalled();
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toContain('Integration — combined result');
    expect(body).not.toContain('orch_1__integration');
  });

  test('a restack from a PREDECESSOR change (not a comment) says "updating to include … change"', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    // restack source (carries restack_predecessor, NOT orchestration_iteration).
    await handler({
      Records: [taskRecord({
        task_id: 'restack-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        restack_predecessor_sub_issue_id: 'Z',
      })],
    } as never);
    const body = upsertStatusCommentMock.mock.calls.at(-1)![2] as string;
    expect(body).toMatch(/ENG-2.*updating to include ENG-1's change/);
  });
});

describe('orchestration-reconciler handler — A6 iteration ack reply (#247 UX.3)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCoreMock.mockReset().mockResolvedValue({ statusCode: 201, body: '{}' });
    postIssueCommentMock.mockReset().mockResolvedValue(true);
    upsertStatusCommentMock.mockReset().mockResolvedValue('panel-cmt-1');
    swapIssueReactionMock.mockReset().mockResolvedValue(true);
    swapCommentReactionMock.mockReset().mockResolvedValue(true);
    transitionIssueStateMock.mockReset().mockResolvedValue(true);
    replyToCommentMock.mockReset().mockResolvedValue('reply-1');
    upsertThreadedReplyMock.mockReset().mockResolvedValue('reply-1');
  });

  /** An iteration event carrying the human comment id that triggered it. */
  const iterEventWithComment = (status: string, commentId = 'human-cmt-1', buildPassed?: boolean, errorMessage?: string) => ({
    Records: [taskRecord({
      task_id: 'iter-task-1',
      status,
      orchestration_id: 'orch_1',
      orchestration_sub_issue_id: 'A',
      orchestration_iteration: true,
      trigger_comment_id: commentId,
      ...(buildPassed !== undefined && { build_passed: buildPassed }),
      ...(errorMessage !== undefined && { error_message: errorMessage }),
    })],
  }) as never;

  test('successful iteration → ✅ threaded reply to the triggering comment, linking the PR', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED'));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    // Signature: replyToComment(ctx, issueId, parentCommentId, body).
    const [, issueId, parentCommentId, body] = upsertThreadedReplyMock.mock.calls[0];
    expect(issueId).toBe('A'); // the sub-issue the comment lives on
    expect(parentCommentId).toBe('human-cmt-1');
    // iteration-UX: the PR ref is a clickable markdown link when the URL resolves.
    expect(body).toMatch(/^✅ Updated — \[PR #\d+\]\(https:\/\/.*\)\./);
    // #247 UX.21: the trigger comment's 👀 swaps to ✅, and the sub-issue
    // advances to In Review (platform-owned settle, not agent-flapped).
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'white_check_mark');
    expect(transitionIssueStateMock).toHaveBeenCalledWith(expect.anything(), 'A', 'started', ['In Review']);
  });

  test('#247 UX.19: a PARENT-routed iteration replies on the PARENT issue, not the sub-issue', async () => {
    // The human commented on the parent epic (UX.18 routed it to sub-issue A).
    // The ✅/❌ reply must use the PARENT issue id as commentCreate's issueId —
    // else Linear rejects the reply (parentId belongs to a different issue) and
    // the human sees 👀 then silence (live-caught on ABCA-304).
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'iter-task-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        orchestration_iteration: true,
        trigger_comment_id: 'parent-cmt-1',
        trigger_comment_issue_id: 'PARENT', // comment lives on the parent epic
      })],
    } as never);

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, issueId, parentCommentId] = upsertThreadedReplyMock.mock.calls[0];
    expect(issueId).toBe('PARENT'); // NOT 'A' — the reply targets the parent comment's issue
    expect(parentCommentId).toBe('parent-cmt-1');
  });

  test('FAILED iteration (agent crash) → ❌ reply with classified reason + CloudWatch task id (UX.5)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('FAILED', 'human-cmt-1', undefined, 'agent_status="error_max_turns"'));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
    expect(body).toMatch(/^❌/);
    expect(body).toMatch(/Exceeded max turns/i); // classified
    expect(body).toMatch(/CloudWatch for task `iter-task-1`/);
    // retryable agent/timeout → plain reply-to-retry next step (retryGuidance).
    expect(body).toMatch(/reply here with any extra guidance/i);
    // A failed iteration still does not cascade onto dependents.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // #247 UX.21: the trigger comment's 👀 swaps to ❌, but the sub-issue state
    // is LEFT in place on failure (the ❌ + reply convey it; never demote).
    expect(swapCommentReactionMock).toHaveBeenCalledWith(expect.anything(), 'human-cmt-1', 'x');
    expect(transitionIssueStateMock).not.toHaveBeenCalled();
  });

  test('COMPLETED-but-build-failed iteration → ❌ build/test reply pointing at PR checks (UX.5)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    // COMPLETED, build_passed=false, NO error_message → build/test failure shape.
    await handler(iterEventWithComment('COMPLETED', 'human-cmt-1', false));

    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
    expect(body).toMatch(/build\/tests didn't pass/i);
    // K2: build-gate failures now point at the agent's CloudWatch build log
    // (the build ran in the microVM), not the PR's GitHub checks.
    expect(body).toMatch(/build log in CloudWatch/i);
    expect(body).not.toMatch(/PR's checks/i);
    // build_passed=false ⇒ not a success ⇒ no cascade onto dependents.
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('build_passed=false → ❌ reply (treated as not-successful)', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    await handler(iterEventWithComment('COMPLETED', 'human-cmt-1', false));
    const [, , , body] = upsertThreadedReplyMock.mock.calls[0];
    expect(body).toMatch(/^❌/);
  });

  test('idempotent: redelivery loses the claim → no duplicate reply', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
    ]);
    // First Update (the ack claim) wins; a second Update with the same key is
    // rejected by the conditional → simulate the redelivery losing the claim.
    let ackClaims = 0;
    const base = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation(async (cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Update' && (cmd.input.UpdateExpression as string)?.includes('ack_replied_at')) {
        ackClaims += 1;
        if (ackClaims > 1) {
          const err = new Error('conditional');
          (err as { name?: string }).name = 'ConditionalCheckFailedException';
          throw err;
        }
        return {};
      }
      return base(cmd);
    });

    await handler(iterEventWithComment('COMPLETED'));
    await handler(iterEventWithComment('COMPLETED')); // redelivery

    // Replied exactly once across both deliveries.
    expect(upsertThreadedReplyMock).toHaveBeenCalledTimes(1);
  });

  test('a restack (no trigger_comment_id) → no ack reply', async () => {
    mockCascade([
      { sub_issue_id: 'A', child_status: 'succeeded', child_task_id: 'task-A', child_branch_name: 'branch-A', linear_identifier: 'ENG-1' },
      { sub_issue_id: 'B', depends_on: ['A'], child_status: 'succeeded', child_task_id: 'task-B', child_branch_name: 'branch-B', linear_identifier: 'ENG-2' },
    ]);
    await handler({
      Records: [taskRecord({
        task_id: 'restack-1',
        status: 'COMPLETED',
        orchestration_id: 'orch_1',
        orchestration_sub_issue_id: 'A',
        restack_predecessor_sub_issue_id: 'Z',
      })],
    } as never);
    expect(upsertThreadedReplyMock).not.toHaveBeenCalled();
  });
});
