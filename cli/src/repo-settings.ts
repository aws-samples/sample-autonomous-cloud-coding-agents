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

import { CliError } from './errors';
import type { RepoSettings } from './repo-lookup';

/** The flag of `bgagent repo onboard` that sets one column. */
interface RepoSettingFlag {
  /** The Commander flag with its placeholder. */
  readonly flag: string;
  readonly description: string;
  /** The value to store. `undefined` means that the flag was not given. Throws `CliError` on a value the column cannot hold. */
  parse(raw: string): unknown;
}

/** The value without surrounding whitespace; an empty one counts as not given. */
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
  max_budget_usd: null,
  memory_token_budget: null,
  approval_gate_cap: null,
  build_command: null,
  lint_command: null,
  system_prompt_overrides: null,
  cedar_policies: null,
  mcp_servers: null,
  cedar_policy_modules: null,
  skills: null,
};
