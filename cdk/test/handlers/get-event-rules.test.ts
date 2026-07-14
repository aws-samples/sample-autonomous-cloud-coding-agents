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

const mockSend = jest.fn();
const mockLoadRepoConfig = jest.fn();
const mockCheckRepoOnboarded = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));
jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...args: unknown[]) => mockLoadRepoConfig(...args),
  checkRepoOnboarded: (...args: unknown[]) => mockCheckRepoOnboarded(...args),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.POLICIES_RATE_LIMIT_PER_MINUTE = '30';

import { _resetCacheForTests, handler } from '../../src/handlers/get-event-rules';

function makeEvent(
  repoId = 'owner%2Frepo',
  query: Record<string, string> | null = null,
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: `/v1/repos/${repoId}/event-rules`,
    pathParameters: { repo_id: repoId },
    queryStringParameters: query,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/repos/{repo_id}/event-rules',
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: { claims: { sub: 'user-alice' } },
      httpMethod: 'GET',
      identity: {} as never,
      path: `/v1/repos/${repoId}/event-rules`,
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/repos/{repo_id}/event-rules',
      stage: 'v1',
    },
  } as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockSend.mockReset();
  mockLoadRepoConfig.mockReset();
  mockCheckRepoOnboarded.mockReset();
  mockCheckRepoOnboarded.mockResolvedValue({ onboarded: true });
  ulidCounter = 0;
  _resetCacheForTests();
});

describe('get-event-rules', () => {
  test('401 when no Cognito claims', async () => {
    const event = makeEvent();
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  test('422 REPO_NOT_ONBOARDED when repo is not in RepoTable', async () => {
    mockSend.mockResolvedValue({});
    mockCheckRepoOnboarded.mockResolvedValue({ onboarded: false });

    const res = await handler(makeEvent('typo%2Frepo'));
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('REPO_NOT_ONBOARDED');
    expect(mockLoadRepoConfig).not.toHaveBeenCalled();
  });

  test('200 with platform-default pack when repo has event_rule_pack pin', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
      event_rule_pack: { id: 'platform-default', version: '1.0.0' },
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.repo_id).toBe('owner/repo');
    expect(body.data.event_rule_pack).toEqual({ id: 'platform-default', version: '1.0.0' });
    const ruleIds = body.data.rules.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toEqual(expect.arrayContaining(['observe-repo-setup', 'notify-on-pr']));
    expect(body.data.registry_packs.length).toBeGreaterThan(0);
  });

  test('workflow_ref query uses workflow eventRulePack when repo has no pin', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
    });

    const res = await handler(makeEvent('owner%2Frepo', {
      workflow_ref: 'coding/new-task-v1',
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.event_rule_pack).toEqual({ id: 'platform-default', version: '1.0.0' });
    const ruleIds = body.data.rules.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toContain('observe-repo-setup');
  });

  test('422 VALIDATION_ERROR when repo pins an unknown event-rule-pack', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
      event_rule_pack: { id: 'does-not-exist', version: '9.9.9' },
    });

    const res = await handler(makeEvent());
    // Fail loud rather than silently applying zero governance rules (#230).
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('does-not-exist@9.9.9');
  });
});
