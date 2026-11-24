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
import { ApiError, CliError } from '../errors';
import { formatJson } from '../format';
import { formatScoreboard } from '../scoreboard';
import type { Scoreboard, ScoreboardRange } from '../types';

/** The periods the API serves a scoreboard for. */
const RANGES: readonly ScoreboardRange[] = ['7d', '30d'];

/**
 * What the command says of a stack that was deployed before the scoreboard. Such a stack refuses
 * the view, in words about a parameter nobody typed; one from before `view` existed ignores it
 * and answers with a page of tasks.
 */
const OLDER_STACK = 'This stack does not serve the scoreboard: it was deployed before `bgagent stats` existed.'
  + ' Redeploy the stack, then run the command again.';

/**
 * `bgagent stats [--range 7d|30d] [--repo owner/repo] [--output text|json]`: the factory
 * scoreboard of the caller's own finished tasks, with the numbers of the console's
 * Scoreboard page.
 */
export function makeStatsCommand(): Command {
  return new Command('stats')
    .description('Show the scoreboard of your finished tasks: speed, quality, leverage and trust, up to the merge')
    .option('--range <range>', `Period the scoreboard covers: ${RANGES.join(' or ')}`, '30d')
    .option('--repo <owner/repo>', 'Count the tasks of one repository only')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .addHelpText(
      'after',
      '\nThe numbers are those of the Scoreboard page of the console, over your own tasks. What each one\n'
      + 'counts and what it leaves out: docs/design/OBSERVABILITY.md, "Factory scoreboard".\n'
      + '\nExamples:\n'
      + '  $ bgagent stats\n'
      + '  $ bgagent stats --range 7d --repo owner/repo\n'
      + '  $ bgagent stats --output json',
    )
    .action(async (opts) => {
      const range = RANGES.find((known) => known === opts.range);
      if (!range) throw new CliError(`--range must be ${RANGES.join(' or ')}.`);

      let board: Scoreboard;
      try {
        board = await new ApiClient().getScoreboard({ range, repo: opts.repo });
      } catch (err) {
        if (err instanceof ApiError && err.message.startsWith('Invalid view value')) throw new CliError(OLDER_STACK);
        throw err;
      }
      // Before anything is printed: `--output json` would print the page of tasks as if it were the scoreboard.
      if (!board?.current) throw new CliError(OLDER_STACK);
      console.log(opts.output === 'json' ? formatJson(board) : formatScoreboard(board, opts.repo));
    });
}
