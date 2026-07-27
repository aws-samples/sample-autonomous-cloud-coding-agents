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

function makeRecord(n: number, status: 'active' | 'revoked' = 'active') {
  return {
    key_id: `k${n}`,
    user_id: 'owner-1',
    name: `ci-${n}`,
    key_hash: 'deadbeef',
    scopes: ['webhooks:manage'],
    status,
    created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const record = makeRecord(1);

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

  describe('pagination (finding #1: Limit is applied pre-filter)', () => {
    test('over-fetches limit+1 so a full page can prove another item exists', async () => {
      await handler(makeEvent({ queryStringParameters: { limit: '20' } }));
      const q = mockDdbSend.mock.calls[0][0].input;
      expect(q.Limit).toBe(21);
    });

    test('a single page short of the limit reports has_more=false with no token', async () => {
      // Fewer active items than requested, table exhausted (no LastEvaluatedKey).
      mockDdbSend.mockResolvedValueOnce({ Items: [makeRecord(1), makeRecord(2)] });
      const result = await handler(makeEvent({ queryStringParameters: { limit: '20' } }));
      const body = JSON.parse(result.body);
      expect(body.data).toHaveLength(2);
      expect(body.pagination.has_more).toBe(false);
      expect(body.pagination.next_token).toBeNull();
      expect(mockDdbSend).toHaveBeenCalledTimes(1);
    });

    test('keeps querying past filtered-out pages until the page is full', async () => {
      // Page 1: Limit applied before filter yields 0 active but a cursor remains.
      mockDdbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { key_id: 'k0' } });
      // Page 2: enough active keys to fill limit=2 plus one extra.
      mockDdbSend.mockResolvedValueOnce({
        Items: [makeRecord(3), makeRecord(2), makeRecord(1)],
        LastEvaluatedKey: { key_id: 'k1' },
      });

      const result = await handler(makeEvent({ queryStringParameters: { limit: '2' } }));
      const body = JSON.parse(result.body);

      expect(mockDdbSend).toHaveBeenCalledTimes(2);
      expect(body.data).toHaveLength(2);
      expect(body.data.map((k: { key_id: string }) => k.key_id)).toEqual(['k3', 'k2']);
      expect(body.pagination.has_more).toBe(true);
      expect(body.pagination.next_token).not.toBeNull();
    });

    test('next_token resumes from the last returned record, not the scan boundary', async () => {
      mockDdbSend.mockResolvedValueOnce({
        Items: [makeRecord(3), makeRecord(2), makeRecord(1)],
        LastEvaluatedKey: { key_id: 'k-scanned-past' },
      });
      const result = await handler(makeEvent({ queryStringParameters: { limit: '2' } }));
      const body = JSON.parse(result.body);

      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      // Boundary is the last item actually returned (k2), so k1 is not skipped.
      expect(decoded).toEqual({ key_id: 'k2', user_id: 'owner-1', created_at: makeRecord(2).created_at });
    });

    test('stops after the page cap and still advances the raw cursor', async () => {
      // Every page filters to nothing but keeps returning a cursor.
      mockDdbSend.mockResolvedValue({ Items: [], LastEvaluatedKey: { key_id: 'kX' } });
      const result = await handler(makeEvent({ queryStringParameters: { limit: '20' } }));
      const body = JSON.parse(result.body);

      expect(mockDdbSend).toHaveBeenCalledTimes(10); // MAX_QUERY_PAGES
      expect(body.data).toHaveLength(0);
      // We bailed on the cap with a scan cursor still pending, so hand it back
      // rather than falsely reporting the list is complete. No boundary record
      // exists (nothing returned), so we fall through to DynamoDB's raw cursor.
      expect(body.pagination.has_more).toBe(true);
      const decoded = JSON.parse(Buffer.from(body.pagination.next_token, 'base64').toString('utf-8'));
      expect(decoded).toEqual({ key_id: 'kX' });
    });
  });
});
