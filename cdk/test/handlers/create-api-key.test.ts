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
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.API_KEY_TABLE_NAME = 'ApiKeys';

import { handler } from '../../src/handlers/create-api-key';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ name: 'CI key' }),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/api-keys',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/api-keys',
    requestContext: {
      authorizer: { claims: { sub: 'user-123' } },
    } as never,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockDdbSend.mockResolvedValue({});
});

describe('create-api-key handler', () => {
  test('creates a key and returns the plaintext once', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.key_id).toBeDefined();
    expect(body.data.name).toBe('CI key');
    expect(body.data.key).toMatch(/^bgak_/);
    expect(body.data.scopes).toEqual(['webhooks:manage']);
    expect(body.data.expires_at).toBeNull();
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('persists only the hash, never the plaintext secret', async () => {
    const result = await handler(makeEvent());
    const plaintext = JSON.parse(result.body).data.key;
    const putItem = mockDdbSend.mock.calls[0][0].input.Item;
    expect(putItem.key_hash).toBeDefined();
    expect(putItem).not.toHaveProperty('key');
    expect(putItem).not.toHaveProperty('secret');
    expect(JSON.stringify(putItem)).not.toContain(plaintext.split('_')[2]);
  });

  test('accepts a custom valid scope list', async () => {
    const event = makeEvent({ body: JSON.stringify({ name: 'ops', scopes: ['tasks:read'] }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body).data.scopes).toEqual(['tasks:read']);
  });

  test('rejects an unknown scope', async () => {
    const event = makeEvent({ body: JSON.stringify({ name: 'x', scopes: ['bogus:scope'] }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('rejects an empty scope array', async () => {
    const event = makeEvent({ body: JSON.stringify({ name: 'x', scopes: [] }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('accepts a future expires_at and echoes it back', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const event = makeEvent({ body: JSON.stringify({ name: 'x', expires_at: future }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body).data.expires_at).toBe(future);
  });

  test('rejects a past expires_at', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const event = makeEvent({ body: JSON.stringify({ name: 'x', expires_at: past }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('rejects a non-ISO expires_at', async () => {
    const event = makeEvent({ body: JSON.stringify({ name: 'x', expires_at: 'not-a-date' }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 401 when not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns 400 for missing body', async () => {
    const result = await handler(makeEvent({ body: null }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 for invalid name', async () => {
    const result = await handler(makeEvent({ body: JSON.stringify({ name: '-bad' }) }));
    expect(result.statusCode).toBe(400);
  });

  test('returns 500 when the DynamoDB write fails', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DDB error'));
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(500);
  });
});
