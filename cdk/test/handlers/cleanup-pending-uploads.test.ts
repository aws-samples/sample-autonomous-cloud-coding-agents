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

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn((input: any) => ({ input, _type: 'Query' })),
  UpdateItemCommand: jest.fn((input: any) => ({ input, _type: 'UpdateItem' })),
  PutItemCommand: jest.fn((input: any) => ({ input, _type: 'PutItem' })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  ListObjectVersionsCommand: jest.fn((input: any) => ({ input, _type: 'ListObjectVersions' })),
  DeleteObjectsCommand: jest.fn((input: any) => ({ input, _type: 'DeleteObjects' })),
}));

process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.TASK_EVENTS_TABLE_NAME = 'EventsTable';
process.env.ATTACHMENTS_BUCKET_NAME = 'test-attachments-bucket';
process.env.PENDING_UPLOAD_TIMEOUT_SECONDS = '1800';
process.env.TASK_RETENTION_DAYS = '90';

import { handler } from '../../src/handlers/cleanup-pending-uploads';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cleanup-pending-uploads handler', () => {
  test('does nothing when no expired tasks found', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [] });

    await handler();

    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('cancels expired task with conditional write and sets TTL', async () => {
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();

    mockDdbSend.mockResolvedValueOnce({
      Items: [{
        task_id: { S: 'TASK001' },
        user_id: { S: 'user-123' },
        created_at: { S: thirtyFiveMinAgo },
      }],
    });

    mockDdbSend.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValueOnce({});

    mockS3Send.mockResolvedValueOnce({ Contents: [] });

    await handler();

    const updateCall = mockDdbSend.mock.calls[1][0];
    expect(updateCall.input.UpdateExpression).toContain('#ttl = :ttl');
    expect(updateCall.input.ExpressionAttributeValues[':ttl']).toBeDefined();
    expect(updateCall.input.ExpressionAttributeValues[':ttl'].N).toBeDefined();
    const ttlValue = Number(updateCall.input.ExpressionAttributeValues[':ttl'].N);
    const expectedMin = Math.floor(Date.now() / 1000) + 89 * 86400;
    const expectedMax = Math.floor(Date.now() / 1000) + 91 * 86400;
    expect(ttlValue).toBeGreaterThan(expectedMin);
    expect(ttlValue).toBeLessThan(expectedMax);
  });

  test('handles race condition with confirm-uploads (ConditionalCheckFailedException)', async () => {
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();

    mockDdbSend.mockResolvedValueOnce({
      Items: [{
        task_id: { S: 'TASK001' },
        user_id: { S: 'user-123' },
        created_at: { S: thirtyFiveMinAgo },
      }],
    });

    const condErr = new Error('The conditional request failed');
    condErr.name = 'ConditionalCheckFailedException';
    mockDdbSend.mockRejectedValueOnce(condErr);

    await handler();

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
  });

  test('cleans up S3 objects after successful cancellation', async () => {
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();

    mockDdbSend.mockResolvedValueOnce({
      Items: [{
        task_id: { S: 'TASK001' },
        user_id: { S: 'user-123' },
        created_at: { S: thirtyFiveMinAgo },
      }],
    });

    mockDdbSend.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValueOnce({});

    mockS3Send.mockResolvedValueOnce({
      Versions: [
        { Key: 'attachments/user-123/TASK001/ATT001/image.png', VersionId: 'v1' },
        { Key: 'attachments/user-123/TASK001/ATT002/doc.pdf', VersionId: 'v2' },
      ],
      DeleteMarkers: [],
    });
    mockS3Send.mockResolvedValueOnce({ Deleted: [{}, {}] });

    await handler();

    const deleteCall = mockS3Send.mock.calls[1][0];
    expect(deleteCall.input.Bucket).toBe('test-attachments-bucket');
    expect(deleteCall.input.Delete.Objects).toEqual([
      { Key: 'attachments/user-123/TASK001/ATT001/image.png', VersionId: 'v1' },
      { Key: 'attachments/user-123/TASK001/ATT002/doc.pdf', VersionId: 'v2' },
    ]);
  });

  test('throws when ALL tasks error (triggers CloudWatch alarm)', async () => {
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();

    mockDdbSend.mockResolvedValueOnce({
      Items: [{
        task_id: { S: 'TASK001' },
        user_id: { S: 'user-123' },
        created_at: { S: thirtyFiveMinAgo },
      }],
    });

    const infraErr = new Error('Service unavailable');
    infraErr.name = 'InternalServerError';
    mockDdbSend.mockRejectedValueOnce(infraErr);

    await expect(handler()).rejects.toThrow('All 1 expired PENDING_UPLOADS task(s) failed to process');
  });

  test('continues pagination when S3 returns empty page with IsTruncated=true', async () => {
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();

    mockDdbSend.mockResolvedValueOnce({
      Items: [{
        task_id: { S: 'TASK001' },
        user_id: { S: 'user-123' },
        created_at: { S: thirtyFiveMinAgo },
      }],
    });

    mockDdbSend.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValueOnce({});

    mockS3Send.mockResolvedValueOnce({
      Versions: [],
      DeleteMarkers: [],
      IsTruncated: true,
      NextKeyMarker: 'attachments/user-123/TASK001/ATT001/image.png',
      NextVersionIdMarker: 'v1',
    });
    mockS3Send.mockResolvedValueOnce({
      Versions: [
        { Key: 'attachments/user-123/TASK001/ATT001/image.png', VersionId: 'v1' },
      ],
      DeleteMarkers: [],
      IsTruncated: false,
    });
    mockS3Send.mockResolvedValueOnce({ Deleted: [{}] });

    await handler();

    const listCalls = mockS3Send.mock.calls.filter(
      (call: any[]) => call[0]?._type === 'ListObjectVersions',
    );
    expect(listCalls).toHaveLength(2);

    expect(listCalls[1][0].input.KeyMarker).toBe('attachments/user-123/TASK001/ATT001/image.png');
    expect(listCalls[1][0].input.VersionIdMarker).toBe('v1');

    const deleteCalls = mockS3Send.mock.calls.filter(
      (call: any[]) => call[0]?._type === 'DeleteObjects',
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0].input.Delete.Objects).toEqual([
      { Key: 'attachments/user-123/TASK001/ATT001/image.png', VersionId: 'v1' },
    ]);
  });

  test('does not throw on partial success (some cancelled, some errored)', async () => {
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { task_id: { S: 'TASK001' }, user_id: { S: 'user-123' }, created_at: { S: thirtyFiveMinAgo } },
        { task_id: { S: 'TASK002' }, user_id: { S: 'user-456' }, created_at: { S: thirtyFiveMinAgo } },
      ],
    });

    mockDdbSend.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValueOnce({});
    mockS3Send.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [] });

    const infraErr = new Error('Timeout');
    infraErr.name = 'RequestTimeout';
    mockDdbSend.mockRejectedValueOnce(infraErr);

    await expect(handler()).resolves.toBeUndefined();
  });
});
