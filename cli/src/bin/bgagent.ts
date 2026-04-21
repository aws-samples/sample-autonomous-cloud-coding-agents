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
import { makeRunCommand } from '../commands/run';
import { makeStatusCommand } from '../commands/status';
import { makeSubmitCommand } from '../commands/submit';
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
program.addCommand(makeRunCommand());
program.addCommand(makeListCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeCancelCommand());
program.addCommand(makeEventsCommand());
program.addCommand(makeWatchCommand());
program.addCommand(makeWebhookCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CliError || err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error('An unexpected error occurred.');
  }
  process.exitCode = 1;
});
