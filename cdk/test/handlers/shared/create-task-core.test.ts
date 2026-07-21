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

// --- Mocks ---
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  ApplyGuardrailCommand: jest.fn((input: unknown) => ({ _type: 'ApplyGuardrail', input })),
}));

// create-task-core collapsed the prior checkRepoOnboarded +
// loadRepoConfig pair into a single ``lookupRepo`` call (see
// ``cdk/src/handlers/shared/repo-config.ts::lookupRepo``). The mock
// exposes the one function the submit path now calls; the two
// convenience wrappers are still exported on the real module but
// create-task-core doesn't reach for them, so leaving them off the
// mock keeps test failures load-bearing if the import surface
// drifts.
const mockLookupRepo = jest.fn();
jest.mock('../../../src/handlers/shared/repo-config', () => ({
  lookupRepo: mockLookupRepo,
}));

// Partial-mock the workflows module: keep every real resolver/descriptor, but
// make ``disallowedWorkflowModel`` controllable so the rule-13 admission path
// can be exercised without shipping a workflow that pins a bad model. Defaults
// to the real implementation (null for all shipped workflows) via beforeEach.
const mockDisallowedWorkflowModel = jest.fn();
jest.mock('../../../src/handlers/shared/workflows', () => {
  const actual = jest.requireActual('../../../src/handlers/shared/workflows');
  return { ...actual, disallowedWorkflowModel: mockDisallowedWorkflowModel };
});

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.TASK_RETENTION_DAYS = '90';
process.env.ORCHESTRATOR_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:live';
process.env.GUARDRAIL_ID = 'test-guardrail-id';
process.env.GUARDRAIL_VERSION = '1';
process.env.REPO_TABLE_NAME = 'RepoConfig';

import { createTaskCore, type TaskCreationContext } from '../../../src/handlers/shared/create-task-core';

function makeContext(overrides: Partial<TaskCreationContext> = {}): TaskCreationContext {
  return {
    userId: 'user-123',
    channelSource: 'api',
    channelMetadata: { source_ip: '1.2.3.4' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
  mockBedrockSend.mockResolvedValue({ action: 'NONE' });
  // Default: repo is onboarded, no blueprint config (submit path
  // resolves to the platform-default approval_gate_cap of 50).
  mockLookupRepo.mockResolvedValue({ onboarded: true, config: null });
  // Default: the resolved workflow's model is permitted (matches the real
  // implementation for every shipped workflow). Rule-13 tests override this.
  mockDisallowedWorkflowModel.mockReturnValue(null);
});

describe('createTaskCore', () => {
  test('creates task successfully', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBeDefined();
    expect(body.data.status).toBe('SUBMITTED');
    expect(body.data.repo).toBe('org/repo');
    expect(mockSend).toHaveBeenCalledTimes(2); // task + event
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  test('accepts an initial_approvals pattern whose value contains a colon', async () => {
    // Regression: the degenerate-pattern guard used split(':', 2)[1], which
    // truncated the value at the next colon. For "ab:cdefgh" that yields the
    // 2-char fragment "ab", which isDegeneratePattern flags as degenerate —
    // a spurious 400. The full value "ab:cdefgh" is not degenerate, so the
    // scope must be accepted.
    const result = await createTaskCore(
      {
        repo: 'org/repo',
        task_description: 'Fix the bug',
        initial_approvals: ['bash_pattern:ab:cdefgh'],
      } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('still rejects a genuinely degenerate initial_approvals pattern', async () => {
    const result = await createTaskCore(
      {
        repo: 'org/repo',
        task_description: 'Fix the bug',
        initial_approvals: ['bash_pattern:*'],
      } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for invalid repo', async () => {
    const result = await createTaskCore({ repo: 'invalid' } as any, makeContext(), 'req-1');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('accepts a repo-less submission (#248 Phase 3)', async () => {
    // No repo + the repo-optional default workflow ⇒ 201, no onboarding lookup,
    // no repo persisted on the record.
    const result = await createTaskCore(
      { workflow_ref: 'default/agent-v1', task_description: 'Summarise these papers' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe('SUBMITTED');
    expect(body.data.repo).toBeNull();
    // Repo-less ⇒ no branch is created (the agent never clones/branches/PRs), so
    // branch_name is empty rather than a misleading bgagent/<id>/... slug.
    expect(body.data.branch_name).toBe('');
    // Repo-less ⇒ the onboarding/blueprint RepoTable lookup is skipped entirely.
    expect(mockLookupRepo).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(2); // task + event
  });

  test('returns 400 for an unsatisfiable @version pin (#296 finding #6)', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', workflow_ref: 'coding/new-task-v1@2.0.0' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('not available');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 400 when a repo-bound workflow is missing its repo (#248 Phase 3)', async () => {
    const result = await createTaskCore(
      { workflow_ref: 'coding/new-task-v1', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('repo');
  });

  test('rejects a malformed repo on a repo-bound workflow (#248 Phase 3)', async () => {
    // The repo-present-but-malformed branch: a repo-bound workflow with a
    // bad-format repo is a 400 with the new "Invalid repo." message.
    const result = await createTaskCore(
      { workflow_ref: 'coding/new-task-v1', repo: 'not-a-repo', task_description: 'Fix it' } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('Invalid repo');
  });

  test('repo-OPTIONAL workflow given a valid repo runs the repo-bound path (#248 Phase 3)', async () => {
    // default/agent-v1 is repo-optional; when a repo IS supplied it must still
    // be onboarded-checked and persisted (requires_repo:false means optional,
    // not forbidden).
    const result = await createTaskCore(
      { workflow_ref: 'default/agent-v1', repo: 'org/repo', task_description: 'Do it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.repo).toBe('org/repo');
    // Repo present ⇒ the onboarding/blueprint lookup DID run.
    expect(mockLookupRepo).toHaveBeenCalledWith('org/repo');
  });

  test('returns 400 when the resolved workflow pins a disallowed model (rule 13)', async () => {
    // WORKFLOWS.md rule 13: a workflow whose agent_config.model.id is not on the
    // platform allow-list FAILS admission (no silent downgrade).
    mockDisallowedWorkflowModel.mockReturnValue('anthropic.some-unapproved-model');
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('not on the platform allow-list');
    // Rejected at admission — no task/event writes, no orchestrator invoke.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('admits a task when the resolved workflow model is permitted (rule 13 pass)', async () => {
    mockDisallowedWorkflowModel.mockReturnValue(null);
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('returns 400 when no task spec', async () => {
    const result = await createTaskCore({ repo: 'org/repo' }, makeContext(), 'req-1');
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when guardrail blocks description', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED' });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'bad content' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('content policy');
  });

  test('returns 503 when guardrail service fails (fail-closed)', async () => {
    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock service unavailable'));
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body).error.message).toContain('Content screening is temporarily unavailable');
  });

  test('returns 200 with existing task for same-user idempotency replay', async () => {
    const existingItem = {
      task_id: 'existing',
      user_id: 'user-123',
      status: 'SUBMITTED',
      repo: 'org/repo',
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
      task_description: 'Original work',
      branch_name: 'bgagent/existing/slug',
      channel_source: 'api',
      channel_metadata: { source_ip: '1.2.3.4' },
      status_created_at: 'SUBMITTED#2020-01-01T00:00:00.000Z',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      idempotency_key: 'my-key',
    };
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({ Item: existingItem });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Idempotent-Replay']).toBe('true');
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBe('existing');
    expect(body.data.task_description).toBe('Original work');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('returns 200 for a repo-less idempotency replay despite empty branch_name', async () => {
    // Regression: a repo-less record legitimately persists branch_name='' (and
    // no repo). The replay completeness check must not treat those falsy fields
    // as "missing" and 500 — only true identity/audit fields are required.
    const existingItem = {
      task_id: 'existing-repoless',
      user_id: 'user-123',
      status: 'SUBMITTED',
      resolved_workflow: { id: 'knowledge/web-research-v1', version: '1.0.0' },
      task_description: 'Summarise these papers',
      branch_name: '',
      channel_source: 'api',
      status_created_at: 'SUBMITTED#2020-01-01T00:00:00.000Z',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      idempotency_key: 'rl-key',
    };
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing-repoless' }] })
      .mockResolvedValueOnce({ Item: existingItem });

    const result = await createTaskCore(
      { workflow_ref: 'knowledge/web-research-v1', task_description: 'Summarise these papers' },
      makeContext({ idempotencyKey: 'rl-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Idempotent-Replay']).toBe('true');
    expect(JSON.parse(result.body).data.task_id).toBe('existing-repoless');
  });

  test('returns 409 when idempotency key belongs to another user', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({
        Item: {
          task_id: 'existing',
          user_id: 'other-user',
          status: 'SUBMITTED',
          repo: 'org/repo',
          resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
          branch_name: 'bgagent/existing/slug',
          channel_source: 'api',
          status_created_at: 'SUBMITTED#2020-01-01T00:00:00.000Z',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        },
      });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error.code).toBe('DUPLICATE_TASK');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('returns 500 when idempotent replay record is incomplete', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({
        Item: {
          task_id: 'existing',
          user_id: 'user-123',
          // missing status, repo, branch_name, channel_source, created_at, updated_at
        },
      });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('returns 500 when idempotent replay record has no user_id (fail-closed)', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'existing' }] })
      .mockResolvedValueOnce({
        Item: {
          task_id: 'existing',
          // user_id missing entirely — must deny, not match
          status: 'SUBMITTED',
          repo: 'org/repo',
          branch_name: 'bgagent/existing/slug',
          channel_source: 'api',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        },
      });

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    // Missing user_id → incomplete record → 500 (fail-closed)
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  test('creates new task when GSI matches but base-table item is gone (TTL race)', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'gone-task' }] })
      .mockResolvedValueOnce({ Item: undefined }) // GetCommand returns nothing
      .mockResolvedValueOnce({}) // PutCommand for new task
      .mockResolvedValueOnce({}); // PutCommand for event

    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'my-key' }),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.task_id).toBeDefined();
    expect(body.data.task_id).not.toBe('gone-task');
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for invalid idempotency key', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ idempotencyKey: 'key with spaces!' }),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
  });

  test('sets channelSource to webhook when specified', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext({ channelSource: 'webhook', channelMetadata: { webhook_id: 'wh-1' } }),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    // The event metadata should include channel_source: 'webhook'
    const putCalls = mockSend.mock.calls;
    const eventPut = putCalls[1][0];
    expect(eventPut.input.Item.metadata.channel_source).toBe('webhook');
  });

  test('includes ttl on task_created event', async () => {
    await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    const putCalls = mockSend.mock.calls;
    const eventPut = putCalls[1][0]; // second DDB call is the event
    expect(eventPut.input.Item.ttl).toBeDefined();
    expect(typeof eventPut.input.Item.ttl).toBe('number');
    expect(eventPut.input.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('returns 201 even when orchestrator fails', async () => {
    mockLambdaSend.mockRejectedValueOnce(new Error('Lambda error'));
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('returns 201 even when event write fails', async () => {
    // First call succeeds (task record), second call fails (event write)
    mockSend
      .mockResolvedValueOnce({}) // PutCommand for task record
      .mockRejectedValueOnce(new Error('Event write error'));
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('omits max_turns from record when not specified (computed at orchestration time)', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.max_turns).toBeNull();
  });

  test('includes user-specified max_turns', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug', max_turns: 50 },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.max_turns).toBe(50);
  });

  test('returns 400 for max_turns of 0', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', max_turns: 0 } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('max_turns');
  });

  test('returns 400 for max_turns of 501', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', max_turns: 501 } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('max_turns');
  });

  test('returns 400 for non-integer max_turns', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', max_turns: 1.5 } as any,
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('max_turns');
  });

  test('returns 400 when task_description exceeds length limit', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'a'.repeat(10_001) },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('exceeds maximum length');
  });

  test('accepts task_description at exactly the length limit', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'a'.repeat(10_000) },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('returns 422 when repo is not onboarded', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: false, config: null });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(422);
    expect(JSON.parse(result.body).error.code).toBe('REPO_NOT_ONBOARDED');
  });

  test('creates task successfully when repo is onboarded', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: true, config: null });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-1',
    );
    expect(result.statusCode).toBe(201);
  });

  test('resolves the platform default when workflow_ref is omitted (repo present)', async () => {
    // createTaskCore does NOT infer the coding workflow from the mere presence
    // of a repo — that "repo task ⇒ coding workflow" decision is pinned by each
    // CHANNEL processor at its call site (Linear/Jira/Slack pass
    // workflow_ref: CODING_WORKFLOW_ID; see those processors' tests). A raw
    // createTaskCore call with no ref falls through the resolution ladder to the
    // repo-less platform default, whether or not a repo is attached.
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-default',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.resolved_workflow).toEqual({ id: 'default/agent-v1', version: '1.0.0' });
  });

  test('resolves the platform default when workflow_ref is omitted AND no repo (symmetric)', async () => {
    // §6 symmetric coverage: the repo-less path through the real caller. Guards
    // against a future fallback-branch inversion that a repo-pinned test would
    // miss (the repo-less default must stay default/agent-v1).
    const result = await createTaskCore(
      { task_description: 'Do some research' },
      makeContext(),
      'req-default-norepo',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.resolved_workflow).toEqual({ id: 'default/agent-v1', version: '1.0.0' });
  });

  test('creates a pr-iteration workflow task with pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', workflow_ref: 'coding/pr-iteration-v1', pr_number: 42 },
      makeContext(),
      'req-pr-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.resolved_workflow).toEqual({ id: 'coding/pr-iteration-v1', version: '1.0.0' });
    expect(body.data.pr_number).toBe(42);
    expect(body.data.branch_name).toBe('pending:pr_resolution');
  });

  test('returns 400 for a pr workflow without pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', workflow_ref: 'coding/pr-iteration-v1', task_description: 'Fix it' },
      makeContext(),
      'req-pr-2',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number');
  });

  test('returns 400 for pr_number on a non-pr workflow', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', pr_number: 42 } as any,
      makeContext(),
      'req-pr-3',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number is only allowed');
  });

  test('returns 400 for an unknown workflow_ref', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', workflow_ref: 'coding/does-not-exist-v1' },
      makeContext(),
      'req-pr-4',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('Unknown workflow_ref');
  });

  test('returns 400 for a malformed workflow_ref', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix it', workflow_ref: 'not-a-valid-ref' },
      makeContext(),
      'req-pr-4b',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('Invalid workflow_ref');
  });

  test('creates a pr-review workflow task with pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', workflow_ref: 'coding/pr-review-v1', pr_number: 99 },
      makeContext(),
      'req-review-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.resolved_workflow).toEqual({ id: 'coding/pr-review-v1', version: '1.0.0' });
    expect(body.data.pr_number).toBe(99);
    expect(body.data.branch_name).toBe('pending:pr_resolution');
  });

  test('returns 400 for a pr-review workflow without pr_number', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', workflow_ref: 'coding/pr-review-v1', task_description: 'Review it' },
      makeContext(),
      'req-review-2',
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('pr_number');
  });

  // -- trace flag (design §10.1) --------------------------------------

  test('trace: true persists on the task record and surfaces in the response', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'deep debug', trace: true },
      makeContext(),
      'req-trace-1',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.trace).toBe(true);

    // Verify the PutCommand carried trace on the record.
    const putCall = mockSend.mock.calls.find(
      c => (c[0] as { _type?: string; input?: { Item?: { trace?: unknown } } })._type === 'Put'
        && (c[0] as { input?: { Item?: unknown } }).input?.Item !== undefined,
    );
    expect(putCall).toBeDefined();
    const item = (putCall![0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(item.trace).toBe(true);
  });

  test('trace omitted or false does NOT persist a trace field (slim wire payload)', async () => {
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'normal' },
      makeContext(),
      'req-trace-2',
    );
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.trace).toBe(false);

    const putCall = mockSend.mock.calls.find(
      c => (c[0] as { _type?: string })._type === 'Put'
        && (c[0] as { input?: { Item?: unknown } }).input?.Item !== undefined,
    );
    const item = (putCall![0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(item).not.toHaveProperty('trace');
  });

  test('trace with non-boolean type returns 400 (strict boolean validation)', async () => {
    // Prevents a misbehaving client from accidentally enabling trace
    // with ``"trace": "false"`` (truthy string).
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x', trace: 'true' } as any,
      makeContext(),
      'req-trace-3',
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('trace');
  });

  test.each([
    ['"false"', 'false'],
    ['numeric 0', 0],
    ['numeric 1', 1],
    ['null', null],
    ['empty object', {}],
  ])('trace as %s is rejected with 400', async (_label, value) => {
    // Adversarial inputs: the strict ``typeof === 'boolean'`` check
    // must reject every non-boolean shape, not just the obvious string
    // case. A future refactor that switches to a truthy test would
    // pass the single "'true'" test above but break on these.
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x', trace: value } as any,
      makeContext(),
      `req-trace-adv-${String(value)}`,
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.message).toContain('trace');
  });

  // --- Chunk 7b: approval_gate_cap resolution (§4 step 5, decision #13) ---

  function getPersistedTaskRecord() {
    const putCall = mockSend.mock.calls.find(
      (c: any) => c[0]?._type === 'Put' && c[0]?.input?.TableName === 'Tasks',
    );
    return putCall?.[0]?.input?.Item;
  }

  // Wrap the ``lookupRepo`` mock for the "onboarded + config" case
  // used by every blueprint-cap test below. Keeps each test focused
  // on the cap value under test rather than repeating the full
  // RepoConfig shape.
  function mockOnboardedWithConfig(config: Record<string, unknown>): void {
    mockLookupRepo.mockResolvedValueOnce({
      onboarded: true,
      config: {
        repo: 'org/repo',
        status: 'active',
        onboarded_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        ...config,
      },
    });
  }

  test('persists default approval_gate_cap of 50 when blueprint omits the override', async () => {
    mockLookupRepo.mockResolvedValueOnce({ onboarded: true, config: null });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x' },
      makeContext(),
      'req-cap-default',
    );
    expect(result.statusCode).toBe(201);
    const record = getPersistedTaskRecord();
    expect(record.approval_gate_cap).toBe(50);
  });

  test('persists default-50 when RepoConfig exists but lacks approval_gate_cap', async () => {
    // Legacy blueprint predating Chunk 7b: cedar_policies set, cap unset.
    mockOnboardedWithConfig({
      cedar_policies: ['permit (principal, action, resource);'],
    });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x' },
      makeContext(),
      'req-cap-legacy',
    );
    expect(result.statusCode).toBe(201);
    const record = getPersistedTaskRecord();
    expect(record.approval_gate_cap).toBe(50);
  });

  test('persists blueprint-configured approval_gate_cap when within bounds', async () => {
    mockOnboardedWithConfig({ approval_gate_cap: 150 });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x' },
      makeContext(),
      'req-cap-override',
    );
    expect(result.statusCode).toBe(201);
    const record = getPersistedTaskRecord();
    expect(record.approval_gate_cap).toBe(150);
  });

  test.each([
    ['min (1)', 1],
    ['max (500)', 500],
  ])('accepts blueprint approval_gate_cap at boundary %s', async (_label, cap) => {
    mockOnboardedWithConfig({ approval_gate_cap: cap });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x' },
      makeContext(),
      `req-cap-boundary-${cap}`,
    );
    expect(result.statusCode).toBe(201);
    expect(getPersistedTaskRecord().approval_gate_cap).toBe(cap);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['exceeds max', 501],
    ['exceeds max big', 10000],
  ])('returns 503 when blueprint approval_gate_cap is %s (out-of-bounds)', async (_label, cap) => {
    // Blueprint synth validation should catch these, but a hand-edited
    // RepoConfig row could bypass it. Fail closed so we never persist
    // a bad cap onto a TaskRecord. 503 SERVICE_UNAVAILABLE (not 500)
    // because the condition is permanent platform misconfiguration,
    // not a transient internal error — 500 would misleadingly suggest
    // retry-will-fix.
    mockOnboardedWithConfig({ approval_gate_cap: cap });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x' },
      makeContext(),
      `req-cap-bad-${cap}`,
    );
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.parse(result.body).error.message).toContain('approval_gate_cap');
  });

  test.each([
    ['string', '50'],
    ['float', 3.14],
    ['object', {}],
  ])('returns 503 when blueprint approval_gate_cap is non-integer (%s)', async (_label, cap) => {
    mockOnboardedWithConfig({ approval_gate_cap: cap });
    const result = await createTaskCore(
      { repo: 'org/repo', task_description: 'x' },
      makeContext(),
      'req-cap-non-int',
    );
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.parse(result.body).error.message).toContain('not an integer');
  });

  test('only performs one RepoTable GetItem on the submit path', async () => {
    // Regression guard: the submit path previously issued two
    // back-to-back GetItems on the same key (onboarding gate +
    // blueprint cap). ``lookupRepo`` collapses them into one.
    await createTaskCore(
      { repo: 'org/repo', task_description: 'Fix the bug' },
      makeContext(),
      'req-single-get',
    );
    expect(mockLookupRepo).toHaveBeenCalledTimes(1);
    expect(mockLookupRepo).toHaveBeenCalledWith('org/repo');
  });
});
