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

import { existsSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { CliError } from '../errors';
import { formatJson, formatReplay } from '../format';

export function makeReplayCommand(): Command {
  return new Command('replay')
    .description('Fetch an operator replay bundle for a task (events, verification, trace URI, cost, correlation ids)')
    .argument('<task-id>', 'Task ID')
    .option('--json', 'Output the raw replay JSON instead of a human-readable summary')
    .option(
      '-o, --output <file>',
      'Write the replay bundle (JSON) to <file> instead of stdout. Use --force to overwrite.',
    )
    .option('-f, --force', 'Overwrite the output file if it already exists')
    .action(async (taskId: string, opts: { json?: boolean; output?: string; force?: boolean }) => {
      // Refuse to clobber an existing --output file (mirrors `trace download`),
      // before the network round trip so the refusal is cheap.
      if (opts.output && !opts.force && existsSync(opts.output)) {
        throw new CliError(
          `Refusing to overwrite existing file ${opts.output}. Pass --force to overwrite.`,
        );
      }

      const client = new ApiClient();
      const bundle = await client.getReplay(taskId);

      // --output always writes JSON (the bundle is a machine artifact when
      // persisted); --json toggles stdout format. Writing to a file emits the
      // confirmation on stderr so stdout stays clean for piping.
      if (opts.output) {
        writeFileSync(opts.output, formatJson(bundle), { mode: 0o600 });
        console.error(`Wrote replay bundle to ${opts.output}`);
        return;
      }

      console.log(opts.json ? formatJson(bundle) : formatReplay(bundle));
    });
}
