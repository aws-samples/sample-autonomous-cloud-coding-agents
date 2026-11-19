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

import type { TaskEvent } from '../api/types';
import { isCutOff, parseToolInput } from './tool-input';

/**
 * Groups the agent's events into turns, the unit `max_turns` counts.
 *
 * In a turn the model answers once: it may think, say something, and ask for
 * tools; the tools' results go back to it in the next turn. The agent writes
 * one `agent_turn` event per message, and a single answer arrives as several
 * messages (thinking, then text, then tool use), so a new turn starts at the
 * first message after one that asked for tools. Counted this way, a finished
 * task's turns match the `turns_completed` the platform reports.
 */

export interface ToolStep {
  /** The `agent_tool_call` event id. */
  readonly id: string;
  readonly at: string;
  readonly turn: number;
  readonly tool: string;
  /** Arguments decoded from the preview; see `inputCutOff`. */
  readonly input: Readonly<Record<string, string>>;
  /** The raw preview, for inputs that are not a readable dict. */
  readonly rawInput: string | null;
  readonly inputCutOff: boolean;
  readonly output: string | null;
  readonly outputCutOff: boolean;
  readonly isError: boolean;
}

export interface Turn {
  readonly number: number;
  readonly at: string;
  readonly said: string | null;
  readonly thinking: string | null;
  readonly tools: readonly ToolStep[];
}

const CUT_MARKER = '...';

function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function joined(a: string | null, b: string | null): string | null {
  return a && b ? `${a}\n\n${b}` : a ?? b;
}

interface Draft {
  number: number;
  at: string;
  said: string | null;
  thinking: string | null;
  tools: Array<Omit<ToolStep, 'output' | 'outputCutOff' | 'isError'> & { output: string | null; outputCutOff: boolean; isError: boolean }>;
}

/** Turns in order, oldest first. Accepts events in any order; non-agent events are ignored. */
export function buildTurns(events: readonly TaskEvent[]): Turn[] {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
  const turns: Draft[] = [];
  const current = (at: string): Draft => {
    const last = turns.at(-1);
    if (last) return last;
    const first: Draft = { number: 1, at, said: null, thinking: null, tools: [] };
    turns.push(first);
    return first;
  };

  for (const event of ordered) {
    const meta = event.metadata ?? {};
    if (event.event_type === 'agent_turn') {
      const last = turns.at(-1);
      let turn = current(event.timestamp);
      if (last && last.tools.length > 0) {
        // The answer before asked for tools, so this message starts the next turn.
        turn = { number: last.number + 1, at: event.timestamp, said: null, thinking: null, tools: [] };
        turns.push(turn);
      }
      turn.said = joined(turn.said, str(meta, 'text_preview'));
      turn.thinking = joined(turn.thinking, str(meta, 'thinking_preview'));
    } else if (event.event_type === 'agent_tool_call') {
      const turn = current(event.timestamp);
      const raw = str(meta, 'tool_input_preview');
      const input = parseToolInput(raw);
      turn.tools.push({
        id: event.event_id,
        at: event.timestamp,
        turn: turn.number,
        tool: str(meta, 'tool_name') ?? 'tool',
        input: input.fields,
        rawInput: raw,
        inputCutOff: input.cutOff,
        output: null,
        outputCutOff: false,
        isError: false,
      });
    } else if (event.event_type === 'agent_tool_result') {
      const tool = str(meta, 'tool_name');
      // Results come back in call order, right after their turn: pair each with the
      // oldest unanswered call of the same tool in the latest turn that has one.
      const matches = (s: Draft['tools'][number]) => s.output === null && (!tool || s.tool === tool);
      const open = [...turns].reverse().find((t) => t.tools.some(matches))?.tools.find(matches);
      if (!open) continue;
      const content = typeof meta.content_preview === 'string' ? meta.content_preview : '';
      const cut = isCutOff(content);
      open.output = cut ? content.slice(0, -CUT_MARKER.length) : content;
      open.outputCutOff = cut;
      open.isError = meta.is_error === true;
    }
  }
  return turns;
}

/** Tool steps by their `agent_tool_call` event id. */
export function stepsById(turns: readonly Turn[]): ReadonlyMap<string, ToolStep> {
  return new Map(turns.flatMap((t) => t.tools.map((s) => [s.id, s] as const)));
}
