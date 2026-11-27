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

import * as fs from 'fs';
import { CliError } from './errors';
import type { RepoSettings } from './repo-lookup';
import { APPROVAL_GATE_CAP_MAX, APPROVAL_GATE_CAP_MIN, MAX_BUDGET_USD_MAX, MAX_BUDGET_USD_MIN } from './types';

/** The largest UTF-8 size of a setting whose text comes from a file: 64 KB. The row, a DynamoDB item, holds at most 400 KB. */
const REPO_TEXT_MAX_BYTES = 65536;

/** The flag of `bgagent repo onboard` that sets one column. */
interface RepoSettingFlag {
  /** The Commander flag with its placeholder. */
  readonly flag: string;
  readonly description: string;
  /** The largest UTF-8 size of the value, in bytes. */
  readonly maxBytes?: number;
  /** The value to store; `undefined` for an empty one, which the command refuses. Throws `CliError` on a value the column cannot hold. */
  parse(raw: string): unknown;
}

/** The text without surrounding whitespace; `undefined` when nothing is left. */
function trimmed(raw: string): string | undefined {
  return raw.trim() || undefined;
}

/**
 * A whole number written in digits only. A sign, a fraction, an exponent, a radix prefix or trailing text
 * gives `undefined`, and so does a number too large to be stored exactly.
 */
function wholeNumber(raw: string): number | undefined {
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The per-repo columns of RepoTable that `bgagent repo onboard` sets or removes, each with the flag that sets it.
 * `null`: the column has no flag, so the command can only remove it (`--unset`).
 * The order is the one of the flags in the help, of the names `--unset` lists and of the settings `repo show` lists after its fixed lines.
 */
export const REPO_SETTINGS: Readonly<Record<keyof RepoSettings, RepoSettingFlag | null>> = {
  compute_type: {
    flag: '--compute-type <type>',
    description: 'Compute substrate: agentcore, ecs, or lambda-microvm',
    parse: (raw) => {
      const type = raw.trim();
      if (!['agentcore', 'ecs', 'lambda-microvm'].includes(type)) {
        throw new CliError("--compute-type must be 'agentcore', 'ecs', or 'lambda-microvm'.");
      }
      return type;
    },
  },
  runtime_arn: { flag: '--runtime-arn <arn>', description: 'Override AgentCore runtime ARN (agentcore only)', parse: trimmed },
  model_id: { flag: '--model <model-id>', description: 'Foundation model ID override', parse: trimmed },
  github_token_secret_arn: { flag: '--token-secret-arn <arn>', description: 'Per-repo GitHub token Secrets Manager ARN', parse: trimmed },
  max_turns: {
    flag: '--max-turns <n>',
    description: 'Default max turns for tasks (1-500)',
    parse: (raw) => {
      const turns = wholeNumber(raw);
      if (turns === undefined || turns < 1 || turns > 500) {
        throw new CliError('--max-turns must be an integer between 1 and 500 (use --unset max_turns for the platform default).');
      }
      return turns;
    },
  },
  poll_interval_ms: {
    flag: '--poll-interval <ms>',
    description: 'Default agent poll interval in milliseconds',
    parse: (raw) => {
      const interval = wholeNumber(raw);
      if (interval === undefined) {
        throw new CliError('--poll-interval must be a whole number of milliseconds.');
      }
      return interval;
    },
  },
  max_budget_usd: {
    flag: '--max-budget <usd>',
    description: `Default cost budget for tasks in USD (${MAX_BUDGET_USD_MIN}-${MAX_BUDGET_USD_MAX})`,
    parse: (raw) => {
      const budget = /^[0-9]+([.][0-9]+)?$/.test(raw) ? Number(raw) : undefined;
      if (budget === undefined || budget < MAX_BUDGET_USD_MIN || budget > MAX_BUDGET_USD_MAX) {
        throw new CliError(
          `--max-budget must be a number between ${MAX_BUDGET_USD_MIN} and ${MAX_BUDGET_USD_MAX} (use --unset max_budget_usd to remove the budget).`,
        );
      }
      return budget;
    },
  },
  memory_token_budget: {
    flag: '--memory-token-budget <tokens>',
    description: 'Token budget for the memory context of tasks',
    parse: (raw) => {
      const budget = wholeNumber(raw);
      if (budget === undefined || budget < 1) {
        throw new CliError(
          `--memory-token-budget must be an integer between 1 and ${Number.MAX_SAFE_INTEGER} (use --unset memory_token_budget for the platform default).`,
        );
      }
      return budget;
    },
  },
  approval_gate_cap: {
    flag: '--approval-gate-cap <n>',
    description: `Cap on the approval gates of a task (${APPROVAL_GATE_CAP_MIN}-${APPROVAL_GATE_CAP_MAX})`,
    parse: (raw) => {
      const cap = wholeNumber(raw);
      if (cap === undefined || cap < APPROVAL_GATE_CAP_MIN || cap > APPROVAL_GATE_CAP_MAX) {
        throw new CliError(
          `--approval-gate-cap must be an integer between ${APPROVAL_GATE_CAP_MIN} and ${APPROVAL_GATE_CAP_MAX} `
          + '(use --unset approval_gate_cap for the platform default).',
        );
      }
      return cap;
    },
  },
  build_command: { flag: '--build-command <command>', description: 'Command the agent runs to build and verify the repository', parse: trimmed },
  lint_command: { flag: '--lint-command <command>', description: 'Command the agent runs to lint the repository', parse: trimmed },
  system_prompt_overrides: {
    flag: '--system-prompt-file <path>',
    description: `File with additional system prompt instructions for tasks (UTF-8, at most ${REPO_TEXT_MAX_BYTES / 1024} KB)`,
    maxBytes: REPO_TEXT_MAX_BYTES,
    parse: (file) => {
      try {
        // fatal: a file that is not UTF-8 is refused, not stored with replacement characters.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
        // A task cannot start with a NUL in its prompt. ASCII text saved as UTF-16 without a byte order mark decodes with one per character.
        if (text.includes('\0')) throw new Error('the file holds a NUL character (UTF-16 or binary?)');
        return trimmed(text);
      } catch (err) {
        throw new CliError(`Cannot read --system-prompt-file '${file}': ${(err as Error).message}`);
      }
    },
  },
  cedar_policies: null,
  mcp_servers: null,
  cedar_policy_modules: null,
  skills: null,
};
