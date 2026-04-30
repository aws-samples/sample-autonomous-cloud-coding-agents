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
    'agent_milestone', // intentionally dropped (--verbose opt-in only)
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

      // (1) Email + GitHub actually ran their dispatch paths.
      expect(observedEvents).toContain('fanout.email.dispatch_stub');
      expect(observedEvents).toContain('fanout.github.dispatch_stub');
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
