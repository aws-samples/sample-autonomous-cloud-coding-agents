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

const MAX_PAGES = 100;

export function makeEventsCommand(): Command {
  return new Command('events')
    .description('Get task events')
    .argument('<task-id>', 'Task ID')
    .option(
      '--limit <n>',
      'Max events to return. With --all: total cap across pages; '
      + 'without --all: single-page size (server-capped at its page maximum)',
      parseInt,
    )
    .option('--all', 'Drain all pages of events (follows next_token)')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (taskId: string, opts) => {
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
          if (pagination.has_more) {
            console.error(
              `\n(Stopped after ${MAX_PAGES} pages — more events exist. `
              + 'Use --output json to get a resume token.)',
            );
          }
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
      return {
        events: events.slice(0, limit),
        pagination: { has_more: false, next_token: null },
      };
    }
    if (!result.pagination.has_more || !result.pagination.next_token) {
      return { events, pagination };
    }
    nextToken = result.pagination.next_token;
  }

  return { events, pagination };
}
