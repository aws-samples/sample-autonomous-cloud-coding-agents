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
import { ApiClient } from '../../src/api-client';
import { makeRegistryCommand } from '../../src/commands/registry';
import { CliError } from '../../src/errors';

jest.mock('../../src/api-client');
jest.mock('fs');

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

describe('registry command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockPublish = jest.fn();
  const mockResolve = jest.fn();
  const mockList = jest.fn();
  const mockShow = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockReadFileSync.mockReset();
    [mockPublish, mockResolve, mockList, mockShow].forEach((m) => m.mockReset());
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      publishRegistryAsset: mockPublish,
      resolveRegistryRef: mockResolve,
      listRegistryAssets: mockList,
      showRegistryAsset: mockShow,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('publish', () => {
    test('reads descriptor + artifact and calls the API', async () => {
      mockReadFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
        if (String(p).includes('descriptor')) {
          return JSON.stringify({ summary: 's', permissions: [], transport: 'http', tool_prefix: 'x' });
        }
        return Buffer.from('{"url":"u"}');
      }) as typeof fs.readFileSync);
      mockPublish.mockResolvedValue({
        kind: 'mcp_server',
        namespace: 'acme',
        name: 'pdf',
        version: '1.4.1',
        status: 'submitted',
        created_at: '2026-07-20T00:00:00Z',
      });

      const cmd = makeRegistryCommand();
      await cmd.parseAsync([
        'node', 'test', 'publish',
        '--kind', 'mcp_server', '--namespace', 'acme', '--name', 'pdf', '--asset-version', '1.4.1',
        '--descriptor', '/tmp/descriptor.json', '--artifact', '/tmp/server.json',
      ]);

      expect(mockPublish).toHaveBeenCalledTimes(1);
      const [req, autoApprove] = mockPublish.mock.calls[0];
      expect(req.kind).toBe('mcp_server');
      expect(req.version).toBe('1.4.1');
      expect(req.artifact_b64).toBe(Buffer.from('{"url":"u"}').toString('base64'));
      expect(autoApprove).toBeFalsy();
    });

    test('passes auto_approve when --auto-approve is set', async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ summary: 's', permissions: [], transport: 'http', tool_prefix: 'x' }),
      );
      mockPublish.mockResolvedValue({
        kind: 'mcp_server',
        namespace: 'acme',
        name: 'pdf',
        version: '1.0.0',
        status: 'approved',
        created_at: 'now',
      });
      const cmd = makeRegistryCommand();
      await cmd.parseAsync([
        'node', 'test', 'publish',
        '--kind', 'mcp_server', '--namespace', 'acme', '--name', 'pdf', '--asset-version', '1.0.0',
        '--descriptor', '/tmp/d.json', '--auto-approve',
      ]);
      expect(mockPublish.mock.calls[0][1]).toBe(true);
    });

    test('rejects an unknown kind before hitting the API', async () => {
      const cmd = makeRegistryCommand();
      await expect(
        cmd.parseAsync([
          'node', 'test', 'publish',
          '--kind', 'nonsense', '--namespace', 'a', '--name', 'b', '--asset-version', '1.0.0',
          '--descriptor', '/tmp/d.json',
        ]),
      ).rejects.toThrow(CliError);
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    test('resolves a ref and prints the pinned version', async () => {
      mockResolve.mockResolvedValue({
        kind: 'mcp_server',
        namespace: 'acme',
        name: 'pdf',
        version: '1.4.1',
        descriptor: { summary: 's', permissions: [] },
        warnings: [],
      });
      const cmd = makeRegistryCommand();
      await cmd.parseAsync(['node', 'test', 'resolve', 'registry://mcp_server/acme/pdf@^1.0.0']);
      expect(mockResolve).toHaveBeenCalledWith('registry://mcp_server/acme/pdf@^1.0.0');
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('1.4.1');
    });
  });

  describe('list', () => {
    test('lists assets of a kind', async () => {
      mockList.mockResolvedValue({
        assets: [{ kind: 'mcp_server', namespace: 'acme', name: 'pdf', latest_version: '1.4.1', status: 'approved' }],
      });
      const cmd = makeRegistryCommand();
      await cmd.parseAsync(['node', 'test', 'list', '--kind', 'mcp_server']);
      expect(mockList).toHaveBeenCalledWith('mcp_server', { namespace: undefined, status: undefined });
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('acme/pdf');
    });
  });

  describe('show', () => {
    test('parses kind/namespace/name and lists versions', async () => {
      mockShow.mockResolvedValue({
        kind: 'mcp_server',
        namespace: 'acme',
        name: 'pdf',
        versions: [{ version: '1.4.1', status: 'approved', created_at: 'now', publisher: 'u' }],
      });
      const cmd = makeRegistryCommand();
      await cmd.parseAsync(['node', 'test', 'show', 'mcp_server/acme/pdf']);
      expect(mockShow).toHaveBeenCalledWith('mcp_server', 'acme', 'pdf');
    });

    test('rejects a malformed id', async () => {
      const cmd = makeRegistryCommand();
      await expect(
        cmd.parseAsync(['node', 'test', 'show', 'not-a-valid-id']),
      ).rejects.toThrow(CliError);
      expect(mockShow).not.toHaveBeenCalled();
    });
  });
});
