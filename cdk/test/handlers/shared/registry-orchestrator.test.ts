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

/**
 * E2E-ish coverage of the orchestrator registry resolve-step (#246, PR 2):
 * given a Blueprint's ``mcp_servers`` refs, ``resolveRegistryAssets`` resolves
 * each via the RegistryClient and is fail-closed on a bad ref / resolution
 * failure. This is the seam the full task path calls before assembling the
 * agent payload; the payload/stamping wiring around it is exercised here by
 * asserting the returned bundle shape the orchestrator threads through.
 */

import { resolveRegistryAssets } from '../../../src/handlers/shared/orchestrator';
import { RegistryResolutionError, type ResolvedAsset } from '../../../src/handlers/shared/registry/types';
import type { BlueprintConfig } from '../../../src/handlers/shared/repo-config';

// Standalone mock fn (not a method on an object) so `.not.toHaveBeenCalled()`
// doesn't trip @typescript-eslint/unbound-method — matches the repo pattern.
const mockResolve = jest.fn();
jest.mock('../../../src/handlers/shared/registry/factory', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/registry/factory');
  return { ...actual, makeRegistryClient: () => ({ resolve: mockResolve }) };
});

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

const asset = (over: Partial<ResolvedAsset> = {}): ResolvedAsset => ({
  kind: 'mcp_server',
  namespace: 'acme',
  name: 'pdf-tools',
  version: '1.4.1',
  runtime: { transport: 'http', url: 'https://mcp.example.com/sse' } as never,
  warnings: [],
  ...over,
});

const bp = (refs: Partial<Pick<BlueprintConfig, 'mcp_servers' | 'cedar_policy_modules' | 'skills'>> = {}): BlueprintConfig => ({
  compute_type: 'agentcore',
  runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/r',
  ...refs,
});

beforeEach(() => jest.clearAllMocks());

describe('resolveRegistryAssets', () => {
  test('returns [] when the blueprint pins no assets', async () => {
    expect(await resolveRegistryAssets(bp(), log)).toEqual([]);
    expect(await resolveRegistryAssets(undefined, log)).toEqual([]);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('resolves each ref into the bundle the orchestrator threads', async () => {
    mockResolve.mockResolvedValue(asset());
    const result = await resolveRegistryAssets(
      bp({ mcp_servers: ['registry://mcp_server/acme/pdf-tools@^1.4.1'] }),
      log,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools', version: '1.4.1' });
    expect(result[0].runtime).toMatchObject({ transport: 'http' });
  });

  test('resolves multiple refs in order', async () => {
    mockResolve
      .mockResolvedValueOnce(asset({ name: 'a', version: '1.0.0' }))
      .mockResolvedValueOnce(asset({ name: 'b', version: '2.0.0' }));
    const result = await resolveRegistryAssets(
      bp({ mcp_servers: ['registry://mcp_server/acme/a@^1.0.0', 'registry://mcp_server/acme/b@^2.0.0'] }),
      log,
    );
    expect(result.map((a) => a.name)).toEqual(['a', 'b']);
  });

  test('fail-closed on a malformed ref (never calls resolve)', async () => {
    await expect(
      resolveRegistryAssets(bp({ mcp_servers: ['registry://mcp_server/acme/pdf-tools'] }), log),
    ).rejects.toBeInstanceOf(RegistryResolutionError);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('fail-closed when the client cannot resolve a version', async () => {
    mockResolve.mockRejectedValue(
      new RegistryResolutionError('NO_MATCHING_VERSION', 'r', 'none'),
    );
    await expect(
      resolveRegistryAssets(bp({ mcp_servers: ['registry://mcp_server/acme/pdf-tools@^9.9.9'] }), log),
    ).rejects.toMatchObject({ reason: 'NO_MATCHING_VERSION' });
  });

  test('a DEPRECATED asset resolves but is logged as a warning', async () => {
    mockResolve.mockResolvedValue(asset({ warnings: ['DEPRECATED'] }));
    const result = await resolveRegistryAssets(
      bp({ mcp_servers: ['registry://mcp_server/acme/pdf-tools@1.4.1'] }),
      log,
    );
    expect(result).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });

  test('resolves cedar_policy_module + skill refs alongside mcp (PR 3)', async () => {
    mockResolve
      .mockResolvedValueOnce(asset({ kind: 'mcp_server', name: 'pdf-tools' }))
      .mockResolvedValueOnce(asset({
        kind: 'cedar_policy_module',
        name: 'force-push',
        runtime: { cedar_text: 'forbid(principal, action, resource);' } as never,
      }))
      .mockResolvedValueOnce(asset({
        kind: 'skill',
        name: 'research',
        runtime: { prompt_fragment: 'Summarize.' } as never,
      }));
    const result = await resolveRegistryAssets(
      bp({
        mcp_servers: ['registry://mcp_server/acme/pdf-tools@^1.4.1'],
        cedar_policy_modules: ['registry://cedar_policy_module/acme/force-push@^1.0.0'],
        skills: ['registry://skill/acme/research@^1.0.0'],
      }),
      log,
    );
    expect(result.map((a) => a.kind)).toEqual(['mcp_server', 'cedar_policy_module', 'skill']);
    expect((result[1].runtime as { cedar_text: string }).cedar_text).toContain('forbid');
    expect((result[2].runtime as { prompt_fragment: string }).prompt_fragment).toBe('Summarize.');
  });
});
