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
const mockLookupRepo = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));
jest.mock('../../src/handlers/shared/repo-config', () => ({
  lookupRepo: (...args: unknown[]) => mockLookupRepo(...args),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_APPROVALS_TABLE_NAME = 'Approvals';
process.env.POLICIES_RATE_LIMIT_PER_MINUTE = '30';

import { _resetCacheForTests, handler } from '../../src/handlers/get-policies';
import type { RepoLookupResult } from '../../src/handlers/shared/repo-config';

/** A Blueprint entry in the annotated form: listed under its own rule id. */
const CUSTOM_SOFT_RULE =
  '@tier("soft") @rule_id("custom_rule") @severity("low") @approval_timeout_s("60") ' +
  'forbid (principal, action == Agent::Action::"execute_bash", resource) ' +
  'when { context.command like "*npm publish*" };';

/** Blueprint entries without annotations, the form `cdk/test/constructs/blueprint.test.ts` uses. */
const UNANNOTATED_RULE =
  'forbid (principal, action == Agent::Action::"execute_bash", resource) when { context.command like "*npm publish*" };';
const OTHER_UNANNOTATED_RULE =
  'forbid (principal, action == Agent::Action::"execute_bash", resource) when { context.command like "*terraform apply*" };';

/** What `lookupRepo` answers for an onboarded repository whose Blueprint holds these Cedar policies. */
function onboardedWith(cedarPolicies?: string[]): RepoLookupResult {
  return {
    onboarded: true,
    config: {
      repo: 'owner/repo',
      status: 'active',
      onboarded_at: '',
      updated_at: '',
      ...(cedarPolicies && { cedar_policies: cedarPolicies }),
    },
  };
}

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
  mockLookupRepo.mockReset();
  // Default: assume repos are onboarded so existing tests that
  // predate the Chunk 10 onboarding gate continue to exercise the
  // happy path. The new T1.4-regression test explicitly overrides
  // this to simulate a non-onboarded repo.
  mockLookupRepo.mockResolvedValue({ onboarded: true, config: null });
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
    mockLookupRepo.mockResolvedValue({ onboarded: false, config: null });

    const res = await handler(makeEvent('typo%2Frepo'));
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('REPO_NOT_ONBOARDED');
    expect(body.error.message).toContain('typo/repo');
    // The gate short-circuits: the one read of the repository row is all it costs.
    expect(mockLookupRepo.mock.calls).toEqual([['typo/repo']]);
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
    mockLookupRepo.mockResolvedValue({ onboarded: false, config: null });

    const res = await handler(makeEvent('typo%2Frepo'));
    expect(res.statusCode).toBe(429);
    expect(mockLookupRepo).not.toHaveBeenCalled();
  });

  test('200 with built-in hard + soft rule summaries when repo has no custom policies', async () => {
    mockSend.mockResolvedValue({}); // rate-limit
    mockLookupRepo.mockResolvedValue(onboardedWith());

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
    const res = await handler(makeEvent('owner%2Frepo-with-dash'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.repo_id).toBe('owner/repo-with-dash');
  });

  test('custom blueprint soft rules appear in response', async () => {
    mockSend.mockResolvedValue({});
    mockLookupRepo.mockResolvedValue(onboardedWith([CUSTOM_SOFT_RULE]));
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    const ruleIds = body.data.policies.soft.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toContain('custom_rule');
  });

  test('lists Blueprint rules written without annotations under the ids the agent gives them', async () => {
    // The agent runs such an entry as a soft rule named legacy_extra_<n>
    // (agent/src/policy.py). That id is what an approval request shows and what
    // `--pre-approve rule:<id>` takes, so the listing has to show it.
    mockSend.mockResolvedValue({});
    mockLookupRepo.mockResolvedValue(onboardedWith([UNANNOTATED_RULE, OTHER_UNANNOTATED_RULE]));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const ruleIds = JSON.parse(res.body).data.policies.soft.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toEqual(expect.arrayContaining(['legacy_extra_0', 'legacy_extra_1']));
  });

  test('numbers the unannotated entries among themselves, whatever stands between them', async () => {
    // An annotated entry brings its own id and takes no number.
    mockSend.mockResolvedValue({});
    mockLookupRepo.mockResolvedValue(onboardedWith([UNANNOTATED_RULE, CUSTOM_SOFT_RULE, OTHER_UNANNOTATED_RULE]));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const ruleIds = JSON.parse(res.body).data.policies.soft.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toEqual(expect.arrayContaining(['legacy_extra_0', 'custom_rule', 'legacy_extra_1']));
  });

  test('lists a Blueprint rule annotated @tier("hard") among the hard rules', async () => {
    mockSend.mockResolvedValue({});
    mockLookupRepo.mockResolvedValue(onboardedWith([
      '@tier("hard") @rule_id("block_prod_writes") ' +
        'forbid (principal, action == Agent::Action::"write_file", resource) ' +
        'when { context.file_path like "prod/**" };',
    ]));

    const res = await handler(makeEvent());

    const { hard, soft } = JSON.parse(res.body).data.policies;
    expect(hard.map((r: { rule_id: string }) => r.rule_id)).toContain('block_prod_writes');
    expect(soft.map((r: { rule_id: string }) => r.rule_id)).not.toContain('block_prod_writes');
  });

  test('uses Cedar annotations to list inline rules and number legacy entries', async () => {
    mockLookupRepo.mockResolvedValue(onboardedWith([
      `// Previously @tier("hard")\n${UNANNOTATED_RULE}`,
      `@tier ( "hard" ) @rule_id ( "publish_freeze" ) ${UNANNOTATED_RULE}`,
      OTHER_UNANNOTATED_RULE,
    ]));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const { hard, soft } = JSON.parse(res.body).data.policies;
    expect(hard).toContainEqual(expect.objectContaining({ rule_id: 'publish_freeze' }));
    expect(soft.slice(-2).map((r: { rule_id: string }) => r.rule_id)).toEqual([
      'legacy_extra_0', 'legacy_extra_1',
    ]);
  });

  test.each([
    ['both tiers', `${CUSTOM_SOFT_RULE}\n@tier("hard") @rule_id("freeze") ${UNANNOTATED_RULE}`],
    ['a comment alone', '// no policies'],
    ['an unbound template', 'forbid (principal == ?principal, action, resource);'],
  ])('reports an invalid Blueprint entry containing %s', async (_description, entry) => {
    mockLookupRepo.mockResolvedValue(onboardedWith([entry]));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(503);
  });

  test('caches per-repo response across calls', async () => {
    mockSend.mockResolvedValue({});

    const first = await handler(makeEvent());

    // Second call within cache TTL: the onboarding gate reads the row again,
    // but the listing is not rebuilt, so a rule added meanwhile is not in it.
    mockLookupRepo.mockResolvedValue(onboardedWith([CUSTOM_SOFT_RULE]));
    const second = await handler(makeEvent());
    expect(JSON.parse(second.body).data).toEqual(JSON.parse(first.body).data);
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
    mockLookupRepo.mockResolvedValue(onboardedWith(['this is not valid cedar at all ;']));
    const res = await handler(makeEvent('owner%2Frepo-bad'));
    expect(res.statusCode).toBe(503);
  });

  test('logs an invalid policy set under its own message, with the text of the parser in `error`', async () => {
    // A data key named `message` would replace the message of the line, and a
    // search of the log group for 'Cedar parse failure' would find nothing.
    mockSend.mockResolvedValue({});
    mockLookupRepo.mockResolvedValue(onboardedWith(['this is not valid cedar at all ;']));
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    await handler(makeEvent('owner%2Frepo-bad'));
    const lines = stderr.mock.calls.map(([line]) => JSON.parse(String(line)));
    stderr.mockRestore();

    expect(lines).toEqual([{
      level: 'ERROR',
      message: 'Cedar parse failure for repo policies',
      repo_id: 'owner/repo-bad',
      error: 'cedar-wasm rejected policy set',
    }]);
  });

  test('a failed read of the repository row fails that request and is not cached', async () => {
    // A listing built without the Blueprint's rules must not be answered as a
    // 200, and above all not be kept in the per-repository cache: every caller
    // of the next five minutes would be told the repository has no rules of its own.
    mockSend.mockResolvedValue({});
    mockLookupRepo
      .mockRejectedValueOnce(new Error('DDB throttle'))
      .mockResolvedValue(onboardedWith([CUSTOM_SOFT_RULE]));

    const failed = await handler(makeEvent());
    const next = await handler(makeEvent());

    expect(failed.statusCode).toBe(500);
    expect(next.statusCode).toBe(200);
    const ruleIds = JSON.parse(next.body).data.policies.soft.map((r: { rule_id: string }) => r.rule_id);
    expect(ruleIds).toContain('custom_rule');
  });

  test('hard rules do not include severity / approval_timeout_s', async () => {
    mockSend.mockResolvedValue({});
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
    const res = await handler(makeEvent('soft%2Fshape'));
    const body = JSON.parse(res.body);
    const soft = body.data.policies.soft.find(
      (r: { rule_id: string }) => r.rule_id === 'force_push_any',
    );
    expect(soft.severity).toBe('medium');
    expect(soft.approval_timeout_s).toBe(3600);
  });
});
