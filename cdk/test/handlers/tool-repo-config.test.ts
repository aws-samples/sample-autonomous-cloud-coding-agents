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

import type { Context } from 'aws-lambda';

const mockLookupRepo = jest.fn();
jest.mock('../../src/handlers/shared/repo-config', () => ({
  lookupRepo: (...args: unknown[]) => mockLookupRepo(...args),
}));

jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { handler } from '../../src/handlers/tool-repo-config';

/** Build a Lambda Context whose clientContext carries the Gateway tool name. */
function gatewayContext(toolName: string | undefined): Context {
  const custom = toolName === undefined ? {} : { bedrockAgentCoreToolName: toolName };
  return { clientContext: { custom } } as unknown as Context;
}

/** A local/direct invoke has no clientContext at all. */
const localContext = {} as unknown as Context;

const ACTIVE_CONFIG = {
  repo: 'aws-samples/my-repo',
  status: 'active',
  compute_type: 'agentcore',
  model_id: 'anthropic.claude-sonnet-4-6',
  max_turns: 50,
  build_command: 'mise run build',
  lint_command: 'mise run lint',
  // Fields the tool deliberately does NOT surface:
  github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:gh',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('tool-repo-config handler', () => {
  test('returns the curated config for an onboarded repo (Gateway-prefixed tool name)', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: true, config: ACTIVE_CONFIG });

    const result = await handler(
      { repo: 'aws-samples/my-repo' },
      gatewayContext('abca-repo-config___abca_repo_config'),
    );

    expect(mockLookupRepo).toHaveBeenCalledWith('aws-samples/my-repo');
    expect(result).toEqual({
      repo: 'aws-samples/my-repo',
      onboarded: true,
      compute_type: 'agentcore',
      model_id: 'anthropic.claude-sonnet-4-6',
      max_turns: 50,
      build_command: 'mise run build',
      lint_command: 'mise run lint',
    });
  });

  test('never leaks secret ARNs in the tool result', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: true, config: ACTIVE_CONFIG });
    const result = await handler(
      { repo: 'aws-samples/my-repo' },
      gatewayContext('abca-repo-config___abca_repo_config'),
    );
    expect(JSON.stringify(result)).not.toContain('secretsmanager');
    expect(result).not.toHaveProperty('github_token_secret_arn');
  });

  test('returns { onboarded: false } (not an error) for a non-onboarded repo', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: false, config: null });
    const result = await handler({ repo: 'org/unknown' }, gatewayContext('abca_repo_config'));
    expect(result).toEqual({ repo: 'org/unknown', onboarded: false });
  });

  test('treats onboarded-but-null config as non-onboarded', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: true, config: null });
    const result = await handler({ repo: 'org/blank' }, gatewayContext('abca_repo_config'));
    expect(result).toEqual({ repo: 'org/blank', onboarded: false });
  });

  test('works on a local/direct invoke where clientContext is absent', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: false, config: null });
    const result = await handler({ repo: 'org/repo' }, localContext);
    expect(result).toEqual({ repo: 'org/repo', onboarded: false });
  });

  test('reads the tool name from a PascalCase Custom map defensively', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: false, config: null });
    const ctx = {
      clientContext: { Custom: { bedrockAgentCoreToolName: 'abca-repo-config___abca_repo_config' } },
    } as unknown as Context;
    const result = await handler({ repo: 'org/repo' }, ctx);
    expect(result.onboarded).toBe(false);
  });

  test('throws when an unexpected tool is routed to this target', async () => {
    await expect(
      handler({ repo: 'org/repo' }, gatewayContext('abca-repo-config___some_other_tool')),
    ).rejects.toThrow("Unknown tool 'some_other_tool'");
    expect(mockLookupRepo).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', {}],
    ['empty', { repo: '' }],
    ['whitespace', { repo: '   ' }],
    ['non-string', { repo: 42 }],
  ])('rejects a %s repo argument before hitting the table', async (_label, input) => {
    await expect(handler(input as { repo?: unknown }, gatewayContext('abca_repo_config'))).rejects.toThrow(
      /requires a non-empty 'repo'/,
    );
    expect(mockLookupRepo).not.toHaveBeenCalled();
  });

  test.each([
    'no-slash',
    'owner/',
    '/name',
    'owner/name/extra',
    'own er/name',
  ])('rejects a malformed repo "%s"', async (repo) => {
    await expect(handler({ repo }, gatewayContext('abca_repo_config'))).rejects.toThrow(
      /must be in "owner\/name" form/,
    );
    expect(mockLookupRepo).not.toHaveBeenCalled();
  });

  test('trims surrounding whitespace before lookup', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: false, config: null });
    await handler({ repo: '  org/repo  ' }, gatewayContext('abca_repo_config'));
    expect(mockLookupRepo).toHaveBeenCalledWith('org/repo');
  });
});
