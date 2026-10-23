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

function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "agent_tool_call" -> "Agent tool call". */
export function eventTypeLabel(eventType: string): string {
  const words = eventType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One-line, human-readable summary of an event, using the same metadata
 * fields the CLI's `status`/`watch` views read. Unknown event types fall
 * back to their scalar metadata so nothing is silently hidden.
 */
export function summarizeEvent(event: TaskEvent): string {
  const meta = event.metadata ?? {};
  switch (event.event_type) {
    case 'agent_milestone':
      return str(meta, 'milestone') ?? '';
    case 'agent_tool_call':
      return str(meta, 'tool_name') ?? 'tool';
    case 'agent_turn': {
      const turn = num(meta, 'turn');
      return turn === null ? '' : `Turn ${turn}`;
    }
    case 'agent_cost_update': {
      const cost = num(meta, 'cost_usd');
      return cost === null ? '' : `$${cost.toFixed(2)} so far`;
    }
    case 'agent_blocked': {
      const parts = [str(meta, 'kind') ?? 'blocked'];
      const resource = str(meta, 'resource');
      const hint = str(meta, 'remediation_hint');
      if (resource) parts.push(`[${resource}]`);
      if (hint) parts.push(`- ${hint}`);
      return parts.join(' ');
    }
    default: {
      const preferred = str(meta, 'reason') ?? str(meta, 'error') ?? str(meta, 'message') ?? str(meta, 'pr_url');
      if (preferred) return preferred;
      return Object.entries(meta)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');
    }
  }
}
