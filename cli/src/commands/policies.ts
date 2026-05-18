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
import type { GetPoliciesResponse, PolicyRuleSummary } from '../types';

/**
 * `bgagent policies list --repo <owner/repo> [--tier hard|soft]` — list
 * the Cedar rules that apply to a repository (design §8.1).
 * `bgagent policies show --repo <owner/repo> --rule <rule_id>` —
 * show a single rule's detail.
 */
export function makePoliciesCommand(): Command {
  const cmd = new Command('policies').description('Discover Cedar HITL policies for a repository');

  cmd.command('list')
    .description('List Cedar HITL rules that apply to a repository')
    .requiredOption('--repo <repo>', 'Repository ID (owner/repo)')
    .option('--tier <tier>', 'Filter by tier (hard or soft)')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      const tier = opts.tier as 'hard' | 'soft' | undefined;
      if (tier && tier !== 'hard' && tier !== 'soft') {
        throw new CliError('--tier must be "hard" or "soft".');
      }
      const client = new ApiClient();
      let result: GetPoliciesResponse;
      try {
        result = await client.listPolicies(opts.repo as string);
      } catch (err) {
        if (err instanceof ApiError) throw mapPoliciesError(err);
        throw err;
      }

      if (opts.output === 'json') {
        const filtered = tier
          ? { ...result, policies: { hard: tier === 'hard' ? result.policies.hard : [], soft: tier === 'soft' ? result.policies.soft : [] } }
          : result;
        console.log(formatJson(filtered));
        return;
      }

      if (!tier || tier === 'hard') {
        console.log('Hard-deny rules (absolute; --pre-approve cannot bypass):');
        renderRules(result.policies.hard);
        console.log();
      }
      if (!tier || tier === 'soft') {
        console.log('Soft-deny rules (require approval; pre-approve with --pre-approve rule:<id>):');
        renderRules(result.policies.soft);
      }
    });

  cmd.command('show')
    .description('Show a specific Cedar rule')
    .requiredOption('--repo <repo>', 'Repository ID (owner/repo)')
    .requiredOption('--rule <rule_id>', 'Rule ID to show')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      const client = new ApiClient();
      let result: GetPoliciesResponse;
      try {
        result = await client.listPolicies(opts.repo as string);
      } catch (err) {
        if (err instanceof ApiError) throw mapPoliciesError(err);
        throw err;
      }
      const ruleId = String(opts.rule);
      const found = result.policies.hard.find((r) => r.rule_id === ruleId)
        ?? result.policies.soft.find((r) => r.rule_id === ruleId);
      if (!found) {
        throw new CliError(
          `Rule "${ruleId}" not found for repo ${opts.repo}. Use \`bgagent policies list\` to see available rules.`,
        );
      }
      if (opts.output === 'json') {
        console.log(formatJson(found));
        return;
      }
      console.log(`rule_id:             ${found.rule_id}`);
      const tier = result.policies.hard.some((r) => r.rule_id === ruleId) ? 'hard' : 'soft';
      console.log(`tier:                ${tier}`);
      if (found.severity) console.log(`severity:            ${found.severity}`);
      if (found.approval_timeout_s) {
        console.log(`approval_timeout_s:  ${found.approval_timeout_s}`);
      }
      if (found.category) console.log(`category:            ${found.category}`);
      console.log(`summary:             ${found.summary}`);
    });

  return cmd;
}

function renderRules(rules: readonly PolicyRuleSummary[]): void {
  if (rules.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rules) {
    const severity = r.severity ? `  severity=${r.severity}` : '';
    const timeout = r.approval_timeout_s ? `  timeout_s=${r.approval_timeout_s}` : '';
    const category = r.category ? `  category=${r.category}` : '';
    console.log(`  ${r.rule_id}${severity}${timeout}${category}`);
    console.log(`      ${r.summary}`);
  }
}

function mapPoliciesError(err: ApiError): CliError {
  switch (err.statusCode) {
    case 401:
      return new CliError(
        `Not authenticated (${err.errorCode}). Run \`bgagent login\` to re-authenticate.`,
      );
    case 404:
      return new CliError(
        `Repository not onboarded or no policies configured (${err.errorCode}).`,
      );
    case 429:
      return new CliError(
        `Rate limit exceeded (${err.errorCode}). policies list is rate-limited.`,
      );
    case 503:
      return new CliError(
        `Policy service temporarily unavailable (${err.errorCode}): ${err.message}`,
      );
    default:
      return new CliError(err.message);
  }
}
