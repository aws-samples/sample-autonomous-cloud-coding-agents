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

import { ApiClient } from '../../src/api-client';
import { makePoliciesCommand } from '../../src/commands/policies';
import { ApiError, CliError } from '../../src/errors';

jest.mock('../../src/api-client');

describe('policies command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockListPolicies = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockListPolicies.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      listPolicies: mockListPolicies,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  const sampleResponse = {
    repo_id: 'owner/repo',
    policies: {
      hard: [
        { rule_id: 'rm_slash', category: 'destructive', summary: 'reject rm -rf /' },
      ],
      soft: [
        {
          rule_id: 'force_push_any',
          severity: 'medium',
          approval_timeout_s: 300,
          category: 'destructive',
          summary: 'force push to any branch',
        },
      ],
    },
  };

  test('list → prints both tiers by default', async () => {
    mockListPolicies.mockResolvedValue(sampleResponse);
    await makePoliciesCommand().parseAsync(['node', 'test', 'list', '--repo', 'owner/repo']);
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Hard-deny rules');
    expect(out).toContain('Soft-deny rules');
    expect(out).toContain('rm_slash');
    expect(out).toContain('force_push_any');
    expect(out).toContain('severity=medium');
    expect(out).toContain('timeout_s=300');
  });

  test('list --tier hard filters out soft', async () => {
    mockListPolicies.mockResolvedValue(sampleResponse);
    await makePoliciesCommand().parseAsync([
      'node', 'test', 'list', '--repo', 'owner/repo', '--tier', 'hard',
    ]);
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('rm_slash');
    expect(out).not.toContain('force_push_any');
  });

  test('list --output json returns structured payload', async () => {
    mockListPolicies.mockResolvedValue(sampleResponse);
    await makePoliciesCommand().parseAsync([
      'node', 'test', 'list', '--repo', 'owner/repo', '--output', 'json',
    ]);
    const out = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(out.repo_id).toBe('owner/repo');
    expect(out.policies.hard[0].rule_id).toBe('rm_slash');
  });

  test('list rejects bad --tier', async () => {
    const cmd = makePoliciesCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'list', '--repo', 'owner/repo', '--tier', 'invalid']),
    ).rejects.toThrow(CliError);
  });

  test('show → prints detail for a known rule', async () => {
    mockListPolicies.mockResolvedValue(sampleResponse);
    await makePoliciesCommand().parseAsync([
      'node', 'test', 'show', '--repo', 'owner/repo', '--rule', 'force_push_any',
    ]);
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('rule_id:');
    expect(out).toContain('force_push_any');
    expect(out).toContain('severity:');
    expect(out).toContain('medium');
    expect(out).toContain('tier:');
    expect(out).toContain('soft');
  });

  test('show → errors on unknown rule', async () => {
    mockListPolicies.mockResolvedValue(sampleResponse);
    const cmd = makePoliciesCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'show', '--repo', 'owner/repo', '--rule', 'missing_rule']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('not found'),
    });
  });

  test('404 → repo-not-onboarded message', async () => {
    mockListPolicies.mockRejectedValue(new ApiError(404, 'REPO_NOT_ONBOARDED', '', ''));
    const cmd = makePoliciesCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'list', '--repo', 'owner/repo']),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('not onboarded'),
    });
  });
});
