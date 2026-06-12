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
import { CliError } from '../errors';
import { formatEvents, formatJson } from '../format';
import { Pagination, TaskEvent } from '../types';

/** Defensive cap on pagination drains with ``--all`` so a runaway/looping
 *  ``next_token`` cannot spin forever. At 100 events/page this covers 10k
 *  events — far beyond any real task's event stream. */
const MAX_PAGES = 100;

export function makeEventsCommand(): Command {
  return new Command('events')
    .description('Get task events')
    .argument('<task-id>', 'Task ID')
    .option('--limit <n>', 'Max total number of events to return', parseInt)
    .option('--all', 'Drain all pages of events (follows next_token)')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (taskId: string, opts) => {
      // Validate --limit as a positive integer (mirrors submit.ts numeric-flag
      // validation) rather than silently forwarding NaN / a negative.
      if (opts.limit !== undefined) {
        if (isNaN(opts.limit) || !Number.isInteger(opts.limit) || opts.limit < 1) {
          throw new CliError('--limit must be a positive integer.');
        }
      }

      const client = new ApiClient();

      if (opts.all) {
        const { events, pagination } = await drainAllEvents(client, taskId, opts.limit);
        if (opts.output === 'json') {
          console.log(formatJson({ data: events, pagination }));
        } else {
          console.log(formatEvents(events));
        }
        return;
      }

      const result = await client.getTaskEvents(taskId, {
        limit: opts.limit,
      });

      if (opts.output === 'json') {
        console.log(formatJson(result));
      } else {
        console.log(formatEvents(result.data));
        if (result.pagination.has_more) {
          console.log('\n(More events available)');
        }
      }
    });
}

/** Follow ``next_token`` until the server reports no more pages, the
 *  defensive ``MAX_PAGES`` cap trips, or ``limit`` total events have been
 *  collected. ``limit`` means the same thing on both command paths — a cap
 *  on the TOTAL events returned — so it is enforced here client-side
 *  rather than forwarded as a per-page size (the server's ``limit`` param
 *  is a page size, which would make ``--all --limit 5`` return everything
 *  in 5-event pages). Returns the concatenated events and the final page's
 *  pagination (``has_more=false`` on a clean full drain). */
async function drainAllEvents(
  client: ApiClient,
  taskId: string,
  limit?: number,
): Promise<{ events: TaskEvent[]; pagination: Pagination }> {
  const events: TaskEvent[] = [];
  let nextToken: string | undefined;
  let pagination: Pagination = { next_token: null, has_more: false };

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.getTaskEvents(taskId, { nextToken });
    events.push(...result.data);
    pagination = result.pagination;
    if (limit !== undefined && events.length >= limit) {
      return { events: events.slice(0, limit), pagination };
    }
    if (!result.pagination.has_more || !result.pagination.next_token) {
      return { events, pagination };
    }
    nextToken = result.pagination.next_token;
  }

  return { events, pagination };
}
