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

import { ConflictException } from '@aws-sdk/client-bedrock-agentcore-control';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as listHandler } from '../../src/handlers/registry-list';
import { handler as publishHandler } from '../../src/handlers/registry-publish';
import { handler as resolveHandler } from '../../src/handlers/registry-resolve';
import { handler as showHandler } from '../../src/handlers/registry-show';
import type { RegistryClient } from '../../src/handlers/shared/registry/client';
import { RegistryResolutionError } from '../../src/handlers/shared/registry/types';

// Mock the factory so handlers get our fake client (no AWS).
const mockClient: jest.Mocked<RegistryClient> = {
  publish: jest.fn(),
  getRecord: jest.fn(),
  listRecords: jest.fn(),
  resolve: jest.fn(),
};
jest.mock('../../src/handlers/shared/registry/factory', () => {
  const actual = jest.requireActual('../../src/handlers/shared/registry/factory');
  return { ...actual, makeRegistryClient: () => mockClient };
});
jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/registry/records',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/registry/records',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-1' } },
      httpMethod: 'POST',
      identity: {} as never,
      path: '/v1/registry/records',
      protocol: 'HTTPS',
      requestId: 'gw-1',
      requestTimeEpoch: 0,
      resourceId: 'res',
      resourcePath: '/registry/records',
      stage: 'v1',
    },
    ...overrides,
  };
}

/** Build an authorizer.claims block with a cognito:groups membership. */
function withGroups(groups: string[]): APIGatewayProxyEvent['requestContext']['authorizer'] {
  return { claims: { 'sub': 'user-1', 'cognito:groups': groups.join(',') } };
}

const validPublishBody = {
  kind: 'mcp_server',
  namespace: 'acme',
  name: 'pdf-tools',
  asset_version: '1.0.0',
  discovery: { name: 'acme/pdf-tools', description: 'd', version: '1.0.0' },
  runtime: { transport: 'http', url: 'https://x' },
};

beforeEach(() => jest.clearAllMocks());

describe('registry-publish handler', () => {
  test('401 without authentication', async () => {
    const res = await publishHandler(makeEvent({ requestContext: { ...makeEvent().requestContext, authorizer: undefined } }));
    expect(res.statusCode).toBe(401);
  });

  test('403 when caller is not a RegistryPublisher', async () => {
    const res = await publishHandler(makeEvent({ body: JSON.stringify(validPublishBody) }));
    expect(res.statusCode).toBe(403);
  });

  test('400 on invalid body (reserved kind)', async () => {
    const res = await publishHandler(makeEvent({
      requestContext: { ...makeEvent().requestContext, authorizer: withGroups(['RegistryPublisher']) },
      body: JSON.stringify({ ...validPublishBody, kind: 'plugin' }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test('400 on non-exact asset_version', async () => {
    const res = await publishHandler(makeEvent({
      requestContext: { ...makeEvent().requestContext, authorizer: withGroups(['RegistryPublisher']) },
      body: JSON.stringify({ ...validPublishBody, asset_version: '^1.0.0' }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test('403 when auto_approve without RegistryApprover', async () => {
    const res = await publishHandler(makeEvent({
      requestContext: { ...makeEvent().requestContext, authorizer: withGroups(['RegistryPublisher']) },
      body: JSON.stringify({ ...validPublishBody, auto_approve: true }),
    }));
    expect(res.statusCode).toBe(403);
  });

  test('201 on happy path', async () => {
    mockClient.publish.mockResolvedValue({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.0.0',
      status: 'PENDING_APPROVAL',
      storageMode: 'native',
      discovery: {},
      runtime: {} as never,
    });
    const res = await publishHandler(makeEvent({
      requestContext: { ...makeEvent().requestContext, authorizer: withGroups(['RegistryPublisher']) },
      body: JSON.stringify(validPublishBody),
    }));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.status).toBe('PENDING_APPROVAL');
  });

  test('409 on immutability collision', async () => {
    mockClient.publish.mockRejectedValue(new ConflictException({ message: 'exists', $metadata: {} }));
    const res = await publishHandler(makeEvent({
      requestContext: { ...makeEvent().requestContext, authorizer: withGroups(['RegistryPublisher']) },
      body: JSON.stringify(validPublishBody),
    }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('REGISTRY_VERSION_EXISTS');
  });
});

describe('registry-resolve handler', () => {
  const ev = (ref?: string): APIGatewayProxyEvent =>
    makeEvent({ httpMethod: 'GET', queryStringParameters: ref ? { ref } : null });

  test('400 when ref missing', async () => {
    expect((await resolveHandler(ev())).statusCode).toBe(400);
  });

  test('422 on an invalid ref (floating constraint)', async () => {
    const res = await resolveHandler(ev('registry://mcp_server/acme/pdf-tools@*'));
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.message).toContain('INVALID_CONSTRAINT');
  });

  test('200 on success', async () => {
    mockClient.resolve.mockResolvedValue({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.4.1',
      runtime: { transport: 'http', url: 'https://x' } as never,
      warnings: [],
    });
    const res = await resolveHandler(ev('registry://mcp_server/acme/pdf-tools@^1.4.1'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.version).toBe('1.4.1');
  });

  test('422 when the client fails resolution', async () => {
    mockClient.resolve.mockRejectedValue(new RegistryResolutionError('NO_MATCHING_VERSION', 'r', 'none'));
    const res = await resolveHandler(ev('registry://mcp_server/acme/pdf-tools@^9.0.0'));
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.message).toContain('NO_MATCHING_VERSION');
  });
});

describe('registry-list handler', () => {
  test('groups per asset at the highest version', async () => {
    mockClient.listRecords.mockResolvedValue([
      { kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools', version: '1.0.0', status: 'APPROVED', storageMode: 'native', discovery: {}, runtime: {} as never },
      { kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools', version: '1.2.0', status: 'APPROVED', storageMode: 'native', discovery: {}, runtime: {} as never },
    ]);
    const res = await listHandler(makeEvent({ httpMethod: 'GET' }));
    expect(res.statusCode).toBe(200);
    const assets = JSON.parse(res.body).data.assets;
    expect(assets).toHaveLength(1);
    expect(assets[0].latest_version).toBe('1.2.0');
  });
});

describe('registry-show handler', () => {
  test('404 when the asset has no versions', async () => {
    mockClient.listRecords.mockResolvedValue([]);
    const res = await showHandler(makeEvent({ httpMethod: 'GET', pathParameters: { kind: 'mcp_server', namespace: 'acme', name: 'nope' } }));
    expect(res.statusCode).toBe(404);
  });

  test('200 lists versions highest-first', async () => {
    mockClient.listRecords.mockResolvedValue([
      { kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools', version: '1.0.0', status: 'DEPRECATED', storageMode: 'native', discovery: {}, runtime: {} as never },
      { kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools', version: '1.2.0', status: 'APPROVED', storageMode: 'native', discovery: {}, runtime: {} as never },
    ]);
    const res = await showHandler(makeEvent({ httpMethod: 'GET', pathParameters: { kind: 'mcp_server', namespace: 'acme', name: 'pdf-tools' } }));
    expect(res.statusCode).toBe(200);
    const versions = JSON.parse(res.body).data.versions;
    expect(versions[0].version).toBe('1.2.0');
  });
});
