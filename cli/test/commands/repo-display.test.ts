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
import * as path from 'path';
import {
  buildRepoShowLines,
  formatGithubTokenSecretLine,
  formatRepoConfigForDisplay,
  PLATFORM_REPO_DEFAULTS,
} from '../../src/repo-display';

const PLATFORM = {
  deployment: { stackName: 'backgroundagent-dev', computeSubstrate: null },
  runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:runtime/test',
  githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:GitHubTokenSecret-AbCdEf',
  bedrockGeoRegion: null,
};
const BLUEPRINT_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:AcmeRepoToken-XyZ123';
// The default starts with its Bedrock geography, and no geography name holds a dot.
const BARE_DEFAULT_MODEL = PLATFORM_REPO_DEFAULTS.model_id.slice(PLATFORM_REPO_DEFAULTS.model_id.indexOf('.') + 1);

describe('formatRepoConfigForDisplay', () => {
  test('resolves platform defaults when blueprint fields are absent from RepoTable', () => {
    const display = formatRepoConfigForDisplay(
      { repo: 'awslabs/agent-plugins', status: 'active' },
      PLATFORM,
    );

    expect(display.effective.compute_type).toBe(PLATFORM_REPO_DEFAULTS.compute_type);
    expect(display.effective.max_turns).toBe(PLATFORM_REPO_DEFAULTS.max_turns);
    expect(display.effective.model_id).toBe(PLATFORM_REPO_DEFAULTS.model_id);
    expect(display.field_sources.compute_type).toBe('platform');
    expect(Object.keys(display.blueprint_overrides)).toHaveLength(0);
  });

  test.each(['us', 'eu', 'us-gov', 'global'])('shows the default model in the %s geography the stack grants', geo => {
    const display = formatRepoConfigForDisplay(
      { repo: 'acme/default', status: 'active' },
      { ...PLATFORM, bedrockGeoRegion: geo },
    );

    expect(display.effective.model_id).toBe(`${geo}.${BARE_DEFAULT_MODEL}`);
    expect(display.field_sources.model_id).toBe('platform');
    expect(buildRepoShowLines(display).find(line => line.key === 'model_id')?.text)
      .toBe(`(platform default) ${geo}.${BARE_DEFAULT_MODEL}`);
  });

  test.each([null, '', '  '])('keeps the shipped default model when the stack exports no geography (%p)', geo => {
    const display = formatRepoConfigForDisplay(
      { repo: 'acme/default', status: 'active' },
      { ...PLATFORM, bedrockGeoRegion: geo },
    );

    expect(display.effective.model_id).toBe(PLATFORM_REPO_DEFAULTS.model_id);
  });

  test('shows a per-blueprint model as stored, whatever geography the stack grants', () => {
    const display = formatRepoConfigForDisplay(
      { repo: 'acme/pinned', status: 'active', model_id: 'eu.anthropic.claude-haiku-5-5' },
      { ...PLATFORM, bedrockGeoRegion: 'us' },
    );

    expect(display.effective.model_id).toBe('eu.anthropic.claude-haiku-5-5');
    expect(display.field_sources.model_id).toBe('blueprint');
  });

  test.each(['agentcore', 'ecs', 'lambda-microvm'] as const)(
    'checks every repository pin against the exclusive %s deployment',
    backend => {
      const platform = {
        ...PLATFORM,
        deployment: { stackName: 'backgroundagent-dev', computeSubstrate: backend, computeDeploymentMode: 'exclusive' },
      };
      const inherited = formatRepoConfigForDisplay({ repo: 'acme/default', status: 'active' }, platform);
      expect(inherited.effective.compute_type).toBe(backend);
      expect(inherited.compute_available).toBe(true);
      expect(inherited.compute_deployment).toEqual({
        stack_name: 'backgroundagent-dev',
        compute_substrate: backend,
        compute_deployment_mode: 'exclusive',
        compute_types: [backend],
        default_compute_type: backend,
      });

      for (const requested of ['agentcore', 'ecs', 'lambda-microvm'] as const) {
        const display = formatRepoConfigForDisplay({
          repo: 'acme/pinned',
          status: 'active',
          compute_type: requested,
          runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
        }, platform);
        expect(display.blueprint_overrides.compute_type).toBe(requested);
        expect(display.compute_available).toBe(requested === backend);
        const lines = buildRepoShowLines(display);
        if (requested === backend) {
          expect(display.configuration_error).toBeUndefined();
          expect(lines.find(line => line.key === 'compute_type')?.text).not.toContain('UNAVAILABLE');
        } else {
          expect(display.configuration_error).toContain(`deploys only '${backend}'`);
          expect(display.effective.runtime_arn).toBeUndefined();
          expect(lines.find(line => line.key === 'compute_type')?.text).toContain('UNAVAILABLE');
          expect(lines.find(line => line.key === 'runtime_arn')?.text).toContain('unavailable');
          expect(lines.find(line => line.key === 'configuration_error')?.text).toBe(display.configuration_error);
        }
      }
    },
  );

  test('marks blueprint override when github_token_secret_arn is set', () => {
    const display = formatRepoConfigForDisplay(
      {
        repo: 'acme/foo',
        status: 'active',
        github_token_secret_arn: BLUEPRINT_ARN,
      },
      PLATFORM,
    );

    expect(display.effective.github_token_source).toBe('blueprint');
    expect(display.effective.github_token_secret_arn).toBe(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:****-XyZ123',
    );
  });

  test('redacts github_token_secret_arn in blueprint_overrides (JSON output contract)', () => {
    const display = formatRepoConfigForDisplay(
      {
        repo: 'acme/foo',
        status: 'active',
        github_token_secret_arn: BLUEPRINT_ARN,
      },
      PLATFORM,
    );

    expect(display.blueprint_overrides.github_token_secret_arn).toBe(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:****-XyZ123',
    );
    expect(JSON.stringify(display)).not.toContain(BLUEPRINT_ARN);
  });
});

describe('buildRepoShowLines', () => {
  test('shows platform defaults instead of dash for unset blueprint fields', () => {
    const display = formatRepoConfigForDisplay(
      { repo: 'awslabs/agent-plugins', status: 'active' },
      PLATFORM,
    );
    const lines = buildRepoShowLines(display);
    const compute = lines.find((l) => l.key === 'compute_type');
    const maxTurns = lines.find((l) => l.key === 'max_turns');
    const cedar = lines.find((l) => l.key === 'cedar_policies');

    expect(compute?.text).toBe('(platform default) agentcore');
    expect(maxTurns?.text).toBe(`(platform default) ${PLATFORM_REPO_DEFAULTS.max_turns}`);
    expect(cedar).toBeUndefined();
  });

  test('the advertised default model matches the one the agent actually falls back to', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../agent/src/config.py'), 'utf8',
    );
    const match = configPy.match(/"ANTHROPIC_MODEL",\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(PLATFORM_REPO_DEFAULTS.model_id).toBe(match![1]);
  });

  test('shows the memory token budget in effect and where it comes from', () => {
    const inherited = formatRepoConfigForDisplay({ repo: 'acme/foo', status: 'active' }, PLATFORM);
    expect(inherited.effective.memory_token_budget).toBe(PLATFORM_REPO_DEFAULTS.memory_token_budget);
    expect(inherited.field_sources.memory_token_budget).toBe('platform');
    expect(inherited.blueprint_overrides).not.toHaveProperty('memory_token_budget');
    expect(buildRepoShowLines(inherited).find((l) => l.key === 'memory_token_budget')?.text)
      .toBe(`(platform default) ${PLATFORM_REPO_DEFAULTS.memory_token_budget}`);

    const pinned = formatRepoConfigForDisplay(
      { repo: 'acme/foo', status: 'active', memory_token_budget: 4000 },
      PLATFORM,
    );
    expect(pinned.effective.memory_token_budget).toBe(4000);
    expect(pinned.field_sources.memory_token_budget).toBe('blueprint');
    expect(pinned.blueprint_overrides.memory_token_budget).toBe(4000);
    expect(buildRepoShowLines(pinned).find((l) => l.key === 'memory_token_budget')?.text)
      .toBe('4000 (per-blueprint override)');
  });

  test('the advertised default memory token budget matches the one hydration applies', () => {
    const memoryTs = fs.readFileSync(
      path.resolve(__dirname, '../../../cdk/src/handlers/shared/memory.ts'), 'utf8',
    );
    const match = memoryTs.match(/const DEFAULT_MEMORY_TOKEN_BUDGET = ([\d_]+);/);
    expect(match).not.toBeNull();
    expect(PLATFORM_REPO_DEFAULTS.memory_token_budget).toBe(Number(match![1].replace(/_/g, '')));
  });

  test('explains platform default github token in text output', () => {
    const display = formatRepoConfigForDisplay(
      { repo: 'awslabs/agent-plugins', status: 'active' },
      PLATFORM,
    );

    expect(formatGithubTokenSecretLine(display))
      .toBe('(platform default) arn:aws:secretsmanager:us-east-1:123456789012:secret:****-AbCdEf');
  });

  test('shows per-blueprint override when field is set in RepoTable', () => {
    const display = formatRepoConfigForDisplay(
      {
        repo: 'acme/foo',
        status: 'active',
        compute_type: 'ecs',
        max_turns: 200,
      },
      PLATFORM,
    );
    const lines = buildRepoShowLines(display);

    expect(lines.find((l) => l.key === 'compute_type')?.text).toBe('ecs (per-blueprint override)');
    expect(lines.find((l) => l.key === 'max_turns')?.text).toBe('200 (per-blueprint override)');
  });

  test('includes optional blueprint-only fields when set', () => {
    const display = formatRepoConfigForDisplay(
      {
        repo: 'acme/foo',
        status: 'active',
        max_budget_usd: 5,
        cedar_policies: ['forbid(principal, action, resource);'],
      },
      PLATFORM,
    );
    const lines = buildRepoShowLines(display);

    expect(lines.find((l) => l.key === 'max_budget_usd')?.text).toBe('5 (per-blueprint override)');
    expect(lines.find((l) => l.key === 'cedar_policies')?.text)
      .toBe('1 policy/policies (per-blueprint override)');
  });

  test('warns when platform stack output is missing', () => {
    const display = formatRepoConfigForDisplay(
      { repo: 'awslabs/agent-plugins', status: 'active' },
      { ...PLATFORM, runtimeArn: null, githubTokenSecretArn: null },
    );

    expect(formatGithubTokenSecretLine(display))
      .toBe('(platform default — GitHubTokenSecretArn stack output not found)');
    const runtime = buildRepoShowLines(display).find((l) => l.key === 'runtime_arn');
    expect(runtime?.text).toBe('(platform default — RuntimeArn stack output not found)');
  });
});
