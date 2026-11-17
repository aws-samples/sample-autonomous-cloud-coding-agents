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

// create-task-core reads ATTACHMENTS_BUCKET_NAME when it loads, and create-task-core.test.ts
// loads it without a bucket, so the presigned-upload branch needs a file of its own.

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn(() => Promise.resolve({ action: 'NONE' })) })),
  ApplyGuardrailCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(() => Promise.reject(new Error('presign failed'))),
}));

process.env.GUARDRAIL_ID = 'test-guardrail-id';
process.env.GUARDRAIL_VERSION = '1';
process.env.ATTACHMENTS_BUCKET_NAME = 'attachments-bucket';

import { createTaskCore } from '../../../src/handlers/shared/create-task-core';

describe('createTaskCore when presigning an upload fails', () => {
  test('fails the task with completed_at, a matching status_created_at and a ttl', async () => {
    const result = await createTaskCore(
      {
        task_description: 'Summarise the attached notes',
        attachments: [{ type: 'file', content_type: 'text/plain', filename: 'notes.txt', expected_size_bytes: 10 }],
      },
      { userId: 'user-123', channelSource: 'api', channelMetadata: {} },
      'req-1',
    );

    expect(result.statusCode).toBe(500);
    const update = mockSend.mock.calls.map(([cmd]) => cmd).find(cmd => cmd._type === 'Update');
    const { UpdateExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values } = update.input;
    expect(UpdateExpression).toContain('completed_at = :now');
    expect(UpdateExpression).toContain('status_created_at = :sca');
    expect(UpdateExpression).toContain('#ttl = :ttl');
    expect(values[':sca']).toBe(`FAILED#${values[':now']}`);
    expect(names['#ttl']).toBe('ttl');
    // Epoch seconds, a retention period ahead: a value in milliseconds would never expire.
    const nowSeconds = Date.now() / 1000;
    expect(values[':ttl']).toBeGreaterThan(nowSeconds);
    expect(values[':ttl']).toBeLessThan(nowSeconds + 91 * 86_400);
  });
});
