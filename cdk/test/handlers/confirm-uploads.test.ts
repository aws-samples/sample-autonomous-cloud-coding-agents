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

import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

// --- Mocks ---
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (...args: unknown[]) => s3Send(...args) })),
  DeleteObjectsCommand: jest.fn((input: unknown) => ({ _type: 'S3Delete', input })),
  GetObjectCommand: jest.fn((input: unknown) => ({ _type: 'S3Get', input })),
  HeadObjectCommand: jest.fn((input: unknown) => ({ _type: 'S3Head', input })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'S3Put', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({})),
}));

jest.mock('../../src/handlers/shared/attachment-screening', () => ({
  screenImage: jest.fn(),
  screenTextFile: jest.fn(),
  AttachmentScreeningError: class extends Error { constructor(msg: string) { super(msg); this.name = 'AttachmentScreeningError'; } },
}));

jest.mock('../../src/handlers/shared/image-tokens', () => ({
  estimateImageTokensFromBuffer: jest.fn(() => 100),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'ULID-1') }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'Events';
process.env.ATTACHMENTS_BUCKET_NAME = 'attachments-bucket';
process.env.USER_CONCURRENCY_TABLE_NAME = 'Concurrency';
process.env.MAX_CONCURRENT_TASKS_PER_USER = '3';
process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123:function:orchestrator';
process.env.GUARDRAIL_ID = 'guardrail-1';
process.env.GUARDRAIL_VERSION = '1';

import { handler } from '../../src/handlers/confirm-uploads';

function makeEvent(taskId: string, userId = 'user-1'): APIGatewayProxyEvent {
  return {
    pathParameters: { task_id: taskId },
    requestContext: {
      authorizer: { claims: { sub: userId } },
    },
    headers: {},
    body: null,
  } as unknown as APIGatewayProxyEvent;
}

function makeContext(remainingMs: number): Context {
  return {
    getRemainingTimeInMillis: jest.fn(() => remainingMs),
    functionName: 'confirm-uploads',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123:function:confirm-uploads',
    memoryLimitInMB: '2048',
    awsRequestId: 'req-1',
    logGroupName: '/aws/lambda/confirm-uploads',
    logStreamName: '2025/01/01/[1]abc',
    callbackWaitsForEmptyEventLoop: true,
    done: jest.fn(),
    fail: jest.fn(),
    succeed: jest.fn(),
  };
}

const PENDING_TASK = {
  task_id: 'task-1',
  user_id: 'user-1',
  status: 'PENDING_UPLOADS',
  repo: 'org/repo',
  branch_name: 'bgagent/task-1/fix',
  channel_source: 'api',
  status_created_at: 'PENDING_UPLOADS#2025-03-15T10:30:00Z',
  created_at: '2025-03-15T10:30:00Z',
  updated_at: '2025-03-15T10:30:00Z',
  attachments: [
    {
      attachment_id: 'att-1',
      type: 'image',
      content_type: 'image/png',
      filename: 'screenshot.png',
      s3_key: 'attachments/user-1/task-1/att-1/screenshot.png',
      size_bytes: 1024,
      screening: { status: 'pending' },
    },
    {
      attachment_id: 'att-2',
      type: 'file',
      content_type: 'text/plain',
      filename: 'notes.txt',
      s3_key: 'attachments/user-1/task-1/att-2/notes.txt',
      size_bytes: 512,
      screening: { status: 'pending' },
    },
  ],
};

describe('confirm-uploads handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    s3Send.mockReset();
    lambdaSend.mockReset();
  });

  test('returns 401 when no auth', async () => {
    const event = { pathParameters: { task_id: 'task-1' }, requestContext: { authorizer: {} }, headers: {}, body: null } as unknown as APIGatewayProxyEvent;
    const result = await handler(event, makeContext(180_000));
    expect(result.statusCode).toBe(401);
  });

  test('returns 404 when task not found', async () => {
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(404);
  });

  test('returns 404 when caller does not own the task', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { ...PENDING_TASK, user_id: 'other-user' } });
    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(404);
  });

  test('returns 200 idempotently when task is already SUBMITTED', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { ...PENDING_TASK, status: 'SUBMITTED' } });
    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(200);
  });

  test('returns 409 when task is in a terminal status', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { ...PENDING_TASK, status: 'CANCELLED' } });
    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(409);
  });

  test('returns 503 with Retry-After when deadline is exceeded before screening starts', async () => {
    ddbSend.mockResolvedValueOnce({ Item: PENDING_TASK });
    // HeadObject succeeds for both attachments
    s3Send
      .mockResolvedValueOnce({ VersionId: 'v1', ContentLength: 1024 })
      .mockResolvedValueOnce({ VersionId: 'v2', ContentLength: 512 });

    // Context reports only 10s remaining (below the 15s deadline margin)
    const context = makeContext(10_000);
    const result = await handler(makeEvent('task-1'), context);

    expect(result.statusCode).toBe(503);
    expect(result.headers?.['Retry-After']).toBe('30');
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('SCREENING_DEADLINE_EXCEEDED');
    expect(body.error.message).toContain('did not complete within the time limit');
  });

  test('returns 400 when uploads are missing (HeadObject 404)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: PENDING_TASK });
    // HeadObject returns 404 for first attachment after all retries
    s3Send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });

    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('ATTACHMENT_UPLOAD_MISSING');
  });

  test('happy path: HeadObject → screen → transition to SUBMITTED → invoke orchestrator', async () => {
    const { screenImage, screenTextFile } = jest.requireMock('../../src/handlers/shared/attachment-screening');

    const pngContent = Buffer.alloc(1024);
    pngContent.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const textContent = Buffer.alloc(512);
    textContent.write('hello world');

    // Screening passes
    screenImage.mockResolvedValue({
      content: pngContent,
      contentType: 'image/png',
      checksum: 'abc123',
      screening: { status: 'passed' },
    });
    screenTextFile.mockResolvedValue({
      content: textContent,
      contentType: 'text/plain',
      checksum: 'def456',
      screening: { status: 'passed' },
    });

    // Use mockImplementation to route DDB calls correctly
    let ddbCallCount = 0;
    ddbSend.mockImplementation(() => {
      ddbCallCount++;
      switch (ddbCallCount) {
        case 1: return Promise.resolve({ Item: PENDING_TASK }); // GetCommand (task)
        case 2: return Promise.resolve({ Item: { active_count: 1 } }); // GetCommand (concurrency pre-check)
        case 3: return Promise.resolve({}); // UpdateCommand (checkConcurrency)
        case 4: return Promise.resolve({}); // UpdateCommand (status transition)
        case 5: return Promise.resolve({}); // PutCommand (event)
        default: return Promise.resolve({});
      }
    });

    // Use mockImplementation for S3 calls to handle interleaving
    let s3CallCount = 0;
    s3Send.mockImplementation((cmd: any) => {
      s3CallCount++;
      if (cmd._type === 'S3Head') {
        // HeadObject — return valid metadata
        const isAtt1 = cmd.input.Key?.includes('att-1');
        return Promise.resolve({
          VersionId: isAtt1 ? 'v1' : 'v2',
          ContentLength: isAtt1 ? 1024 : 512,
        });
      }
      if (cmd._type === 'S3Get') {
        // GetObject — return content for screening
        const isAtt1 = cmd.input.Key?.includes('att-1');
        const content = isAtt1 ? pngContent : textContent;
        return Promise.resolve({
          Body: { transformToByteArray: () => content },
        });
      }
      if (cmd._type === 'S3Put') {
        return Promise.resolve({ VersionId: 'v-screened' });
      }
      return Promise.resolve({});
    });

    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent('task-1'), makeContext(180_000));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe('SUBMITTED');
    expect(lambdaSend).toHaveBeenCalled();
  });

  test('returns 429 when concurrency pre-check fails', async () => {
    ddbSend.mockResolvedValueOnce({ Item: PENDING_TASK });
    s3Send
      .mockResolvedValueOnce({ VersionId: 'v1', ContentLength: 1024 })
      .mockResolvedValueOnce({ VersionId: 'v2', ContentLength: 512 });

    // Concurrency pre-check shows user is at limit
    ddbSend.mockResolvedValueOnce({ Item: { active_count: 3 } });

    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(429);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  test('returns 400 ATTACHMENT_BLOCKED when screening rejects content', async () => {
    const { screenImage, AttachmentScreeningError } = jest.requireMock('../../src/handlers/shared/attachment-screening');

    ddbSend.mockResolvedValueOnce({ Item: PENDING_TASK });
    s3Send
      .mockResolvedValueOnce({ VersionId: 'v1', ContentLength: 1024 })
      .mockResolvedValueOnce({ VersionId: 'v2', ContentLength: 512 });

    // Pre-check passes
    ddbSend.mockResolvedValueOnce({ Item: { active_count: 0 } });

    // GetObject for first attachment
    const pngContent = Buffer.alloc(1024);
    s3Send.mockResolvedValueOnce({ Body: { transformToByteArray: () => pngContent } });

    // Screening blocks the image
    screenImage.mockRejectedValueOnce(new AttachmentScreeningError('Inappropriate content detected'));

    // DDB updates for failure (conditional write + event)
    ddbSend.mockResolvedValue({});
    // S3 cleanup (delete objects)
    s3Send.mockResolvedValue({});

    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('ATTACHMENT_BLOCKED');
  });

  test('skips S3 cleanup when failTaskOnScreening loses the race (ConditionalCheckFailedException)', async () => {
    const { screenImage, AttachmentScreeningError } = jest.requireMock('../../src/handlers/shared/attachment-screening');

    ddbSend.mockResolvedValueOnce({ Item: PENDING_TASK });
    s3Send
      .mockResolvedValueOnce({ VersionId: 'v1', ContentLength: 1024 })
      .mockResolvedValueOnce({ VersionId: 'v2', ContentLength: 512 });

    // Pre-check passes
    ddbSend.mockResolvedValueOnce({ Item: { active_count: 0 } });

    // GetObject for first attachment
    const pngContent = Buffer.alloc(1024);
    s3Send.mockResolvedValueOnce({ Body: { transformToByteArray: () => pngContent } });

    // Screening blocks the image
    screenImage.mockRejectedValueOnce(new AttachmentScreeningError('Inappropriate content detected'));

    // failTaskOnScreening conditional write fails — another caller already transitioned
    const condErr = new Error('The conditional request failed');
    condErr.name = 'ConditionalCheckFailedException';
    ddbSend.mockRejectedValueOnce(condErr);

    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(400);

    // S3 DeleteObjectsCommand should NOT have been called (only Head + Get calls)
    const s3DeleteCalls = s3Send.mock.calls.filter(
      (call: any[]) => call[0]?._type === 'S3Delete',
    );
    expect(s3DeleteCalls).toHaveLength(0);
  });

  test('does not re-upload content to S3 after screening passes (no redundant PUT)', async () => {
    const { screenImage, screenTextFile } = jest.requireMock('../../src/handlers/shared/attachment-screening');

    const pngContent = Buffer.alloc(1024);
    pngContent.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const textContent = Buffer.alloc(512);
    textContent.write('hello world');

    screenImage.mockResolvedValue({
      content: pngContent,
      contentType: 'image/png',
      checksum: 'abc123',
      screening: { status: 'passed' },
    });
    screenTextFile.mockResolvedValue({
      content: textContent,
      contentType: 'text/plain',
      checksum: 'def456',
      screening: { status: 'passed' },
    });

    let ddbCallCount = 0;
    ddbSend.mockImplementation(() => {
      ddbCallCount++;
      switch (ddbCallCount) {
        case 1: return Promise.resolve({ Item: PENDING_TASK });
        case 2: return Promise.resolve({ Item: { active_count: 1 } });
        case 3: return Promise.resolve({});
        case 4: return Promise.resolve({});
        case 5: return Promise.resolve({});
        default: return Promise.resolve({});
      }
    });

    s3Send.mockImplementation((cmd: any) => {
      if (cmd._type === 'S3Head') {
        const isAtt1 = cmd.input.Key?.includes('att-1');
        return Promise.resolve({
          VersionId: isAtt1 ? 'v1' : 'v2',
          ContentLength: isAtt1 ? 1024 : 512,
        });
      }
      if (cmd._type === 'S3Get') {
        const isAtt1 = cmd.input.Key?.includes('att-1');
        return Promise.resolve({
          Body: { transformToByteArray: () => (isAtt1 ? pngContent : textContent) },
        });
      }
      if (cmd._type === 'S3Put') {
        return Promise.resolve({ VersionId: 'v-screened' });
      }
      return Promise.resolve({});
    });

    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(200);

    // Verify NO S3 PutObject calls were made
    const s3PutCalls = s3Send.mock.calls.filter(
      (call: any[]) => call[0]?._type === 'S3Put',
    );
    expect(s3PutCalls).toHaveLength(0);
  });

  test('uses original versionId and size from HeadObject in attachment record after screening', async () => {
    const { screenImage, screenTextFile } = jest.requireMock('../../src/handlers/shared/attachment-screening');

    const pngContent = Buffer.alloc(1024);
    pngContent.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const textContent = Buffer.alloc(512);
    textContent.write('hello world');

    screenImage.mockResolvedValue({
      content: pngContent,
      contentType: 'image/png',
      checksum: 'abc123',
      screening: { status: 'passed' },
    });
    screenTextFile.mockResolvedValue({
      content: textContent,
      contentType: 'text/plain',
      checksum: 'def456',
      screening: { status: 'passed' },
    });

    let ddbCallCount = 0;
    ddbSend.mockImplementation(() => {
      ddbCallCount++;
      switch (ddbCallCount) {
        case 1: return Promise.resolve({ Item: PENDING_TASK });
        case 2: return Promise.resolve({ Item: { active_count: 0 } });
        case 3: return Promise.resolve({});
        case 4: return Promise.resolve({});
        case 5: return Promise.resolve({});
        default: return Promise.resolve({});
      }
    });

    s3Send.mockImplementation((cmd: any) => {
      if (cmd._type === 'S3Head') {
        const isAtt1 = cmd.input.Key?.includes('att-1');
        return Promise.resolve({
          VersionId: isAtt1 ? 'original-v1' : 'original-v2',
          ContentLength: isAtt1 ? 1024 : 512,
        });
      }
      if (cmd._type === 'S3Get') {
        const isAtt1 = cmd.input.Key?.includes('att-1');
        return Promise.resolve({
          Body: { transformToByteArray: () => (isAtt1 ? pngContent : textContent) },
        });
      }
      return Promise.resolve({});
    });

    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent('task-1'), makeContext(180_000));
    expect(result.statusCode).toBe(200);

    // Check the DDB UpdateCommand (transition to SUBMITTED) includes original versionIds
    const updateCall = ddbSend.mock.calls.find(
      (call: any[]) => call[0]?.input?.UpdateExpression?.includes('attachments'),
    );
    expect(updateCall).toBeDefined();
    const attachments = updateCall![0].input.ExpressionAttributeValues[':atts'];
    const att1 = attachments.find((a: any) => a.attachment_id === 'att-1');
    const att2 = attachments.find((a: any) => a.attachment_id === 'att-2');
    expect(att1.s3_version_id).toBe('original-v1');
    expect(att1.size_bytes).toBe(1024);
    expect(att2.s3_version_id).toBe('original-v2');
    expect(att2.size_bytes).toBe(512);
  });
});
