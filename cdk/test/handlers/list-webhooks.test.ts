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

function makeRecord(n: number) {
  return {
    webhook_id: `wh-${n}`,
    user_id: 'user-123',
    name: `ci-${n}`,
    status: 'active',
    created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    updated_at: '2026-01-01T00:00:00Z',
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

  describe('pagination (Limit is applied before the revoked filter)', () => {
    test('over-fetches limit+1 so a full page can prove another webhook exists', async () => {
      await handler(makeEvent({ queryStringParameters: { limit: '20' } }));
      const q = mockSend.mock.calls[0][0].input;
      expect(q.Limit).toBe(21);
    });

    test('passes next_token as ExclusiveStartKey', async () => {
      const key = { webhook_id: 'wh-1' };
      const token = Buffer.from(JSON.stringify(key)).toString('base64');

      await handler(makeEvent({ queryStringParameters: { next_token: token } }));

      expect(mockSend.mock.calls[0][0].input.ExclusiveStartKey).toEqual(key);
    });

    test('returns 400 for a next_token that cannot be decoded', async () => {
      const cut = Buffer.from('{"webhook_id":"w').toString('base64');
      const result = await handler(makeEvent({ queryStringParameters: { next_token: cut } }));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid next_token.' });
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('a single page short of the limit reports has_more=false with no token', async () => {
      mockSend.mockResolvedValueOnce({ Items: [makeRecord(2), makeRecord(1)] });
      const result = await handler(makeEvent({ queryStringParameters: { limit: '20' } }));
      const body = JSON.parse(result.body);
      expect(body.data).toHaveLength(2);
      expect(body.pagination.has_more).toBe(false);
      expect(body.pagination.next_token).toBeNull();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('keeps querying past filtered-out pages until the page is full', async () => {
      mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { webhook_id: 'wh-0' } });
      mockSend.mockResolvedValue({
        Items: [makeRecord(3), makeRecord(2), makeRecord(1)],
        LastEvaluatedKey: { webhook_id: 'wh-1' },
      });

      const result = await handler(makeEvent({ queryStringParameters: { limit: '2' } }));
      const body = JSON.parse(result.body);

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ webhook_id: 'wh-0' });
      expect(body.data.map((w: { webhook_id: string }) => w.webhook_id)).toEqual(['wh-3', 'wh-2']);
      expect(body.pagination.has_more).toBe(true);
      expect(body.pagination.next_token).not.toBeNull();
    });

    test('next_token resumes from the last returned webhook, not the scan boundary', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [makeRecord(3), makeRecord(2), makeRecord(1)],
        LastEvaluatedKey: { webhook_id: 'wh-scanned-past' },
      });
      const result = await handler(makeEvent({ queryStringParameters: { limit: '2' } }));
      const body = JSON.parse(result.body);

      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      expect(decoded).toEqual({ webhook_id: 'wh-2', user_id: 'user-123', created_at: makeRecord(2).created_at });
    });

    test('stops after the page cap and still advances the raw cursor', async () => {
      mockSend.mockResolvedValue({ Items: [], LastEvaluatedKey: { webhook_id: 'wh-x' } });
      const result = await handler(makeEvent({ queryStringParameters: { limit: '20' } }));
      const body = JSON.parse(result.body);

      expect(mockSend).toHaveBeenCalledTimes(10);
      expect(body.data).toHaveLength(0);
      expect(body.pagination.has_more).toBe(true);
      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      expect(decoded).toEqual({ webhook_id: 'wh-x' });
    });
  });
});
