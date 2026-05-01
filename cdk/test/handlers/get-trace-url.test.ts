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

// --- Mocks ---
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const mockGetSignedUrl = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn((input: unknown) => ({ _type: 'S3Get', input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TRACE_ARTIFACTS_BUCKET_NAME = 'trace-bucket';

import { handler, parseS3Uri, TRACE_URL_TTL_SECONDS } from '../../src/handlers/get-trace-url';

const TRACE_URI = 's3://trace-bucket/traces/user-123/task-1.jsonl.gz';
const TASK_RECORD = {
  task_id: 'task-1',
  user_id: 'user-123',
  status: 'COMPLETED',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'COMPLETED#2025-03-15T10:30:00Z',
  created_at: '2025-03-15T10:30:00Z',
  updated_at: '2025-03-15T10:31:00Z',
  trace: true,
  trace_s3_uri: TRACE_URI,
};

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/tasks/task-1/trace',
    pathParameters: { task_id: 'task-1' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks/{task_id}/trace',
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
      path: '/v1/tasks/task-1/trace',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/tasks/{task_id}/trace',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ Item: TASK_RECORD });
  mockGetSignedUrl.mockResolvedValue('https://example.com/presigned?sig=abc');
});

describe('get-trace-url handler', () => {
  test('returns presigned URL + expires_at for a trace-enabled task', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.url).toBe('https://example.com/presigned?sig=abc');
    expect(typeof body.data.expires_at).toBe('string');
    // Should parse as a future ISO timestamp ~15 min out
    const expiresAt = new Date(body.data.expires_at).getTime();
    const now = Date.now();
    const delta = expiresAt - now;
    expect(delta).toBeGreaterThan((TRACE_URL_TTL_SECONDS - 5) * 1000);
    expect(delta).toBeLessThanOrEqual((TRACE_URL_TTL_SECONDS + 5) * 1000);
  });

  test('calls getSignedUrl with the expected TTL (15 min)', async () => {
    await handler(makeEvent());

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = mockGetSignedUrl.mock.calls[0];
    expect(command.input.Bucket).toBe('trace-bucket');
    expect(command.input.Key).toBe('traces/user-123/task-1.jsonl.gz');
    expect(options).toEqual({ expiresIn: TRACE_URL_TTL_SECONDS });
  });

  test('returns 401 when user is not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe('UNAUTHORIZED');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 400 when task_id is missing', async () => {
    const result = await handler(makeEvent({ pathParameters: null }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 404 when task does not exist', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TASK_NOT_FOUND');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('returns 403 when task belongs to another user', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ...TASK_RECORD, user_id: 'other-user' },
    });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('returns 404 TRACE_NOT_AVAILABLE when trace_s3_uri is absent', async () => {
    const { trace_s3_uri: _unused, ...recordWithoutTrace } = TASK_RECORD;
    mockSend.mockResolvedValueOnce({ Item: recordWithoutTrace });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('TRACE_NOT_AVAILABLE');
    expect(JSON.parse(result.body).error.message).toMatch(/--trace/);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('returns 500 when trace_s3_uri is malformed', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { ...TASK_RECORD, trace_s3_uri: 'not-an-s3-uri' },
    });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
    expect(JSON.parse(result.body).error.message).toMatch(/malformed/);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('returns 500 when trace_s3_uri points at an unexpected bucket (defense in depth)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        ...TASK_RECORD,
        trace_s3_uri: 's3://attacker-bucket/traces/user-123/task-1.jsonl.gz',
      },
    });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
    expect(JSON.parse(result.body).error.message).toMatch(/unexpected bucket/);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('returns 403 when trace key is not under the caller\'s user prefix', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        ...TASK_RECORD,
        // Bucket matches, but the key is under a different user prefix
        trace_s3_uri: 's3://trace-bucket/traces/other-user/task-1.jsonl.gz',
      },
    });
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DB failure'));
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });

  test('returns 500 on S3 presign error', async () => {
    mockGetSignedUrl.mockRejectedValueOnce(new Error('presign boom'));
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });

  test('includes standard headers and X-Request-Id', async () => {
    const result = await handler(makeEvent());

    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['X-Request-Id']).toBe('REQ-ULID');
  });
});

describe('parseS3Uri', () => {
  test('parses a valid s3:// URI', () => {
    expect(parseS3Uri('s3://bucket/path/to/object.jsonl.gz')).toEqual({
      bucket: 'bucket',
      key: 'path/to/object.jsonl.gz',
    });
  });

  test('rejects non-s3:// schemes', () => {
    expect(parseS3Uri('https://bucket/key')).toBeNull();
    expect(parseS3Uri('s3:/bucket/key')).toBeNull();
  });

  test('rejects missing bucket', () => {
    expect(parseS3Uri('s3:///key')).toBeNull();
  });

  test('rejects missing key', () => {
    expect(parseS3Uri('s3://bucket/')).toBeNull();
    expect(parseS3Uri('s3://bucket')).toBeNull();
  });

  test('preserves nested key paths', () => {
    expect(parseS3Uri('s3://b/a/b/c/d.txt')).toEqual({ bucket: 'b', key: 'a/b/c/d.txt' });
  });

  test('pins behavior on double-slash keys (leading / preserved in key)', () => {
    // Current implementation produces ``key='/object'`` on ``s3://bucket//object``.
    // S3 accepts this as a distinct key; the handler's prefix check then
    // rejects it (key does not start with ``traces/<uid>/``). Pinning
    // the shape so a future parser refactor does not silently change
    // it.
    expect(parseS3Uri('s3://bucket//object')).toEqual({ bucket: 'bucket', key: '/object' });
  });

  test('pins behavior on query-string-like suffixes (treated as literal key chars)', () => {
    // S3 object keys can legally contain ``?`` and ``#``. The parser
    // treats the entire post-bucket path as the key — it does NOT
    // URL-decode or strip query fragments. The handler's bucket +
    // prefix guards still gate these; pinning behavior here so a
    // future ``new URL(...)`` rewrite has an explicit contract to
    // maintain (``URL`` would split off ``?`` into ``search``).
    expect(parseS3Uri('s3://bucket/traces/u/t.jsonl.gz?x=1')).toEqual({
      bucket: 'bucket',
      key: 'traces/u/t.jsonl.gz?x=1',
    });
    expect(parseS3Uri('s3://bucket/traces/u/t.jsonl.gz#frag')).toEqual({
      bucket: 'bucket',
      key: 'traces/u/t.jsonl.gz#frag',
    });
  });
});
