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
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));
jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...args: unknown[]) => mockLoadRepoConfig(...args),
  checkRepoOnboarded: (...args: unknown[]) => mockCheckRepoOnboarded(...args),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.POLICIES_RATE_LIMIT_PER_MINUTE = '30';

import { _resetCacheForTests, handler } from '../../src/handlers/get-policies';

function makeEvent(repoId = 'owner%2Frepo'): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: `/v1/repos/${repoId}/policies`,
    pathParameters: { repo_id: repoId },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/repos/{repo_id}/policies',
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: { claims: { sub: 'user-alice' } },
      httpMethod: 'GET',
      identity: {} as never,
      path: `/v1/repos/${repoId}/policies`,
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/repos/{repo_id}/policies',
      stage: 'v1',
    },
  } as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockSend.mockReset();
  mockLoadRepoConfig.mockReset();
  mockCheckRepoOnboarded.mockReset();
  // Default: assume repos are onboarded so existing tests that
  // predate the Chunk 10 onboarding gate continue to exercise the
  // happy path. The new T1.4-regression test explicitly overrides
  // this to simulate a non-onboarded repo.
  mockCheckRepoOnboarded.mockResolvedValue({ onboarded: true });
  ulidCounter = 0;
  _resetCacheForTests();
});

describe('get-policies', () => {
  test('401 when no Cognito claims', async () => {
    const event = makeEvent();
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  test('400 when repo_id missing', async () => {
    const event = makeEvent();
    (event.pathParameters as { repo_id?: string }) = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  // Chunk 10 E2E T1.4: ``GET /repos/{repo}/policies`` must gate on
  // onboarding the same way ``POST /tasks`` does. Previously the
  // handler was lenient — a typo'd repo name returned 200 with the
  // built-in policies, leading users to mistake the response for proof
  // the repo was onboarded.

  test('422 REPO_NOT_ONBOARDED when repo is not in RepoTable', async () => {
    mockSend.mockResolvedValue({}); // rate-limit update succeeds
    mockCheckRepoOnboarded.mockResolvedValue({ onboarded: false });

    const res = await handler(makeEvent('typo%2Frepo'));
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('REPO_NOT_ONBOARDED');
    expect(body.error.message).toContain('typo/repo');
    // loadRepoConfig must NOT have been called — the gate short-circuits.
    expect(mockLoadRepoConfig).not.toHaveBeenCalled();
  });

  test('422 gate runs after rate-limit (rate-limited caller gets 429, not 422)', async () => {
    // Rate-limit writes fail with ConditionalCheckFailed BEFORE the
    // onboarding check. A user hammering the endpoint must see the
    // 429 (their own fault) rather than leaking which repos are
    // onboarded via a 422-vs-200 timing oracle.
    mockSend.mockRejectedValue(
      Object.assign(new Error('rate limit exceeded'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    mockCheckRepoOnboarded.mockResolvedValue({ onboarded: false });

    const res = await handler(makeEvent('typo%2Frepo'));
    expect(res.statusCode).toBe(429);
    expect(mockCheckRepoOnboarded).not.toHaveBeenCalled();
  });

  test('200 with built-in hard + soft rule summaries when repo has no custom policies', async () => {
    mockSend.mockResolvedValue({}); // rate-limit
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ruleIdsHard = body.data.policies.hard.map((r: { rule_id: string }) => r.rule_id);
    const ruleIdsSoft = body.data.policies.soft.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIdsHard).toEqual(
      expect.arrayContaining([
        'rm_slash',
        'write_git_internals',
        'drop_table',
      ]),
    );
    expect(ruleIdsSoft).toEqual(
      expect.arrayContaining([
        'force_push_any',
        'write_env_files',
        'write_credentials',
      ]),
    );
  });

  test('decodes URL-encoded repo path segment', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue(null);
    const res = await handler(makeEvent('owner%2Frepo-with-dash'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.repo_id).toBe('owner/repo-with-dash');
  });

  test('custom blueprint soft rules appear in response', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
      cedar_policies: [
        '@tier("soft") @rule_id("custom_rule") @severity("low") @approval_timeout_s("60") ' +
          'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
          'when { context.command like "*npm publish*" };',
      ],
    });
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    const ruleIds = body.data.policies.soft.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toContain('custom_rule');
  });

  test('caches per-repo response across calls', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue(null);

    await handler(makeEvent());
    const firstCallCount = mockLoadRepoConfig.mock.calls.length;

    // Second call within cache TTL — should not re-invoke loadRepoConfig.
    await handler(makeEvent());
    expect(mockLoadRepoConfig.mock.calls.length).toBe(firstCallCount);
  });

  test('429 on rate-limit exceeded', async () => {
    const err = new Error('ConditionalCheckFailedException');
    (err as { name: string }).name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(err);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(429);
  });

  test('503 on invalid blueprint cedar_policies text', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
      cedar_policies: ['this is not valid cedar at all ;'],
    });
    const res = await handler(makeEvent('owner%2Frepo-bad'));
    expect(res.statusCode).toBe(503);
  });

  test('continues with built-ins when repo config load fails', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockRejectedValue(new Error('DDB throttle'));
    const res = await handler(makeEvent('fallback%2Frepo'));
    expect(res.statusCode).toBe(200);
  });

  test('hard rules do not include severity / approval_timeout_s', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue(null);
    const res = await handler(makeEvent('hard%2Fshape'));
    const body = JSON.parse(res.body);
    const hardRule = body.data.policies.hard[0];
    expect(hardRule.severity).toBeUndefined();
    expect(hardRule.approval_timeout_s).toBeUndefined();
    expect(hardRule.rule_id).toBeDefined();
    expect(hardRule.summary).toBeDefined();
  });

  test('soft rules carry severity + approval_timeout_s', async () => {
    mockSend.mockResolvedValue({});
    mockLoadRepoConfig.mockResolvedValue(null);
    const res = await handler(makeEvent('soft%2Fshape'));
    const body = JSON.parse(res.body);
    const soft = body.data.policies.soft.find(
      (r: { rule_id: string }) => r.rule_id === 'force_push_any',
    );
    expect(soft.severity).toBe('medium');
    expect(soft.approval_timeout_s).toBe(300);
  });
});
