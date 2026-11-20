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

import { GetRegistryRecordCommand, ListRegistryRecordsCommand } from '@aws-sdk/client-agent-registry-control';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../src/handlers/registry-show';
import { AgentRegistryClient } from '../../src/handlers/shared/registry/agent-registry-client';

// registry-handlers.test.ts, which holds the other cases of this handler, fakes the
// registry client. Here the handler runs over the real adapter and a fake of the AWS
// client under it, because the two together decide what `registry show` fetches.
const mockRecords = [
  ['pdf-tools', '1.0.0'], ['pdf-tools', '1.2.0'], ['other-a', '1.0.0'], ['other-b', '1.0.0'], ['other-c', '1.0.0'],
].map(([name, version], index) => ({
  recordId: `rec-${index + 1}`,
  name: `mcp_server/acme/${name}`,
  recordType: 'MCP',
  descriptors: {
    mcpServer: {
      data: JSON.stringify({ name: `acme/${name}`, version, _meta: { 'dev.abca.runtime': { transport: 'http', url: 'https://x' } } }),
    },
  },
  recordVersion: version,
  status: 'APPROVED',
}));
const mockSend = jest.fn(async (command: unknown) => {
  if (command instanceof ListRegistryRecordsCommand) return { registryRecords: mockRecords };
  if (command instanceof GetRegistryRecordCommand) return mockRecords.find(record => record.recordId === command.input.recordId) ?? {};
  throw new Error(`unexpected command ${command?.constructor?.name}`);
});
jest.mock('../../src/handlers/shared/registry/factory', () => {
  const actual = jest.requireActual('../../src/handlers/shared/registry/factory');
  return {
    ...actual,
    makeRegistryClient: () => new AgentRegistryClient({ registryId: 'AbCdEfGh1234', client: { send: mockSend } as never }),
  };
});

describe('registry-show handler over the registry adapter', () => {
  // The list of the registry carries each record's name, so only the versions of the
  // asset that is shown need a GetRegistryRecord: not every record of its kind and namespace.
  test('fetches the versions of the asset it shows, not the records of its neighbours', async () => {
    const res = await handler({
      pathParameters: { kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools' },
      requestContext: { authorizer: { claims: { sub: 'user-1' } } },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.versions).toEqual([
      { version: '1.2.0', status: 'APPROVED', created_at: null, publisher: null },
      { version: '1.0.0', status: 'APPROVED', created_at: null, publisher: null },
    ]);
    const fetched = mockSend.mock.calls.filter(([command]) => command instanceof GetRegistryRecordCommand);
    expect(fetched.map(([command]) => (command as GetRegistryRecordCommand).input.recordId)).toEqual(['rec-1', 'rec-2']);
  });
});
