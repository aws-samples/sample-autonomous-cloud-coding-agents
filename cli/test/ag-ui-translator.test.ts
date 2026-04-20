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

import {
  TaskEventRecord,
  agUiToSemantic,
  translateDbRowToAgUi,
} from '../src/ag-ui-translator';

const BASE_ID = '01HDDB0000ABC000000000001A';
const TS_ISO = '2026-04-18T12:34:56.000Z';
const TS_MS = Date.parse(TS_ISO);

function row(event_type: string, metadata: Record<string, unknown>): TaskEventRecord {
  return { event_id: BASE_ID, event_type, timestamp: TS_ISO, metadata };
}

/* ========================================================================= */
/*  translateDbRowToAgUi — per event type                                    */
/* ========================================================================= */

describe('translateDbRowToAgUi', () => {
  test('agent_turn produces CUSTOM(thinking) + TEXT_MESSAGE_START/CONTENT/END triad', () => {
    const result = translateDbRowToAgUi(row('agent_turn', {
      turn: 3,
      model: 'claude-sonnet-4',
      thinking_preview: 'thinking-text',
      text_preview: 'response-body',
      tool_calls_count: 2,
    }));

    // 1 CUSTOM(thinking) + 3 triad events
    expect(result).toHaveLength(4);
    expect(result.map(e => e.type)).toEqual([
      'CUSTOM',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);

    // Every event has a DDB-derived id so the SSE cursor advances.
    for (const ev of result) {
      expect(typeof ev.id).toBe('string');
      expect((ev.id as string).startsWith(BASE_ID)).toBe(true);
    }

    // Suffix distinguishes each event.
    expect(result[0].id).toBe(`${BASE_ID}:thinking`);
    expect(result[1].id).toBe(`${BASE_ID}:start`);
    expect(result[2].id).toBe(`${BASE_ID}:content`);
    expect(result[3].id).toBe(`${BASE_ID}:end`);

    // Timestamp is milliseconds (AG-UI canonical).
    for (const ev of result) {
      expect(ev.timestamp).toBe(TS_MS);
    }

    // TEXT_MESSAGE_START carries role + messageId and semantic metadata.
    expect(result[1]).toMatchObject({
      type: 'TEXT_MESSAGE_START',
      messageId: `${BASE_ID}:msg`,
      role: 'assistant',
      turn: 3,
      model: 'claude-sonnet-4',
      tool_calls_count: 2,
    });

    // TEXT_MESSAGE_CONTENT carries the delta.
    expect(result[2]).toMatchObject({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: `${BASE_ID}:msg`,
      delta: 'response-body',
    });
  });

  test('agent_turn without thinking_preview skips the CUSTOM(thinking) event', () => {
    const result = translateDbRowToAgUi(row('agent_turn', {
      turn: 1,
      model: 'claude-sonnet-4',
      text_preview: 'hello',
      tool_calls_count: 0,
    }));
    expect(result.map(e => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
  });

  test('agent_tool_call produces TOOL_CALL_START/ARGS/END triad with shared toolCallId', () => {
    const result = translateDbRowToAgUi(row('agent_tool_call', {
      tool_name: 'Bash',
      tool_input_preview: 'ls -la',
      turn: 1,
    }));

    expect(result).toHaveLength(3);
    expect(result.map(e => e.type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ]);

    // All share the same toolCallId.
    const tcids = new Set(result.map(e => e.toolCallId));
    expect(tcids.size).toBe(1);
    expect([...tcids][0]).toBe(`${BASE_ID}:call`);

    // TOOL_CALL_START has the tool name.
    expect(result[0]).toMatchObject({
      type: 'TOOL_CALL_START',
      toolCallName: 'Bash',
      tool_name: 'Bash',
      tool_input_preview: 'ls -la',
      turn: 1,
    });

    // TOOL_CALL_ARGS has delta=preview.
    expect(result[1]).toMatchObject({
      type: 'TOOL_CALL_ARGS',
      delta: 'ls -la',
    });
  });

  test('agent_tool_result produces a single TOOL_CALL_RESULT; error flag propagates', () => {
    const result = translateDbRowToAgUi(row('agent_tool_result', {
      tool_name: 'Bash',
      is_error: true,
      content_preview: 'not found',
      turn: 1,
    }));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('TOOL_CALL_RESULT');
    expect(result[0].id).toBe(BASE_ID);
    expect(result[0]).toMatchObject({
      role: 'tool',
      content: 'not found',
      tool_name: 'Bash',
      is_error: true,
      turn: 1,
      error: true,
    });
  });

  test('agent_tool_result without is_error omits the error flag', () => {
    const result = translateDbRowToAgUi(row('agent_tool_result', {
      tool_name: 'Read',
      is_error: false,
      content_preview: 'ok',
      turn: 1,
    }));
    expect(result[0].is_error).toBe(false);
    expect((result[0] as { error?: boolean }).error).toBeUndefined();
  });

  test('agent_milestone produces STEP_STARTED + STEP_FINISHED pair', () => {
    const result = translateDbRowToAgUi(row('agent_milestone', {
      milestone: 'repo_setup_complete',
      details: 'branch=feature/foo',
    }));

    expect(result).toHaveLength(2);
    expect(result.map(e => e.type)).toEqual(['STEP_STARTED', 'STEP_FINISHED']);
    expect(result[0].stepName).toBe('repo_setup_complete');
    expect(result[1].stepName).toBe('repo_setup_complete');
    expect(result[1].details).toBe('branch=feature/foo');
    expect(result[0].id).toBe(`${BASE_ID}:step-started`);
    expect(result[1].id).toBe(`${BASE_ID}:step-finished`);
  });

  test('agent_cost_update produces a single CUSTOM(agent_cost_update)', () => {
    const result = translateDbRowToAgUi(row('agent_cost_update', {
      cost_usd: 0.1234,
      input_tokens: 1000,
      output_tokens: 500,
      turn: 5,
    }));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('CUSTOM');
    expect(result[0].name).toBe('agent_cost_update');
    expect(result[0].id).toBe(BASE_ID);
    expect(result[0].value).toMatchObject({
      cost_usd: 0.1234,
      input_tokens: 1000,
      output_tokens: 500,
      turn: 5,
    });
  });

  test('agent_error produces a single CUSTOM(agent_error)', () => {
    const result = translateDbRowToAgUi(row('agent_error', {
      error_type: 'RuntimeError',
      message_preview: 'boom',
    }));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('CUSTOM');
    expect(result[0].name).toBe('agent_error');
    expect(result[0].value).toMatchObject({
      error_type: 'RuntimeError',
      message: 'boom',
    });
  });

  test('unknown event_type returns empty array', () => {
    const result = translateDbRowToAgUi(row('mystery_type', { any: 'thing' }));
    expect(result).toEqual([]);
  });

  test('every returned event carries an id derived from the DDB event_id', () => {
    // This is the critical requirement from the Step 6 brief: if the SSE
    // client doesn't see an id on catch-up events it cannot advance the
    // cursor, causing excessive re-fetching on reconnect.
    const rows: TaskEventRecord[] = [
      row('agent_turn', { turn: 1, text_preview: 'x', tool_calls_count: 0 }),
      row('agent_tool_call', { tool_name: 'Bash', tool_input_preview: 'ls', turn: 1 }),
      row('agent_tool_result', { tool_name: 'Bash', is_error: false, content_preview: 'ok', turn: 1 }),
      row('agent_milestone', { milestone: 'm1', details: 'd' }),
      row('agent_cost_update', { cost_usd: 0.01, input_tokens: 10, output_tokens: 20, turn: 1 }),
      row('agent_error', { error_type: 'E', message_preview: 'm' }),
    ];

    const allEvents = rows.flatMap(r => translateDbRowToAgUi(r));
    expect(allEvents.length).toBeGreaterThan(0);
    for (const ev of allEvents) {
      expect(typeof ev.id).toBe('string');
      expect((ev.id as string).startsWith(BASE_ID)).toBe(true);
    }
  });

  test('handles missing metadata fields gracefully (fail-open coercion)', () => {
    // Non-numeric tokens should not throw.
    const result = translateDbRowToAgUi(row('agent_cost_update', {
      cost_usd: null,
      input_tokens: 'not-a-number',
      output_tokens: undefined,
    }));
    expect(result).toHaveLength(1);
    expect(result[0].value).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});

/* ========================================================================= */
/*  agUiToSemantic — per AG-UI event type                                    */
/* ========================================================================= */

describe('agUiToSemantic', () => {
  test('TEXT_MESSAGE_START is silent (null) — rendered on END', () => {
    expect(agUiToSemantic({ type: 'TEXT_MESSAGE_START', messageId: 'm' })).toBeNull();
  });

  test('TEXT_MESSAGE_CONTENT is silent (null)', () => {
    expect(agUiToSemantic({ type: 'TEXT_MESSAGE_CONTENT', delta: 'x' })).toBeNull();
  });

  test('TEXT_MESSAGE_END renders as agent_turn and strips the :end suffix from id', () => {
    const result = agUiToSemantic({
      type: 'TEXT_MESSAGE_END',
      id: `${BASE_ID}:end`,
      timestamp: TS_MS,
      turn: 2,
      model: 'claude-sonnet-4',
      tool_calls_count: 1,
      thinking_preview: 't',
      text_preview: 'hello',
    });
    expect(result).not.toBeNull();
    expect(result?.event_id).toBe(BASE_ID);
    expect(result?.event_type).toBe('agent_turn');
    expect(result?.metadata).toMatchObject({
      turn: 2,
      model: 'claude-sonnet-4',
      tool_calls_count: 1,
      thinking_preview: 't',
      text_preview: 'hello',
    });
  });

  test('TOOL_CALL_START renders as agent_tool_call', () => {
    const result = agUiToSemantic({
      type: 'TOOL_CALL_START',
      id: `${BASE_ID}:start`,
      timestamp: TS_MS,
      toolCallName: 'Bash',
      tool_input_preview: 'ls',
      turn: 1,
    });
    expect(result?.event_type).toBe('agent_tool_call');
    expect(result?.metadata).toMatchObject({
      tool_name: 'Bash',
      tool_input_preview: 'ls',
      turn: 1,
    });
  });

  test('TOOL_CALL_ARGS and TOOL_CALL_END are silent (null)', () => {
    expect(agUiToSemantic({ type: 'TOOL_CALL_ARGS', toolCallId: 'x' })).toBeNull();
    expect(agUiToSemantic({ type: 'TOOL_CALL_END', toolCallId: 'x' })).toBeNull();
  });

  test('TOOL_CALL_RESULT renders as agent_tool_result', () => {
    const result = agUiToSemantic({
      type: 'TOOL_CALL_RESULT',
      id: BASE_ID,
      timestamp: TS_MS,
      tool_name: 'Bash',
      is_error: true,
      content: 'denied',
      turn: 1,
    });
    expect(result?.event_type).toBe('agent_tool_result');
    expect(result?.metadata).toMatchObject({
      tool_name: 'Bash',
      is_error: true,
      content_preview: 'denied',
      turn: 1,
    });
  });

  test('STEP_STARTED is silent; STEP_FINISHED renders as agent_milestone', () => {
    expect(agUiToSemantic({ type: 'STEP_STARTED', stepName: 'x' })).toBeNull();
    const result = agUiToSemantic({
      type: 'STEP_FINISHED',
      id: `${BASE_ID}:step-finished`,
      timestamp: TS_MS,
      stepName: 'repo_setup',
      details: 'branch=main',
    });
    expect(result?.event_type).toBe('agent_milestone');
    expect(result?.event_id).toBe(BASE_ID);
    expect(result?.metadata).toMatchObject({
      milestone: 'repo_setup',
      details: 'branch=main',
    });
  });

  test('CUSTOM(agent_cost_update) renders as agent_cost_update', () => {
    const result = agUiToSemantic({
      type: 'CUSTOM',
      id: BASE_ID,
      timestamp: TS_MS,
      name: 'agent_cost_update',
      value: {
        cost_usd: 0.42,
        input_tokens: 100,
        output_tokens: 50,
        turn: 4,
      },
    });
    expect(result?.event_type).toBe('agent_cost_update');
    expect(result?.metadata).toMatchObject({
      cost_usd: 0.42,
      input_tokens: 100,
      output_tokens: 50,
      turn: 4,
    });
  });

  test('CUSTOM(agent_error) renders as agent_error', () => {
    const result = agUiToSemantic({
      type: 'CUSTOM',
      id: BASE_ID,
      timestamp: TS_MS,
      name: 'agent_error',
      value: {
        error_type: 'RuntimeError',
        message: 'boom',
      },
    });
    expect(result?.event_type).toBe('agent_error');
    expect(result?.metadata).toMatchObject({
      error_type: 'RuntimeError',
      message_preview: 'boom',
    });
  });

  test('CUSTOM(agent_thinking) is silent — supplementary only', () => {
    expect(agUiToSemantic({
      type: 'CUSTOM',
      name: 'agent_thinking',
      value: { turn: 1, thinking: 't' },
    })).toBeNull();
  });

  test('RUN_STARTED / RUN_FINISHED / RUN_ERROR are silent at the formatter', () => {
    expect(agUiToSemantic({ type: 'RUN_STARTED', runId: 'r' })).toBeNull();
    expect(agUiToSemantic({ type: 'RUN_FINISHED', runId: 'r' })).toBeNull();
    expect(agUiToSemantic({ type: 'RUN_ERROR', runId: 'r', code: 'x' })).toBeNull();
  });

  test('unknown AG-UI types fall through to null', () => {
    expect(agUiToSemantic({ type: 'MYSTERY' })).toBeNull();
  });
});

/* ========================================================================= */
/*  Round-trip: DDB row → AG-UI → semantic produces the same semantic form    */
/* ========================================================================= */

describe('translateDbRowToAgUi → agUiToSemantic round-trip', () => {
  test('agent_turn round-trips — only the TEXT_MESSAGE_END emits semantic form', () => {
    const input = row('agent_turn', {
      turn: 7,
      model: 'claude-sonnet-4',
      thinking_preview: 'x',
      text_preview: 'y',
      tool_calls_count: 3,
    });
    const agUi = translateDbRowToAgUi(input);
    const semantic = agUi.map(agUiToSemantic).filter((e): e is NonNullable<typeof e> => e !== null);

    // Four AG-UI events (CUSTOM + triad) but only one semantic event (from END).
    expect(agUi.length).toBe(4);
    expect(semantic.length).toBe(1);
    expect(semantic[0].event_type).toBe('agent_turn');
    expect(semantic[0].event_id).toBe(BASE_ID);
    expect(semantic[0].metadata).toMatchObject({
      turn: 7,
      model: 'claude-sonnet-4',
      tool_calls_count: 3,
      thinking_preview: 'x',
      text_preview: 'y',
    });
  });

  test('agent_tool_call round-trips — only TOOL_CALL_START emits semantic form', () => {
    const input = row('agent_tool_call', {
      tool_name: 'Edit',
      tool_input_preview: 'path=/foo',
      turn: 2,
    });
    const agUi = translateDbRowToAgUi(input);
    const semantic = agUi.map(agUiToSemantic).filter((e): e is NonNullable<typeof e> => e !== null);

    expect(agUi.length).toBe(3);
    expect(semantic.length).toBe(1);
    expect(semantic[0].event_type).toBe('agent_tool_call');
    expect(semantic[0].metadata).toMatchObject({
      tool_name: 'Edit',
      tool_input_preview: 'path=/foo',
      turn: 2,
    });
  });

  test('agent_tool_result round-trips to a single agent_tool_result', () => {
    const input = row('agent_tool_result', {
      tool_name: 'Bash',
      is_error: false,
      content_preview: 'ok',
      turn: 3,
    });
    const agUi = translateDbRowToAgUi(input);
    const semantic = agUi.map(agUiToSemantic).filter((e): e is NonNullable<typeof e> => e !== null);
    expect(semantic).toHaveLength(1);
    expect(semantic[0].event_type).toBe('agent_tool_result');
    expect(semantic[0].event_id).toBe(BASE_ID);
  });

  test('agent_milestone round-trips — STEP_STARTED silent, STEP_FINISHED renders', () => {
    const input = row('agent_milestone', {
      milestone: 'tests_passed',
      details: '42/42',
    });
    const agUi = translateDbRowToAgUi(input);
    const semantic = agUi.map(agUiToSemantic).filter((e): e is NonNullable<typeof e> => e !== null);

    expect(agUi.length).toBe(2);
    expect(semantic.length).toBe(1);
    expect(semantic[0].event_type).toBe('agent_milestone');
    expect(semantic[0].metadata).toMatchObject({
      milestone: 'tests_passed',
      details: '42/42',
    });
  });

  test('agent_cost_update round-trips 1:1', () => {
    const input = row('agent_cost_update', {
      cost_usd: 0.01,
      input_tokens: 10,
      output_tokens: 20,
      turn: 1,
    });
    const agUi = translateDbRowToAgUi(input);
    const semantic = agUi.map(agUiToSemantic).filter((e): e is NonNullable<typeof e> => e !== null);
    expect(semantic).toHaveLength(1);
    expect(semantic[0].event_type).toBe('agent_cost_update');
    expect(semantic[0].metadata).toMatchObject({
      cost_usd: 0.01,
      input_tokens: 10,
      output_tokens: 20,
      turn: 1,
    });
  });

  test('agent_error round-trips — CUSTOM(agent_error) becomes agent_error semantic', () => {
    const input = row('agent_error', {
      error_type: 'E',
      message_preview: 'broke',
    });
    const agUi = translateDbRowToAgUi(input);
    const semantic = agUi.map(agUiToSemantic).filter((e): e is NonNullable<typeof e> => e !== null);
    expect(semantic).toHaveLength(1);
    expect(semantic[0].event_type).toBe('agent_error');
    expect(semantic[0].metadata).toMatchObject({
      error_type: 'E',
      message_preview: 'broke',
    });
  });
});
