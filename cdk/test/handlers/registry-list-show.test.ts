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
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));
jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.REGISTRY_ASSETS_TABLE_NAME = 'RegistryAssets';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as listHandler } from '../../src/handlers/registry-list';
import { handler as showHandler } from '../../src/handlers/registry-show';

function row(namespace: string, name: string, version: string, status = 'approved') {
  return {
    pk: `mcp_server#${namespace}/${name}`,
    sk: version,
    kind: 'mcp_server',
    namespace,
    name,
    version,
    status,
    created_at: '2026-07-20T00:00:00Z',
    publisher: 'sub-1',
    descriptor: { summary: 's', permissions: [] },
    status_history: [],
  };
}

beforeEach(() => jest.clearAllMocks());

describe('registry list handler', () => {
  function listEvent(qs: Record<string, string> | null, authed = true): APIGatewayProxyEvent {
    return {
      queryStringParameters: qs,
      requestContext: { authorizer: { claims: authed ? { sub: 'u' } : {} } },
    } as unknown as APIGatewayProxyEvent;
  }

  test('401 unauthenticated', async () => {
    expect((await listHandler(listEvent({ kind: 'mcp_server' }, false))).statusCode).toBe(401);
  });

  test('400 when kind missing or unknown', async () => {
    expect((await listHandler(listEvent(null))).statusCode).toBe(400);
    expect((await listHandler(listEvent({ kind: 'nope' }))).statusCode).toBe(400);
  });

  test('collapses versions to the highest per asset', async () => {
    mockDdbSend.mockResolvedValue({
      Items: [row('acme', 'pdf', '1.0.0'), row('acme', 'pdf', '1.10.0'), row('acme', 'other', '2.0.0')],
    });
    const res = await listHandler(listEvent({ kind: 'mcp_server' }));
    expect(res.statusCode).toBe(200);
    const assets = JSON.parse(res.body).data.assets;
    expect(assets).toHaveLength(2);
    const pdf = assets.find((a: { name: string }) => a.name === 'pdf');
    expect(pdf.latest_version).toBe('1.10.0'); // semver, not lexicographic
  });

  test('excludes removed unless status=removed requested', async () => {
    mockDdbSend.mockResolvedValue({ Items: [row('acme', 'gone', '1.0.0', 'removed')] });
    expect(JSON.parse((await listHandler(listEvent({ kind: 'mcp_server' }))).body).data.assets).toHaveLength(0);
    expect(
      JSON.parse((await listHandler(listEvent({ kind: 'mcp_server', status: 'removed' }))).body).data.assets,
    ).toHaveLength(1);
  });

  test('honors the namespace filter', async () => {
    mockDdbSend.mockResolvedValue({ Items: [row('acme', 'pdf', '1.0.0'), row('other', 'pdf', '1.0.0')] });
    const res = await listHandler(listEvent({ kind: 'mcp_server', namespace: 'acme' }));
    expect(JSON.parse(res.body).data.assets).toHaveLength(1);
  });
});

describe('registry show handler', () => {
  function showEvent(params: Record<string, string> | null, authed = true): APIGatewayProxyEvent {
    return {
      pathParameters: params,
      requestContext: { authorizer: { claims: authed ? { sub: 'u' } : {} } },
    } as unknown as APIGatewayProxyEvent;
  }

  test('401 unauthenticated', async () => {
    expect(
      (await showHandler(showEvent({ kind: 'mcp_server', namespace: 'acme', name: 'pdf' }, false))).statusCode,
    ).toBe(401);
  });

  test('400 on missing path params', async () => {
    expect((await showHandler(showEvent(null))).statusCode).toBe(400);
  });

  test('404 when the asset has no versions', async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const res = await showHandler(showEvent({ kind: 'mcp_server', namespace: 'acme', name: 'pdf' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('REGISTRY_ASSET_NOT_FOUND');
  });

  test('returns versions newest-semver-first', async () => {
    mockDdbSend.mockResolvedValue({
      Items: [row('acme', 'pdf', '1.2.0'), row('acme', 'pdf', '1.10.0'), row('acme', 'pdf', '1.9.0')],
    });
    const res = await showHandler(showEvent({ kind: 'mcp_server', namespace: 'acme', name: 'pdf' }));
    expect(res.statusCode).toBe(200);
    const versions = JSON.parse(res.body).data.versions.map((v: { version: string }) => v.version);
    expect(versions).toEqual(['1.10.0', '1.9.0', '1.2.0']);
  });
});
