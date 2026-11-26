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

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn(() => Promise.resolve({ action: 'NONE' })) })),
  ApplyGuardrailCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => ({})) }));

interface PresignParams {
  readonly Key: string;
  readonly Conditions: unknown[];
  readonly Fields: Record<string, string>;
  readonly Expires: number;
}
const mockPresign = jest.fn((_client: unknown, params: PresignParams) => Promise.resolve({
  url: 'https://attachments-bucket.s3.amazonaws.com/',
  fields: { ...params.Fields, key: params.Key },
}));
jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: (client: unknown, params: PresignParams) => mockPresign(client, params),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.GUARDRAIL_ID = 'test-guardrail-id';
process.env.GUARDRAIL_VERSION = '1';
process.env.ATTACHMENTS_BUCKET_NAME = 'attachments-bucket';

import { createTaskCore } from '../../../src/handlers/shared/create-task-core';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({});
});

describe('createTaskCore upload instructions', () => {
  test('answers 202 with one instruction for each attachment the client has to upload', async () => {
    const result = await createTaskCore(
      {
        task_description: 'Summarise the attached notes',
        attachments: [
          { type: 'file', content_type: 'text/plain', filename: 'notes.txt', expected_size_bytes: 10 },
          { type: 'url', url: 'https://example.com/spec.pdf' },
          { type: 'image', content_type: 'image/png', filename: 'diagram.png', expected_size_bytes: 2_000_000 },
        ],
      },
      { userId: 'user-123', channelSource: 'api', channelMetadata: {} },
      'req-1',
    );

    expect(result.statusCode).toBe(202);
    const data = JSON.parse(result.body).data;
    expect(data.status).toBe('PENDING_UPLOADS');
    const task = mockSend.mock.calls.map(([command]) => command).find(command => command.input.TableName === 'Tasks').input.Item;
    const uploads = task.attachments.filter((a: { type: string }) => a.type !== 'url');
    expect(uploads.map((a: { filename: string }) => a.filename)).toEqual(['notes.txt', 'diagram.png']);
    expect(data.upload_instructions).toEqual(uploads.map((a: { attachment_id: string; filename: string; content_type: string }) => ({
      attachment_id: a.attachment_id,
      filename: a.filename,
      upload_url: 'https://attachments-bucket.s3.amazonaws.com/',
      upload_fields: {
        'Content-Type': a.content_type,
        'key': `attachments/user-123/${task.task_id}/${a.attachment_id}/${a.filename}`,
      },
      upload_expires_at: expect.any(String),
    })));
    expect(mockPresign.mock.calls.map(([, params]) => [params.Conditions, params.Expires])).toEqual([
      [[['content-length-range', 1, MAX_UPLOAD_BYTES], ['eq', '$Content-Type', 'text/plain']], 600],
      [[['content-length-range', 1, MAX_UPLOAD_BYTES], ['eq', '$Content-Type', 'image/png']], 600],
    ]);
    expect(Date.parse(data.task_expires_at)).toBeGreaterThan(Date.now());
  });

  describe('when an Idempotency-Key is replayed', () => {
    const task = {
      task_id: 'task-1',
      user_id: 'user-123',
      status: 'PENDING_UPLOADS',
      resolved_workflow: { id: 'default/agent-v1', version: '1.0.0' },
      task_description: 'Summarise the attached notes',
      branch_name: '',
      channel_source: 'api',
      channel_metadata: {},
      status_created_at: 'PENDING_UPLOADS#2026-11-17T10:00:00.000Z',
      created_at: '2026-11-17T10:00:00.000Z',
      updated_at: '2026-11-17T10:00:00.000Z',
      idempotency_key: 'spec-1',
      attachments: [
        {
          attachment_id: 'att-url',
          type: 'url',
          content_type: 'application/octet-stream',
          filename: 'spec.pdf',
          source_url: 'https://example.com/spec.pdf',
          screening: { status: 'pending' },
        },
        {
          attachment_id: 'att-screened',
          type: 'image',
          content_type: 'image/png',
          filename: 'diagram.png',
          s3_key: 'attachments/user-123/task-1/att-screened/diagram.png',
          s3_version_id: 'v1',
          size_bytes: 2_000_000,
          checksum_sha256: 'sum',
          screening: { status: 'passed', screened_at: '2026-11-17T10:05:00.000Z' },
        },
        {
          attachment_id: 'att-notes',
          type: 'file',
          content_type: 'text/plain',
          filename: 'notes.txt',
          screening: { status: 'pending' },
        },
      ],
    };

    function replay(stored: Record<string, unknown>) {
      mockSend
        .mockResolvedValueOnce({ Items: [{ task_id: 'task-1' }] })
        .mockResolvedValueOnce({ Item: stored });
      return createTaskCore(
        {
          task_description: 'Summarise the attached notes',
          attachments: [{ type: 'file', content_type: 'text/plain', filename: 'notes.txt', expected_size_bytes: 10 }],
        },
        { userId: 'user-123', channelSource: 'api', channelMetadata: {}, idempotencyKey: 'spec-1' },
        'req-2',
      );
    }

    test('a task that still waits for its uploads comes with new instructions for them', async () => {
      const result = await replay(task);

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['Idempotent-Replay']).toBe('true');
      const data = JSON.parse(result.body).data;
      expect(data).toMatchObject({ task_id: 'task-1', status: 'PENDING_UPLOADS' });
      expect(data.upload_instructions).toEqual([{
        attachment_id: 'att-notes',
        filename: 'notes.txt',
        upload_url: 'https://attachments-bucket.s3.amazonaws.com/',
        upload_fields: { 'Content-Type': 'text/plain', 'key': 'attachments/user-123/task-1/att-notes/notes.txt' },
        upload_expires_at: expect.any(String),
      }]);
      expect(data.task_expires_at).toBe('2026-11-17T10:30:00.000Z');
      expect(mockSend.mock.calls.map(([command]) => command._type)).toEqual(['Query', 'Get']);
    });

    test('a task that has left PENDING_UPLOADS comes without instructions', async () => {
      const result = await replay({ ...task, status: 'SUBMITTED', status_created_at: 'SUBMITTED#2026-11-17T10:06:00.000Z' });

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['Idempotent-Replay']).toBe('true');
      const data = JSON.parse(result.body).data;
      expect(data.status).toBe('SUBMITTED');
      expect(data).not.toHaveProperty('upload_instructions');
      expect(data).not.toHaveProperty('task_expires_at');
      expect(mockPresign).not.toHaveBeenCalled();
    });
  });
});
