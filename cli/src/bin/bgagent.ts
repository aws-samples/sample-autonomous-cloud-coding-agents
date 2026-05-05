#!/usr/bin/env node

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
import { makeCancelCommand } from '../commands/cancel';
import { makeConfigureCommand } from '../commands/configure';
import { makeEventsCommand } from '../commands/events';
import { makeListCommand } from '../commands/list';
import { makeLoginCommand } from '../commands/login';
import { makeNudgeCommand } from '../commands/nudge';
import { makeStatusCommand } from '../commands/status';
import { makeSubmitCommand } from '../commands/submit';
import { makeTraceCommand } from '../commands/trace';
import { makeWatchCommand } from '../commands/watch';
import { makeWebhookCommand } from '../commands/webhook';
import { setVerbose } from '../debug';
import { ApiError, CliError } from '../errors';

const program = new Command();

program
  .name('bgagent')
  .description('Background Agent CLI — submit and manage coding tasks')
  .version('0.0.0')
  .option('--verbose', 'Enable debug output')
  .hook('preAction', (_thisCommand, actionCommand) => {
    // Resolve --verbose from the root program, not the subcommand
    const rootOpts = actionCommand.parent?.opts() ?? actionCommand.opts();
    if (rootOpts.verbose) {
      setVerbose(true);
    }
  });

program.addCommand(makeConfigureCommand());
program.addCommand(makeLoginCommand());
program.addCommand(makeSubmitCommand());
program.addCommand(makeListCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeCancelCommand());
program.addCommand(makeNudgeCommand());
program.addCommand(makeEventsCommand());
program.addCommand(makeWatchCommand());
program.addCommand(makeTraceCommand());
program.addCommand(makeWebhookCommand());

// Execute the CLI only when run directly. Importing this module (e.g.
// from a test harness or a wrapper) must not parse the importer's
// ``process.argv`` nor schedule a ``process.exit`` on the importer's
// event loop. Keeping the side-effect behind ``require.main === module``
// preserves both properties without forcing callers to mock the
// program object. Commands under ``cli/src/commands/*`` already export
// ``makeXxxCommand()`` factories for direct invocation in tests.
if (require.main === module) {
  program
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      if (err instanceof CliError || err instanceof ApiError) {
        console.error(`Error: ${err.message}`);
      } else if (err instanceof Error) {
        console.error(`Error: ${err.message}`);
      } else {
        console.error('An unexpected error occurred.');
      }
      process.exitCode = 1;
    })
    .finally(() => {
      // Node's global ``fetch`` (undici) keeps TCP sockets alive in a
      // connection pool by default. After a long-running command like
      // ``bgagent watch`` finishes its logical work, those sockets keep
      // the event loop open for the pool's idle timeout, leaving the
      // process hanging long past task terminal. We set ``exitCode``
      // (so the natural drain path uses it) and schedule a deferred
      // ``process.exit`` as a fallback: an ``unref``'d 50 ms timer
      // gives async ``stderr`` / ``stdout`` flushes and ``on('exit')``
      // handlers a chance to complete, while still guaranteeing a
      // bounded exit time instead of the pool's multi-second
      // keep-alive timeout. Observed in Scenarios 6 and 7-extended
      // deploy validation where ``bgagent watch`` had to be ``pkill``-ed
      // after the task reached COMPLETED.
      setTimeout(() => {
        process.exit(process.exitCode ?? 0);
      }, 50).unref();
    });
}
