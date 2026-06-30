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

import {
  buildRepoShowLines,
  formatGithubTokenSecretLine,
  formatRepoConfigForDisplay,
  PLATFORM_REPO_DEFAULTS,
} from '../../src/repo-display';

const PLATFORM = {
  runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:runtime/test',
  githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:GitHubTokenSecret-AbCdEf',
};
const BLUEPRINT_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:AcmeRepoToken-XyZ123';

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

    // `repo show --output json` serializes blueprint_overrides verbatim, so the
    // raw secret ARN must never appear here.
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
    expect(maxTurns?.text).toBe('(platform default) 100');
    expect(cedar).toBeUndefined();
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
      { runtimeArn: null, githubTokenSecretArn: null },
    );

    expect(formatGithubTokenSecretLine(display))
      .toBe('(platform default — GitHubTokenSecretArn stack output not found)');
    const runtime = buildRepoShowLines(display).find((l) => l.key === 'runtime_arn');
    expect(runtime?.text).toBe('(platform default — RuntimeArn stack output not found)');
  });
});
