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

const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: s3Send })),
  PutObjectCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

// DynamoDB doc client — drives persistScreenshotUrl.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  ConditionalCheckFailedException: class extends Error {},
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const captureScreenshotMock = jest.fn();
jest.mock('../../src/handlers/shared/agentcore-browser', () => ({
  captureScreenshot: (...args: unknown[]) => captureScreenshotMock(...args),
}));

const resolveGitHubTokenMock = jest.fn();
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: (...args: unknown[]) => resolveGitHubTokenMock(...args),
}));

const upsertTaskCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/github-comment', () => ({
  upsertTaskComment: (...args: unknown[]) => upsertTaskCommentMock(...args),
}));

const postIssueCommentMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-feedback', () => ({
  postIssueComment: (...args: unknown[]) => postIssueCommentMock(...args),
}));

const findLinearIssueMock = jest.fn();
const extractLinearIdentifierMock = jest.fn();
const extractFromBranchMock = jest.fn();
jest.mock('../../src/handlers/shared/linear-issue-lookup', () => ({
  findLinearIssueByIdentifier: (...args: unknown[]) => findLinearIssueMock(...args),
  extractLinearIdentifier: (...args: unknown[]) => extractLinearIdentifierMock(...args),
  extractLinearIdentifierFromBranch: (...args: unknown[]) => extractFromBranchMock(...args),
}));

const deliverJiraMock = jest.fn();
jest.mock('../../src/handlers/shared/jira-deployment-preview', () => ({
  deliverJiraDeploymentPreview: (...args: unknown[]) => deliverJiraMock(...args),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ input })),
}));
jest.mock('../../src/handlers/shared/github-webhook-verify', () => ({
  verifyGitHubRequest: jest.fn().mockResolvedValue(true),
}));

process.env.SCREENSHOT_BUCKET_NAME = 'screenshots';
process.env.SCREENSHOT_PUBLIC_HOST = 'd1.cloudfront.net';
process.env.GITHUB_TOKEN_SECRET_ARN = 'gh-token';
process.env.GITHUB_WEBHOOK_SECRET_ARN = 'webhook-secret';
process.env.GITHUB_WEBHOOK_DEDUP_TABLE_NAME = 'dedup';
process.env.GITHUB_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'processor';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as receiverHandler } from '../../src/handlers/github-webhook';
import { handler as processorHandler } from '../../src/handlers/github-webhook-processor';

const sha = 'a'.repeat(40);
const pr41 = { number: 41, state: 'open', title: 'other PR', head: { sha, ref: 'other' } };
const pr42 = { number: 42, state: 'open', title: 'preview PR', head: { sha, ref: 'preview' } };

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  ddbSend.mockResolvedValue({});
  lambdaSend.mockResolvedValue({});
  s3Send.mockResolvedValue({});
  resolveGitHubTokenMock.mockResolvedValue('token');
  captureScreenshotMock.mockResolvedValue(Buffer.from('png'));
  upsertTaskCommentMock.mockResolvedValue({ commentId: 1 });
});

test.each(['check_run', 'deployment_status'])('receiver %s payload drives the processor to the correct PR', async (eventType) => {
  const body = eventType === 'check_run' ? {
    action: 'completed',
    repository: { full_name: 'owner/repo' },
    check_run: {
      id: 123,
      name: 'AWS Amplify Console Web Preview',
      status: 'completed',
      conclusion: 'success',
      head_sha: sha.toUpperCase(),
      details_url: 'https://pr-42.app123.amplifyapp.com',
      app: { slug: 'aws-amplify-us-east-1', owner: { login: 'aws-amplify-console' } },
      pull_requests: [pr41, pr42],
    },
  } : {
    repository: { full_name: 'owner/repo' },
    deployment: { id: 123, sha, environment: 'Preview' },
    deployment_status: { id: 456, state: 'success', environment_url: 'https://preview.vercel.app' },
  };
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) => ({
    ok: true,
    status: 200,
    json: async () => String(url).endsWith('/pulls/42') ? pr42 : [pr41, pr42],
  } as Response));

  const response = await receiverHandler({
    body: JSON.stringify(body),
    headers: { 'X-GitHub-Event': eventType, 'X-Hub-Signature-256': 'sha256=verified-by-mock' },
  } as unknown as APIGatewayProxyEvent);
  expect(response.statusCode).toBe(200);
  expect(lambdaSend).toHaveBeenCalledTimes(1);
  // Pass the actual bytes emitted by the receiver without rebuilding any fields.
  const forwarded = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
  if (eventType === 'deployment_status') expect(forwarded).toEqual({ raw_body: JSON.stringify(body) });
  await processorHandler(forwarded);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(eventType === 'check_run'
    ? 'https://api.github.com/repos/owner/repo/pulls/42'
    : `https://api.github.com/repos/owner/repo/commits/${sha}/pulls`, expect.anything());
  expect(captureScreenshotMock).toHaveBeenCalledTimes(1);
  expect(upsertTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({
    repo: 'owner/repo', issueOrPrNumber: eventType === 'check_run' ? 42 : 41,
  }));
});
