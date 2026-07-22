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
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'PutObject', input })),
}));
jest.mock('../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

process.env.REGISTRY_ASSETS_TABLE_NAME = 'RegistryAssets';
process.env.REGISTRY_ARTIFACTS_BUCKET_NAME = 'registry-artifacts';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../src/handlers/registry-publish';

function event(opts: {
  groups?: string[];
  body?: unknown;
  authed?: boolean;
  autoApprove?: boolean;
}): APIGatewayProxyEvent {
  const claims: Record<string, unknown> = {};
  if (opts.authed !== false) claims.sub = 'user-123';
  if (opts.groups) claims['cognito:groups'] = opts.groups;
  return {
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    queryStringParameters: opts.autoApprove ? { auto_approve: 'true' } : null,
    requestContext: { authorizer: { claims } },
  } as unknown as APIGatewayProxyEvent;
}

const validBody = {
  kind: 'mcp_server',
  namespace: 'acme',
  name: 'pdf-tools',
  version: '1.4.1',
  descriptor: { summary: 'PDF', permissions: [], transport: 'http', tool_prefix: 'mcp__pdf__' },
  artifact_b64: Buffer.from('{}').toString('base64'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockS3Send.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});
});

describe('registry publish handler', () => {
  test('401 when unauthenticated', async () => {
    const res = await handler(event({ authed: false, body: validBody }));
    expect(res.statusCode).toBe(401);
  });

  test('403 when caller is in no registry group', async () => {
    const res = await handler(event({ groups: ['SomeOtherGroup'], body: validBody }));
    expect(res.statusCode).toBe(403);
  });

  test('publishes as submitted for a RegistryPublisher', async () => {
    const res = await handler(event({ groups: ['RegistryPublisher'], body: validBody }));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.status).toBe('submitted');
    // artifact uploaded, then record written
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('auto_approve lands approved only for an approver', async () => {
    const approver = await handler(event({ groups: ['RegistryApprover'], body: validBody, autoApprove: true }));
    expect(JSON.parse(approver.body).data.status).toBe('approved');

    // a plain publisher asking for auto_approve still lands submitted
    const publisher = await handler(event({ groups: ['RegistryPublisher'], body: validBody, autoApprove: true }));
    expect(JSON.parse(publisher.body).data.status).toBe('submitted');
  });

  test('400 on descriptor validation failure', async () => {
    const res = await handler(
      event({ groups: ['RegistryPublisher'], body: { ...validBody, version: '^1.4.1' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('409 on version immutability collision', async () => {
    mockDdbSend.mockRejectedValueOnce(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }),
    );
    const res = await handler(event({ groups: ['RegistryPublisher'], body: validBody }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('REGISTRY_VERSION_EXISTS');
  });

  test('write is guarded by attribute_not_exists on pk and sk', async () => {
    await handler(event({ groups: ['RegistryPublisher'], body: validBody }));
    const putInput = mockDdbSend.mock.calls[0][0].input;
    expect(putInput.ConditionExpression).toContain('attribute_not_exists(pk)');
    expect(putInput.ConditionExpression).toContain('attribute_not_exists(sk)');
  });

  test('400 on non-JSON body', async () => {
    const res = await handler({
      body: 'not json',
      queryStringParameters: null,
      requestContext: { authorizer: { claims: { 'sub': 'u', 'cognito:groups': ['RegistryPublisher'] } } },
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(400);
  });
});
