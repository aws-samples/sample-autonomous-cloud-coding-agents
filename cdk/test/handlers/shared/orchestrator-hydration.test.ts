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

/**
 * `hydrateAndTransition`: the event it writes when the guardrail blocks a task's
 * context, and its URL-attachment branch. That branch runs only when
 * ATTACHMENTS_BUCKET_NAME is set before the module loads, which the main suite
 * (test/handlers/orchestrate-task.test.ts) does not do.
 */

// --- Mocks ---
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({ BedrockRuntimeClient: jest.fn(() => ({})) }));

const mockHydrateContext = jest.fn();
const mockResolveGitHubToken = jest.fn();
jest.mock('../../../src/handlers/shared/context-hydration', () => ({
  hydrateContext: mockHydrateContext,
  resolveGitHubToken: mockResolveGitHubToken,
}));

const mockResolveUrlAttachments = jest.fn();
jest.mock('../../../src/handlers/shared/resolve-url-attachments', () => ({
  resolveUrlAttachments: mockResolveUrlAttachments,
}));

const mockLoadRepoConfig = jest.fn();
jest.mock('../../../src/handlers/shared/repo-config', () => ({ loadRepoConfig: mockLoadRepoConfig }));

// Set env vars before importing (module-level constants are captured at import time)
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.ATTACHMENTS_BUCKET_NAME = 'attachments-bucket';
process.env.GUARDRAIL_ID = 'guardrail-1';
process.env.GUARDRAIL_VERSION = '1';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:platform-token';

import type { HydratedContext } from '../../../src/handlers/shared/context-hydration';
import { hydrateAndTransition, loadBlueprintConfig } from '../../../src/handlers/shared/orchestrator';
import type { AttachmentRecord, TaskRecord } from '../../../src/handlers/shared/types';

/** A task on issue #42 of a private repository. It has no pull request. */
const task: TaskRecord = {
  task_id: 'TASK001',
  user_id: 'user-123',
  status: 'SUBMITTED',
  repo: 'acme/private-app',
  issue_number: 42,
  resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
  branch_name: 'bgagent/TASK001/fix-bug',
  channel_source: 'api',
  status_created_at: 'SUBMITTED#2024-01-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  task_description: 'Fix the bug',
};

const hydratedContext: HydratedContext = {
  version: 1,
  user_prompt: 'Task ID: TASK001\nRepository: acme/private-app\n\n## Task\n\nFix the bug',
  sources: ['issue', 'task_description'],
  token_estimate: 20,
  truncated: false,
  content_trust: { issue: 'untrusted-external', task_description: 'trusted' },
};

interface SentCommand {
  readonly _type: string;
  readonly input: Record<string, unknown>;
}

/** Commands of one type that the mocked document client received, in order. */
function commandsOfType(type: string): SentCommand[] {
  return mockDdbSend.mock.calls.map(c => c[0]).filter(c => c._type === type);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({});
  mockHydrateContext.mockResolvedValue(hydratedContext);
  mockLoadRepoConfig.mockResolvedValue(null);
});

describe('hydrateAndTransition: guardrail_blocked event', () => {
  test('has no undefined value when the task has no pull request', async () => {
    mockHydrateContext.mockResolvedValue({
      ...hydratedContext,
      guardrail_blocked: 'Task context blocked by content policy',
    });

    await expect(hydrateAndTransition(task)).rejects.toThrow('Guardrail blocked: Task context blocked by content policy');

    const blocked = commandsOfType('Put')
      .map(c => c.input.Item as { event_type: string; metadata: Record<string, unknown> })
      .filter(item => item.event_type === 'guardrail_blocked');
    expect(blocked).toHaveLength(1);
    // The document client leaves out an undefined attribute of the item itself but
    // throws on one inside a map: an undefined value here loses the whole event.
    expect(Object.values(blocked[0].metadata)).not.toContain(undefined);
    expect(blocked[0].metadata).toEqual({
      reason: 'Task context blocked by content policy',
      resolved_workflow: 'coding/new-task-v1',
      sources: ['issue', 'task_description'],
      token_estimate: 20,
      content_trust: { issue: 'untrusted-external', task_description: 'trusted' },
    });
  });
});

describe('hydrateAndTransition: URL attachments', () => {
  const pending: AttachmentRecord = {
    attachment_id: 'att-1',
    type: 'url',
    content_type: 'application/octet-stream',
    filename: 'spec.md',
    source_url: 'https://raw.githubusercontent.com/acme/private-app/main/docs/spec.md',
    screening: { status: 'pending' },
  };
  /** What `resolveUrlAttachments` returns for it once fetched, screened and uploaded. */
  const stored: AttachmentRecord = {
    attachment_id: 'att-1',
    type: 'file',
    content_type: 'text/markdown',
    filename: 'spec.md',
    source_url: 'https://raw.githubusercontent.com/acme/private-app/main/docs/spec.md',
    s3_key: 'attachments/user-123/TASK001/att-1/spec.md',
    s3_version_id: 'v1',
    size_bytes: 2048,
    checksum_sha256: 'a'.repeat(64),
    screening: { status: 'passed', screened_at: '2024-01-01T00:00:05Z' },
  };
  const taskWithUrl: TaskRecord = { ...task, attachments: [pending] };

  /** True for the write that puts the attachment records on the task. */
  function isAttachmentsWrite(cmd: SentCommand): boolean {
    return cmd._type === 'Update'
      && Object.values((cmd.input.ExpressionAttributeNames ?? {}) as Record<string, string>).includes('attachments');
  }

  beforeEach(() => {
    mockResolveGitHubToken.mockImplementation((secretArn: string) => Promise.resolve(`token-of-${secretArn}`));
    mockResolveUrlAttachments.mockResolvedValue([stored]);
  });

  test('are fetched with the token of the repository when its blueprint sets one', async () => {
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'acme/private-app',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      github_token_secret_arn: 'arn:repo-token',
    });

    await hydrateAndTransition(taskWithUrl, await loadBlueprintConfig(taskWithUrl));

    expect(mockResolveGitHubToken.mock.calls).toEqual([['arn:repo-token']]);
    expect(mockResolveUrlAttachments).toHaveBeenCalledWith(
      [pending], 'TASK001', 'user-123', expect.objectContaining({ githubToken: 'token-of-arn:repo-token' }),
    );
  });

  test('are fetched with the platform token when the repository has none of its own', async () => {
    await hydrateAndTransition(taskWithUrl, await loadBlueprintConfig(taskWithUrl));

    expect(mockResolveGitHubToken.mock.calls).toEqual([['arn:platform-token']]);
    expect(mockResolveUrlAttachments).toHaveBeenCalledWith(
      [pending], 'TASK001', 'user-123', expect.objectContaining({ githubToken: 'token-of-arn:platform-token' }),
    );
  });

  test('are put on the task record as fetched and screened', async () => {
    await hydrateAndTransition(taskWithUrl, await loadBlueprintConfig(taskWithUrl));

    const writes = commandsOfType('Update').filter(isAttachmentsWrite);
    expect(writes).toHaveLength(1);
    expect(writes[0].input.TableName).toBe('Tasks');
    expect(writes[0].input.Key).toEqual({ task_id: 'TASK001' });
    expect(Object.values(writes[0].input.ExpressionAttributeValues as Record<string, unknown>)).toContainEqual([stored]);
  });

  test('still reach the agent when the record cannot be updated', async () => {
    mockDdbSend.mockImplementation((cmd: SentCommand) =>
      (isAttachmentsWrite(cmd) ? Promise.reject(new Error('Throughput exceeded')) : Promise.resolve({})));

    const payload = await hydrateAndTransition(taskWithUrl, await loadBlueprintConfig(taskWithUrl));

    expect(commandsOfType('Update').filter(isAttachmentsWrite)).toHaveLength(1);
    expect(payload.attachments).toEqual([expect.objectContaining({
      attachment_id: 'att-1',
      s3_uri: 's3://attachments-bucket/attachments/user-123/TASK001/att-1/spec.md',
      s3_version_id: 'v1',
    })]);
  });
});
