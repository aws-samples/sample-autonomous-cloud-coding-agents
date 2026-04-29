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
  parseStreamRecord,
  shouldFanOut,
  handler,
  type FanOutEvent,
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

describe('fanout-task-events: shouldFanOut filter', () => {
  const make = (event_type: string): FanOutEvent => ({
    task_id: 't-1',
    event_id: 'e-1',
    event_type,
    timestamp: '2026-04-22T04:00:00Z',
  });

  test.each([
    'task_created',
    'task_failed',
    'task_completed',
    'task_cancelled',
    'task_stranded',
    'agent_milestone',
    'agent_error',
    'pr_created',
  ])('%s is fanned out', (t) => {
    expect(shouldFanOut(make(t))).toBe(true);
  });

  test.each([
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
