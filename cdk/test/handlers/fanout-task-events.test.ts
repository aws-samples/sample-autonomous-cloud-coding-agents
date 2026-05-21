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

// Issue #64: SlackNotifyFn migrated onto FanOutConsumer as a dispatcher.
// The dispatcher calls into ``slack-notify.ts::dispatchSlackEvent``; we
// mock that here so the fanout tests focus on routing invariants and
// leave the per-dispatcher Slack behaviour to ``slack-notify.test.ts``.
// Exposing the mock + the tagged ``SlackApiError`` class lets routing
// tests drive the two observable outcomes the dispatcher produces
// (resolve → ``fanout.slack.dispatched``; reject with SlackApiError →
// router-level ``fanout.slack.api_error`` warn without dispatcher
// rejection).
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

  // Rev-6 design §6.2 + issue #64: the Slack dispatcher is the only
  // channel that consumes ``task_created`` / ``session_started`` /
  // ``task_timed_out`` — it gates further on ``channel_source ===
  // 'slack'`` so the extra lifecycle signals never reach API / webhook
  // / Linear tasks. That extra gate lives inside the dispatcher, so at
  // the filter layer these events now fan out.
  test.each([
    'task_failed',
    'task_completed',
    'task_cancelled',
    'task_stranded',
    'task_timed_out', // Slack lifecycle (issue #64)
    'task_created', // Slack lifecycle (issue #64)
    'session_started', // Slack lifecycle (issue #64)
    'agent_error',
    'pr_created',
    'approval_requested', // Cedar HITL
    'approval_stranded', // Cedar HITL
    'status_response', // Phase 2 forward-compat
  ])('%s is fanned out (matches at least one channel default)', (t) => {
    expect(shouldFanOut(make(t))).toBe(true);
  });

  test.each([
    // Bare ``agent_milestone`` (no ``metadata.milestone``) stays
    // dropped; wrapped milestones on the ``ROUTABLE_MILESTONES``
    // allowlist route by name — see the agent_milestone routing
    // suite below.
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
  // Lock in the exact sets from the design doc so a drift in
  // CHANNEL_DEFAULTS surfaces here instead of in production telemetry.
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
    // ``pr_created`` is deliberately NOT in the Slack default — the
    // ``task_completed`` message already renders a "View PR" button
    // with the same URL, and posting both would visually duplicate.
    // GitHub keeps ``pr_created`` because the edit-in-place comment
    // benefits from the early checkpoint.
    expect(f.has('pr_created')).toBe(false);
  });

  test('every Slack-default event the dispatcher actually renders today is in NOTIFIABLE_EVENTS (issue #64 review Cat 7 drift guard)', () => {
    // The router subscribes Slack to events the dispatcher must
    // render. ``approval_requested``, ``approval_stranded``, and
    // ``status_response`` are forward-compat (no Slack-side renderer
    // today — the CLI surfaces approval UX; Slack is only in the
    // channel-defaults set so a future Slack-button renderer can
    // light up without changing the router filter). They're allowed
    // to be in CHANNEL_DEFAULTS.slack but absent from
    // NOTIFIABLE_EVENTS — when their emitters land, this test will
    // start failing and force the dispatcher update at the same time.
    // Every OTHER Slack default must be renderable, otherwise
    // telemetry lies. Use ``requireActual`` to bypass the
    // slack-notify mock and read the real exported NOTIFIABLE_EVENTS
    // set.
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
    // Design §6.2 explicitly limits Email to these three types.
    // task_cancelled and task_stranded are NOT delivered via email —
    // the user already knows they cancelled; strands are an operator
    // signal handled via Slack / dashboards.
    const f = CHANNEL_DEFAULTS.email;
    expect([...f].sort()).toEqual([
      'approval_requested',
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
    const outcome = await routeEvent(mk('task_completed'));
    expect([...outcome.dispatched].sort()).toEqual(['email', 'github', 'slack']);
    expect(outcome.infraRejections).toEqual([]);
  });

  test('task_cancelled skips Email per §6.2 (only Slack + GitHub)', async () => {
    // Regression guard against accidentally folding cancelled+stranded
    // into Email via a shared TERMINAL spread — design says Email is
    // minimal (task_completed, task_failed, approval_required only).
    const outcome = await routeEvent(mk('task_cancelled'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'slack']);
  });

  test('task_stranded skips Email per §6.2', async () => {
    const outcome = await routeEvent(mk('task_stranded'));
    expect([...outcome.dispatched].sort()).toEqual(['github', 'slack']);
  });

  test('agent_error routes only to Slack', async () => {
    const outcome = await routeEvent(mk('agent_error'));
    expect(outcome.dispatched).toEqual(['slack']);
  });

  test('pr_created routes to GitHub only (not Slack — task_completed already carries View PR)', async () => {
    const outcome = await routeEvent(mk('pr_created'));
    expect(outcome.dispatched).toEqual(['github']);
    expect(outcome.dispatched).not.toContain('slack');
  });

  test('event with no subscribers returns an empty channel list', async () => {
    // ``agent_milestone`` is not in any channel's default — routing
    // must produce an empty list so the handler records dispatched=0.
    const outcome = await routeEvent(mk('agent_milestone'));
    expect(outcome.dispatched).toEqual([]);
    expect(outcome.infraRejections).toEqual([]);
  });

  test('per-task override silences one channel without affecting others', async () => {
    const overrides: TaskNotificationsConfig = { slack: { enabled: false } };
    const outcome = await routeEvent(mk('task_completed'), overrides);
    expect([...outcome.dispatched].sort()).toEqual(['email', 'github']);
    expect(outcome.dispatched).not.toContain('slack');
  });
});

describe('fanout-task-events: channel isolation', () => {
  test('one channel rejecting does NOT prevent the others from dispatching', async () => {
    // Simulate a Slack infra failure by making the dispatchSlackEvent
    // mock reject with a non-SlackApiError throw (SlackApiError would be
    // swallowed at the dispatcher boundary — see the SlackApiError
    // suppression test below). The router's ``Promise.allSettled`` must
    // record Slack as rejected while Email + GitHub complete normally.
    // The assertions verify two independent signals:
    //   (1) the other two dispatchers' work actually ran (proving the
    //       channels were attempted, not short-circuited)
    //   (2) Slack is omitted from the ``dispatched`` return so batch
    //       telemetry reflects reality
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

      // (1) Email ran its dispatch path (GitHub short-circuits on
      // "task not found" because the shared DDB mock returns no Item —
      // that's fine; the key invariant is that one channel's failure
      // doesn't block the others). Slack's dispatcher was invoked
      // exactly once even though it rejected.
      expect(observedEvents).toContain('fanout.email.dispatch_stub');
      expect(mockDispatchSlackEvent).toHaveBeenCalledTimes(1);

      // (2) Telemetry truthfulness: Slack must NOT be in ``dispatched``
      // because its dispatcher rejected. Email + GitHub are.
      expect([...outcome.dispatched].sort()).toEqual(['email', 'github']);
      expect(outcome.dispatched).not.toContain('slack');

      // (3) Slack landed in ``infraRejections`` so the handler will
      // flag this record for partial-batch retry — the BLOCKER that
      // motivated the post-issue-#64 review fix. Without this signal,
      // a transient Slack-side DDB throttle would be a permanent drop.
      expect(outcome.infraRejections).toEqual(['slack']);

      // The rejection surfaces in a warn log so operators can alert on it.
      const warnCalls = warnSpy.mock.calls.map(c => c[1] as Record<string, unknown> | undefined);
      const rejectedWarn = warnCalls.find(meta => meta?.event === 'fanout.dispatcher.rejected');
      expect(rejectedWarn).toBeDefined();
      expect(rejectedWarn?.channel).toBe('slack');
      // The warn flags the rejection as retryable so operators can
      // tell the difference between a noisy infra blip (this) and a
      // channel-terminal swallow like ``channel_not_found`` (which
      // emits ``fanout.slack.api_error`` instead).
      expect(rejectedWarn?.retryable).toBe(true);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      mockDispatchSlackEvent.mockReset();
    }
  });

  test('SlackApiError from the dispatcher is swallowed (counted as dispatched)', async () => {
    // Slack API errors like ``channel_not_found`` are not recoverable
    // by a Lambda retry. The fanout Slack dispatcher catches
    // SlackApiError internally and logs ``fanout.slack.api_error``
    // without propagating, so the router treats Slack as dispatched.
    // This keeps Lambda from burning retries on a bot-token misroute
    // while still surfacing the failure in CloudWatch.
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

      // Slack is listed as dispatched despite the API error — the
      // router never saw a rejection because the dispatcher swallowed
      // it. The router-level ``fanout.dispatcher.rejected`` warn must
      // NOT fire for this case, and ``infraRejections`` must NOT
      // include Slack (so the handler does not push the record into
      // ``batchItemFailures`` — Lambda must not waste retries on
      // ``channel_not_found``).
      expect(outcome.dispatched).toContain('slack');
      expect(outcome.infraRejections).not.toContain('slack');
      const rejected = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.dispatcher.rejected',
      );
      expect(rejected).toBeUndefined();
      // The swallow was observable via ``fanout.slack.api_error``.
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
        mkEvent('agent_turn'), // dropped (verbose)
        mkEvent('task_completed'), // dispatched
        mkEvent('agent_cost_update'), // dropped
        mkEvent('pr_created'), // dispatched
      ],
    };
    // Must not throw; the log-only dispatchers just call logger.info.
    // Handler returns a ``DynamoDBBatchResponse`` so ``reportBatchItemFailures``
    // semantics are honored end-to-end (finding #1). Empty ``batchItemFailures``
    // means every record succeeded from the event-source-mapping's perspective.
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });

  test('per-task cap drops events beyond 20 per invocation', async () => {
    const records: DynamoDBRecord[] = [];
    // 25 milestones for the same task.
    for (let i = 0; i < 25; i++) {
      records.push(mkEvent('agent_milestone', 't-chatty'));
    }
    const event: DynamoDBStreamEvent = { Records: records };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
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
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
  });

  test('REMOVE events are skipped', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [mkRecord('REMOVE', undefined)],
    };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
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
    await handler(event);

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
    await handler(event);

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
    await handler(event);

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
    // No UpdateItem either — nothing to persist.
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('missing task record (TTL race) → skip without throwing', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-missing')] };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

    expect(mockUpsertTaskComment).not.toHaveBeenCalled();
  });

  test('upsertTaskComment rejection escalates to partial-batch retry (post-issue-#64-review)', async () => {
    // Pre-fix: this test asserted ``batchItemFailures: []`` because
    // the router swallowed any dispatcher rejection. That hid
    // transient GitHub 5xxs as permanent drops. After the fix, an
    // upsertTaskComment rejection lands in ``infraRejections`` and
    // the handler escalates the record for partial-batch retry —
    // matching the legacy ``SlackNotifyFn`` semantic where infra
    // errors triggered Lambda retry.
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockUpsertTaskComment.mockRejectedValueOnce(new Error('github 500'));

    const event = { Records: [mkEvent('task_completed', 't-gh')] } as DynamoDBStreamEvent;
    const result = await handler(event);
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe(event.Records[0].eventID);
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
    await handler(event);

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
    await handler(event);

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
      await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

      // No UpdateCommand fires — the 400 path has nothing to persist.
      const updateCalls = mockDdbSend.mock.calls.filter(
        c => (c[0] as { _type?: string })._type === 'Update',
      );
      expect(updateCalls).toHaveLength(0);

      // Post-issue-#64-review Cat 3 fix: GitHub 4xx (excluding 401 +
      // 404 which have dedicated handling) is now treated as a
      // **channel-terminal** error. The dispatcher swallows it via a
      // dedicated ``fanout.github.api_error`` warn, NOT a generic
      // ``fanout.dispatcher.rejected``. This keeps Lambda from
      // burning retries on a fundamentally bad request — symmetric
      // with the SlackApiError swallow on ``channel_not_found``.
      const apiErrWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.github.api_error',
      );
      expect(apiErrWarn).toBeDefined();
      expect((apiErrWarn?.[1] as Record<string, unknown>).http_status).toBe(400);
      expect(String((apiErrWarn?.[1] as Record<string, unknown>).error)).toContain('HTTP 400');

      // ``fanout.dispatcher.rejected`` must NOT fire — it is reserved
      // for retryable infra rejections under the new contract.
      const rejectedWarn = warnSpy.mock.calls.find(
        c => (c[1] as Record<string, unknown> | undefined)?.event === 'fanout.dispatcher.rejected',
      );
      expect(rejectedWarn).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test.each([403, 429])(
    'HTTP %s from GitHub escalates to partial-batch retry (rate-limit carve-out, PR #79 review #1)',
    async (httpStatus) => {
      // 403 ("API rate limit exceeded") and 429 ("Too Many Requests")
      // are 4xx but transient. The original migration's blanket 4xx
      // swallow would permanently drop entire reconciliation waves
      // under sustained rate-limiting. The carve-out re-classifies
      // them as infra rejections so the record retries until the
      // rate-limit window clears (or DLQs after retryAttempts).
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

      // Record IS in batchItemFailures — Lambda will replay until
      // the rate-limit window opens. Critical: the swallow-as-terminal
      // path would have produced an empty array (silent drop).
      expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.eventID }]);
    },
  );

  test('falls back to issue_number when pr_number is absent', async () => {
    // Webhook-submitted issue tasks are the common real-world surface.
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
    await handler(event);

    // Fallback to the platform env-var ARN (set at the top of this file).
    expect(mockResolveGitHubToken).toHaveBeenCalledWith('arn:aws:secretsmanager:us-east-1:0:secret:platform');
  });

  test('resolveGitHubToken throwing causes the dispatcher to skip without calling upsertTaskComment', async () => {
    // SFH-S1 adjacent: when Secrets Manager fails, we must NOT
    // attempt to write a comment with an undefined token.
    mockDdbSend.mockResolvedValueOnce({ Item: TASK_RECORD_BASE });
    mockResolveGitHubToken.mockRejectedValueOnce(new Error('secrets manager down'));

    const event: DynamoDBStreamEvent = { Records: [mkEvent('task_completed', 't-gh')] };
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

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
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

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
    await handler(event);

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
    await handler(event);

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
    await handler(event);

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
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });

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

// ---------------------------------------------------------------------------
// Issue #64 — Slack dispatcher integration (SlackNotifyFn migration)
// ---------------------------------------------------------------------------

describe('fanout-task-events: Slack dispatcher (issue #64 migration)', () => {
  // Confirm the Slack dispatcher is wired into the router and receives
  // the parsed FanOutEvent (not a raw DynamoDB stream record). Detailed
  // per-behaviour coverage (dedup, thread management, reactions, session
  // cleanup) lives in ``slack-notify.test.ts``.

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
    // Event is the pre-parsed FanOutEvent shape, not a raw stream record.
    expect(parsedEvent).toMatchObject({
      task_id: 't-slack',
      event_type: 'task_completed',
    });
    // Routing threads the handler's shared DocumentClient through —
    // otherwise every dispatched event would pay a fresh client init.
    expect(ddbClient).toBeDefined();
  });

  test('task_created fans out (Slack lifecycle event re-added for issue #64)', async () => {
    // Before #64, ``task_created`` was intentionally dropped at the
    // filter layer to keep integrations quiet by default. The Slack
    // dispatcher now gates further on ``channel_source === 'slack'``,
    // so re-admitting it at the filter is safe.
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
    // Post-issue-#64-review BLOCKER fix: an infra error inside the
    // Slack dispatcher (DDB throttling on the task GetItem, Secrets
    // Manager 5xx, transient Slack API timeout) must NOT be silently
    // dropped. The handler routes the rejection through the new
    // ``infraRejections`` channel and pushes the record into
    // ``batchItemFailures`` so Lambda retries it. Without this, the
    // migration would lose the legacy ``SlackNotifyFn`` retry
    // semantic.
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(
      new Error('slack side ddb throttled'),
    );

    const record = mkEvent('task_completed', 't-slack-fail');
    const result = await handler({ Records: [record] });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: record.eventID }]);
  });

  test('Slack dispatcher SlackApiError swallow does NOT escalate to retry', async () => {
    // The other side of the boundary: ``channel_not_found`` and
    // similar terminal Slack API errors are wrapped in SlackApiError
    // and swallowed inside ``dispatchToSlack``. The router never sees
    // the rejection so the record advances cleanly. Pinning this
    // distinction prevents a future "let's just retry everything"
    // refactor from burning Lambda retries on channel_not_found.
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

  test('SlackApiError matched by name even when instanceof fails (PR #79 review #7)', async () => {
    // Defense-in-depth: if a bundler ever duplicates the slack-notify
    // module, two distinct SlackApiError classes coexist and
    // ``instanceof`` against one fails for instances of the other.
    // The dispatcher must fall back to ``err.name === 'SlackApiError'``
    // so a duplicated-class scenario doesn't flip the channel-terminal
    // swallow into an infinite retry loop. Synthesise that exact
    // shape: a plain Error with name === 'SlackApiError', NOT an
    // instance of the mock's SlackApiError class.
    const fakeForeignSlackApiError = new Error(
      'slack chat.postMessage failed: not_authed',
    );
    fakeForeignSlackApiError.name = 'SlackApiError';
    mockDispatchSlackEvent.mockReset().mockRejectedValueOnce(fakeForeignSlackApiError);

    const event: DynamoDBStreamEvent = {
      Records: [mkEvent('task_completed', 't-slack-foreign-class')],
    };
    // Must still be caught — record advances, no batchItemFailures.
    await expect(handler(event)).resolves.toEqual({ batchItemFailures: [] });
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
    // ``pr_created`` is in the GitHub default → fan out (Slack
    // explicitly excludes pr_created; see CHANNEL_DEFAULTS comment).
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

  test('routeEvent dispatches agent_milestone(pr_created) to GitHub only (Slack opted out to avoid duplicate View PR)', async () => {
    const outcome = await routeEvent(makeMilestone('pr_created'));
    expect(outcome.dispatched).toEqual(['github']);
  });

  test('routeEvent drops agent_milestone(agent_turn-like) that no channel subscribes to', async () => {
    // ``nudge_acknowledged`` is in no channel default today. Must
    // still route cleanly (empty list) rather than throw.
    const outcome = await routeEvent(makeMilestone('nudge_acknowledged'));
    expect(outcome.dispatched).toEqual([]);
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
    await handler(event);

    expect(mockUpsertTaskComment).toHaveBeenCalledTimes(1);
    // Comment body renders ``pr_created`` (the effective type),
    // not the wrapper ``agent_milestone``. Cross-check: the watch
    // CLI renders ``★ pr_created: ...`` on the same record, so the
    // two surfaces stay consistent.
    const renderArg = mockRenderCommentBody.mock.calls[0][0];
    expect(renderArg.latestEventType).toBe('pr_created');
  });
});

// ---------------------------------------------------------------------------
// Krokoko code review findings #1 + #5 — partial-batch response contract
// ---------------------------------------------------------------------------

/**
 * Stream record with a caller-supplied ``eventID`` so the test can
 * assert which record surfaces in ``batchItemFailures``. ``mkEvent``
 * uses ``Math.random()`` for the id which is fine for parse tests but
 * useless when we need to cross-reference the failure identifier.
 */
function mkEventWithId(type: string, eventID: string, taskId = 't-fail'): DynamoDBRecord {
  return {
    eventID,
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    dynamodb: {
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

describe('fanout-task-events: partial-batch response (findings #1 + #5)', () => {
  // Finding #1: the construct sets ``reportBatchItemFailures: true`` on
  // the event-source-mapping, but the handler used to return ``void``.
  // That combination makes Lambda retry the WHOLE batch on any
  // unhandled throw — replaying every sibling event and defeating the
  // per-task ordering guarantee promised upstream by
  // ``ParallelizationFactor: 1``.
  //
  // Finding #5: the architecturally reachable poison-pill path is a
  // throw that bypasses ``routeEvent``'s ``Promise.allSettled``. The
  // isolation works today for async rejections (``resolveTokenSecretArn``
  // → ``AccessDeniedException`` is caught), but a future refactor that
  // drops ``allSettled`` or introduces a sync-throw path before the
  // dispatcher list is built would surface that throw at the handler.
  // The tests below exercise the handler's defensive try/catch by
  // injecting a throw from a dependency the handler uses OUTSIDE
  // ``routeEvent`` — the ``logger.warn`` call in the rate-limit path —
  // which is the same failure shape the handler must tolerate for any
  // future escape from ``allSettled`` containment.

  beforeEach(() => {
    mockDdbSend.mockReset().mockResolvedValue({ Item: undefined });
    mockUpsertTaskComment.mockReset();
    mockRenderCommentBody.mockReset().mockReturnValue('rendered body');
    mockLoadRepoConfig.mockReset().mockResolvedValue(null);
    mockResolveGitHubToken.mockReset().mockResolvedValue('ghp_fake');
    mockClearTokenCache.mockReset();
  });

  test('AccessDeniedException from resolveTokenSecretArn lands in infraRejections and flags the record for retry', async () => {
    // Pre-issue-#64-review: this test asserted ``batchItemFailures: []``
    // because ``Promise.allSettled`` swallowed the rejection — that
    // pinned a real BLOCKER (transient infra errors silently dropped).
    // After the fix, the dispatcher's rejection lands in
    // ``infraRejections`` and the handler escalates it to the partial-
    // batch retry path. AccessDenied is technically a hard configuration
    // failure (not transient), but treating it as retryable is correct
    // — operators will see the record stuck in retry and the warn rate
    // climbing on ``fanout.dispatcher.rejected`` until they fix the
    // IAM policy. Silently dropping was the worse failure mode.
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

      // Record is flagged for partial-batch retry — Lambda will replay
      // this single eventID, leaving siblings alone.
      expect(result.batchItemFailures).toEqual([{ itemIdentifier: poisonId }]);

      // The rejection is observable through the dispatcher-rejected
      // warn so operators can alarm distinctly from the generic
      // record-failed warn.
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

  test('unhandled throw OUTSIDE routeEvent flags the record as a batch item failure (finding #1 defense)', async () => {
    // Defense-in-depth proof: when SOMETHING in the record-processing
    // loop throws past ``routeEvent``'s containment (simulated here by
    // making ``logger.warn`` throw on the rate-limit path — the
    // closest real non-``routeEvent`` code path), the handler's
    // per-record try/catch must push the record's ``eventID`` into
    // ``batchItemFailures`` so Lambda retries ONLY that record. Pre-fix
    // the handler returned void and Lambda would retry the ENTIRE
    // batch, replaying every sibling event and defeating per-task
    // ordering.
    const loggerModule = await import('../../src/handlers/shared/logger');
    // Rate-limit warn on the 21st event throws; earlier events succeed.
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
      // 21 events for the same task — the 21st triggers the rate-limit
      // warn, which throws, escaping ``routeEvent`` entirely (the
      // cap check happens BEFORE ``routeEvent`` is called).
      const records: DynamoDBRecord[] = [];
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('agent_milestone', `evt-${i}`, 't-chatty'));
      }
      // Only the 21st record should be in batchItemFailures — events
      // 0..19 succeed (within cap), event 20 trips the cap and throws.
      // Note that ``agent_milestone`` with no metadata.milestone does
      // not match any filter (so it's dropped), but the cap check is
      // purely per-task per invocation and fires regardless; to make
      // the record reach the cap check we use ``task_completed`` which
      // routes to all three channels and survives ``shouldFanOut``.
      records.length = 0;
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('task_completed', `evt-${i}`, 't-chatty'));
      }

      const result = await handler({ Records: records });

      expect(warnCalls).toBeGreaterThan(0);
      // The 21st record (index 20) is the one that hit the cap and
      // threw via the broken warn. Everything before it succeeded
      // from the handler's perspective (``routeEvent`` short-circuits
      // on "task not found" since the shared DDB mock returns no Item).
      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: 'evt-20' },
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('successful records do NOT appear in batchItemFailures (mixed batch)', async () => {
    // Mixed batch: one record throws past routeEvent (via the same
    // rate-limit-warn trick as above but in a simpler shape — we make
    // the second record specifically trigger the throw), the other
    // routes cleanly. The response must list ONLY the failing eventID.
    const loggerModule = await import('../../src/handlers/shared/logger');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn').mockImplementation(
      (_msg: string, meta?: Record<string, unknown>) => {
        if (meta?.event === 'fanout.rate_limit.hit') {
          throw new Error('simulated broken logger');
        }
      },
    );
    try {
      // Send 21 events for 't-chatty' (trips the cap on #21 → throws)
      // preceded by ONE event for 't-ok' (dispatches cleanly).
      const records: DynamoDBRecord[] = [];
      records.push(mkEventWithId('task_completed', 'evt-ok', 't-ok'));
      for (let i = 0; i < 21; i++) {
        records.push(mkEventWithId('task_completed', `evt-chatty-${i}`, 't-chatty'));
      }
      const result = await handler({ Records: records });

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0]).toEqual({ itemIdentifier: 'evt-chatty-20' });
      // Specifically NOT the successful record.
      expect(result.batchItemFailures.map(f => f.itemIdentifier)).not.toContain('evt-ok');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('poisonous record emits a fanout.record.failed warn so operators can alarm', async () => {
    // The warn is the observability counterpart to the structured
    // retry response — operators grep CloudWatch for the event name
    // and alarm on its rate.
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
      // The underlying error message propagates into the warn so the
      // alarm can point at the root cause rather than just the fact of
      // a failure.
      expect(String(failedWarn?.meta?.error)).toContain('simulated broken logger');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('batch with zero throws returns an empty batchItemFailures array', async () => {
    // Regression guard: the structured-response shape must hold even
    // when nothing fails. Lambda's event-source-mapping treats an
    // empty array as "all records succeeded" and advances the cursor.
    const event: DynamoDBStreamEvent = {
      Records: [
        mkEvent('agent_turn'), // dropped (verbose)
        mkEvent('task_completed'), // dispatched (GitHub short-circuits on missing task)
      ],
    };
    const result = await handler(event);
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
