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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ID') }));

process.env.WEBHOOK_TABLE_NAME = 'Webhooks';

import { handler } from '../../src/handlers/list-webhooks';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/webhooks',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/webhooks',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
      httpMethod: 'GET',
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
      path: '/v1/webhooks',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/webhooks',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
});

describe('list-webhooks handler', () => {
  test('returns empty list', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toEqual([]);
    expect(body.pagination.has_more).toBe(false);
  });

  test('returns webhooks for user', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        { webhook_id: 'wh-1', user_id: 'user-123', name: 'CI', status: 'active', created_at: '2025-01-01', updated_at: '2025-01-01' },
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].webhook_id).toBe('wh-1');
    expect(body.data[0].name).toBe('CI');
  });

  test('supports pagination', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ webhook_id: 'wh-1', user_id: 'user-123', name: 'CI', status: 'active', created_at: '2025-01-01', updated_at: '2025-01-01' }],
      LastEvaluatedKey: { webhook_id: 'wh-1', user_id: 'user-123', created_at: '2025-01-01' },
    });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body);
    expect(body.pagination.has_more).toBe(true);
    expect(body.pagination.next_token).toBeDefined();
  });

  test('returns 401 when not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB error'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
  });
});
