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
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ') }));

process.env.API_KEY_TABLE_NAME = 'ApiKeys';

import { handler } from '../../src/handlers/list-api-keys';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/api-keys',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/api-keys',
    requestContext: {
      authorizer: { claims: { sub: 'owner-1' } },
    } as never,
    ...overrides,
  };
}

const record = {
  key_id: 'k1',
  user_id: 'owner-1',
  name: 'ci',
  key_hash: 'deadbeef',
  scopes: ['webhooks:manage'],
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockResolvedValue({ Items: [record] });
});

describe('list-api-keys handler', () => {
  test('lists keys for the caller and strips the hash + owner', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].key_id).toBe('k1');
    expect(body.data[0]).not.toHaveProperty('key_hash');
    expect(body.data[0]).not.toHaveProperty('user_id');
  });

  test('queries UserIndex keyed by the caller', async () => {
    await handler(makeEvent());
    const q = mockDdbSend.mock.calls[0][0].input;
    expect(q.IndexName).toBe('UserIndex');
    expect(q.ExpressionAttributeValues[':uid']).toBe('owner-1');
  });

  test('filters to active keys by default', async () => {
    await handler(makeEvent());
    const q = mockDdbSend.mock.calls[0][0].input;
    expect(q.FilterExpression).toBe('#s = :active');
    expect(q.ExpressionAttributeValues[':active']).toBe('active');
  });

  test('includes revoked keys when include_revoked=true', async () => {
    await handler(makeEvent({ queryStringParameters: { include_revoked: 'true' } }));
    const q = mockDdbSend.mock.calls[0][0].input;
    expect(q.FilterExpression).toBeUndefined();
  });

  test('returns 401 when unauthenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns 500 on a DynamoDB error', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DDB error'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
  });
});
