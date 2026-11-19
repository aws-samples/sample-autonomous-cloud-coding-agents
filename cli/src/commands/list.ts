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
import { followPages, formatJson, formatTaskList } from '../format';

/**
 * Requests one `list` sends at most. `list --status RUNNING` rarely fills a page, so over a long history every call
 * sends them all: 5 keeps a call every two seconds under the 1,000 requests in five minutes the API allows one address.
 */
const MAX_LIST_REQUESTS = 5;

export function makeListCommand(): Command {
  return new Command('list')
    .description('List tasks')
    .option('--status <statuses>', 'Filter by status (comma-separated)')
    .option('--repo <owner/repo>', 'Filter by repository')
    .option('--limit <n>', 'Max number of tasks to return', parseInt)
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      const client = new ApiClient();
      const result = await followPages(
        await client.listTasks({ status: opts.status, repo: opts.repo, limit: opts.limit }),
        opts.limit,
        (limit, nextToken) => client.listTasks({ status: opts.status, repo: opts.repo, limit, nextToken }),
        MAX_LIST_REQUESTS,
      );

      if (opts.output === 'json') {
        console.log(formatJson(result));
      } else {
        console.log(formatTaskList(result.data));
        if (result.pagination.has_more) {
          console.log('\n(More results available)');
        }
      }
    });
}
