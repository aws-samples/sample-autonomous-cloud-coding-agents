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

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ') }));

process.env.API_KEY_TABLE_NAME = 'ApiKeys';

import { handler } from '../../src/handlers/delete-api-key';

const KEY_ID = 'key-abc';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'DELETE',
    isBase64Encoded: false,
    path: `/v1/api-keys/${KEY_ID}`,
    pathParameters: { key_id: KEY_ID },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/api-keys/{key_id}',
    requestContext: {
      authorizer: { claims: { sub: 'owner-1' } },
    } as never,
    ...overrides,
  };
}

const activeItem = {
  Item: { key_id: KEY_ID, user_id: 'owner-1', name: 'ci', status: 'active', scopes: ['webhooks:manage'] },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('delete-api-key handler', () => {
  test('soft-revokes an owned active key', async () => {
    mockDdbSend
      .mockResolvedValueOnce(activeItem)
      .mockResolvedValueOnce({ Attributes: { ...activeItem.Item, status: 'revoked', updated_at: 'now', revoked_at: 'now' } });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data.status).toBe('revoked');
    const update = mockDdbSend.mock.calls[1][0];
    expect(update._type).toBe('Update');
  });

  test('returns 404 (not 403) when the key belongs to another user', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { ...activeItem.Item, user_id: 'someone-else' } });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('API_KEY_NOT_FOUND');
    // must not attempt the update
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('returns 404 when the key does not exist', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(404);
  });

  test('returns 409 when the key is already revoked', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { ...activeItem.Item, status: 'revoked' } });
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('API_KEY_ALREADY_REVOKED');
  });

  test('returns 401 when unauthenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns 400 when key_id path param is missing', async () => {
    const result = await handler(makeEvent({ pathParameters: null }));
    expect(result.statusCode).toBe(400);
  });
});
