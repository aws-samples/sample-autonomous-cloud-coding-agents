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
import { makeAdminCommand } from '../commands/admin';
import { makeApiKeyCommand } from '../commands/api-key';
import { makeApproveCommand } from '../commands/approve';
import { makeBudgetCommand } from '../commands/budget';
import { makeCancelCommand } from '../commands/cancel';
import { makeChangePasswordCommand } from '../commands/change-password';
import { makeConfigureCommand } from '../commands/configure';
import { makeDenyCommand } from '../commands/deny';
import { makeEventsCommand } from '../commands/events';
import { makeGithubCommand } from '../commands/github';
import { makeJiraCommand } from '../commands/jira';
import { makeLinearCommand } from '../commands/linear';
import { makeListCommand } from '../commands/list';
import { makeLoginCommand } from '../commands/login';
import { makeNudgeCommand } from '../commands/nudge';
import { makeOpsCommand } from '../commands/ops';
import { makePendingCommand } from '../commands/pending';
import { makePlatformCommand } from '../commands/platform';
import { makePoliciesCommand } from '../commands/policies';
import { makeRegistryCommand } from '../commands/registry';
import { makeReplayCommand } from '../commands/replay';
import { makeRepoCommand } from '../commands/repo';
import { makeRuntimeCommand } from '../commands/runtime';
import { makeSetupCommand } from '../commands/setup';
import { makeSlackCommand } from '../commands/slack';
import { makeStatsCommand } from '../commands/stats';
import { makeStatusCommand } from '../commands/status';
import { makeSubmitCommand } from '../commands/submit';
import { makeTraceCommand } from '../commands/trace';
import { makeWatchCommand } from '../commands/watch';
import { makeWebhookCommand } from '../commands/webhook';
import { setVerbose } from '../debug';
import { CliError } from '../errors';
import { applyDefaultAppId } from '../ua';

const program = new Command();

program
  .name('bgagent')
  .description('Background Agent CLI — submit and manage coding tasks')
  .version('0.0.0')
  .option('--verbose', 'Enable debug output')
  .hook('preAction', (thisCommand) => {
    // thisCommand is the root program, which owns --verbose, whatever subcommand runs
    if (thisCommand.opts().verbose) {
      setVerbose(true);
    }
  });

program.addCommand(makeSetupCommand());
program.addCommand(makeConfigureCommand());
program.addCommand(makeLoginCommand());
program.addCommand(makeChangePasswordCommand());
program.addCommand(makeSubmitCommand());
program.addCommand(makeListCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeReplayCommand());
program.addCommand(makeCancelCommand());
program.addCommand(makeNudgeCommand());
program.addCommand(makeApproveCommand());
program.addCommand(makeDenyCommand());
program.addCommand(makePendingCommand());
program.addCommand(makeBudgetCommand());
program.addCommand(makeStatsCommand());
program.addCommand(makePoliciesCommand());
program.addCommand(makeEventsCommand());
program.addCommand(makeSlackCommand());
program.addCommand(makeLinearCommand());
program.addCommand(makeJiraCommand());
program.addCommand(makeGithubCommand());
program.addCommand(makePlatformCommand());
program.addCommand(makeRepoCommand());
program.addCommand(makeRuntimeCommand());
program.addCommand(makeOpsCommand());
program.addCommand(makeWatchCommand());
program.addCommand(makeTraceCommand());
program.addCommand(makeWebhookCommand());
program.addCommand(makeApiKeyCommand());
program.addCommand(makeAdminCommand());
program.addCommand(makeRegistryCommand());

/**
 * Parse ``argv`` and run the command it names. A failure is reported on
 * stderr and sets ``process.exitCode``; the returned promise never rejects.
 */
export async function run(argv: string[]): Promise<void> {
  await program
    .parseAsync(argv)
    .catch((err: unknown) => {
      if (err instanceof Error) {
        console.error(`Error: ${err.message}`);
      } else {
        console.error('An unexpected error occurred.');
      }
      process.exitCode = err instanceof CliError ? err.exitCode : 1;
    });
}

if (require.main === module) {
  applyDefaultAppId();
  void run(process.argv)
    .finally(() => {
      const EXIT_FLUSH_DELAY_MS = 50;
      setTimeout(() => {
        process.exit(process.exitCode ?? 0);
      }, EXIT_FLUSH_DELAY_MS).unref();
    });
}
