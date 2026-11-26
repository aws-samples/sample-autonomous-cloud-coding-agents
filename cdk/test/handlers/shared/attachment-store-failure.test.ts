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

const screenImageMock = jest.fn();
jest.mock('../../../src/handlers/shared/attachment-screening', () => ({
  ...jest.requireActual('../../../src/handlers/shared/attachment-screening'),
  screenImage: (...args: unknown[]) => screenImageMock(...args),
}));
jest.mock('dns/promises', () => ({
  lookup: () => Promise.resolve([{ address: '203.0.113.7', family: 4 }]),
}));
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  resolveJiraOauthToken: () => Promise.resolve({
    accessToken: 'at-1',
    scope: 'read:jira-work',
    siteUrl: 'https://acme.atlassian.net',
    oauthSecretArn: 'arn:secret',
  }),
}));

import type { S3Client } from '@aws-sdk/client-s3';
import { downloadScreenAndStoreJiraAttachments, JiraAttachmentError } from '../../../src/handlers/shared/jira-attachments';
import { downloadScreenAndStoreLinearAttachments, LinearAttachmentError } from '../../../src/handlers/shared/linear-attachments';
import { logger } from '../../../src/handlers/shared/logger';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function imageResponse(): Response {
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
    body: {
      getReader: () => ({
        read() {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: new Uint8Array(PNG_BYTES) });
        },
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Response;
}

const s3Send = jest.fn();
const storage = {
  s3Client: { send: s3Send } as unknown as S3Client,
  bucketName: 'attachments-bucket',
  screeningConfig: { guardrailId: 'gr-1', guardrailVersion: '1', bedrockClient: {} as never },
  userId: 'user-1',
  taskId: 'task-1',
};

beforeEach(() => {
  screenImageMock.mockReset().mockImplementation((content: Buffer) => Promise.resolve({
    content,
    checksum: 'sha256:abc',
    screening: { status: 'passed', screened_at: '2026-07-22T00:00:00Z' },
  }));
  s3Send.mockReset();
  (global.fetch as unknown) = jest.fn().mockResolvedValue(imageResponse());
});

afterEach(() => {
  jest.restoreAllMocks();
});

test.each([
  [
    'Linear',
    LinearAttachmentError,
    () => downloadScreenAndStoreLinearAttachments(
      '![shot.png](https://uploads.linear.app/aaaa-1111/bbbb-2222/shot.png?signature=abc)',
      10,
      { ...storage, accessToken: 'lin_oauth_at', linearWorkspaceId: 'ws-1' },
    ),
  ],
  [
    'Jira',
    JiraAttachmentError,
    () => downloadScreenAndStoreJiraAttachments(
      [{ id: 'att-1', filename: 'shot.png', mimeType: 'image/png', size: PNG_BYTES.length }],
      10,
      { ...storage, cloudId: 'cloud-1', registryTableName: 'JiraRegistry' },
    ),
  ],
])('%s: an attachment that S3 refuses to store is refused with the error the processor answers, and the S3 error stays in the log', async (_tracker, AttachmentError, download) => {
  const sdkText = 'User: arn:aws:sts::123456789012:assumed-role/Stack-WebhookProcessorRole/fn is not authorized to perform: s3:PutObject';
  s3Send.mockRejectedValueOnce(Object.assign(new Error(sdkText), { name: 'AccessDenied' }));
  const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  const err = await download().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AttachmentError);
  expect((err as Error).message).toBe("Attachment 'shot.png' could not be stored.");
  expect(JSON.stringify(logged.mock.calls)).toContain(sdkText);
});
