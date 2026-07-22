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

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const mockResolveAll = jest.fn();
jest.mock('../../../src/handlers/shared/registry-resolver', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/registry-resolver');
  return { ...actual, resolveAll: mockResolveAll };
});

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';
process.env.RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/t';

import { resolveRegistryAssetsForTask } from '../../../src/handlers/shared/orchestrator';
import { RegistryResolutionError } from '../../../src/handlers/shared/registry-resolver';
import type { BlueprintConfig } from '../../../src/handlers/shared/repo-config';
import type { ResolvedAsset, TaskRecord } from '../../../src/handlers/shared/types';

const task = { task_id: 'T1', user_id: 'u', status: 'HYDRATING', branch_name: 'b' } as TaskRecord;

function mcpAsset(name: string, version: string, warnings: string[] = []): ResolvedAsset {
  return {
    kind: 'mcp_server',
    namespace: 'acme',
    name,
    version,
    descriptor: { summary: 's', permissions: [] },
    warnings,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockResolvedValue({});
});

describe('resolveRegistryAssetsForTask', () => {
  test('no pins → empty bundle, no resolve, no DDB write', async () => {
    const bundle = await resolveRegistryAssetsForTask(task, {} as BlueprintConfig);
    expect(bundle).toEqual({ mcp_servers: [], cedar_policy_modules: [], skills: [] });
    expect(mockResolveAll).not.toHaveBeenCalled();
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('one MCP pin → resolves, stamps resolved_assets triples on the task', async () => {
    mockResolveAll.mockResolvedValue({
      mcp_servers: [mcpAsset('pdf-tools', '1.4.1')],
      cedar_policy_modules: [],
      skills: [],
    });
    const bundle = await resolveRegistryAssetsForTask(task, {
      mcp_servers: ['registry://mcp_server/acme/pdf-tools@^1.0.0'],
    } as BlueprintConfig);

    expect(bundle.mcp_servers).toHaveLength(1);

    // Find the Update that stamped resolved_assets.
    const stamp = mockDdbSend.mock.calls
      .map((c) => c[0].input)
      .find((i) => i?.ExpressionAttributeNames?.['#ra'] === 'resolved_assets');
    expect(stamp).toBeDefined();
    expect(stamp.ExpressionAttributeValues[':ra']).toEqual([
      { kind: 'mcp_server', id: 'acme/pdf-tools', version: '1.4.1' },
    ]);
  });

  test('a bad pin propagates RegistryResolutionError (fail-closed) + emits failure event', async () => {
    mockResolveAll.mockRejectedValue(
      new RegistryResolutionError('NO_MATCHING_VERSION', 'registry://mcp_server/acme/x@^9.0.0'),
    );
    await expect(
      resolveRegistryAssetsForTask(task, {
        mcp_servers: ['registry://mcp_server/acme/x@^9.0.0'],
      } as BlueprintConfig),
    ).rejects.toBeInstanceOf(RegistryResolutionError);

    // A registry_resolution_failed event row was written.
    const failEvent = mockDdbSend.mock.calls
      .map((c) => c[0].input)
      .find((i) => JSON.stringify(i?.Item ?? {}).includes('registry_resolution_failed'));
    expect(failEvent).toBeDefined();
  });

  test('deprecated resolution still resolves and records the deprecation', async () => {
    mockResolveAll.mockResolvedValue({
      mcp_servers: [mcpAsset('pdf-tools', '1.4.1', ['DEPRECATED'])],
      cedar_policy_modules: [],
      skills: [],
    });
    const bundle = await resolveRegistryAssetsForTask(task, {
      mcp_servers: ['registry://mcp_server/acme/pdf-tools@^1.0.0'],
    } as BlueprintConfig);
    expect(bundle.mcp_servers[0].warnings).toContain('DEPRECATED');
    // resolved event carries the deprecated list
    const resolvedEvent = mockDdbSend.mock.calls
      .map((c) => c[0].input)
      .find((i) => JSON.stringify(i?.Item ?? {}).includes('registry_assets_resolved'));
    expect(resolvedEvent).toBeDefined();
  });
});
