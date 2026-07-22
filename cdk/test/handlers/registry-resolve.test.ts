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

const mockResolveRef = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('../../src/handlers/shared/registry-resolver', () => {
  const actual = jest.requireActual('../../src/handlers/shared/registry-resolver');
  return {
    ...actual,
    resolveRef: mockResolveRef,
  };
});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mockGetSignedUrl }));
jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.REGISTRY_ARTIFACTS_BUCKET_NAME = 'registry-artifacts';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../src/handlers/registry-resolve';
import { RegistryResolutionError } from '../../src/handlers/shared/registry-resolver';

function event(ref: string | null, authed = true): APIGatewayProxyEvent {
  return {
    queryStringParameters: ref === null ? null : { ref },
    requestContext: { authorizer: { claims: authed ? { sub: 'u' } : {} } },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSignedUrl.mockResolvedValue('https://signed.example/artifact');
});

describe('registry resolve handler', () => {
  test('401 when unauthenticated', async () => {
    const res = await handler(event('registry://mcp_server/acme/x@^1.0.0', false));
    expect(res.statusCode).toBe(401);
  });

  test('400 when ref query param is missing', async () => {
    const res = await handler(event(null));
    expect(res.statusCode).toBe(400);
  });

  test('200 with a presigned artifact URL for an mcp_server', async () => {
    mockResolveRef.mockResolvedValue({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      version: '1.4.1',
      descriptor: { summary: 's', permissions: [] },
      warnings: [],
    });
    const res = await handler(event('registry://mcp_server/acme/pdf-tools@^1.0.0'));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.version).toBe('1.4.1');
    expect(data.artifact_url).toBe('https://signed.example/artifact');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  test('422 with the specific reason on resolution failure', async () => {
    mockResolveRef.mockRejectedValue(
      new RegistryResolutionError('NO_MATCHING_VERSION', 'registry://mcp_server/acme/x@^9.0.0'),
    );
    const res = await handler(event('registry://mcp_server/acme/x@^9.0.0'));
    expect(res.statusCode).toBe(422);
    const err = JSON.parse(res.body).error;
    expect(err.code).toBe('REGISTRY_RESOLUTION_FAILED');
    expect(err.message).toContain('NO_MATCHING_VERSION');
  });

  test('does not presign for a kind without an artifact loader path', async () => {
    // capability is not in KINDS_REQUIRING_ARTIFACT
    mockResolveRef.mockResolvedValue({
      kind: 'capability',
      namespace: 'acme',
      name: 'wf',
      version: '1.0.0',
      descriptor: { summary: 's', permissions: [] },
      warnings: [],
    });
    const res = await handler(event('registry://capability/acme/wf@^1.0.0'));
    expect(res.statusCode).toBe(200);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).data.artifact_url).toBeUndefined();
  });
});
