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
 * AG-UI ↔ semantic event translator for the CLI (mirror of
 * ``agent/src/sse_wire.py``).
 *
 * Two responsibilities:
 *
 * 1. {@link translateDbRowToAgUi} — translate a DynamoDB progress row (the
 *    shape ProgressWriter writes) into a list of AG-UI events. Used by the
 *    SSE client's catch-up callback so replayed REST data has byte-identical
 *    wire semantics to live SSE frames. Every returned event carries the
 *    DDB ``event_id`` attached as ``id`` so the SSE client's dedup + cursor
 *    advancement work correctly.
 *
 * 2. {@link agUiToSemantic} — invert AG-UI back to the semantic shape that
 *    ``cli/src/commands/watch.ts`` knows how to render. Used as the Option A
 *    formatter boundary: both SSE (live) and polling (REST) code paths call
 *    the same renderer on the *semantic* object, so output is guaranteed
 *    identical regardless of transport.
 *
 * Triad vs collapsed design choice (Step 6 deliverable):
 *
 *   For ``agent_turn`` / ``agent_tool_call`` / ``agent_milestone`` we emit the
 *   full AG-UI triad (START/CONTENT/END, START/ARGS/END, STEP_STARTED/
 *   STEP_FINISHED) rather than a single collapsed CUSTOM. This preserves the
 *   exact wire format that ``sse_wire.py`` produces on the live stream, so
 *   catch-up replay events and live events are indistinguishable to both the
 *   dedup machinery and the formatter. The cost is 3 events per semantic turn,
 *   but dedup handles duplicates cleanly and the formatter renders only on
 *   the terminal frame of each group (END / FINISHED).
 *
 * Dedup id convention: a single DDB row produces N AG-UI events. To keep
 * them dedup-distinct we suffix the row's event_id with ``:start`` / ``:content``
 * / ``:end`` / ``:args`` / ``:step-started`` / ``:step-finished``. The suffix is
 * stripped by {@link agUiToSemantic} when needed.
 */

import { AgUiEvent } from './sse-client';

/* ------------------------------------------------------------------------ */
/*  DB row ↔ AG-UI translator (mirror of agent/src/sse_wire.py)             */
/* ------------------------------------------------------------------------ */

/** The shape ProgressWriter writes to DDB. Field names mirror the Python. */
export interface TaskEventRecord {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
}

/** Synthesise a numeric ms-since-epoch stamp from an ISO-8601 timestamp.
 *  Falls back to ``0`` on parse failure rather than throwing — the consumer
 *  tolerates zero gracefully. */
function tsMs(iso: string | undefined): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/** Best-effort string coercion; empty string for null/undefined. */
function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/** Best-effort int coercion; 0 on failure. */
function asInt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Best-effort boolean coercion; ``false`` for everything except truthy. */
function asBool(value: unknown): boolean {
  return Boolean(value);
}

/**
 * Translate a single DDB progress row into a list of AG-UI events. Always
 * returns at least one event when the row's ``event_type`` is recognised;
 * unknown types return ``[]``.
 *
 * Every returned event carries ``id`` — the DDB event_id (possibly suffixed)
 * — so the SSE client advances its catch-up cursor past this row on replay.
 *
 * @param row - DDB row from TaskEventsTable (as produced by ProgressWriter).
 * @returns list of AG-UI events (may be empty for unknown event types).
 */
export function translateDbRowToAgUi(row: TaskEventRecord): AgUiEvent[] {
  const ts = tsMs(row.timestamp);
  const md = row.metadata ?? {};
  const baseId = row.event_id;

  switch (row.event_type) {
    case 'agent_turn':
      return translateAgentTurn(baseId, ts, md);
    case 'agent_tool_call':
      return translateAgentToolCall(baseId, ts, md);
    case 'agent_tool_result':
      return translateAgentToolResult(baseId, ts, md);
    case 'agent_milestone':
      return translateAgentMilestone(baseId, ts, md);
    case 'agent_cost_update':
      return translateAgentCostUpdate(baseId, ts, md);
    case 'agent_error':
      return translateAgentError(baseId, ts, md);
    default:
      return [];
  }
}

function translateAgentTurn(
  baseId: string,
  ts: number,
  md: Record<string, unknown>,
): AgUiEvent[] {
  const out: AgUiEvent[] = [];
  const turn = asInt(md.turn);
  const thinking = asString(md.thinking_preview);
  const text = asString(md.text_preview);
  const toolCallsCount = asInt(md.tool_calls_count);
  const model = asString(md.model);
  // Synthesize a stable message id derived from the DDB row so live + catch-up
  // events for the same turn would collide on messageId — reinforces dedup.
  const messageId = `${baseId}:msg`;

  if (thinking) {
    out.push({
      type: 'CUSTOM',
      timestamp: ts,
      id: `${baseId}:thinking`,
      name: 'agent_thinking',
      value: { turn, thinking },
    });
  }

  out.push({
    type: 'TEXT_MESSAGE_START',
    timestamp: ts,
    id: `${baseId}:start`,
    messageId,
    role: 'assistant',
    // Carry semantic metadata so agUiToSemantic can round-trip.
    turn,
    model,
    tool_calls_count: toolCallsCount,
    thinking_preview: thinking,
    text_preview: text,
  });

  out.push({
    type: 'TEXT_MESSAGE_CONTENT',
    timestamp: ts,
    id: `${baseId}:content`,
    messageId,
    delta: text,
  });

  // TEXT_MESSAGE_END carries the semantic metadata too so the formatter —
  // which renders on END to produce a single line per turn — has everything
  // it needs without having to correlate with an earlier frame's state.
  out.push({
    type: 'TEXT_MESSAGE_END',
    timestamp: ts,
    id: `${baseId}:end`,
    messageId,
    turn,
    model,
    tool_calls_count: toolCallsCount,
    thinking_preview: thinking,
    text_preview: text,
  });

  return out;
}

function translateAgentToolCall(
  baseId: string,
  ts: number,
  md: Record<string, unknown>,
): AgUiEvent[] {
  const toolName = asString(md.tool_name) || 'unknown';
  const toolInputPreview = asString(md.tool_input_preview);
  const turn = asInt(md.turn);
  const toolCallId = `${baseId}:call`;

  return [
    {
      type: 'TOOL_CALL_START',
      timestamp: ts,
      id: `${baseId}:start`,
      toolCallId,
      toolCallName: toolName,
      // Carry semantic metadata for round-trip.
      tool_name: toolName,
      tool_input_preview: toolInputPreview,
      turn,
    },
    {
      type: 'TOOL_CALL_ARGS',
      timestamp: ts,
      id: `${baseId}:args`,
      toolCallId,
      delta: toolInputPreview,
    },
    {
      type: 'TOOL_CALL_END',
      timestamp: ts,
      id: `${baseId}:end`,
      toolCallId,
    },
  ];
}

function translateAgentToolResult(
  baseId: string,
  ts: number,
  md: Record<string, unknown>,
): AgUiEvent[] {
  const toolName = asString(md.tool_name);
  const isError = asBool(md.is_error);
  const content = asString(md.content_preview);
  const turn = asInt(md.turn);

  const result: AgUiEvent = {
    type: 'TOOL_CALL_RESULT',
    timestamp: ts,
    id: baseId,
    // No correlated toolCallId — the receiving DDB row doesn't include one.
    // The formatter renders by tool_name which suffices for the progress UI.
    toolCallId: `${baseId}:result`,
    role: 'tool',
    content,
    tool_name: toolName,
    is_error: isError,
    turn,
  };
  if (isError) {
    (result as { error?: boolean }).error = true;
  }
  return [result];
}

function translateAgentMilestone(
  baseId: string,
  ts: number,
  md: Record<string, unknown>,
): AgUiEvent[] {
  const milestone = asString(md.milestone) || 'milestone';
  const details = asString(md.details);

  const started: AgUiEvent = {
    type: 'STEP_STARTED',
    timestamp: ts,
    id: `${baseId}:step-started`,
    stepName: milestone,
  };
  const finished: AgUiEvent = {
    type: 'STEP_FINISHED',
    timestamp: ts,
    id: `${baseId}:step-finished`,
    stepName: milestone,
    details,
  };
  return [started, finished];
}

function translateAgentCostUpdate(
  baseId: string,
  ts: number,
  md: Record<string, unknown>,
): AgUiEvent[] {
  return [{
    type: 'CUSTOM',
    timestamp: ts,
    id: baseId,
    name: 'agent_cost_update',
    value: {
      cost_usd: md.cost_usd,
      input_tokens: asInt(md.input_tokens),
      output_tokens: asInt(md.output_tokens),
      turn: asInt(md.turn),
    },
  }];
}

function translateAgentError(
  baseId: string,
  ts: number,
  md: Record<string, unknown>,
): AgUiEvent[] {
  return [{
    type: 'CUSTOM',
    timestamp: ts,
    id: baseId,
    name: 'agent_error',
    value: {
      error_type: asString(md.error_type) || 'UnknownError',
      message: asString(md.message_preview),
    },
  }];
}

/* ------------------------------------------------------------------------ */
/*  AG-UI → semantic event (Option A formatter boundary)                    */
/* ------------------------------------------------------------------------ */

/**
 * Semantic event shape used by the CLI formatter — exactly the vocabulary
 * the Phase 1a REST polling path emitted. Intentionally mirrors
 * {@link TaskEventRecord} so {@link cli/src/commands/watch.ts.renderEvent}
 * can render either source uniformly.
 */
export interface SemanticEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
}

/** ISO-8601 timestamp from ms-since-epoch (AG-UI canonical). */
function msToIso(ms: number | undefined): string {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now();
  return new Date(n).toISOString();
}

/** Strip our ``:<suffix>`` convention when deriving an event_id for the
 *  semantic shape. A single semantic event may correspond to multiple AG-UI
 *  events (triad) — we only emit the semantic form once, on the terminal
 *  frame (END / FINISHED), so all three map back to the same base id. */
function stripSuffix(id: string | undefined): string {
  if (!id) return '';
  const colon = id.lastIndexOf(':');
  if (colon < 0) return id;
  const tail = id.slice(colon + 1);
  const knownTails = new Set([
    'start', 'content', 'end', 'args', 'call', 'result',
    'step-started', 'step-finished', 'msg', 'thinking',
  ]);
  return knownTails.has(tail) ? id.slice(0, colon) : id;
}

/**
 * Convert an AG-UI event back into the semantic shape the formatter knows.
 * Returns ``null`` for frames that should not render standalone (e.g. the
 * START/CONTENT leaders of a triad — we render on END only, to avoid three
 * lines of output per turn).
 *
 * @param ev - AG-UI event from either the live SSE stream or catch-up REST.
 * @returns semantic event or ``null`` if this frame is intentionally silent.
 */
export function agUiToSemantic(ev: AgUiEvent): SemanticEvent | null {
  const t = ev.type;
  const timestamp = msToIso(typeof ev.timestamp === 'number' ? ev.timestamp : undefined);
  const idRaw = typeof ev.id === 'string' ? ev.id : '';
  const eventId = stripSuffix(idRaw);

  switch (t) {
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_CONTENT':
      // Swallow — we render on TEXT_MESSAGE_END to emit a single line per turn.
      return null;
    case 'TEXT_MESSAGE_END': {
      return {
        event_id: eventId,
        event_type: 'agent_turn',
        timestamp,
        metadata: {
          turn: asInt(ev.turn),
          model: asString(ev.model),
          tool_calls_count: asInt(ev.tool_calls_count),
          thinking_preview: asString(ev.thinking_preview),
          text_preview: asString(ev.text_preview),
        },
      };
    }
    case 'TOOL_CALL_START': {
      // Render on TOOL_CALL_START — the ARGS carry the preview already.
      return {
        event_id: eventId,
        event_type: 'agent_tool_call',
        timestamp,
        metadata: {
          tool_name: asString(ev.tool_name) || asString(ev.toolCallName) || 'unknown',
          tool_input_preview: asString(ev.tool_input_preview),
          turn: asInt(ev.turn),
        },
      };
    }
    case 'TOOL_CALL_ARGS':
    case 'TOOL_CALL_END':
      // Already rendered on TOOL_CALL_START — stay silent.
      return null;
    case 'TOOL_CALL_RESULT':
      return {
        event_id: eventId,
        event_type: 'agent_tool_result',
        timestamp,
        metadata: {
          tool_name: asString(ev.tool_name),
          is_error: asBool(ev.is_error),
          content_preview: asString(ev.content),
          turn: asInt(ev.turn),
        },
      };
    case 'STEP_STARTED':
      // Silent — render on STEP_FINISHED (it carries details).
      return null;
    case 'STEP_FINISHED':
      return {
        event_id: eventId,
        event_type: 'agent_milestone',
        timestamp,
        metadata: {
          milestone: asString(ev.stepName),
          details: asString(ev.details),
        },
      };
    case 'CUSTOM':
      return customToSemantic(ev, eventId, timestamp);
    case 'RUN_STARTED':
    case 'RUN_FINISHED':
    case 'RUN_ERROR':
      // Run-level frames are handled by the watch command directly (terminal-
      // state detection + exit code). The formatter needn't render them as
      // semantic events.
      return null;
    default:
      return null;
  }
}

/** Handle the CUSTOM family — cost / thinking / error. */
function customToSemantic(
  ev: AgUiEvent,
  eventId: string,
  timestamp: string,
): SemanticEvent | null {
  const name = asString(ev.name);
  const value = (ev.value && typeof ev.value === 'object') ? ev.value as Record<string, unknown> : {};

  if (name === 'agent_cost_update') {
    return {
      event_id: eventId,
      event_type: 'agent_cost_update',
      timestamp,
      metadata: {
        cost_usd: value.cost_usd,
        input_tokens: asInt(value.input_tokens),
        output_tokens: asInt(value.output_tokens),
        turn: asInt(value.turn),
      },
    };
  }
  if (name === 'agent_error') {
    return {
      event_id: eventId,
      event_type: 'agent_error',
      timestamp,
      metadata: {
        error_type: asString(value.error_type) || 'UnknownError',
        message_preview: asString(value.message),
      },
    };
  }
  // ``agent_thinking`` is a supplementary CUSTOM emitted alongside the triad —
  // the agent_turn rendering already includes the thinking preview, so we
  // stay silent here.
  if (name === 'agent_thinking') {
    return null;
  }
  // Unknown CUSTOM → render as a generic semantic event so users still see it.
  return {
    event_id: eventId,
    event_type: name || 'custom_event',
    timestamp,
    metadata: { ...value },
  };
}
