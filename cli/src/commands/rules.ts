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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { ApiError, CliError } from '../errors';
import { formatJson } from '../format';

interface FixtureFile {
  description?: string;
  event: { event_type: string; metadata?: Record<string, unknown> };
  rules: unknown[];
  expected_matches: string[];
  aggregate_state?: { cumulative_cost_usd?: number; turn_count?: number };
}

function loadFixture(name: string): FixtureFile {
  const repoRoot = path.resolve(__dirname, '../../..');
  const fixturePath = path.join(repoRoot, 'agent/event-rules/fixtures', `${name}.json`);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as FixtureFile;
}

function eventName(eventType: string, metadata: Record<string, unknown>): string {
  if (eventType === 'agent_milestone' && typeof metadata.milestone === 'string') {
    return metadata.milestone;
  }
  if (typeof metadata.checkpoint === 'string') return metadata.checkpoint;
  return eventType;
}

function matchRules(fixture: FixtureFile): string[] {
  const name = eventName(fixture.event.event_type, fixture.event.metadata ?? {});
  const meta = fixture.event.metadata ?? {};
  const matched: string[] = [];
  for (const raw of fixture.rules) {
    const rule = raw as Record<string, unknown>;
    if (rule.on !== name) continue;
    const when = rule.when as { fields?: Record<string, unknown>; aggregate?: { cost_usd_gte?: number; turn_count_gte?: number } } | undefined;
    if (when?.fields) {
      let ok = true;
      for (const [k, v] of Object.entries(when.fields)) {
        if (meta[k] !== v) ok = false;
      }
      if (!ok) continue;
    }
    if (when?.aggregate?.cost_usd_gte !== undefined) {
      const cumulative = fixture.aggregate_state?.cumulative_cost_usd
        ?? (meta.cumulative_cost_usd as number | undefined);
      if (cumulative === undefined || cumulative < when.aggregate.cost_usd_gte) continue;
    }
    if (when?.aggregate?.turn_count_gte !== undefined) {
      const turns = fixture.aggregate_state?.turn_count
        ?? (meta.turn_count as number | undefined);
      if (turns === undefined || turns < when.aggregate.turn_count_gte) continue;
    }
    matched.push(String(rule.id));
  }
  return matched;
}

export function makeRulesCommand(): Command {
  const rules = new Command('rules')
    .description('Event governance rule utilities (issue #230)');

  rules
    .command('eval')
    .description('Evaluate a golden fixture locally')
    .requiredOption('--fixture <name>', 'Fixture basename under agent/event-rules/fixtures/')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action((opts: { fixture: string; output: string }) => {
      const fixture = loadFixture(opts.fixture);
      const matched = matchRules(fixture);
      const payload = {
        fixture: opts.fixture,
        description: fixture.description,
        matched,
        expected: fixture.expected_matches,
        ok: matched.join(',') === fixture.expected_matches.join(','),
      };
      if (opts.output === 'json') {
        console.log(formatJson(payload));
        return;
      }
      console.log(fixture.description ?? opts.fixture);
      console.log(`matched: ${matched.join(', ') || '(none)'}`);
      console.log(`expected: ${fixture.expected_matches.join(', ')}`);
      console.log(payload.ok ? 'OK' : 'MISMATCH');
      if (!payload.ok) process.exitCode = 1;
    });

  rules
    .command('list')
    .description('List resolved event governance rules for a repo')
    .requiredOption('--repo <owner/repo>', 'Repository identifier')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts: { repo: string; output: string }) => {
      const client = new ApiClient();
      try {
        const result = await client.listEventRules(opts.repo);
        if (opts.output === 'json') {
          console.log(formatJson(result));
          return;
        }
        console.log(`Event rules for ${result.repo_id}:`);
        if (result.event_rule_pack) {
          console.log(`  pack: ${result.event_rule_pack.id}@${result.event_rule_pack.version}`);
        }
        if (result.rules.length === 0) {
          console.log('  (no rules configured)');
          return;
        }
        for (const rule of result.rules) {
          const mode = rule.mode === 'observe_only' ? '[observe] ' : '';
          console.log(`  - ${mode}${rule.rule_id}: on=${rule.on} action=${rule.action} (${rule.evaluation})`);
          if (rule.reason) console.log(`      ${rule.reason}`);
        }
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw new CliError(err.message);
        }
        throw err;
      }
    });

  return rules;
}
