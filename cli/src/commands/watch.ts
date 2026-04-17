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

import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { formatJson } from '../format';
import { TERMINAL_STATUSES, TaskEvent } from '../types';

const POLL_INTERVAL_MS = 2_000;

/** Progress event types emitted by the agent ProgressWriter. */
const PROGRESS_EVENT_TYPES = new Set([
  'agent_turn',
  'agent_tool_call',
  'agent_tool_result',
  'agent_milestone',
  'agent_cost_update',
  'agent_error',
]);

/** Format an event timestamp to a short local time string. */
function formatTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleTimeString();
  } catch {
    return isoTimestamp;
  }
}

/** Render a single progress event as a human-readable line. */
export function renderEvent(event: TaskEvent): string {
  const time = formatTime(event.timestamp);
  const meta = event.metadata;

  switch (event.event_type) {
    case 'agent_turn': {
      const turn = meta.turn ?? '?';
      const model = meta.model ?? '';
      const tools = meta.tool_calls_count ?? 0;
      let line = `[${time}] Turn #${turn} (${model}, ${tools} tool call${tools === 1 ? '' : 's'})`;
      if (meta.thinking_preview) {
        line += `\n         Thinking: ${meta.thinking_preview}`;
      }
      if (meta.text_preview) {
        line += `\n         Text: ${meta.text_preview}`;
      }
      return line;
    }
    case 'agent_tool_call': {
      const tool = meta.tool_name ?? 'unknown';
      const preview = meta.tool_input_preview ?? '';
      return `[${time}]   ▶ ${tool}: ${preview}`;
    }
    case 'agent_tool_result': {
      const tool = meta.tool_name ?? '';
      const isError = meta.is_error ? ' [ERROR]' : '';
      const preview = meta.content_preview ?? '';
      return `[${time}]   ◀ ${tool}${isError}: ${preview}`;
    }
    case 'agent_milestone': {
      const milestone = meta.milestone ?? '';
      const details = meta.details ?? '';
      return `[${time}] ★ ${milestone}${details ? ': ' + details : ''}`;
    }
    case 'agent_cost_update': {
      const cost = meta.cost_usd != null ? `$${Number(meta.cost_usd).toFixed(4)}` : '$?';
      const input = meta.input_tokens ?? 0;
      const output = meta.output_tokens ?? 0;
      return `[${time}] Cost: ${cost} (${input} in / ${output} out tokens)`;
    }
    case 'agent_error': {
      const errType = meta.error_type ?? 'Error';
      const msg = meta.message_preview ?? '';
      return `[${time}] ✖ ${errType}: ${msg}`;
    }
    default:
      return `[${time}] ${event.event_type}: ${JSON.stringify(meta)}`;
  }
}

export function makeWatchCommand(): Command {
  return new Command('watch')
    .description('Watch task progress in real-time')
    .argument('<task-id>', 'Task ID')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (taskId: string, opts) => {
      const client = new ApiClient();
      const isJson = opts.output === 'json';

      // Track last seen event_id to avoid re-displaying events
      let lastSeenEventId: string | null = null;
      let aborted = false;

      // Handle Ctrl+C for clean exit
      const onSignal = (): void => {
        aborted = true;
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      try {
        if (!isJson) {
          process.stderr.write(`Watching task ${taskId}... (Ctrl+C to stop)\n`);
        }

        while (!aborted) {
          // Fetch events
          const result = await client.getTaskEvents(taskId, { limit: 100 });
          const events = result.data;

          // Filter to only new events (after lastSeenEventId)
          const lastSeen = lastSeenEventId;
          const newEvents: TaskEvent[] = lastSeen
            ? events.filter(e => e.event_id > lastSeen)
            : events;

          if (newEvents.length > 0) {
            lastSeenEventId = newEvents[newEvents.length - 1].event_id;

            if (isJson) {
              for (const event of newEvents) {
                console.log(formatJson(event));
              }
            } else {
              for (const event of newEvents) {
                if (PROGRESS_EVENT_TYPES.has(event.event_type)) {
                  console.log(renderEvent(event));
                }
              }
            }
          }

          // Check if task has reached terminal state
          const task = await client.getTask(taskId);
          if ((TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
            if (!isJson) {
              process.stderr.write(`\nTask ${task.status.toLowerCase()}.\n`);
            }
            process.exitCode = task.status === 'COMPLETED' ? 0 : 1;
            break;
          }

          await sleep(POLL_INTERVAL_MS);
        }
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
