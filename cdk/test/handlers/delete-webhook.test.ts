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

import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const mockSmSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSmSend })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ID') }));

process.env.WEBHOOK_TABLE_NAME = 'Webhooks';
process.env.WEBHOOK_RETENTION_DAYS = '30';

import { handler } from '../../src/handlers/delete-webhook';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'DELETE',
    isBase64Encoded: false,
    path: '/v1/webhooks/wh-123',
    pathParameters: { webhook_id: 'wh-123' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/webhooks/{webhook_id}',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
      httpMethod: 'DELETE',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test/1.0',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      path: '/v1/webhooks/wh-123',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/webhooks/{webhook_id}',
      stage: 'v1',
    },
    ...overrides,
  };
}

const activeRecord = {
  webhook_id: 'wh-123',
  user_id: 'user-123',
  name: 'CI',
  status: 'active',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend
    .mockResolvedValueOnce({ Item: activeRecord }) // GetCommand
    .mockResolvedValueOnce({ Attributes: { ...activeRecord, status: 'revoked', revoked_at: '2025-06-01' } }); // UpdateCommand
  mockSmSend.mockResolvedValue({});
});

describe('delete-webhook handler', () => {
  test('revokes webhook successfully', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe('revoked');
    expect(mockSmSend).toHaveBeenCalledTimes(1); // DeleteSecret
  });

  test('returns 404 when webhook not found', async () => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('WEBHOOK_NOT_FOUND');
  });

  test('returns 404 when different user owns webhook', async () => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValueOnce({
      Item: { ...activeRecord, user_id: 'other-user' },
    });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
  });

  test('returns 409 when webhook already revoked', async () => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValueOnce({
      Item: { ...activeRecord, status: 'revoked' },
    });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('WEBHOOK_ALREADY_REVOKED');
  });

  test('returns 401 when not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('stamps TTL on webhook revocation', async () => {
    mockDdbSend.mockReset();
    mockDdbSend
      .mockResolvedValueOnce({ Item: activeRecord }) // GetCommand
      .mockResolvedValueOnce({ Attributes: { ...activeRecord, status: 'revoked', revoked_at: '2025-06-01' } }); // UpdateCommand
    mockSmSend.mockResolvedValue({});

    await handler(makeEvent());

    const updateCall = mockDdbSend.mock.calls[1][0];
    expect(updateCall.input.UpdateExpression).toContain('#ttl = :ttl');
    expect(updateCall.input.ExpressionAttributeNames['#ttl']).toBe('ttl');
    expect(typeof updateCall.input.ExpressionAttributeValues[':ttl']).toBe('number');
  });

  test('succeeds even if secret deletion fails', async () => {
    mockSmSend.mockRejectedValueOnce(new Error('SM error'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
  });
});
