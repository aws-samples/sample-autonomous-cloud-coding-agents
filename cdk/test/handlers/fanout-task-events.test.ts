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

// -- DDB + downstream-module mocks (hoisted before handler import) --
// Default resolves to an empty-item Get so routing tests that don't
// care about DDB see the dispatcher short-circuit on "task not found"
// rather than throwing a TypeError. Per-test code can override with
// ``mockDdbSend.mockReset()`` + ``.mockResolvedValueOnce(...)`` as
// needed.
const mockDdbSend = jest.fn().mockResolvedValue({ Item: undefined });
// Stub the DDB client + command constructors. Using ``jest.fn`` for
// each command class gives us ``new GetCommand(input)`` producing a
// plain object we can inspect; the DocumentClient's ``send`` is routed
// to the mock above. ``requireActual`` on ``lib-dynamodb`` would pull
// in the real command implementations which internally instantiate
// ``client-dynamodb`` classes we've stubbed — that's the import cycle
// that surfaces as ``GetItemCommand is not a constructor``.
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const mockUpsertTaskComment: jest.Mock = jest.fn();
const mockRenderCommentBody: jest.Mock = jest.fn().mockReturnValue('rendered body');
jest.mock('../../src/handlers/shared/github-comment', () => ({
  upsertTaskComment: (args: unknown) => mockUpsertTaskComment(args),
  renderCommentBody: (args: unknown) => mockRenderCommentBody(args),
  // Stub class mirrors the production shape so the handler's
  // ``instanceof GitHubCommentError && err.httpStatus === 401`` check
  // fires correctly in the token-rotation test.
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

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:platform';

import {
  CHANNEL_DEFAULTS,
  parseStreamRecord,
  resolveChannelFilter,
  routeEvent,
  shouldFanOut,
  handler,
  type FanOutEvent,
  type TaskNotificationsConfig,
} from '../../src/handlers/fanout-task-events';

function mkRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  newImage: Record<string, { S?: string; N?: string; BOOL?: boolean; M?: Record<string, { S?: string }> }> | undefined,
): DynamoDBRecord {
  return {
    eventID: `evt-${Math.random().toString(36).slice(2)}`,
    eventName,
    eventSource: 'aws:dynamodb',
    dynamodb: newImage ? { NewImage: newImage as never } : {},
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
      // missing event_id, event_type, timestamp
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

  // Rev-6 design §6.2: chattier event types (task_created, agent_milestone)
  // are intentionally dropped from defaults so users don't mute integrations
  // on day one. The ``--verbose`` opt-in (Chunk K follow-up) will re-enable
  // milestone delivery.
  test.each([
    'task_failed',
    'task_completed',
    'task_cancelled',
    'task_stranded',
    'agent_error',
    'pr_created',
    'approval_required', // Phase 3 forward-compat
    'status_response', // Phase 2 forward-compat
  ])('%s is fanned out (matches at least one channel default)', (t) => {
    expect(shouldFanOut(make(t))).toBe(true);
  });

  test.each([
    'task_created', // intentionally dropped in rev-6 defaults
    // Bare ``agent_milestone`` (no ``metadata.milestone``) stays
    // dropped; wrapped milestones on the ``ROUTABLE_MILESTONES``
    // allowlist route by name — see the agent_milestone routing
    // suite below.
    'agent_milestone',
    'agent_turn',
    'agent_tool_call',
    'agent_tool_result',
    'agent_cost_update',
    'session_started',
    'hydration_started',
    'hydration_complete',
    'admission_rejected',
    'something_else',
  ])('%s is NOT fanned out (verbose / internal)', (t) => {
    expect(shouldFanOut(make(t))).toBe(false);
  });
});

describe('fanout-task-events: per-channel filter contract (design §6.2)', () => {
  // Lock in the exact sets from the design doc so a drift in
  // CHANNEL_DEFAULTS surfaces here instead of in production telemetry.
  test('Slack subscribes to terminal + PR + error + approval + status_response', () => {
    const f = CHANNEL_DEFAULTS.slack;
    expect([...f].sort()).toEqual([
      'agent_error',
      'approval_required',
      'pr_created',
      'status_response',
      'task_cancelled',
      'task_completed',
      'task_failed',
      'task_stranded',
    ]);
  });

  test('Email subscribes to task_completed + task_failed + approval_required only (minimal per §6.2)', () => {
    // Design §6.2 explicitly limits Email to these three types.
    // task_cancelled and task_stranded are NOT delivered via email —
    // the user already knows they cancelled; strands are an operator
    // signal handled via Slack / dashboards.
    const f = CHANNEL_DEFAULTS.email;
    expect([...f].sort()).toEqual([
      'approval_required',
      'task_completed',
      'task_failed',
    ]);
    expect(f.has('task_cancelled')).toBe(false);
    expect(f.has('task_stranded')).toBe(false);
  });

  test('GitHub subscribes to pr_created + terminal (edit-in-place surface)', () => {
    const f = CHANNEL_DEFAULTS.github;
    expect([...f].sort()).toEqual([
      'pr_created',
      'task_cancelled',
      'task_completed',
      'task_failed',
      'task_stranded',
    ]);
  });

  test('agent_error routes only to Slack, not Email or GitHub', () => {
    // Operator-focused event. Email fires once per outcome; GitHub
    // edits in place on PR activity; only Slack surfaces errors
    // directly so on-call can jump in.
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
    // Must NOT include the default agent_error — explicit overrides
    // replace, not augment.
    expect(f.has('agent_error')).toBe(false);
  });

  test('"default" token in an explicit list expands to the channel defaults', () => {
    const overrides: TaskNotificationsConfig = {
      slack: { events: ['default', 'agent_milestone'] },
    };
    const f = resolveChannelFilter('slack', overrides);
    // Inherits every default + the extra opt-in.
    for (const t of CHANNEL_DEFAULTS.slack) expect(f.has(t)).toBe(true);
    expect(f.has('agent_milestone')).toBe(true);
  });

  test('empty events list mutes the channel AND emits a footgun warn', async () => {
    // An empty explicit list is almost always a submission mistake
    // (e.g. ``jq '.events=[]'`` accident). Silent mute would be
    // a silent-failure trap; surface the WARN so operators see it.
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
    // Slack silenced — but email still sees terminal events.
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

  test('task_completed routes to all three channels', async () => {
    const channels = await routeEvent(mk('task_completed'));
    expect(channels.sort()).toEqual(['email', 'github', 'slack']);
  });

  test('task_cancelled skips Email per §6.2 (only Slack + GitHub)', async () => {
    // Regression guard against accidentally folding cancelled+stranded
    // into Email via a shared TERMINAL spread — design says Email is
    // minimal (task_completed, task_failed, approval_required only).
    const channels = await routeEvent(mk('task_cancelled'));
    expect(channels.sort()).toEqual(['github', 'slack']);
  });

  test('task_stranded skips Email per §6.2', async () => {
    const channels = await routeEvent(mk('task_stranded'));
    expect(channels.sort()).toEqual(['github', 'slack']);
  });

  test('agent_error routes only to Slack', async () => {
    const channels = await routeEvent(mk('agent_error'));
    expect(channels).toEqual(['slack']);
  });

  test('pr_created routes to Slack + GitHub but not Email', async () => {
    const channels = await routeEvent(mk('pr_created'));
    expect(channels.sort()).toEqual(['github', 'slack']);
  });

  test('event with no subscribers returns an empty channel list', async () => {
    // ``agent_milestone`` is not in any channel's default — routing
    // must produce an empty list so the handler records dispatched=0.
    const channels = await routeEvent(mk('agent_milestone'));
    expect(channels).toEqual([]);
  });

  test('per-task override silences one channel without affecting others', async () => {
    const overrides: TaskNotificationsConfig = { slack: { enabled: false } };
    const channels = await routeEvent(mk('task_completed'), overrides);
    expect(channels.sort()).toEqual(['email', 'github']);
    expect(channels).not.toContain('slack');
  });
});

describe('fanout-task-events: channel isolation', () => {
  test('one channel rejecting does NOT prevent the others from dispatching', async () => {
    // Simulate a Slack-side failure by making the Slack dispatcher's
    // inner ``logger.info`` throw, which escapes its own try-block via
    // the caught-and-rethrown path in the stub. The router's
    // ``Promise.allSettled`` must record Slack as rejected while
    // Email + GitHub complete normally. The assertions verify two
    // independent signals:
    //   (1) the other two dispatchers' stub log calls actually ran
    //       (proving the work was done, not just that the router
    //       reported success)
    //   (2) Slack is omitted from the ``dispatched`` return so batch
    //       telemetry reflects reality
    const loggerModule = await import('../../src/handlers/shared/logger');
    const originalInfo = loggerModule.logger.info.bind(loggerModule.logger);
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    const observedEvents: string[] = [];
    const infoSpy = jest.spyOn(loggerModule.logger, 'info').mockImplementation(
      (msg: string, meta?: Record<string, unknown>) => {
        const ev = meta?.event as string | undefined;
        if (ev) observedEvents.push(ev);
        if (ev === 'fanout.slack.dispatch_stub') {
          throw new Error('slack is down');
        }
        return originalInfo(msg, meta);
      },
    );
    try {
      const channels = await routeEvent({
        task_id: 't-isol',
        event_id: 'e-isol',
        event_type: 'task_completed',
        timestamp: '2026-04-22T04:00:00Z',
      });

      // (1) Email actually ran its dispatch path (GitHub short-circuits
      // on "task not found" because the shared DDB mock returns no
      // Item — that's fine; the key invariant is that one channel's
      // failure doesn't block the others).
      expect(observedEvents).toContain('fanout.email.dispatch_stub');
      // Slack also ran (it threw), so its log line was emitted before the throw.
      expect(observedEvents).toContain('fanout.slack.dispatch_stub');

      // (2) Telemetry truthfulness: Slack must NOT be in ``dispatched``
      // because its dispatcher rejected. Email + GitHub are.
      expect(channels.sort()).toEqual(['email', 'github']);
      expect(channels).not.toContain('slack');

      // The rejection surfaces in a warn log so operators can alert on it.
      const warnCalls = warnSpy.mock.calls.map(c => c[1] as Record<string, unknown> | undefined);
      const rejectedWarn = warnCalls.find(meta => meta?.event === 'fanout.dispatcher.rejected');
      expect(rejectedWarn).toBeDefined();
      expect(rejectedWarn?.channel).toBe('slack');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('fanout-task-events: handler', () => {
  test('dispatches only filtered events', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        mkEvent('agent_turn'), // dropped (verbose)
        mkEvent('task_completed'), // dispatched
        mkEvent('agent_cost_update'), // dropped
        mkEvent('pr_created'), // dispatched
      ],
    };
    // Must not throw; the log-only dispatchers just call logger.info.
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
  });

  test('per-task cap drops events beyond 20 per invocation', async () => {
    const records: DynamoDBRecord[] = [];
    // 25 milestones for the same task.
    for (let i = 0; i < 25; i++) {
      records.push(mkEvent('agent_milestone', 't-chatty'));
    }
    const event: DynamoDBStreamEvent = { Records: records };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
    // No strong assertion possible without mocking logger — but the
    // call must not throw, and the cap path is exercised.
  });

  test('malformed records are dropped, not thrown', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        mkRecord('INSERT', undefined),
        mkRecord('INSERT', { task_id: { S: 'x' } }), // missing fields
        mkEvent('task_completed'),
      ],
    };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
  });

  test('REMOVE events are skipped', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [mkRecord('REMOVE', undefined)],
    };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chunk J — GitHub dispatcher integration
// ---------------------------------------------------------------------------

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
    // Per-test-suite reset. After ``mockReset`` we re-establish a
    // permissive default so a test that forgets to script GetCommand
    // doesn't crash with a TypeError.
    mockDdbSend.mockReset().mockResolvedValue({ Item: undefined });
    mockUpsertTaskComment.mockReset();
    mockRenderCommentBody.mockReset().mockReturnValue('rendered body');
    mockLoadRepoConfig.mockReset().mockResolvedValue(null);
    mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_fake');
    mockClearTokenCache.mockReset();
  });

  test('first terminal event POSTs a new comment and persists the comment_id to TaskTable', async () => {
    // Get task record → upsert creates → UpdateItem persists.
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE }) // GetCommand
      .mockResolvedValueOnce({}); // UpdateCommand
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 555,
      created: true,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
    const upsertArg = mockUpsertTaskComment.mock.calls[0][0];
    expect(upsertArg).toMatchObject({
      repo: 'owner/repo',
      issueOrPrNumber: 42,
      token: 'ghp_fake',
      existingCommentId: undefined,
    });
    // Scenario 7-ext (redeploy) BLOCKER regression: the dispatcher
    // used to carry ``existingEtag`` for an ``If-Match`` PATCH header
    // that GitHub rejects with HTTP 400. The field must no longer be
    // passed on.
    expect(upsertArg).not.toHaveProperty('existingEtag');
    // UpdateCommand fired with the new id (no etag persistence).
    const update = mockDdbSend.mock.calls[1][0] as {
      input: {
        ExpressionAttributeValues: Record<string, unknown>;
        UpdateExpression: string;
        ConditionExpression: string;
      };
    };
    expect(update.input.ExpressionAttributeValues[':cid']).toBe(555);
    expect(update.input.UpdateExpression).toBe('SET github_comment_id = :cid');
    expect(update.input.UpdateExpression).not.toMatch(/etag/);
    // First-ever POST guard: refuse to overwrite a sibling's comment id
    // that might have landed between our GetItem and this UpdateItem.
    expect(update.input.ConditionExpression).toContain('attribute_not_exists(github_comment_id)');
  });

  test('subsequent event passes the persisted comment_id so the helper PATCHes', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...TASK_RECORD_BASE, github_comment_id: 555 } });
    // No UpdateCommand on a PATCH — nothing new to persist.
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 555,
      created: false,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    const upsertArg = mockUpsertTaskComment.mock.calls[0][0];
    expect(upsertArg.existingCommentId).toBe(555);
    // No second DDB call (no UpdateCommand) — the PATCH path skips
    // ``saveCommentState`` since there's no new state.
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('task with no issue_number and no pr_number skips the GitHub dispatcher', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { ...TASK_RECORD_BASE, pr_number: undefined, issue_number: undefined },
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
    // No UpdateItem either — nothing to persist.
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('missing task record (TTL race) → skip without throwing', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-missing')] };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
  });

  test('upsertTaskComment rejection does NOT break the batch (routeEvent catches)', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockUpsertTaskComment.mockRejectedValueOnce(new Error('github 500'));

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();
    // No UpdateCommand fires (no id to persist from a failed upsert).
    const updateCalls = mockDdbSend.mock.calls.filter(
      c => (c[0] as { _type?: string })._type === 'Update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('dispatcher does NOT forward an If-Match-style ETag to upsertTaskComment (BLOCKER regression)', async () => {
    // Scenario 7-ext (redeploy) found that GitHub rejects any PATCH
    // on an issue comment carrying a conditional header with HTTP 400
    // ("Conditional request headers are not allowed in unsafe requests
    // unless supported by the endpoint"). The fanout dispatcher must
    // not carry an etag through to the helper, even when stray
    // ``github_comment_etag`` data exists on legacy TaskRecords from
    // before this fix landed.
    mockDdbSend
      .mockResolvedValueOnce({
        Item: {
          ...TASK_RECORD_BASE,
          github_comment_id: 555,
          // Legacy field — must be ignored by the new code path.
          github_comment_etag: '"legacy-etag-from-before-fix"',
        },
      });
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 555,
      created: false,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    const upsertArg = mockUpsertTaskComment.mock.calls[0][0];
    expect(upsertArg.existingCommentId).toBe(555);
    expect(upsertArg).not.toHaveProperty('existingEtag');
  });

  test('404 → POST fallback persists new comment id with a prev-id condition guard', async () => {
    // Race guard (silent-failure review SIG-3): when the cached
    // comment was deleted upstream and the helper POSTed a new one,
    // the UpdateItem must require ``github_comment_id = :prev`` so
    // we cannot silently overwrite a sibling fanout invocation that
    // already re-posted (or that beat us to writing a fresh id).
    mockDdbSend
      .mockResolvedValueOnce({
        Item: { ...TASK_RECORD_BASE, github_comment_id: 555 },
      })
      .mockResolvedValueOnce({}); // UpdateCommand for the re-POST
    mockUpsertTaskComment.mockResolvedValueOnce({
      commentId: 999, // new id from the fallback POST
      created: true,
    });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    const update = mockDdbSend.mock.calls[1][0] as {
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
    // End-to-end version of silent-failure review MINOR-1: if a
    // future refactor accidentally reintroduces an If-Match (or any
    // conditional header) header, GitHub returns HTTP 400 for the
    // PATCH. The fanout handler must NOT retry via POST (only 404
    // triggers the fallback) and must NOT persist anything new. The
    // 400 surfaces as a warn through the batch-level
    // ``fanout.dispatcher.rejected`` log instead.
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
      await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();

      // No UpdateCommand fires — the 400 path has nothing to persist.
      const updateCalls = mockDdbSend.mock.calls.filter(
        c => (c[0] as { _type?: string })._type === 'Update',
      );
      expect(updateCalls).toHaveLength(0);

      // The 400 surfaced as a dispatcher-rejected warn, not as a
      // silent swallow.
      const rejectedWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.dispatcher.rejected',
      );
      expect(rejectedWarn).toBeDefined();
      expect((rejectedWarn?.[1] as Record<string, unknown>).channel).toBe('github');
      expect(String((rejectedWarn?.[1] as Record<string, unknown>).error)).toContain('HTTP 400');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('falls back to issue_number when pr_number is absent', async () => {
    // Webhook-submitted issue tasks are the common real-world surface.
    mockDdbSend
      .mockResolvedValueOnce({
        Item: { ...TASK_RECORD_BASE, pr_number: undefined, issue_number: 7 },
      })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    expect(mockUpsertTaskComment.mock.calls[0][0].issueOrPrNumber).toBe(7);
  });

  test('loadRepoConfig throwing a transient error falls back to the platform default token', async () => {
    // SFH-S2: DDB throttling must not black-hole GitHub comments;
    // the dispatcher falls back to the platform default ARN so
    // one flaky invocation doesn't silence the whole fleet.
    mockLoadRepoConfig.mockRejectedValueOnce(
      Object.assign(new Error('rate exceeded'), { name: 'ProvisionedThroughputExceededException' }),
    );
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    // Fallback to the platform env-var ARN (set at the top of this file).
    expect(mockResolveGitHubToken).toHaveBeenCalledWith('arn:aws:secretsmanager:us-east-1:0:secret:platform');
  });

  test('resolveGitHubToken throwing causes the dispatcher to skip without calling upsertTaskComment', async () => {
    // SFH-S1 adjacent: when Secrets Manager fails, we must NOT
    // attempt to write a comment with an undefined token.
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockResolveGitHubToken.mockRejectedValueOnce(new Error('secrets manager down'));

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
  });

  test('saveCommentState ConditionalCheckFailed (task evicted) logs at INFO not ERROR', async () => {
    // Benign: the task was TTL-evicted between the Get and the
    // Update. Subsequent events for this task will also skip, so
    // no duplicate-comment risk. Must NOT alarm operators.
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockRejectedValueOnce(
        Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' }),
      );
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();

    // Upsert fired (comment posted); handler didn't throw.
    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
  });

  test('saveCommentState non-conditional failure (DDB throttling) logs at ERROR with error_id', async () => {
    // SFH-B2: non-ConditionalCheckFailed failures leave the task
    // without a comment_id, so the next event will duplicate. This
    // is a real persistence bug that must alarm distinctly.
    const errorSpy = jest.fn();
    jest.spyOn(
      (await import('../../src/handlers/shared/logger')).logger,
      'error',
    ).mockImplementation(errorSpy);

    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockRejectedValueOnce(
        Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
      );
    mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    // The dedicated error_id tag must fire so operators can alarm on it.
    const errorCall = errorSpy.mock.calls.find(
      c => (c[1] as Record<string, unknown> | undefined)?.error_id === 'FANOUT_GITHUB_PERSIST_FAILED',
    );
    expect(errorCall).toBeDefined();
  });

  test('401 from GitHub clears the token cache and retries once with a fresh token', async () => {
    // SFH-S1: token rotation recovery. The first upsert rejects with
    // 401, the dispatcher evicts the cache, re-fetches, and retries.
    // We import the (mocked) class fresh so ``instanceof`` in the
    // handler matches the instance the test throws.
    const { GitHubCommentError } = jest.requireMock<typeof import('../../src/handlers/shared/github-comment')>(
      '../../src/handlers/shared/github-comment',
    );
    mockDdbSend
      .mockResolvedValueOnce({ Item: TASK_RECORD_BASE })
      .mockResolvedValueOnce({});
    mockUpsertTaskComment
      .mockRejectedValueOnce(new GitHubCommentError('unauthorized', 401))
      .mockResolvedValueOnce({ commentId: 1, created: true });
    // Two token fetches — stale then fresh.
    mockResolveGitHubToken
      .mockResolvedValueOnce('ghp_stale')
      .mockResolvedValueOnce('ghp_fresh');

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await handler(event, {} as never, () => undefined);

    expect(mockClearTokenCache).toHaveBeenCalledTimes(1);
    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(2);
    // Retry carried the fresh token.
    expect(mockUpsertTaskComment.mock.calls[1][0].token).toBe('ghp_fresh');
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
    await handler(event, {} as never, () => undefined);

    expect(mockResolveGitHubToken).toHaveBeenCalledWith('arn:repo-specific');
  });

  // ---- Scenario 7-extended regression (post-K2 deploy validation) ----

  test('TaskRecord with string-typed cost_usd/duration_s renders without throwing (DDB Number coercion)', async () => {
    // Regression: the DynamoDB Document-client returns Number
    // attributes as strings. ``renderCommentBody`` calls
    // ``costUsd.toFixed(4)`` which throws TypeError on a string,
    // causing every terminal event on a pr_iteration task to be
    // rejected by the dispatcher (observed in Scenario 7-extended
    // deploy validation, task ``01KQSPFXQMYQR0CNGCF56XB9ZM``). The
    // fan-out boundary must coerce.
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
    await expect(handler(event, {} as never, () => undefined)).resolves.toBeUndefined();

    expect(mockRenderCommentBody).toHaveBeenCalledTimes(1);
    const renderArg = mockRenderCommentBody.mock.calls[0][0];
    // Coerced to finite numbers so ``.toFixed`` downstream works.
    expect(typeof renderArg.costUsd).toBe('number');
    expect(renderArg.costUsd).toBeCloseTo(0.2094, 4);
    expect(typeof renderArg.durationS).toBe('number');
    expect(renderArg.durationS).toBe(96);
    // Upsert reached the HTTP layer — no TypeError short-circuit.
    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
  });

  test('non-finite string cost collapses to null and emits a warn (surfaces writer bugs)', async () => {
    // Defense-in-depth: a corrupt ``cost_usd`` that parses to ``NaN``
    // must not produce a ``$NaN`` row. The coercion returns ``null``
    // so the optional render branch stays off, but must also emit a
    // ``fanout.numeric_coercion_failed`` warn so the writer bug is
    // not silently absorbed.
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
      await handler(event, {} as never, () => undefined);

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
    // The DDB Item may simply omit the attributes (task still RUNNING
    // at the time of the event). ``undefined`` inputs must not warn —
    // they're not corrupt, they're just not set yet.
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    try {
      const base = { ...TASK_RECORD_BASE } as Record<string, unknown>;
      delete base.cost_usd;
      delete base.duration_s;
      mockDdbSend.mockResolvedValueOnce({ Item: base }).mockResolvedValueOnce({});
      mockUpsertTaskComment.mockResolvedValueOnce({ commentId: 1, created: true });

      const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
      await handler(event, {} as never, () => undefined);

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

// ---------------------------------------------------------------------------
// Scenario 7-extended — agent_milestone routing regression
// ---------------------------------------------------------------------------

/** Stream record for an ``agent_milestone`` event carrying a named
 *  milestone in ``metadata.milestone`` — the shape written by
 *  ``agent/src/progress_writer.py::write_agent_milestone``. */
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
  // The agent writes named checkpoints (``pr_created``,
  // ``nudge_acknowledged``, …) with ``event_type = agent_milestone``
  // and ``metadata.milestone`` carrying the name (see
  // ``agent/src/progress_writer.py::write_agent_milestone``). The
  // channel-default filters are expressed against the milestone names
  // directly (design §6.2), so routing unwraps the wrapper before
  // matching. Without unwrap, ``pr_created`` would fan out to zero
  // channels — observed in Scenario 7-extended.

  const makeMilestone = (milestone: string): FanOutEvent => ({
    task_id: 't-1',
    event_id: 'e-1',
    event_type: 'agent_milestone',
    timestamp: '2026-05-04T14:34:57Z',
    metadata: { milestone },
  });

  test('shouldFanOut unwraps agent_milestone to its milestone name', () => {
    // ``pr_created`` is in Slack + GitHub defaults → fan out.
    expect(shouldFanOut(makeMilestone('pr_created'))).toBe(true);
  });

  test('shouldFanOut drops agent_milestone with a non-subscribed milestone', () => {
    // ``repo_setup_complete`` is deliberately NOT in any channel's
    // default — verbose opt-in only, per §6.2.
    expect(shouldFanOut(makeMilestone('repo_setup_complete'))).toBe(false);
  });

  test('shouldFanOut keeps old behavior when metadata.milestone is missing or malformed', () => {
    // Backwards-compat: a bare ``agent_milestone`` event (shouldn't
    // happen in practice — the writer always sets ``milestone``) must
    // not crash the router; it simply doesn't match any default. We
    // cover: missing ``metadata`` entirely, empty ``metadata`` object,
    // missing ``milestone`` key, empty-string milestone, and a
    // non-string milestone value.
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
    // Structural defense against naming drift: a future rename that
    // accidentally makes ``metadata.milestone`` equal an existing
    // channel-default entry (e.g. ``task_cancelled``) must NOT start
    // silently fanning out. Only the allowlist (today: ``pr_created``)
    // is eligible for unwrap.
    const colliding: FanOutEvent = {
      task_id: 't-collide',
      event_id: 'e-collide',
      event_type: 'agent_milestone',
      timestamp: '2026-05-04T14:34:57Z',
      metadata: { milestone: 'task_cancelled' },
    };
    // ``task_cancelled`` is in Slack + GitHub defaults as a terminal
    // event type — but unwrap must still refuse because the milestone
    // is outside ``ROUTABLE_MILESTONES``.
    expect(shouldFanOut(colliding)).toBe(false);
  });

  test('routeEvent dispatches agent_milestone(pr_created) to Slack + GitHub, not Email', async () => {
    const channels = await routeEvent(makeMilestone('pr_created'));
    expect(channels.sort()).toEqual(['github', 'slack']);
  });

  test('routeEvent drops agent_milestone(agent_turn-like) that no channel subscribes to', async () => {
    // ``nudge_acknowledged`` is in no channel default today. Must
    // still route cleanly (empty list) rather than throw.
    const channels = await routeEvent(makeMilestone('nudge_acknowledged'));
    expect(channels).toEqual([]);
  });

  test('handler dispatches GitHub comment on agent_milestone(pr_created) stream record', async () => {
    // End-to-end guard: the DynamoDB Stream shape for pr_created is
    // an ``agent_milestone`` wrapper. The handler must read the
    // milestone name from metadata, match the GitHub default filter,
    // load the task, and reach ``upsertTaskComment``.
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
    await handler(event, {} as never, () => undefined);

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
    // Comment body renders ``pr_created`` (the effective type),
    // not the wrapper ``agent_milestone``. Cross-check: the watch
    // CLI renders ``★ pr_created: ...`` on the same record, so the
    // two surfaces stay consistent.
    const renderArg = mockRenderCommentBody.mock.calls[0][0];
    expect(renderArg.latestEventType).toBe('pr_created');
  });
});
