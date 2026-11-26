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

import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

const mockDdbSend = jest.fn().mockResolvedValue({ Item: undefined });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

const mockUpsertTaskComment: jest.Mock = jest.fn();
const mockRenderCommentBody: jest.Mock = jest.fn().mockReturnValue('rendered body');
jest.mock('../../src/handlers/shared/github-comment', () => ({
  upsertTaskComment: (args: unknown) => mockUpsertTaskComment(args),
  renderCommentBody: (args: unknown) => mockRenderCommentBody(args),
  GitHubCommentError: class GitHubCommentError extends Error {
    readonly httpStatus: number | undefined;
    constructor(message: string, httpStatus?: number) {
      super(message);
      this.name = 'GitHubCommentError';
      this.httpStatus = httpStatus;
    }
  },
}));

const mockLoadRepoConfig: jest.Mock = jest.fn();
jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (repo: string) => mockLoadRepoConfig(repo),
}));

const mockResolveGitHubToken: jest.Mock = jest.fn();
const mockClearTokenCache: jest.Mock = jest.fn();
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: (arn: string) => mockResolveGitHubToken(arn),
  clearTokenCache: () => mockClearTokenCache(),
}));

const mockDispatchSlackEvent: jest.Mock = jest.fn();
jest.mock('../../src/handlers/slack-notify', () => {
  class SlackApiError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SlackApiError';
    }
  }
  return {
    dispatchSlackEvent: (ev: unknown, ddb: unknown) => mockDispatchSlackEvent(ev, ddb),
    SlackApiError,
  };
});

const mockPostIssueComment: jest.Mock = jest.fn().mockResolvedValue({ ok: true });
const mockReplyToComment: jest.Mock = jest.fn().mockResolvedValue('reply-id');
const mockSwapCommentReaction: jest.Mock = jest.fn().mockResolvedValue(true);
const mockUpsertThreadedReply: jest.Mock = jest.fn().mockResolvedValue('reply-id');
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (
    ctx: { linearWorkspaceId: string; registryTableName: string },
    issueId: string,
    body: string,
  ) => mockPostIssueComment(ctx, issueId, body),
  replyToComment: (
    ctx: { linearWorkspaceId: string; registryTableName: string },
    issueId: string,
    parentCommentId: string,
    body: string,
  ) => mockReplyToComment(ctx, issueId, parentCommentId, body),
  upsertThreadedReply: (
    ctx: { linearWorkspaceId: string; registryTableName: string },
    issueId: string,
    parentCommentId: string,
    body: string,
    existingReplyId?: string,
    options?: Record<string, unknown>,
  ) => mockUpsertThreadedReply(ctx, issueId, parentCommentId, body, existingReplyId, options),
  swapCommentReaction: (ctx: unknown, commentId: string, emoji: string) =>
    mockSwapCommentReaction(ctx, commentId, emoji),
  EMOJI_SUCCESS: 'white_check_mark',
  EMOJI_FAILURE: 'x',
  EMOJI_NEEDS_INPUT: 'question',
}));

const mockPostIssueCommentAdf: jest.Mock = jest.fn().mockResolvedValue({ ok: true });
const mockUpdateIssueCommentAdf: jest.Mock = jest.fn().mockResolvedValue({ ok: true });
const mockBuildAdfDocument: jest.Mock = jest.fn(
  (paragraphs: ReadonlyArray<ReadonlyArray<{ text: string }>>) => ({ _adf: paragraphs }),
);
const mockIterationStatus = jest.fn();
afterEach(() => {
  for (const [status] of mockIterationStatus.mock.calls) {
    expect(status).toEqual(expect.objectContaining({ terminal: true }));
  }
  mockIterationStatus.mockClear();
});
jest.mock('../../src/handlers/shared/jira-iteration-comment', () => ({
  updateJiraIterationComment: (_ddb: unknown, _table: string, _task: string,
    ctx: unknown, issue: string, comment: string, status: { body: unknown; terminal: boolean }) => {
    mockIterationStatus(status);
    return mockUpdateIssueCommentAdf(ctx, issue, comment, status.body);
  },
}));

jest.mock('../../src/handlers/shared/jira-feedback', () => ({
  postIssueCommentAdf: (
    ctx: { cloudId: string; registryTableName: string },
    issueKey: string,
    body: unknown,
  ) => mockPostIssueCommentAdf(ctx, issueKey, body),
  updateIssueCommentAdf: (
    ctx: { cloudId: string; registryTableName: string },
    issueKey: string,
    commentId: string,
    body: unknown,
  ) => mockUpdateIssueCommentAdf(ctx, issueKey, commentId, body),
  buildAdfDocument: (paragraphs: ReadonlyArray<ReadonlyArray<{ text: string }>>) =>
    mockBuildAdfDocument(paragraphs),
  parseMarkdownBlocks: jest.requireActual('../../src/handlers/shared/jira-feedback').parseMarkdownBlocks,
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:platform';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';
process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = 'JiraWorkspaceRegistry';

function adfText(body: unknown): string {
  const paragraphs = (body as { _adf?: ReadonlyArray<ReadonlyArray<{ text: string }>> })._adf ?? [];
  return paragraphs.map((runs) => runs.map((r) => r.text).join('')).join('\n');
}

import {
  CHANNEL_DEFAULTS,
  parseStreamRecord,
  renderJiraFinalStatusComment,
  renderLinearFinalStatusComment,
  resolveChannelFilter,
  routeEvent,
  shouldFanOut,
  handler,
  type FanOutEvent,
  type TaskNotificationsConfig,
} from '../../src/handlers/fanout-task-events';
import { parseCommentTrigger } from '../../src/handlers/shared/comment-trigger';
import { MAX_REPLY_ATTEMPTS } from '../../src/handlers/shared/iteration-reply-claim';
import type { AdfBlock, AdfParagraph } from '../../src/handlers/shared/jira-feedback';
import {
  renderJiraFinalStatusText,
  renderJiraFinishedPointer,
} from '../../src/handlers/shared/jira-status-comment';

function mkRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  newImage: Record<string, { S?: string; N?: string; BOOL?: boolean; M?: Record<string, { S?: string }> }> | undefined,
): DynamoDBRecord {
  const id = Math.random().toString(36).slice(2);
  return {
    eventID: `evt-${id}`,
    eventName,
    eventSource: 'aws:dynamodb',
    dynamodb: { SequenceNumber: `seq-${id}`, ...(newImage && { NewImage: newImage as never }) },
  } as unknown as DynamoDBRecord;
}

function mkEvent(type: string, taskId = 't-1'): DynamoDBRecord {
  return mkRecord('INSERT', {
    task_id: { S: taskId },
    event_id: { S: `01ABC${type}` },
    event_type: { S: type },
    timestamp: { S: '2026-04-22T04:00:00Z' },
    metadata: { M: { code: { S: 'OK' } } },
  });
}

function mkMilestone(milestone: string, taskId = 't-1', details?: string): DynamoDBRecord {
  return mkRecord('INSERT', {
    task_id: { S: taskId },
    event_id: { S: `01ABC${milestone}` },
    event_type: { S: 'agent_milestone' },
    timestamp: { S: '2026-04-22T04:00:00Z' },
    metadata: { M: { milestone: { S: milestone }, ...(details !== undefined && { details: { S: details } }) } },
  });
}

describe('fanout-task-events: parseStreamRecord', () => {
  test('parses a well-formed INSERT into FanOutEvent', () => {
    const rec = mkEvent('task_completed', 't-parse-1');
    const parsed = parseStreamRecord(rec);
    expect(parsed).not.toBeNull();
    expect(parsed!.task_id).toBe('t-parse-1');
    expect(parsed!.event_type).toBe('task_completed');
    expect(parsed!.metadata).toEqual({ code: 'OK' });
  });

  test('returns null on REMOVE (tombstones are ignored)', () => {
    const rec = mkRecord('REMOVE', undefined);
    expect(parseStreamRecord(rec)).toBeNull();
  });

  test('returns null when NewImage is missing required fields', () => {
    const rec = mkRecord('INSERT', {
      task_id: { S: 't-bad' },
    });
    expect(parseStreamRecord(rec)).toBeNull();
  });
});

describe('fanout-task-events: shouldFanOut filter (union of per-channel defaults)', () => {
  const make = (event_type: string): FanOutEvent => ({
    task_id: 't-1',
    event_id: 'e-1',
    event_type,
    timestamp: '2026-04-22T04:00:00Z',
  });

  test.each([
    'task_failed',
    'task_completed',
    'task_cancelled',
    'task_stranded',
    'task_timed_out',
    'task_created',
    'session_started',
    'agent_error',
    'pr_created',
    'approval_requested',
    'approval_stranded',
    'status_response',
  ])('%s is fanned out (matches at least one channel default)', (t) => {
    expect(shouldFanOut(make(t))).toBe(true);
  });

  test.each([
    'agent_milestone',
    'agent_turn',
    'agent_tool_call',
    'agent_tool_result',
    'agent_cost_update',
    'hydration_started',
    'hydration_complete',
    'admission_rejected',
    'something_else',
  ])('%s is NOT fanned out (verbose / internal)', (t) => {
    expect(shouldFanOut(make(t))).toBe(false);
  });
});

describe('fanout-task-events: per-channel filter contract (design §6.2)', () => {
  test('Slack subscribes to terminal + error + approval milestones + status_response + lifecycle (NOT pr_created)', () => {
    const f = CHANNEL_DEFAULTS.slack;
    expect([...f].sort()).toEqual([
      'agent_error',
      'approval_requested',
      'approval_stranded',
      'session_started',
      'status_response',
      'task_cancelled',
      'task_completed',
      'task_created',
      'task_failed',
      'task_stranded',
      'task_timed_out',
    ]);
    expect(f.has('pr_created')).toBe(false);
  });

  test('every Slack-default event the dispatcher actually renders today is in NOTIFIABLE_EVENTS (drift guard)', () => {
    const real = jest.requireActual<typeof import('../../src/handlers/slack-notify')>(
      '../../src/handlers/slack-notify',
    );
    const forwardCompat = new Set(['approval_requested', 'approval_stranded', 'status_response']);
    const expectedRenderable = [...CHANNEL_DEFAULTS.slack].filter(
      e => !forwardCompat.has(e),
    );
    for (const eventType of expectedRenderable) {
      expect(real.NOTIFIABLE_EVENTS.has(eventType)).toBe(true);
    }
  });

  test('Email subscribes to task_completed + task_failed + approval_requested only (minimal per §6.2)', () => {
    const f = CHANNEL_DEFAULTS.email;
    expect([...f].sort()).toEqual([
      'approval_requested',
      'task_completed',
      'task_failed',
    ]);
    expect(f.has('task_cancelled')).toBe(false);
    expect(f.has('task_stranded')).toBe(false);
  });

  test('GitHub subscribes to pr_created + terminal events + task_timed_out (edit-in-place surface)', () => {
    const f = CHANNEL_DEFAULTS.github;
    expect([...f].sort()).toEqual([
      'pr_created',
      'task_cancelled',
      'task_completed',
      'task_failed',
      'task_stranded',
      'task_timed_out',
    ]);
  });

  test('Linear subscribes to pr_created + terminal events + task_timed_out (ADR-016 P4.5 courtesy comment + post-once final-status)', () => {
    const f = CHANNEL_DEFAULTS.linear;
    expect([...f].sort()).toEqual([
      'pr_created',
      'task_cancelled',
      'task_completed',
      'task_failed',
      'task_stranded',
      'task_timed_out',
    ]);
  });

  test('Jira subscribes to terminal events + task_timed_out (post-once final-status comment)', () => {
    const f = CHANNEL_DEFAULTS.jira;
    expect([...f].sort()).toEqual([
      'task_cancelled',
      'task_completed',
      'task_failed',
      'task_stranded',
      'task_timed_out',
    ]);
    expect(f.has('pr_created')).toBe(false);
    expect(f.has('approval_requested')).toBe(false);
  });

  test('agent_error routes only to Slack, not Email or GitHub', () => {
    expect(CHANNEL_DEFAULTS.slack.has('agent_error')).toBe(true);
    expect(CHANNEL_DEFAULTS.email.has('agent_error')).toBe(false);
    expect(CHANNEL_DEFAULTS.github.has('agent_error')).toBe(false);
  });
});

describe('fanout-task-events: resolveChannelFilter overrides', () => {
  test('no overrides → channel default', () => {
    expect(resolveChannelFilter('slack')).toBe(CHANNEL_DEFAULTS.slack);
  });

  test('enabled=false returns empty set so no events dispatch', () => {
    const overrides: TaskNotificationsConfig = { email: { enabled: false } };
    expect(resolveChannelFilter('email', overrides).size).toBe(0);
  });

  test('explicit events replace defaults entirely', () => {
    const overrides: TaskNotificationsConfig = {
      slack: { events: ['task_completed'] },
    };
    const f = resolveChannelFilter('slack', overrides);
    expect([...f]).toEqual(['task_completed']);
    expect(f.has('agent_error')).toBe(false);
  });

  test('"default" token in an explicit list expands to the channel defaults', () => {
    const overrides: TaskNotificationsConfig = {
      slack: { events: ['default', 'agent_milestone'] },
    };
    const f = resolveChannelFilter('slack', overrides);
    for (const t of CHANNEL_DEFAULTS.slack) expect(f.has(t)).toBe(true);
    expect(f.has('agent_milestone')).toBe(true);
  });

  test('empty events list mutes the channel AND emits a footgun warn', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      const overrides: TaskNotificationsConfig = { slack: { events: [] } };
      expect(resolveChannelFilter('slack', overrides).size).toBe(0);
      const warnMeta = warnSpy.mock.calls.map(c => c[1] as Record<string, unknown> | undefined);
      const emptyWarn = warnMeta.find(m => m?.event === 'fanout.resolve.empty_events_override');
      expect(emptyWarn).toBeDefined();
      expect(emptyWarn?.channel).toBe('slack');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('other channels are unaffected when one is overridden', () => {
    const overrides: TaskNotificationsConfig = {
      slack: { enabled: false },
    };
    expect(resolveChannelFilter('slack', overrides).size).toBe(0);
    expect(resolveChannelFilter('email', overrides)).toBe(CHANNEL_DEFAULTS.email);
  });
});

describe('fanout-task-events: routeEvent (per-channel dispatch)', () => {
  const mk = (event_type: string): FanOutEvent => ({
    task_id: 't-route',
    event_id: 'e-route',
    event_type,
    timestamp: '2026-04-22T04:00:00Z',
  });

  test('task_completed routes to all five channels (slack, github, linear, jira, email)', async () => {
    const outcome = await routeEvent(mk('task_completed'));
    expect([...outcome.dispatched].sort()).toEqual(['email', 'github', 'jira', 'linear', 'slack']);
    expect(outcome.infraRejections).toEqual([]);
  });

  test('task_cancelled skips Email per §6.2 (Slack + GitHub + Linear + Jira)', async () => {
    const outcome = await routeEvent(mk('task_cancelled'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'jira', 'linear', 'slack']);
  });

  test('task_stranded skips Email per §6.2', async () => {
    const outcome = await routeEvent(mk('task_stranded'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'jira', 'linear', 'slack']);
  });

  test('task_timed_out routes to Slack + GitHub + Jira + Linear', async () => {
    const outcome = await routeEvent(mk('task_timed_out'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'jira', 'linear', 'slack']);
  });

  test('agent_error routes only to Slack', async () => {
    const outcome = await routeEvent(mk('agent_error'));
    expect(outcome.dispatched).toEqual(['slack']);
  });

  test('pr_created routes to GitHub + Linear (ADR-016 P4.5 courtesy comment), not Slack', async () => {
    const outcome = await routeEvent(mk('pr_created'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'linear']);
    expect(outcome.dispatched).not.toContain('slack');
  });

  test('event with no subscribers returns an empty channel list', async () => {
    const outcome = await routeEvent(mk('agent_milestone'));
    expect(outcome.dispatched).toEqual([]);
    expect(outcome.infraRejections).toEqual([]);
  });

  test('per-task override silences one channel without affecting others', async () => {
    const overrides: TaskNotificationsConfig = { slack: { enabled: false } };
    const outcome = await routeEvent(mk('task_completed'), overrides);
    expect([...outcome.dispatched].sort()).toEqual(['email', 'github', 'jira', 'linear']);
    expect(outcome.dispatched).not.toContain('slack');
  });
});

describe('fanout-task-events: channel isolation', () => {
  test('one channel rejecting does NOT prevent the others from dispatching', async () => {
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(
      Object.assign(new Error('slack infra down'), { name: 'ProvisionedThroughputExceededException' }),
    );
    const loggerModule = await import('../../src/handlers/shared/logger');
    const originalInfo = loggerModule.logger.info.bind(loggerModule.logger);
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    const observedEvents: string[] = [];
    const infoSpy = jest.spyOn(loggerModule.logger, 'info').mockImplementation(
      (msg: string, meta?: Record<string, unknown>) => {
        const ev = meta?.event as string | undefined;
        if (ev) observedEvents.push(ev);
        return originalInfo(msg, meta);
      },
    );
    try {
      const outcome = await routeEvent({
        task_id: 't-isol',
        event_id: 'e-isol',
        event_type: 'task_completed',
        timestamp: '2026-04-22T04:00:00Z',
      });

      expect(observedEvents).toContain('fanout.email.dispatch_stub');
      expect(mockDispatchSlackEvent).toHaveBeenCalledTimes(1);

      expect([...outcome.dispatched].sort()).toEqual(['email', 'github', 'jira', 'linear']);
      expect(outcome.dispatched).not.toContain('slack');

      expect(outcome.infraRejections).toEqual(['slack']);

      const warnCalls = warnSpy.mock.calls.map(c => c[1] as Record<string, unknown> | undefined);
      const rejectedWarn = warnCalls.find(meta => meta?.event === 'fanout.dispatcher.rejected');
      expect(rejectedWarn).toBeDefined();
      expect(rejectedWarn?.channel).toBe('slack');
      expect(rejectedWarn?.retryable).toBe(true);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      mockDispatchSlackEvent.mockReset();
    }
  });

  test('SlackApiError from the dispatcher is swallowed (counted as dispatched)', async () => {
    const { SlackApiError } = jest.requireMock<typeof import('../../src/handlers/slack-notify')>(
      '../../src/handlers/slack-notify',
    );
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(
      new SlackApiError('slack chat.postMessage failed: channel_not_found'),
    );
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      const outcome = await routeEvent({
        task_id: 't-api-err',
        event_id: 'e-api-err',
        event_type: 'task_completed',
        timestamp: '2026-05-05T00:00:00Z',
      });

      expect(outcome.dispatched).toContain('slack');
      expect(outcome.infraRejections).not.toContain('slack');
      const rejected = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.dispatcher.rejected',
      );
      expect(rejected).toBeUndefined();
      const apiErr = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.slack.api_error',
      );
      expect(apiErr).toBeDefined();
    } finally {
      warnSpy.mockRestore();
      mockDispatchSlackEvent.mockReset();
    }
  });
});

describe('fanout-task-events: handler', () => {
  test('dispatches only filtered events', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        mkEvent('agent_turn'),
        mkEvent('task_completed'),
        mkEvent('agent_cost_update'),
        mkEvent('pr_created'),
      ],
    };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });

  test('per-task cap drops events beyond 20 per invocation', async () => {
    const records: DynamoDBRecord[] = [];
    for (let i = 0; i < 25; i++) {
      records.push(mkEvent('agent_milestone', 't-chatty'));
    }
    const event: DynamoDBStreamEvent = { Records: records };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });

  test('malformed records are dropped, not thrown', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        mkRecord('INSERT', undefined),
        mkRecord('INSERT', { task_id: { S: 'x' } }),
        mkEvent('task_completed'),
      ],
    };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });

  test('REMOVE events are skipped', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [mkRecord('REMOVE', undefined)],
    };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });
});

describe('fanout-task-events: GitHub dispatcher (Chunk J)', () => {
  const TASK_RECORD_BASE = {
    task_id: 't-gh',
    user_id: 'u-1',
    status: 'COMPLETED',
    repo: 'owner/repo',
    pr_number: 42,
    branch_name: 'bgagent/t-gh/fix',
    channel_source: 'api',
    status_created_at: 'COMPLETED#2026-04-30T12:00:00Z',
    created_at: '2026-04-30T11:50:00Z',
    updated_at: '2026-04-30T12:00:00Z',
  };

  beforeEach(() => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Update') return Promise.resolve({});
      return Promise.resolve({ Item: undefined });
    });
    mockUpsertTaskComment.mockReset();
    mockRenderCommentBody.mockReset().mockReturnValue('rendered body');
    mockLoadRepoConfig.mockReset().mockResolvedValue(null);
    mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_fake');
    mockClearTokenCache.mockReset();
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: true });
  });

  test('first terminal event POSTs a new comment and persists the comment_id to TaskTable', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 555,
      created: true,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
    const upsertArg = mockUpsertTaskComment.mock.calls[0][0];
    expect(upsertArg).toMatchObject({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      token: 'ghp_fake',
      existingCommentId: undefined,
    });
    expect(upsertArg).not.toHaveProperty('existingEtag');
    const updateCall = mockDdbSend.mock.calls.find(
      ([cmd]) => (cmd as { _type?: string })._type === 'Update',
    );
    expect(updateCall).toBeDefined();
    const update = updateCall![0] as {
      input: {
        ExpressionAttributeValues: Record<string, unknown>;
        UpdateExpression: string;
        ConditionExpression: string;
      };
    };
    expect(update.input.ExpressionAttributeValues[':cid']).toBe(555);
    expect(update.input.UpdateExpression).toBe('SET github_comment_id = :cid');
    expect(update.input.UpdateExpression).not.toMatch(/etag/);
    expect(update.input.ConditionExpression).toContain('attribute_not_exists(github_comment_id)');
  });

  test('subsequent event passes the persisted comment_id so the helper PATCHes', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') {
        return Promise.resolve({ Item: { ...TASK_RECORD_BASE, github_comment_id: 555 } });
      }
      return Promise.resolve({});
    });
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 555,
      created: false,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    const upsertArg = mockUpsertTaskComment.mock.calls[0][0];
    expect(upsertArg.existingCommentId).toBe(555);
    const updateCalls = mockDdbSend.mock.calls.filter(
      ([cmd]) => (cmd as { _type?: string })._type === 'Update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('task with no issue_number and no pr_number skips the GitHub dispatcher', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') {
        return Promise.resolve({
          Item: { ...TASK_RECORD_BASE, pr_number: undefined, issue_number: undefined },
        });
      }
      return Promise.resolve({});
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
    const updateCalls = mockDdbSend.mock.calls.filter(
      ([cmd]) => (cmd as { _type?: string })._type === 'Update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('missing task record (TTL race) → skip without throwing', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-missing')] };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
  });

  test('upsertTaskComment rejection escalates to partial-batch retry', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockUpsertTaskComment.mockRejectedValueOnce(new Error('github 500'));

    const event = { Records: [mkEvent('task_completed', 't-gh')] } as DynamoDBStreamEvent;
    const result = await handler(event);
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe(event.Records[0].dynamodb?.SequenceNumber);
    const updateCalls = mockDdbSend.mock.calls.filter(
      c => (c[0] as { _type?: string })._type === 'Update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('dispatcher does NOT forward an If-Match-style ETag to upsertTaskComment (BLOCKER regression)', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Item: {
          ...TASK_RECORD_BASE,
          github_comment_id: 555,
          github_comment_etag: '"legacy-etag-from-before-fix"',
        },
      });
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 555,
      created: false,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    const upsertArg = mockUpsertTaskComment.mock.calls[0][0];
    expect(upsertArg.existingCommentId).toBe(555);
    expect(upsertArg).not.toHaveProperty('existingEtag');
  });

  test('404 → POST fallback persists new comment id with a prev-id condition guard', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') {
        return Promise.resolve({
          Item: { ...TASK_RECORD_BASE, github_comment_id: 555 },
        });
      }
      return Promise.resolve({});
    });
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 999,
      created: true,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    const updateCall = mockDdbSend.mock.calls.find(
      ([cmd]) => (cmd as { _type?: string })._type === 'Update',
    );
    expect(updateCall).toBeDefined();
    const update = updateCall![0] as {
      input: {
        ExpressionAttributeValues: Record<string, unknown>;
        UpdateExpression: string;
        ConditionExpression: string;
      };
    };
    expect(update.input.ExpressionAttributeValues[':cid']).toBe(999);
    expect(update.input.ExpressionAttributeValues[':prev']).toBe(555);
    expect(update.input.ConditionExpression).toContain('github_comment_id = :prev');
    expect(update.input.ConditionExpression).not.toContain('attribute_not_exists(github_comment_id)');
  });

  test('400 from PATCH surfaces as fanout.dispatcher.rejected without duplicate POST (If-Match regression guard)', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      mockDdbSend.mockResolvedValueOnce({
        Item: { ...TASK_RECORD_BASE, github_comment_id: 555 },
      });
      const { GitHubCommentError } = jest.requireMock<typeof import('../../src/handlers/shared/github-comment')>(
        '../../src/handlers/shared/github-comment',
      );
      mockUpsertTaskComment.mockRejectedValueOnce(
        new GitHubCommentError(
          'PATCH /repos/owner/repo/issues/comments/555 failed: HTTP 400',
          400,
        ),
      );

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
      await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

      const updateCalls = mockDdbSend.mock.calls.filter(
        c => (c[0] as { _type?: string })._type === 'Update',
      );
      expect(updateCalls).toHaveLength(0);

      const apiErrWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.github.api_error',
      );
      expect(apiErrWarn).toBeDefined();
      expect((apiErrWarn?.[1] as Record<string, unknown>).http_status).toBe(400);
      expect(String((apiErrWarn?.[1] as Record<string, unknown>).error)).toContain('HTTP 400');

      const rejectedWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.dispatcher.rejected',
      );
      expect(rejectedWarn).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test.each([403, 429])(
    'HTTP %s from GitHub escalates to partial-batch retry (rate-limit carve-out)',
    async (httpStatus) => {
      mockDdbSend.mockResolvedValueOnce({
        Item: { ...TASK_RECORD_BASE, github_comment_id: 555 },
      });
      const { GitHubCommentError } = jest.requireMock<typeof import('../../src/handlers/shared/github-comment')>(
        '../../src/handlers/shared/github-comment',
      );
      mockUpsertTaskComment.mockRejectedValueOnce(
        new GitHubCommentError(
          `PATCH /repos/owner/repo/issues/comments/555 failed: HTTP ${httpStatus}`,
          httpStatus,
        ),
      );

      const record = mkEvent('task_completed', 't-gh');
      const result = await handler({ Records: [record] });

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.dynamodb?.SequenceNumber }]);
    },
  );

  test('falls back to issue_number when pr_number is absent', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Item: { ...TASK_RECORD_BASE, pr_number: undefined, issue_number: 7 },
      })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    expect(mockUpsertTaskComment.mock.calls[0][0].issueOrPrNumber).toBe(7);
  });

  test('loadRepoConfig throwing a transient error falls back to the platform default token', async () => {
    mockLoadRepoConfig.mockRejectedValueOnce(
      Object.assign(new Error('rate exceeded'), { name: 'ProvisionedThroughputExceededException' }),
    );
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    expect(mockResolveGitHubToken).toHaveBeenCalledWith('arn:aws:secretsmanager:us-east-1:0:secret:platform');
  });

  test('resolveGitHubToken throwing causes the dispatcher to skip without calling upsertTaskComment', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockResolveGitHubToken.mockRejectedValueOnce(new Error('secrets manager down'));

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
  });

  test('saveCommentState ConditionalCheckFailed (task evicted) logs at INFO not ERROR', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: TASK_RECORD_BASE });
      if (cmd?._type === 'Update') {
        return Promise.reject(
          Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' }),
        );
      }
      return Promise.resolve({});
    });
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
  });

  test('saveCommentState non-conditional failure (DDB throttling) logs at ERROR with error_id', async () => {
    const errorSpy = jest.fn();
    jest.spyOn(
      (await import('../../src/handlers/shared/logger')).logger,
      'error',
    ).mockImplementation(errorSpy);

    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: TASK_RECORD_BASE });
      if (cmd?._type === 'Update') {
        return Promise.reject(
          Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
        );
      }
      return Promise.resolve({});
    });
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    const errorCall = errorSpy.mock.calls.find(
      c => (c[1] as Record<string, unknown> | undefined)?.error_id === 'FANOUT_GITHUB_PERSIST_FAILED',
    );
    expect(errorCall).toBeDefined();
  });

  test('401 from GitHub clears the token cache and retries once with a fresh token', async () => {
    const { GitHubCommentError } = jest.requireMock<typeof import('../../src/handlers/shared/github-comment')>(
      '../../src/handlers/shared/github-comment',
    );
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment
      .mockRejectedValueOnce(new GitHubCommentError('unauthorized', 401))
      .mockResolvedValueOnce({ commentId: 1, created: true });
    mockResolveGitHubToken
      .mockResolvedValueOnce('ghp_stale')
      .mockResolvedValueOnce('ghp_fresh');

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    expect(mockClearTokenCache).toHaveBeenCalledTimes(1);
    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(2);
    expect(mockUpsertTaskComment.mock.calls[1][0].token).toBe('ghp_fresh');
  });

  test('a 401 that persists after the token refresh is swallowed, not retried', async () => {
    const { GitHubCommentError } = jest.requireMock<typeof import('../../src/handlers/shared/github-comment')>(
      '../../src/handlers/shared/github-comment',
    );
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
      mockUpsertTaskComment
        .mockRejectedValueOnce(new GitHubCommentError('unauthorized', 401))
        .mockRejectedValueOnce(new GitHubCommentError('unauthorized', 401));

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
      await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

      expect(mockClearTokenCache).toHaveBeenCalledTimes(1);
      expect(mockUpsertTaskComment).toHaveBeenCalledTimes(2);
      const warns = warnSpy.mock.calls.map(c => c[1] as Record<string, unknown> | undefined);
      expect(warns.find(meta => meta?.event === 'fanout.github.api_error')).toMatchObject({
        task_id: 't-gh',
        http_status: 401,
      });
      expect(warns.find(meta => meta?.event === 'fanout.dispatcher.rejected')).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a retryable failure of the retry after a 401 still escalates to partial-batch retry', async () => {
    const { GitHubCommentError } = jest.requireMock<typeof import('../../src/handlers/shared/github-comment')>(
      '../../src/handlers/shared/github-comment',
    );
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockUpsertTaskComment
      .mockRejectedValueOnce(new GitHubCommentError('unauthorized', 401))
      .mockRejectedValueOnce(new GitHubCommentError('bad gateway', 502));

    const record = mkEvent('task_completed', 't-gh');
    const result = await handler({ Records: [record] });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.dynamodb?.SequenceNumber }]);
  });

  test('per-repo github_token_secret_arn override takes precedence over platform default', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      github_token_secret_arn: 'arn:repo-specific',
    });
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event);

    expect(mockResolveGitHubToken).toHaveBeenCalledWith('arn:repo-specific');
  });

  test('pr_created shows the PR link from the milestone when the task record has no pr_url yet', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...TASK_RECORD_BASE, status: 'RUNNING' } })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    await handler({
      Records: [mkMilestone('pr_created', 't-gh', 'https://github.com/owner/repo/pull/42')],
    });

    const renderArg = mockRenderCommentBody.mock.calls[0][0];
    expect(renderArg.latestEventType).toBe('pr_created');
    expect(renderArg.prUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  test('the pr_url of the task record wins over the milestone text', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...TASK_RECORD_BASE, pr_url: 'https://github.com/owner/repo/pull/42' } })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    await handler({
      Records: [mkMilestone('pr_created', 't-gh', 'https://github.com/owner/repo/pull/99')],
    });

    expect(mockRenderCommentBody.mock.calls[0][0].prUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  test('a terminal event takes no PR link from its own metadata', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE }).mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    await handler({
      Records: [mkRecord('INSERT', {
        task_id: { S: 't-gh' },
        event_id: { S: '01ABCtask_failed' },
        event_type: { S: 'task_failed' },
        timestamp: { S: '2026-04-22T04:00:00Z' },
        metadata: { M: { details: { S: 'https://example.com/not-a-pull-request' } } },
      })],
    });

    expect(mockRenderCommentBody.mock.calls[0][0].prUrl).toBeNull();
  });

  test('a timed-out task gets its comment updated', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') {
        return Promise.resolve({
          Item: { ...TASK_RECORD_BASE, status: 'TIMED_OUT', github_comment_id: 555 },
        });
      }
      return Promise.resolve({});
    });
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 555, created: false });

    await handler({ Records: [mkEvent('task_timed_out', 't-gh')] });

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
    expect(mockUpsertTaskComment.mock.calls[0][0].existingCommentId).toBe(555);
    expect(mockRenderCommentBody.mock.calls[0][0]).toMatchObject({
      status: 'TIMED_OUT',
      latestEventType: 'task_timed_out',
    });
  });

  test('TaskRecord with string-typed cost_usd/duration_s renders without throwing (DDB Number coercion)', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Item: {
          ...TASK_RECORD_BASE,
          cost_usd: '0.20939010000000002',
          duration_s: '96.0',
        },
      })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(mockRenderCommentBody).toHaveBeenCalledTimes(1);
    const renderArg = mockRenderCommentBody.mock.calls[0][0];
    expect(typeof renderArg.costUsd).toBe('number');
    expect(renderArg.costUsd).toBeCloseTo(0.2094, 4);
    expect(typeof renderArg.durationS).toBe('number');
    expect(renderArg.durationS).toBe(96);
    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
  });

  test('non-finite string cost collapses to null and emits a warn (surfaces writer bugs)', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      mockDdbSend
        .mockResolvedValueOnce({
          Item: { ...TASK_RECORD_BASE, cost_usd: 'not-a-number', duration_s: null },
        })
        .mockResolvedValueOnce({});
      mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
      await handler(event);

      const renderArg = mockRenderCommentBody.mock.calls[0][0];
      expect(renderArg.costUsd).toBeNull();
      expect(renderArg.durationS).toBeNull();

      const warnCall = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'numeric.coercion_failed',
      );
      expect(warnCall).toBeDefined();
      expect((warnCall?.[1] as Record<string, unknown>).field).toBe('cost_usd');
      expect((warnCall?.[1] as Record<string, unknown>).raw).toBe('not-a-number');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('absent cost_usd / duration_s fields (not just null) render as absent without warning', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      const base = { ...TASK_RECORD_BASE } as Record<string, unknown>;
      delete base.cost_usd;
      delete base.duration_s;
      mockDdbSend.mockResolvedValueOnce({ Item: base }).mockResolvedValueOnce({});
      mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
      await handler(event);

      const renderArg = mockRenderCommentBody.mock.calls[0][0];
      expect(renderArg.costUsd).toBeNull();
      expect(renderArg.durationS).toBeNull();

      const coercionWarns = warnSpy.mock.calls.filter(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'numeric.coercion_failed',
      );
      expect(coercionWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('fanout-task-events: Slack dispatcher', () => {
  beforeEach(() => {
    mockDdbSend.mockReset().mockResolvedValue({ Item: undefined });
    mockDispatchSlackEvent.mockReset().mockResolvedValue(undefined);
  });

  test('task_completed invokes the Slack dispatcher with the parsed event + shared ddb client', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [mkEvent('task_completed', 't-slack')],
    };
    await handler(event);

    expect(mockDispatchSlackEvent).toHaveBeenCalledTimes(1);
    const [parsedEvent, ddbClient] = mockDispatchSlackEvent.mock.calls[0];
    expect(parsedEvent).toMatchObject({
      task_id: 't-slack',
      event_type: 'task_completed',
    });
    expect(ddbClient).toBeDefined();
  });

  test('task_created fans out (Slack lifecycle event)', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [mkEvent('task_created', 't-slack-created')],
    };
    await handler(event);

    expect(mockDispatchSlackEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchSlackEvent.mock.calls[0][0].event_type).toBe('task_created');
  });

  test('session_started and task_timed_out reach the Slack dispatcher', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        mkEvent('session_started', 't-slack-ss'),
        mkEvent('task_timed_out', 't-slack-to'),
      ],
    };
    await handler(event);

    const types = mockDispatchSlackEvent.mock.calls.map(c => c[0].event_type);
    expect(types.sort()).toEqual(['session_started', 'task_timed_out']);
  });

  test('Slack dispatcher infra rejection escalates record to partial-batch retry', async () => {
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(
      new Error('slack side ddb throttled'),
    );

    const record = mkEvent('task_completed', 't-slack-fail');
    const result = await handler({ Records: [record] });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.dynamodb?.SequenceNumber }]);
  });

  test('Slack dispatcher SlackApiError swallow does NOT escalate to retry', async () => {
    const { SlackApiError } = jest.requireMock<typeof import('../../src/handlers/slack-notify')>(
      '../../src/handlers/slack-notify',
    );
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(
      new SlackApiError('slack chat.postMessage failed: channel_not_found'),
    );

    const event: DynamoDBStreamEvent = {
      Records: [mkEvent('task_completed', 't-slack-terminal')],
    };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });

  test('SlackApiError matched by name even when instanceof fails', async () => {
    const fakeForeignSlackApiError = new Error(
      'slack chat.postMessage failed: not_authed',
    );
    fakeForeignSlackApiError.name = 'SlackApiError';
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(fakeForeignSlackApiError);

    const event: DynamoDBStreamEvent = {
      Records: [mkEvent('task_completed', 't-slack-foreign-class')],
    };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });
});

describe('fanout-task-events: Linear dispatcher', () => {
  const TASK_RECORD_LINEAR = {
    task_id: 't-lin',
    user_id: 'u-1',
    status: 'COMPLETED',
    repo: 'owner/repo',
    branch_name: 'bgagent/t-lin/fix',
    channel_source: 'linear',
    channel_metadata: {
      linear_issue_id: 'issue-uuid-42',
      linear_workspace_id: 'org-uuid-acme',
    },
    status_created_at: 'COMPLETED#2026-04-30T12:00:00Z',
    created_at: '2026-04-30T11:50:00Z',
    updated_at: '2026-04-30T12:00:00Z',
    cost_usd: 0.55,
    turns_attempted: 27,
    max_turns: 100,
    duration_s: 221,
    pr_url: 'https://github.com/owner/repo/pull/13',
  };

  beforeEach(() => {
    mockDdbSend.mockReset().mockResolvedValue({ Item: undefined });
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: true });
    mockReplyToComment.mockReset().mockResolvedValue('reply-id');
    mockUpsertThreadedReply.mockReset().mockResolvedValue('reply-id');
    mockSwapCommentReaction.mockReset().mockResolvedValue(true);
    mockDispatchSlackEvent.mockReset().mockResolvedValue(undefined);
    mockUpsertTaskComment.mockReset().mockResolvedValue({ commentId: 1, created: false });
    mockRenderCommentBody.mockReset().mockReturnValue('rendered body');
    mockLoadRepoConfig.mockReset().mockResolvedValue(null);
    mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_fake');
  });

  const mockGet = (item: unknown) => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: item });
      return Promise.resolve({});
    });
  };

  test('task_completed posts ✅ comment with cost / turns / duration on linked Linear issue', async () => {
    mockGet(TASK_RECORD_LINEAR);

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    const [ctx, issueId, body] = mockPostIssueComment.mock.calls[0];
    expect(ctx).toEqual({
      linearWorkspaceId: 'org-uuid-acme',
      registryTableName: 'LinearWorkspaceRegistry',
    });
    expect(issueId).toBe('issue-uuid-42');
    expect(body).toContain('✅');
    expect(body).toContain('Task completed');
    expect(body).toContain('$0.55');
    expect(body).toContain('27 / 100');
    expect(body).toContain('3m 41s');
    expect(body).toContain('https://github.com/owner/repo/pull/13');
    expect(body).toContain('t-lin');
  });

  test('task_failed without PR renders ❌ frame', async () => {
    mockGet({
      ...TASK_RECORD_LINEAR,
      pr_url: undefined,
      error_message: 'Generic crash',
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_failed', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    const [, , body] = mockPostIssueComment.mock.calls[0];
    expect(body).toContain('❌');
    expect(body).not.toContain('Shipped a PR');
  });

  test('error_max_turns + pr_url renders ⚠️ "shipped a PR but stopped early" frame', async () => {
    mockGet({
      ...TASK_RECORD_LINEAR,
      error_message: 'Task did not succeed: agent_status="error_max_turns"',
      turns_attempted: 101,
      cost_usd: 3.44,
      duration_s: 1272,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_failed', 't-lin')] };
    await handler(event);

    const [, , body] = mockPostIssueComment.mock.calls[0];
    expect(body).toContain('⚠️');
    expect(body).toContain('Shipped a PR but stopped early');
    expect(body).toContain('https://github.com/owner/repo/pull/13');
    expect(body).toContain('$3.44');
    expect(body).toContain('101 / 100');
    expect(body).toContain('21m 12s');
  });

  test('non-Linear task short-circuits — postIssueComment never called', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, channel_source: 'github' });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });

  test('pr_created posts a "🔗 Opened PR" comment for a first-run task', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, pr_number: 13 });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    const [, issueId, body] = mockPostIssueComment.mock.calls[0];
    expect(issueId).toBe('issue-uuid-42');
    expect(body).toContain('🔗');
    expect(body).toContain('PR #13');
    expect(body).toContain('https://github.com/owner/repo/pull/13');
  });

  test('pr_created without a PR url yet posts nothing (nothing to link)', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, pr_url: undefined });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });

  test('pr_created links the PR from the milestone when the task record has no pr_url yet', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, pr_url: undefined });

    const event: DynamoDBStreamEvent = {
      Records: [mkMilestone('pr_created', 't-lin', 'https://github.com/owner/repo/pull/13')],
    };
    await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    const [, issueId, body] = mockPostIssueComment.mock.calls[0];
    expect(issueId).toBe('issue-uuid-42');
    expect(body).toBe('🔗 Opened a pull request: https://github.com/owner/repo/pull/13');
  });

  test.each(['', 'PR opened on branch bgagent/t-lin/fix', 'http://github.com/owner/repo/pull/13'])(
    'pr_created whose milestone text is not an https URL (%j) posts nothing',
    async (details) => {
      mockGet({ ...TASK_RECORD_LINEAR, pr_url: undefined });

      await handler({ Records: [mkMilestone('pr_created', 't-lin', details)] });

      expect(mockPostIssueComment).not.toHaveBeenCalled();
    },
  );

  test('pr_created is post-once — already-posted marker skips the comment', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, pr_number: 13, linear_pr_comment_event_id: 'prior-event' });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });

  test('pr_created RETRYABLE failure escalates to partial-batch retry, no marker persisted', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, pr_number: 13 });
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: false, retryable: true });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe(event.Records[0].dynamodb?.SequenceNumber);
    const updateCalls = mockDdbSend.mock.calls.filter((c) => (c[0] as { _type?: string })._type === 'Update');
    expect(updateCalls).toHaveLength(0);
  });

  test('pr_created TERMINAL failure stays log-only (no retry, no marker)', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, pr_number: 13 });
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: false, retryable: false });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    const result = await handler(event);

    expect(result.batchItemFailures).toHaveLength(0);
  });

  test('pr_created on an iteration matures the threaded reply instead of posting a top-level comment', async () => {
    mockGet({
      ...TASK_RECORD_LINEAR,
      pr_number: 13,
      channel_metadata: {
        ...TASK_RECORD_LINEAR.channel_metadata,
        trigger_comment_id: 'trigger-c1',
        iteration_reply_comment_id: 'reply-c1',
      },
    });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    await handler(event);

    expect(mockUpsertThreadedReply).toHaveBeenCalledTimes(1);
    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });

  test('a pr_created milestone delivered AFTER the settle does NOT overwrite the outcome', async () => {
    mockGet({
      ...TASK_RECORD_LINEAR,
      pr_number: 13,
      ack_replied_at: '2026-07-25T01:14:04.301Z',
      channel_metadata: {
        ...TASK_RECORD_LINEAR.channel_metadata,
        trigger_comment_id: 'trigger-c1',
        iteration_reply_comment_id: 'reply-c1',
      },
    });

    const event: DynamoDBStreamEvent = { Records: [mkMilestone('pr_created', 't-lin')] };
    await handler(event);

    expect(mockUpsertThreadedReply).not.toHaveBeenCalled();
    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });

  test('Linear-origin task missing channel_metadata.linear_issue_id — skip with warning', async () => {
    mockGet({
      ...TASK_RECORD_LINEAR,
      channel_metadata: { linear_workspace_id: 'org-uuid-acme' },
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).not.toHaveBeenCalled();
  });

  test('terminal post failure (auth, bad issue id) does not reject the dispatcher', async () => {
    mockGet(TASK_RECORD_LINEAR);
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: false, retryable: false });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    const result = await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test('retryable post failure (network, 5xx, 429) escalates to batchItemFailures', async () => {
    mockGet(TASK_RECORD_LINEAR);
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: false, retryable: true });

    const records = [mkEvent('task_completed', 't-lin')];
    const event: DynamoDBStreamEvent = { Records: records };
    const result = await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]).toEqual({ itemIdentifier: records[0].dynamodb?.SequenceNumber });

    const updates = mockDdbSend.mock.calls
      .map(([cmd]) => cmd as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update'
        && cmd.input?.UpdateExpression?.includes('linear_final_comment_event_id'));
    expect(updates).toHaveLength(0);
  });

  test('successful post persists the post-once marker on the TaskRecord', async () => {
    mockGet(TASK_RECORD_LINEAR);

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    const updates = mockDdbSend.mock.calls
      .map(([cmd]) => cmd as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update'
        && cmd.input?.UpdateExpression?.includes('linear_final_comment_event_id'));
    expect(updates).toHaveLength(1);
  });

  test('marker already on the TaskRecord → retry skips the duplicate post (idempotency)', async () => {
    mockGet({ ...TASK_RECORD_LINEAR, linear_final_comment_event_id: 'EVT001' });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    const result = await handler(event);

    expect(mockPostIssueComment).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test('failed post does not persist the marker (next retry may post)', async () => {
    mockGet(TASK_RECORD_LINEAR);
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: false, retryable: false });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    await handler(event);

    const updates = mockDdbSend.mock.calls
      .map(([cmd]) => cmd as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update'
        && cmd.input?.UpdateExpression?.includes('linear_final_comment_event_id'));
    expect(updates).toHaveLength(0);
  });

  test('marker persist failure does not reject the dispatcher (post already succeeded)', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: TASK_RECORD_LINEAR });
      if (cmd?._type === 'Update') return Promise.reject(new Error('DDB throttled'));
      return Promise.resolve({});
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
    const result = await handler(event);

    expect(mockPostIssueComment).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test('LINEAR_WORKSPACE_REGISTRY_TABLE_NAME unset → dispatcher logs WARN and skips', async () => {
    const original = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
    delete process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      mockGet(TASK_RECORD_LINEAR);

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-lin')] };
      const result = await handler(event);

      expect(mockPostIssueComment).not.toHaveBeenCalled();
      expect(result).toEqual({ batchItemFailures: [] });
      const missingEnvWarn = warnSpy.mock.calls
        .map(c => c[1] as Record<string, unknown> | undefined)
        .find(meta => meta?.event === 'fanout.linear.missing_env');
      expect(missingEnvWarn).toBeDefined();
      expect(missingEnvWarn?.error_id).toBe('FANOUT_LINEAR_MISSING_ENV');
    } finally {
      warnSpy.mockRestore();
      if (original !== undefined) process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = original;
    }
  });

  test('error_max_turns WITHOUT pr_url renders ❌ frame, not ⚠️ (the no-PR boundary)', async () => {
    mockGet({
      ...TASK_RECORD_LINEAR,
      pr_url: undefined,
      error_message: 'Task did not succeed: agent_status="error_max_turns"',
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_failed', 't-lin')] };
    await handler(event);

    const [, , body] = mockPostIssueComment.mock.calls[0];
    expect(body).toContain('❌');
    expect(body).not.toContain('⚠️');
    expect(body).not.toContain('Shipped a PR');
    expect(body).toContain('Exceeded max turns');
  });

  describe('standalone iteration threaded reply', () => {
    const STANDALONE = {
      ...TASK_RECORD_LINEAR,
      channel_metadata: {
        linear_issue_id: 'issue-uuid-42',
        linear_workspace_id: 'org-uuid-acme',
        trigger_comment_id: 'human-cmt-7',
      },
      pr_url: 'https://github.com/owner/repo/pull/13',
    };

    test('task_completed → ✅ MATURED threaded reply (not a fresh comment, no top-level metrics comment)', async () => {
      mockGet(STANDALONE);
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });

      expect(mockUpsertThreadedReply).toHaveBeenCalledTimes(1);
      const [, issueId, parentCommentId, body] = mockUpsertThreadedReply.mock.calls[0];
      expect(issueId).toBe('issue-uuid-42');
      expect(parentCommentId).toBe('human-cmt-7');
      expect(body).toMatch(/^✅ Updated — \[PR #13\]\(https:\/\/github\.com\/owner\/repo\/pull\/13\)\./);
      expect(mockPostIssueComment).not.toHaveBeenCalled();
    });

    test('task_failed (agent crash) → ❌ reply with classified reason + CloudWatch task id', async () => {
      mockGet({ ...STANDALONE, error_message: 'agent_status="error_max_turns"' });
      await handler({ Records: [mkEvent('task_failed', 't-lin')] });
      const [, , , body] = mockUpsertThreadedReply.mock.calls[0];
      expect(body).toMatch(/^❌/);
      expect(body).toMatch(/Exceeded max turns/i);
      expect(body).toMatch(/CloudWatch for task `t-lin`/);
      expect(body).toMatch(/reply here with any extra guidance/i);
    });

    test('task_completed but build_passed=false → ❌ build/test reply pointing at the CloudWatch build log', async () => {
      mockGet({ ...STANDALONE, build_passed: false, error_message: undefined });
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });
      const [, , , body] = mockUpsertThreadedReply.mock.calls[0];
      expect(body).toMatch(/build\/tests didn't pass/i);
      expect(body).toMatch(/build log in CloudWatch for task `t-lin`/);
      expect(body).not.toMatch(/PR's checks/i);
    });

    test('renders the clickable preview thumbnail from a LATE consistent re-read', async () => {
      const PNG = 'https://cdn.example/screenshots/iter.png';
      const DEPLOY = 'https://app.vercel.app';
      mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string; input?: { ConsistentRead?: boolean } }) => {
        if (cmd?._type === 'Get' && cmd.input?.ConsistentRead) {
          return Promise.resolve({ Item: { screenshot_url: PNG, screenshot_preview_url: DEPLOY } });
        }
        if (cmd?._type === 'Get') return Promise.resolve({ Item: STANDALONE });
        return Promise.resolve({});
      });
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });
      const [, , , body] = mockUpsertThreadedReply.mock.calls[0];
      expect(body).toContain(`[![preview](${PNG})](${DEPLOY})`);
    });

    test('an ORCHESTRATION iteration (orchestration_iteration=true) is NOT replied here (reconciler owns it)', async () => {
      mockGet({
        ...STANDALONE,
        channel_metadata: { ...STANDALONE.channel_metadata, orchestration_iteration: 'true' },
      });
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });
      expect(mockUpsertThreadedReply).not.toHaveBeenCalled();
    });

    test('a plain Linear task WITHOUT trigger_comment_id gets no threaded reply', async () => {
      mockGet(TASK_RECORD_LINEAR);
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });
      expect(mockUpsertThreadedReply).not.toHaveBeenCalled();
    });

    test('the terminal settle asks the surface to restore the outcome if it gets overwritten', async () => {
      mockGet(STANDALONE);
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });

      const options = mockUpsertThreadedReply.mock.calls[0][5] as Record<string, unknown>;
      expect(options).toMatchObject({ preservePreview: true, repairIfOverwritten: true });
      expect(options.skipIfSettled).toBeFalsy();
    });

    test('a terminal reply that FAILS hands its claim back so a redelivery can retry', async () => {
      mockGet(STANDALONE);
      mockUpsertThreadedReply.mockReset().mockResolvedValue(null);

      await handler({ Records: [mkEvent('task_completed', 't-lin')] });

      const updates = mockDdbSend.mock.calls
        .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } })
        .filter((cmd) => cmd?._type === 'Update' && /ack_replied_at/.test(cmd.input?.UpdateExpression ?? ''));
      expect(updates[0].input?.UpdateExpression).toBe('SET ack_replied_at = :now');
      expect(updates[1].input?.UpdateExpression).toContain('REMOVE ack_replied_at');
      expect(updates[1].input?.ExpressionAttributeValues?.[':ours'])
        .toBe(updates[0].input?.ExpressionAttributeValues?.[':now']);
    });

    test('a terminal reply that fails reports its record, so the event is delivered again', async () => {
      mockGet(STANDALONE);
      mockUpsertThreadedReply.mockReset().mockResolvedValue(null);
      const record = mkEvent('task_completed', 't-lin');

      const result = await handler({ Records: [record] });

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.dynamodb?.SequenceNumber }]);
      expect(mockSwapCommentReaction).not.toHaveBeenCalled();
    });

    test('a reply that keeps failing is retried on three redeliveries, then settled by the reaction alone', async () => {
      let attempts = 0;
      mockDdbSend.mockReset().mockImplementation((cmd: {
        _type?: string;
        input?: { ProjectionExpression?: string; UpdateExpression?: string };
      }) => {
        if (cmd?._type === 'Get' && cmd.input?.ProjectionExpression === 'ack_reply_attempts') {
          return Promise.resolve({ Item: { ack_reply_attempts: attempts } });
        }
        if (cmd?._type === 'Get') return Promise.resolve({ Item: STANDALONE });
        if (cmd?._type === 'Update' && /REMOVE ack_replied_at/.test(cmd.input?.UpdateExpression ?? '')) {
          if (attempts >= MAX_REPLY_ATTEMPTS) {
            return Promise.reject(Object.assign(new Error('spent'), { name: 'ConditionalCheckFailedException' }));
          }
          attempts += 1;
        }
        return Promise.resolve({});
      });
      mockUpsertThreadedReply.mockReset().mockResolvedValue(null);
      const record = mkEvent('task_failed', 't-lin');

      const reported: number[] = [];
      for (let delivery = 1; delivery <= 4; delivery += 1) {
        reported.push((await handler({ Records: [record] })).batchItemFailures.length);
      }

      expect(reported).toEqual([1, 1, 1, 0]);
      expect(mockUpsertThreadedReply).toHaveBeenCalledTimes(4);
      expect(mockSwapCommentReaction).toHaveBeenCalledTimes(1);
      expect(mockSwapCommentReaction).toHaveBeenCalledWith(expect.anything(), 'human-cmt-7', 'x');
    });

    test('a failed reply whose claim another delivery has taken is left to that delivery', async () => {
      mockDdbSend.mockReset().mockImplementation((cmd: {
        _type?: string;
        input?: { ProjectionExpression?: string; UpdateExpression?: string };
      }) => {
        if (cmd?._type === 'Get' && cmd.input?.ProjectionExpression === 'ack_reply_attempts') {
          return Promise.resolve({ Item: { ack_reply_attempts: 1 } });
        }
        if (cmd?._type === 'Get') return Promise.resolve({ Item: STANDALONE });
        if (cmd?._type === 'Update' && /REMOVE ack_replied_at/.test(cmd.input?.UpdateExpression ?? '')) {
          return Promise.reject(Object.assign(new Error('not ours'), { name: 'ConditionalCheckFailedException' }));
        }
        return Promise.resolve({});
      });
      mockUpsertThreadedReply.mockReset().mockResolvedValue(null);

      const result = await handler({ Records: [mkEvent('task_completed', 't-lin')] });

      expect(result.batchItemFailures).toEqual([]);
      expect(mockSwapCommentReaction).not.toHaveBeenCalled();
    });

    test('a SUCCESSFUL reply keeps its claim — the once-only guarantee still holds', async () => {
      mockGet(STANDALONE);
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });

      const removes = mockDdbSend.mock.calls
        .map((c) => c[0] as { _type?: string; input?: { UpdateExpression?: string } })
        .filter((cmd) => cmd?._type === 'Update' && /REMOVE ack_replied_at/.test(cmd.input?.UpdateExpression ?? ''));
      expect(removes).toHaveLength(0);
    });

    test('idempotent: a redelivered terminal event that loses the ack claim does not double-reply', async () => {
      mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string; input?: { UpdateExpression?: string } }) => {
        if (cmd?._type === 'Get') return Promise.resolve({ Item: STANDALONE });
        if (cmd?._type === 'Update' && cmd.input?.UpdateExpression?.includes('ack_replied_at')) {
          const err = new Error('conditional');
          (err as { name?: string }).name = 'ConditionalCheckFailedException';
          return Promise.reject(err);
        }
        return Promise.resolve({});
      });
      await handler({ Records: [mkEvent('task_completed', 't-lin')] });
      expect(mockUpsertThreadedReply).not.toHaveBeenCalled();
    });
  });
});

describe('renderLinearFinalStatusComment', () => {
  test('all metrics null → renders em-dash placeholders', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_failed',
      prUrl: null,
      costUsd: null,
      turns: null,
      maxTurns: null,
      durationS: null,
      taskId: 't-empty',
      errorTitle: null,
    });
    expect(body).toContain('cost: — • turns: — • duration: —');
  });

  test('turns present but maxTurns null → renders just turns without slash', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.5,
      turns: 27,
      maxTurns: null,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
    });
    expect(body).toContain('turns: 27 ');
    expect(body).not.toContain('27 /');
  });

  test('✅ task_completed with prUrl null → NO PR line', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.5,
      turns: 10,
      maxTurns: 100,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
    });
    expect(body).toContain('✅');
    expect(body).not.toContain('PR:');
  });

  test('formatDuration: under 60s → seconds only', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.01,
      turns: 1,
      maxTurns: 100,
      durationS: 42,
      taskId: 't',
      errorTitle: null,
    });
    expect(body).toContain('duration: 42s');
  });

  test('formatDuration: exact minute → `Nm` without zero seconds', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.01,
      turns: 1,
      maxTurns: 100,
      durationS: 180,
      taskId: 't',
      errorTitle: null,
    });
    expect(body).toContain('duration: 3m');
    expect(body).not.toContain('3m 0s');
  });

  test('formatDuration: minutes + seconds → `Nm Ss`', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.01,
      turns: 1,
      maxTurns: 100,
      durationS: 221,
      taskId: 't',
      errorTitle: null,
    });
    expect(body).toContain('duration: 3m 41s');
  });

  test('⚠️ frame renders the classifier title alongside the shipped-but-stopped line', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_failed',
      prUrl: 'https://github.com/owner/repo/pull/35',
      costUsd: 3.44,
      turns: 101,
      maxTurns: 100,
      durationS: 1272,
      taskId: 't-abca-91',
      errorTitle: 'Hit max-turns cap',
    });
    expect(body).toContain('⚠️');
    expect(body).toContain('Shipped a PR but stopped early');
    expect(body).toContain('Hit max-turns cap');
  });

  test('❌ frame includes classifier title when known', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_failed',
      prUrl: null,
      costUsd: 0.05,
      turns: 3,
      maxTurns: 100,
      durationS: 30,
      taskId: 't',
      errorTitle: 'Insufficient GitHub permissions',
    });
    expect(body).toContain('❌');
    expect(body).toContain('Insufficient GitHub permissions');
  });

  test('❌ frame renders without colon when errorTitle is null (clean fallback)', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_cancelled',
      prUrl: null,
      costUsd: null,
      turns: null,
      maxTurns: null,
      durationS: null,
      taskId: 't',
      errorTitle: null,
    });
    expect(body).toContain('❌');
    expect(body).toContain('cancelled');
    expect(body).not.toMatch(/cancelled:\s/);
  });

  test('❌ task_timed_out reads "Task timed out", not the raw subtype "timed_out"', () => {
    const body = renderLinearFinalStatusComment({
      eventType: 'task_timed_out',
      prUrl: null,
      costUsd: 0.1,
      turns: 5,
      maxTurns: 5,
      durationS: 3600,
      taskId: 't-timeout',
      errorTitle: null,
    });
    expect(body.split('\n')[0]).toBe('❌ **Task timed out**');
  });

  describe('clarify-before-spend — needsInput hold', () => {
    test('renders the question as 💬, not a ✅/❌, with no cost/turns subtitle', () => {
      const body = renderLinearFinalStatusComment({
        eventType: 'task_completed',
        prUrl: null,
        costUsd: 0.02,
        turns: 2,
        maxTurns: 100,
        durationS: 15,
        taskId: 't-hold',
        errorTitle: null,
        needsInput: true,
        answerText: 'Which part feels slow — initial load, filtering, or chart rendering? And a target (e.g. under 1s)?',
      });
      expect(body).toContain('💬');
      expect(body).not.toContain('✅');
      expect(body).not.toContain('❌');
      expect(body).toContain('Which part feels slow');
      expect(body).not.toContain('cost:');
      expect(body).toMatch(/reply/i);
    });

    test('falls back to a generic ask when answerText is empty', () => {
      const body = renderLinearFinalStatusComment({
        eventType: 'task_completed',
        prUrl: null,
        costUsd: null,
        turns: null,
        maxTurns: null,
        durationS: null,
        taskId: 't-hold2',
        errorTitle: null,
        needsInput: true,
        answerText: '',
      });
      expect(body).toContain('💬');
      expect(body).toMatch(/more detail/i);
    });
  });
});

describe('fanout-task-events: Jira dispatcher', () => {
  const TASK_RECORD_JIRA = {
    task_id: 't-jira',
    user_id: 'u-1',
    status: 'COMPLETED',
    repo: 'owner/repo',
    branch_name: 'bgagent/t-jira/fix',
    channel_source: 'jira',
    channel_metadata: {
      jira_cloud_id: 'cloud-uuid-acme',
      jira_issue_key: 'KAN-42',
    },
    status_created_at: 'COMPLETED#2026-06-30T12:00:00Z',
    created_at: '2026-06-30T11:50:00Z',
    updated_at: '2026-06-30T12:00:00Z',
    cost_usd: 0.55,
    turns_attempted: 27,
    max_turns: 100,
    duration_s: 221,
    pr_url: 'https://github.com/owner/repo/pull/13',
  };

  beforeEach(() => {
    mockDdbSend.mockReset().mockResolvedValue({ Item: undefined });
    mockPostIssueCommentAdf.mockReset().mockResolvedValue({ ok: true });
    mockUpdateIssueCommentAdf.mockReset().mockResolvedValue({ ok: true });
    mockBuildAdfDocument.mockClear();
    mockDispatchSlackEvent.mockReset().mockResolvedValue(undefined);
    mockUpsertTaskComment.mockReset().mockResolvedValue({ commentId: 1, created: false });
    mockRenderCommentBody.mockReset().mockReturnValue('rendered body');
    mockLoadRepoConfig.mockReset().mockResolvedValue(null);
    mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_fake');
    mockPostIssueComment.mockReset().mockResolvedValue({ ok: true });
  });

  const mockGet = (item: unknown) => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: item });
      return Promise.resolve({});
    });
  };

  test('task_completed posts ✅ comment with cost / turns / duration + PR link on the Jira issue', async () => {
    mockGet(TASK_RECORD_JIRA);

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    await handler(event);

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    const [ctx, issueKey, body] = mockPostIssueCommentAdf.mock.calls[0];
    expect(ctx).toEqual({ cloudId: 'cloud-uuid-acme', registryTableName: 'JiraWorkspaceRegistry' });
    expect(issueKey).toBe('KAN-42');
    const text = adfText(body);
    expect(text).toContain('✅');
    expect(text).toContain('Task completed');
    expect(text).toContain('$0.55');
    expect(text).toContain('27 / 100');
    expect(text).toContain('3m 41s');
    expect(text).toContain('https://github.com/owner/repo/pull/13');
    expect(text).toContain('t-jira');
  });

  test('task_failed without PR renders ❌ frame', async () => {
    mockGet({ ...TASK_RECORD_JIRA, pr_url: undefined, error_message: 'Generic crash' });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_failed', 't-jira')] };
    await handler(event);

    const [, , body] = mockPostIssueCommentAdf.mock.calls[0];
    const text = adfText(body);
    expect(text).toContain('❌');
    expect(text).not.toContain('Shipped a PR');
  });

  test('error_max_turns + pr_url renders ⚠️ "shipped a PR but stopped early" frame', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      error_message: 'Task did not succeed: agent_status="error_max_turns"',
      turns_attempted: 101,
      cost_usd: 3.44,
      duration_s: 1272,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_failed', 't-jira')] };
    await handler(event);

    const [, , body] = mockPostIssueCommentAdf.mock.calls[0];
    const text = adfText(body);
    expect(text).toContain('⚠️');
    expect(text).toContain('Shipped a PR but stopped early');
    expect(text).toContain('https://github.com/owner/repo/pull/13');
    expect(text).toContain('$3.44');
    expect(text).toContain('101 / 100');
    expect(text).toContain('21m 12s');
  });

  test('task_timed_out posts a Jira comment (Jira default subscribes to it)', async () => {
    mockGet({ ...TASK_RECORD_JIRA, error_message: 'Task did not succeed: timed out', pr_url: undefined });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_timed_out', 't-jira')] };
    await handler(event);

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    const [, , body] = mockPostIssueCommentAdf.mock.calls[0];
    expect(adfText(body)).toContain('❌');
  });

  test('standalone iteration finishes its progress comment and posts a separate result', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        trigger_comment_issue_id: 'KAN-42',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(mockUpdateIssueCommentAdf).toHaveBeenCalledTimes(1);
    const [ctx, issueKey, commentId, body] = mockUpdateIssueCommentAdf.mock.calls[0];
    expect(ctx).toEqual({
      cloudId: 'cloud-uuid-acme',
      registryTableName: 'JiraWorkspaceRegistry',
    });
    expect(issueKey).toBe('KAN-42');
    expect(commentId).toBe('status-comment-1');
    expect(adfText(body)).toBe('✅ Finished — result posted below.');

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    const [, finalIssueKey, finalBody] = mockPostIssueCommentAdf.mock.calls[0];
    expect(finalIssueKey).toBe('KAN-42');
    expect(adfText(finalBody)).toContain('cost: $0.55 • turns: 27 / 100 • duration: 3m 41s');
    expect(adfText(finalBody)).toContain('task t-jira');
    const finalRuns = (finalBody as {
      _adf: ReadonlyArray<ReadonlyArray<{ text: string; href?: string }>>;
    })._adf.flat();
    expect(finalRuns).toContainEqual(expect.objectContaining({
      text: 'https://github.com/owner/repo/pull/13',
      href: 'https://github.com/owner/repo/pull/13',
    }));
  });

  test('standalone iteration that answered a question posts the answer in its result', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      code_changed: false,
      answer_text: 'Because the queue already retries.\n\nSee worker.ts.',
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(adfText(mockUpdateIssueCommentAdf.mock.calls[0][3])).toBe('💬 Finished — answer posted below.');
    expect(adfText(mockPostIssueCommentAdf.mock.calls[0][2])).toBe([
      '✅ Task completed',
      'Because the queue already retries.',
      '',
      'See worker.ts.',
      'cost: $0.55 • turns: 27 / 100 • duration: 3m 41s',
      'PR: https://github.com/owner/repo/pull/13',
      'task t-jira',
    ].join('\n'));
  });

  test('the answer comment is never read as a trigger, even when the answer spells out the mention', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      code_changed: false,
      answer_text: 'Nothing to change. For the other layout, comment "@bgagent use layout B".',
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    const body = mockPostIssueCommentAdf.mock.calls[0][2] as {
      _adf: ReadonlyArray<ReadonlyArray<{ text: string; strong?: boolean }>>;
    };
    const fromAdf = adfText(body);
    const fromWiki = body._adf
      .map((runs) => runs.map((run) => (run.strong ? `*${run.text}*` : run.text)).join(''))
      .join('\n\n');
    for (const readBack of [fromAdf, fromWiki]) {
      expect(readBack).toContain('@bgagent');
      expect(parseCommentTrigger(readBack).triggered).toBe(false);
    }
  });

  test('standalone iteration that completes with a red build is reported as a failure', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      build_passed: false,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(adfText(mockUpdateIssueCommentAdf.mock.calls[0][3])).toBe('❌ Finished — details posted below.');
    const result = adfText(mockPostIssueCommentAdf.mock.calls[0][2]);
    expect(result).toMatch(/^⚠️ Shipped a PR but stopped early/);
    expect(result).not.toContain('✅');
    expect(result.split('\n')[0]).toBe(
      '⚠️ Shipped a PR but stopped early — Build or tests did not pass — review and decide if more work is needed',
    );
  });

  test('standalone iteration that only answers, on a pull request whose build is red, posts its answer', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      build_passed: false,
      code_changed: false,
      answer_text: 'The lint step fails: worker.ts has an unused import.',
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(adfText(mockPostIssueCommentAdf.mock.calls[0][2])).toBe([
      '✅ Task completed',
      'The lint step fails: worker.ts has an unused import.',
      'cost: $0.55 • turns: 27 / 100 • duration: 3m 41s',
      'PR: https://github.com/owner/repo/pull/13',
      'task t-jira',
    ].join('\n'));
    expect(adfText(mockUpdateIssueCommentAdf.mock.calls[0][3])).toBe('💬 Finished — answer posted below.');
  });

  test('standalone iteration that changed code and completes with a red build is still a failure', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      build_passed: false,
      code_changed: true,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(adfText(mockUpdateIssueCommentAdf.mock.calls[0][3])).toBe('❌ Finished — details posted below.');
    expect(adfText(mockPostIssueCommentAdf.mock.calls[0][2]))
      .toMatch(/^⚠️ Shipped a PR but stopped early — Build or tests did not pass/);
  });

  test('a run that stopped to ask a question posts the question, not a completion', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      pr_url: undefined,
      code_changed: false,
      answer_text: 'Which login page do you mean?\nThe admin one or the customer one?',
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    const text = adfText(mockPostIssueCommentAdf.mock.calls[0][2]);
    expect(text).toMatch(/^🤖 ABCA has a question before it starts\n/);
    expect(text).toContain('Which login page do you mean?\nThe admin one or the customer one?');
    expect(text).not.toContain('Task completed');
    expect(text).not.toContain('✅');
    expect(text).toMatch(/re-apply the trigger label/);
    expect(text).toContain('task t-jira');
  });

  test('the question of a held run is rendered from its Markdown, not posted as literal text', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      pr_url: undefined,
      code_changed: false,
      answer_text: 'Do you mean `login.tsx` or **the admin page**?\n```\nsrc/login.tsx\nsrc/admin/login.tsx\n```',
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    const body = mockPostIssueCommentAdf.mock.calls[0][2] as { _adf: ReadonlyArray<unknown> };
    expect(body._adf.slice(0, 3)).toEqual([
      [{ text: '🤖 ' }, { text: 'ABCA has a question before it starts', strong: true }],
      [
        { text: 'Do you mean ' },
        { text: 'login.tsx', code: true },
        { text: ' or ' },
        { text: 'the admin page', strong: true },
        { text: '?' },
      ],
      { code: 'src/login.tsx\nsrc/admin/login.tsx' },
    ]);
  });

  test('a link or an image in the question of a held run stays as typed: the text is the agent\'s own', async () => {
    const question = 'Which one: [Open live preview](https://example.org/x) or ![x](https://example.org/y.png)?';
    mockGet({ ...TASK_RECORD_JIRA, pr_url: undefined, code_changed: false, answer_text: question });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    const body = mockPostIssueCommentAdf.mock.calls[0][2] as { _adf: ReadonlyArray<unknown> };
    expect(body._adf[1]).toEqual([{ text: question }]);
  });

  test('a held run without a stored question still asks for detail', async () => {
    mockGet({ ...TASK_RECORD_JIRA, pr_url: undefined, code_changed: false });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    const text = adfText(mockPostIssueCommentAdf.mock.calls[0][2]);
    expect(text).toContain('ABCA has a question');
    expect(text).toMatch(/more detail/i);
    expect(text).not.toContain('Task completed');
  });

  test('the question comment is never read as a trigger, even when the question spells out the mention', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      pr_url: undefined,
      code_changed: false,
      answer_text: 'Should @bgagent change the login page or the signup page?',
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    const body = mockPostIssueCommentAdf.mock.calls[0][2] as {
      _adf: ReadonlyArray<ReadonlyArray<{ text: string; strong?: boolean }>>;
    };
    const fromAdf = adfText(body);
    const fromWiki = body._adf
      .map((runs) => runs.map((run) => (run.strong ? `*${run.text}*` : run.text)).join(''))
      .join('\n\n');
    for (const readBack of [fromAdf, fromWiki]) {
      expect(readBack).toContain('@bgagent');
      expect(parseCommentTrigger(readBack).triggered).toBe(false);
    }
    expect(parseCommentTrigger('Should @bgagent change the login page or the signup page?').triggered).toBe(true);
  });

  test.each([
    ['a failed run', 'task_failed', {}, '❌'],
    ['a completed run that opened a PR', 'task_completed', { pr_url: 'https://github.com/owner/repo/pull/13' }, '✅ Task completed'],
    ['an iteration that answered without a change', 'task_completed', {
      channel_metadata: { ...TASK_RECORD_JIRA.channel_metadata, trigger_comment_id: 'human-comment-1' },
    }, '✅ Task completed'],
  ] as const)('%s is not rendered as a question', async (_name, eventType, overrides, expected) => {
    mockGet({ ...TASK_RECORD_JIRA, pr_url: undefined, code_changed: false, answer_text: 'A question?', ...overrides });

    await handler({ Records: [mkEvent(eventType, 't-jira')] });

    const text = adfText(mockPostIssueCommentAdf.mock.calls[0][2]);
    expect(text).toContain(expected);
    expect(text).not.toContain('has a question');
  });

  test('a first-run task with a red build keeps its ordinary completion comment', async () => {
    mockGet({ ...TASK_RECORD_JIRA, build_passed: false });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(adfText(mockPostIssueCommentAdf.mock.calls[0][2])).toContain('✅ Task completed');
  });

  test('orchestrated iteration leaves terminal maturation to the reconciler', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
        orchestration_iteration: 'true',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(mockUpdateIssueCommentAdf).not.toHaveBeenCalled();
    expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
  });

  test('redelivered standalone iteration loses the terminal claim and does not edit twice', async () => {
    const task = {
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    };
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: task });
      if (cmd?._type === 'Update') {
        return Promise.reject(Object.assign(new Error('claimed'), {
          name: 'ConditionalCheckFailedException',
        }));
      }
      return Promise.resolve({});
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(mockUpdateIssueCommentAdf).not.toHaveBeenCalled();
  });

  test('iteration without a captured reply id honors the post-once marker on redelivery', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      jira_final_comment_event_id: 'EVT001',
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
      },
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(mockUpdateIssueCommentAdf).not.toHaveBeenCalled();
    expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
  });

  test('standalone iteration whose status comment cannot be edited still posts its result', async () => {
    const task = {
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    };
    mockGet(task);
    mockUpdateIssueCommentAdf.mockResolvedValue({
      ok: false,
      retryable: false,
    });

    const result = await handler({
      Records: [mkEvent('task_completed', 't-jira')],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    const posted = adfText(mockPostIssueCommentAdf.mock.calls[0][2]);
    expect(posted).toContain('✅ Task completed');
    expect(posted).toContain('task t-jira');
    const claims = mockDdbSend.mock.calls
      .map(([command]) => command as {
        _type?: string;
        input?: { UpdateExpression?: string };
      })
      .filter(command =>
        command._type === 'Update'
        && /ack_replied_at/.test(command.input?.UpdateExpression ?? ''),
      );
    expect(claims.map(command => command.input?.UpdateExpression)).toEqual(['SET ack_replied_at = :now']);
  });

  test('standalone iteration whose status comment stays uneditable after its retries still posts its result', async () => {
    const task = {
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    };
    mockDdbSend.mockReset().mockImplementation((cmd: {
      _type?: string;
      input?: { ProjectionExpression?: string; UpdateExpression?: string };
    }) => {
      if (cmd?._type === 'Get' && cmd.input?.ProjectionExpression === 'ack_reply_attempts') {
        return Promise.resolve({ Item: { ack_reply_attempts: 3 } });
      }
      if (cmd?._type === 'Get') return Promise.resolve({ Item: task });
      if (cmd?._type === 'Update' && /REMOVE ack_replied_at/.test(cmd.input?.UpdateExpression ?? '')) {
        return Promise.reject(Object.assign(new Error('spent'), { name: 'ConditionalCheckFailedException' }));
      }
      return Promise.resolve({});
    });
    mockUpdateIssueCommentAdf.mockResolvedValue({
      ok: false,
      retryable: true,
    });

    const result = await handler({
      Records: [mkEvent('task_completed', 't-jira')],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    expect(adfText(mockPostIssueCommentAdf.mock.calls[0][2])).toContain('task t-jira');
  });

  test('transient standalone iteration update failure releases the claim and retries the record', async () => {
    const task = {
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    };
    mockGet(task);
    mockUpdateIssueCommentAdf.mockResolvedValue({
      ok: false,
      retryable: true,
    });
    const record = mkEvent('task_completed', 't-jira');

    const result = await handler({ Records: [record] });

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: record.dynamodb?.SequenceNumber },
    ]);
    const claims = mockDdbSend.mock.calls
      .map(([command]) => command as {
        _type?: string;
        input?: {
          UpdateExpression?: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        };
      })
      .filter(command =>
        command._type === 'Update'
        && /ack_replied_at/.test(command.input?.UpdateExpression ?? ''),
      );
    expect(claims).toHaveLength(2);
    expect(claims[0].input?.UpdateExpression).toBe('SET ack_replied_at = :now');
    expect(claims[1].input?.UpdateExpression).toContain('REMOVE ack_replied_at');
    expect(claims[1].input?.ExpressionAttributeValues?.[':ours'])
      .toBe(claims[0].input?.ExpressionAttributeValues?.[':now']);
    expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
  });

  test('terminal separate-result failure folds the full outcome into the status comment', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });
    mockPostIssueCommentAdf.mockResolvedValue({
      ok: false,
      retryable: false,
    });

    await handler({ Records: [mkEvent('task_completed', 't-jira')] });

    expect(mockUpdateIssueCommentAdf).toHaveBeenCalledTimes(2);
    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    const [, , fallbackCommentId, fallbackBody] = mockUpdateIssueCommentAdf.mock.calls[1];
    expect(fallbackCommentId).toBe('status-comment-1');
    expect(adfText(fallbackBody)).toContain('cost: $0.55 • turns: 27 / 100 • duration: 3m 41s');
    expect(adfText(fallbackBody)).toContain('task t-jira');
    const releases = mockDdbSend.mock.calls
      .map(([command]) => command as {
        _type?: string;
        input?: { UpdateExpression?: string };
      })
      .filter(command =>
        command._type === 'Update'
        && /REMOVE ack_replied_at/.test(command.input?.UpdateExpression ?? ''),
      );
    expect(releases).toHaveLength(0);
  });

  test('retryable separate-result failure releases the claim and retries the record', async () => {
    mockGet({
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    });
    mockPostIssueCommentAdf.mockResolvedValue({
      ok: false,
      retryable: true,
    });
    const record = mkEvent('task_completed', 't-jira');

    const result = await handler({ Records: [record] });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.dynamodb?.SequenceNumber }]);
    expect(mockUpdateIssueCommentAdf).toHaveBeenCalledTimes(1);
    const releases = mockDdbSend.mock.calls
      .map(([command]) => command as {
        _type?: string;
        input?: { UpdateExpression?: string };
      })
      .filter(command =>
        command._type === 'Update'
        && /REMOVE ack_replied_at/.test(command.input?.UpdateExpression ?? ''),
      );
    expect(releases).toHaveLength(1);
  });

  test('exhausted separate-result retries fold the full outcome into the status comment', async () => {
    const task = {
      ...TASK_RECORD_JIRA,
      channel_metadata: {
        ...TASK_RECORD_JIRA.channel_metadata,
        trigger_comment_id: 'human-comment-1',
        iteration_reply_comment_id: 'status-comment-1',
      },
    };
    mockDdbSend.mockReset().mockImplementation((cmd: {
      _type?: string;
      input?: {
        ProjectionExpression?: string;
        UpdateExpression?: string;
      };
    }) => {
      if (cmd?._type === 'Get' && cmd.input?.ProjectionExpression === 'ack_reply_attempts') {
        return Promise.resolve({ Item: { ack_reply_attempts: 3 } });
      }
      if (cmd?._type === 'Get') return Promise.resolve({ Item: task });
      if (cmd?._type === 'Update' && /REMOVE ack_replied_at/.test(cmd.input?.UpdateExpression ?? '')) {
        return Promise.reject(Object.assign(new Error('spent'), {
          name: 'ConditionalCheckFailedException',
        }));
      }
      return Promise.resolve({});
    });
    mockPostIssueCommentAdf.mockResolvedValue({
      ok: false,
      retryable: true,
    });

    const result = await handler({
      Records: [mkEvent('task_completed', 't-jira')],
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(mockUpdateIssueCommentAdf).toHaveBeenCalledTimes(2);
    expect(adfText(mockUpdateIssueCommentAdf.mock.calls[1][3])).toContain('task t-jira');
  });

  test('non-Jira task short-circuits — postIssueCommentAdf never called', async () => {
    mockGet({ ...TASK_RECORD_JIRA, channel_source: 'github' });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    await handler(event);

    expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
  });

  test('Jira-origin task missing jira_issue_key — skip without posting', async () => {
    mockGet({ ...TASK_RECORD_JIRA, channel_metadata: { jira_cloud_id: 'cloud-uuid-acme' } });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    await handler(event);

    expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
  });

  test('terminal post failure (auth, bad issue key) does not reject the dispatcher', async () => {
    mockGet(TASK_RECORD_JIRA);
    mockPostIssueCommentAdf.mockReset().mockResolvedValue({ ok: false, retryable: false });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    const result = await handler(event);

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test('retryable post failure (network, 5xx, 429) escalates to batchItemFailures', async () => {
    mockGet(TASK_RECORD_JIRA);
    mockPostIssueCommentAdf.mockReset().mockResolvedValue({ ok: false, retryable: true });

    const records = [mkEvent('task_completed', 't-jira')];
    const event: DynamoDBStreamEvent = { Records: records };
    const result = await handler(event);

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]).toEqual({ itemIdentifier: records[0].dynamodb?.SequenceNumber });

    const updates = mockDdbSend.mock.calls
      .map(([cmd]) => cmd as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update'
        && cmd.input?.UpdateExpression?.includes('jira_final_comment_event_id'));
    expect(updates).toHaveLength(0);
  });

  test('successful post persists the post-once marker on the TaskRecord', async () => {
    mockGet(TASK_RECORD_JIRA);

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    await handler(event);

    const updates = mockDdbSend.mock.calls
      .map(([cmd]) => cmd as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update'
        && cmd.input?.UpdateExpression?.includes('jira_final_comment_event_id'));
    expect(updates).toHaveLength(1);
  });

  test('marker already on the TaskRecord → retry skips the duplicate post (idempotency)', async () => {
    mockGet({ ...TASK_RECORD_JIRA, jira_final_comment_event_id: 'EVT001' });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    const result = await handler(event);

    expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test('failed post does not persist the marker (next retry may post)', async () => {
    mockGet(TASK_RECORD_JIRA);
    mockPostIssueCommentAdf.mockReset().mockResolvedValue({ ok: false, retryable: false });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    await handler(event);

    const updates = mockDdbSend.mock.calls
      .map(([cmd]) => cmd as { _type?: string; input?: { UpdateExpression?: string } })
      .filter((cmd) => cmd?._type === 'Update'
        && cmd.input?.UpdateExpression?.includes('jira_final_comment_event_id'));
    expect(updates).toHaveLength(0);
  });

  test('marker persist failure does not reject the dispatcher (post already succeeded)', async () => {
    mockDdbSend.mockReset().mockImplementation((cmd: { _type?: string }) => {
      if (cmd?._type === 'Get') return Promise.resolve({ Item: TASK_RECORD_JIRA });
      if (cmd?._type === 'Update') return Promise.reject(new Error('DDB throttled'));
      return Promise.resolve({});
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
    const result = await handler(event);

    expect(mockPostIssueCommentAdf).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test('JIRA_WORKSPACE_REGISTRY_TABLE_NAME unset → dispatcher logs WARN and skips', async () => {
    const original = process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    delete process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME;
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      mockGet(TASK_RECORD_JIRA);

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-jira')] };
      const result = await handler(event);

      expect(mockPostIssueCommentAdf).not.toHaveBeenCalled();
      expect(result).toEqual({ batchItemFailures: [] });
      const missingEnvWarn = warnSpy.mock.calls
        .map(c => c[1] as Record<string, unknown> | undefined)
        .find(meta => meta?.event === 'fanout.jira.missing_env');
      expect(missingEnvWarn).toBeDefined();
      expect(missingEnvWarn?.error_id).toBe('FANOUT_JIRA_MISSING_ENV');
    } finally {
      warnSpy.mockRestore();
      if (original !== undefined) process.env.JIRA_WORKSPACE_REGISTRY_TABLE_NAME = original;
    }
  });
});

describe('renderJiraFinalStatusComment', () => {
  type Paragraphs = ReadonlyArray<AdfParagraph>;

  const flatten = (paragraphs: ReadonlyArray<AdfBlock>) =>
    (paragraphs as Paragraphs).map((runs) => runs.map((r) => r.text).join('')).join('\n');

  test('all metrics null → renders em-dash placeholders', () => {
    const text = flatten(renderJiraFinalStatusComment({
      eventType: 'task_failed',
      prUrl: null,
      costUsd: null,
      turns: null,
      maxTurns: null,
      durationS: null,
      taskId: 't-empty',
      errorTitle: null,
    }));
    expect(text).toContain('cost: — • turns: — • duration: —');
  });

  test('✅ success path renders the PR link (the agent\'s own PR-opened comment is not guaranteed)', () => {
    const paragraphs = renderJiraFinalStatusComment({
      eventType: 'task_completed',
      prUrl: 'https://github.com/o/r/pull/7',
      costUsd: 0.5,
      turns: 3,
      maxTurns: 100,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
    }) as Paragraphs;
    const text = flatten(paragraphs);
    expect(text).toContain('✅');
    expect(text).toContain('PR: https://github.com/o/r/pull/7');
    expect(paragraphs[0]).toEqual([{ text: '✅ ' }, { text: 'Task completed', strong: true }]);
    const urlRun = paragraphs.flat().find((r) => r.text === 'https://github.com/o/r/pull/7');
    expect(urlRun).toEqual({ text: 'https://github.com/o/r/pull/7', href: 'https://github.com/o/r/pull/7' });
    expect(renderJiraFinalStatusText({
      eventType: 'task_completed',
      prUrl: 'https://github.com/o/r/pull/7',
      costUsd: 0.5,
      turns: 3,
      maxTurns: 100,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
    })).toContain('[https://github.com/o/r/pull/7](https://github.com/o/r/pull/7)');
  });

  test.each([
    ['result', '✅ Finished — result posted below.'],
    ['details', '❌ Finished — details posted below.'],
    ['answer', '💬 Finished — answer posted below.'],
  ] as const)('renders the %s terminal pointer', (kind, expected) => {
    expect(flatten(renderJiraFinishedPointer(kind))).toBe(expected);
  });

  test('✅ success path without a PR omits the PR line', () => {
    const text = flatten(renderJiraFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.5,
      turns: 3,
      maxTurns: 100,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
    }));
    expect(text).not.toContain('PR:');
  });

  test('⚠️ frame renders the classifier title + PR link, bolding only through the reason', () => {
    const paragraphs = renderJiraFinalStatusComment({
      eventType: 'task_failed',
      prUrl: 'https://github.com/owner/repo/pull/35',
      costUsd: 3.44,
      turns: 101,
      maxTurns: 100,
      durationS: 1272,
      taskId: 't-abca-91',
      errorTitle: 'Hit max-turns cap',
    }) as Paragraphs;
    const text = flatten(paragraphs);
    expect(text).toContain('⚠️');
    expect(text).toContain('Shipped a PR but stopped early');
    expect(text).toContain('Hit max-turns cap');
    expect(text).toContain('PR: https://github.com/owner/repo/pull/35');
    expect(paragraphs[0][0]).toEqual({
      text: '⚠️ Shipped a PR but stopped early — Hit max-turns cap',
      strong: true,
    });
    expect(paragraphs[0][1]).toEqual({ text: ' — review and decide if more work is needed' });
  });

  test('❌ task_timed_out humanizes the subtype — "Task timed out", not "timed_out"', () => {
    const paragraphs = renderJiraFinalStatusComment({
      eventType: 'task_timed_out',
      prUrl: null,
      costUsd: 0.1,
      turns: 5,
      maxTurns: 5,
      durationS: 3600,
      taskId: 't-timeout',
      errorTitle: null,
    }) as Paragraphs;
    expect(paragraphs[0][0]).toEqual({ text: '❌ Task timed out', strong: true });
    expect(flatten(paragraphs)).not.toContain('timed_out');
  });

  test('❌ frame renders without a colon when errorTitle is null', () => {
    const text = flatten(renderJiraFinalStatusComment({
      eventType: 'task_cancelled',
      prUrl: null,
      costUsd: null,
      turns: null,
      maxTurns: null,
      durationS: null,
      taskId: 't',
      errorTitle: null,
    }));
    expect(text).toContain('❌');
    expect(text).toContain('cancelled');
    expect(text).not.toMatch(/cancelled:\s/);
  });

  test('turns present but maxTurns null → renders just turns without slash', () => {
    const text = flatten(renderJiraFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.5,
      turns: 27,
      maxTurns: null,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
    }));
    expect(text).toContain('turns: 27 ');
    expect(text).not.toContain('27 /');
  });

  test('shows the answer of a completed run between the header and the metrics', () => {
    const input = {
      prUrl: null,
      costUsd: 0.5,
      turns: 3,
      maxTurns: 100,
      durationS: 60,
      taskId: 't',
      errorTitle: null,
      answerText: '  Because the queue already retries.  ',
    };
    expect(flatten(renderJiraFinalStatusComment({ ...input, eventType: 'task_completed' }))).toBe([
      '✅ Task completed',
      'Because the queue already retries.',
      'cost: $0.50 • turns: 3 / 100 • duration: 1m',
      'task t',
    ].join('\n'));
    expect(flatten(renderJiraFinalStatusComment({ ...input, eventType: 'task_failed' })))
      .not.toContain('queue');
  });

  test('task-id footer run is italic (ADF em mark)', () => {
    const paragraphs = renderJiraFinalStatusComment({
      eventType: 'task_completed',
      prUrl: null,
      costUsd: 0.5,
      turns: 3,
      maxTurns: 100,
      durationS: 60,
      taskId: 't-foot',
      errorTitle: null,
    }) as Paragraphs;
    expect(paragraphs[paragraphs.length - 1][0]).toEqual({ text: 'task t-foot', em: true });
  });
});

function mkMilestoneRecord(milestone: string, taskId = 't-1'): DynamoDBRecord {
  return mkRecord('INSERT', {
    task_id: { S: taskId },
    event_id: { S: `01MILE${milestone}` },
    event_type: { S: 'agent_milestone' },
    timestamp: { S: '2026-05-04T14:34:57Z' },
    metadata: { M: { milestone: { S: milestone } } },
  });
}

describe('fanout-task-events: agent_milestone routing (effective event type)', () => {
  const makeMilestone = (milestone: string): FanOutEvent => ({
    task_id: 't-1',
    event_id: 'e-1',
    event_type: 'agent_milestone',
    timestamp: '2026-05-04T14:34:57Z',
    metadata: { milestone },
  });

  test('shouldFanOut unwraps agent_milestone to its milestone name', () => {
    expect(shouldFanOut(makeMilestone('pr_created'))).toBe(true);
  });

  test('shouldFanOut drops agent_milestone with a non-subscribed milestone', () => {
    expect(shouldFanOut(makeMilestone('repo_setup_complete'))).toBe(false);
  });

  test('shouldFanOut keeps old behavior when metadata.milestone is missing or malformed', () => {
    const bare: FanOutEvent = {
      task_id: 't-1',
      event_id: 'e-1',
      event_type: 'agent_milestone',
      timestamp: '2026-05-04T14:34:57Z',
    };
    expect(shouldFanOut(bare)).toBe(false);
    expect(shouldFanOut({ ...bare, metadata: {} })).toBe(false);
    expect(shouldFanOut({ ...bare, metadata: { foo: 'bar' } })).toBe(false);
    expect(shouldFanOut({ ...bare, metadata: { milestone: '' } })).toBe(false);
    expect(shouldFanOut({ ...bare, metadata: { milestone: 42 as unknown as string } })).toBe(false);
  });

  test('shouldFanOut rejects milestones outside the routing allowlist even if they match a channel default', () => {
    const colliding: FanOutEvent = {
      task_id: 't-collide',
      event_id: 'e-collide',
      event_type: 'agent_milestone',
      timestamp: '2026-05-04T14:34:57Z',
      metadata: { milestone: 'task_cancelled' },
    };
    expect(shouldFanOut(colliding)).toBe(false);
  });

  test('routeEvent dispatches agent_milestone(pr_created) to GitHub + Linear (ADR-016 P4.5), not Slack', async () => {
    const outcome = await routeEvent(makeMilestone('pr_created'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'linear']);
    expect(outcome.dispatched).not.toContain('slack');
  });

  test('routeEvent drops agent_milestone(agent_turn-like) that no channel subscribes to', async () => {
    const outcome = await routeEvent(makeMilestone('nudge_acknowledged'));
    expect(outcome.dispatched).toEqual([]);
  });

  test('handler dispatches GitHub comment on agent_milestone(pr_created) stream record', async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Item: {
          task_id: 't-milestone',
          user_id: 'u-1',
          status: 'RUNNING',
          repo: 'owner/repo',
          pr_number: 99,
          branch_name: 'bgagent/t-milestone/fix',
          channel_source: 'api',
          status_created_at: 'RUNNING#2026-05-04T14:34:57Z',
          created_at: '2026-05-04T14:30:00Z',
          updated_at: '2026-05-04T14:34:57Z',
        },
      })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 777,
      created: true,
    });

    const event: DynamoDBStreamEvent = {
      Records: [mkMilestoneRecord('pr_created', 't-milestone')],
    };
    await handler(event);

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
    const renderArg = mockRenderCommentBody.mock.calls[0][0];
    expect(renderArg.latestEventType).toBe('pr_created');
  });
});

function mkEventWithId(
  type: string,
  eventID: string,
  taskId = 't-fail',
  sequenceNumber = `seq-${eventID}`,
): DynamoDBRecord {
  return {
    eventID,
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        task_id: { S: taskId },
        event_id: { S: `01ABC${type}` },
        event_type: { S: type },
        timestamp: { S: '2026-05-05T00:00:00Z' },
        metadata: { M: { code: { S: 'OK' } } },
      } as never,
    },
  } as unknown as DynamoDBRecord;
}

describe('fanout-task-events: partial-batch response', () => {
  beforeEach(() => {
    mockDdbSend.mockReset().mockResolvedValue({ Item: undefined });
    mockUpsertTaskComment.mockReset();
    mockRenderCommentBody.mockReset().mockReturnValue('rendered body');
    mockLoadRepoConfig.mockReset().mockResolvedValue(null);
    mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_fake');
    mockClearTokenCache.mockReset();
  });

  test('a failed record is reported by its stream sequence number, not by its eventID', async () => {
    // Lambda resumes a DynamoDB stream from the sequence number of the first failed record:
    // https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        task_id: 't-seq',
        user_id: 'u-1',
        status: 'COMPLETED',
        repo: 'owner/repo',
        pr_number: 42,
        branch_name: 'bgagent/t-seq/fix',
        channel_source: 'api',
        status_created_at: 'COMPLETED#2026-05-05T00:00:00Z',
        created_at: '2026-05-05T00:00:00Z',
        updated_at: '2026-05-05T00:00:00Z',
      },
    });
    mockUpsertTaskComment.mockRejectedValueOnce(new Error('github 502'));

    const result = await handler({
      Records: [mkEventWithId('task_completed', 'e-1', 't-seq', '4900')],
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: '4900' }]);
  });

  test('AccessDeniedException from resolveTokenSecretArn lands in infraRejections and flags the record for retry', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      mockDdbSend.mockResolvedValueOnce({
        Item: {
          task_id: 't-boom',
          user_id: 'u-1',
          status: 'COMPLETED',
          repo: 'owner/repo',
          pr_number: 42,
          branch_name: 'bgagent/t-boom/fix',
          channel_source: 'api',
          status_created_at: 'COMPLETED#2026-05-05T00:00:00Z',
          created_at: '2026-05-05T00:00:00Z',
          updated_at: '2026-05-05T00:00:00Z',
        },
      });
      mockLoadRepoConfig.mockRejectedValueOnce(
        Object.assign(new Error('iam deny'), { name: 'AccessDeniedException' }),
      );

      const poisonId = 'evt-access-denied';
      const event: DynamoDBStreamEvent = {
        Records: [mkEventWithId('task_completed', poisonId, 't-boom')],
      };

      const result = await handler(event);

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: `seq-${poisonId}` }]);

      const rejectedWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.dispatcher.rejected',
      );
      expect(rejectedWarn).toBeDefined();
      expect((rejectedWarn?.[1] as Record<string, unknown>).channel).toBe('github');
      expect((rejectedWarn?.[1] as Record<string, unknown>).retryable).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('unhandled throw OUTSIDE routeEvent flags the record as a batch item failure', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    let warnCalls = 0;
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(
      (_msg: string, meta?: Record<string, unknown>) => {
        if (meta?.event === 'fanout.rate_limit.hit') {
          warnCalls++;
          throw new Error('simulated: logger broke during rate-limit warn');
        }
      },
    );
    try {
      const records: DynamoDBRecord[] = [];
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('agent_milestone', `evt-${i}`, 't-chatty'));
      }
      records.length = 0;
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('task_completed', `evt-${i}`, 't-chatty'));
      }

      const result = await handler({ Records: records });

      expect(warnCalls).toBeGreaterThan(0);
      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'seq-evt-20' },
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('successful records do NOT appear in batchItemFailures (mixed batch)', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(
      (_msg: string, meta?: Record<string, unknown>) => {
        if (meta?.event === 'fanout.rate_limit.hit') {
          throw new Error('simulated broken logger');
        }
      },
    );
    try {
      const records: DynamoDBRecord[] = [];
      records.push(mkEventWithId('task_completed', 'evt-ok', 't-ok'));
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('task_completed', `evt-chatty-${i}`, 't-chatty'));
      }
      const result = await handler({ Records: records });

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0]).toEqual({ itemIdentifier: 'seq-evt-chatty-20' });
      expect(result.batchItemFailures.map(f => f.itemIdentifier)).not.toContain('seq-evt-ok');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('poisonous record emits a fanout.record.failed warn so operators can alarm', async () => {
    const loggerModule = await import('../../src/handlers/shared/logger');
    const allWarns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(
      (msg: string, meta?: Record<string, unknown>) => {
        allWarns.push({ msg, meta });
        if (meta?.event === 'fanout.rate_limit.hit') {
          throw new Error('simulated broken logger for rate-limit path');
        }
      },
    );
    try {
      const records: DynamoDBRecord[] = [];
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('task_completed', `evt-${i}`, 't-chatty'));
      }
      await handler({ Records: records });

      const failedWarn = allWarns.find(w => w.meta?.event === 'fanout.record.failed');
      expect(failedWarn).toBeDefined();
      expect(failedWarn?.meta?.event_id).toBe('evt-20');
      expect(String(failedWarn?.meta?.error)).toContain('simulated broken logger');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('batch with zero throws returns an empty batchItemFailures array', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        mkEvent('agent_turn'),
        mkEvent('task_completed'),
      ],
    };
    const result = await handler(event);
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
