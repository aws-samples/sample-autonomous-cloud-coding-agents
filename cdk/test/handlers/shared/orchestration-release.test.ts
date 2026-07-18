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

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  readConcurrencyBudget,
  releaseChild,
  releaseReadyChildren,
} from '../../../src/handlers/shared/orchestration-release';
import { deriveOrchestrationId, type OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';
import { isValidIdempotencyKey } from '../../../src/handlers/shared/validation';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const NOW = '2026-06-09T12:00:00.000Z';

function makeRow(overrides: Partial<OrchestrationChildRow> = {}): OrchestrationChildRow {
  return {
    orchestration_id: 'orch_abc',
    sub_issue_id: 'SUB-1',
    parent_linear_issue_id: 'PARENT',
    linear_workspace_id: 'WS',
    repo: 'owner/repo',
    depends_on: [],
    child_status: 'ready',
    linear_identifier: 'ENG-1',
    title: 'Build the thing',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function created(taskId: string) {
  return jest.fn().mockResolvedValue({ statusCode: 201, body: JSON.stringify({ data: { task_id: taskId } }) });
}

describe('releaseChild — idempotency key is accepted by the REAL validator', () => {
  // Regression: the key was originally `${orchestration_id}#${sub_issue_id}`,
  // but createTaskCore validates against /^[a-zA-Z0-9_-]{1,128}$/ — the '#'
  // was rejected with a 400 and the child silently never started. Mocked
  // createTaskCore tests didn't catch it; this asserts the generated key
  // against the actual validator with production-shaped ids.
  test('generated key passes isValidIdempotencyKey for real-world ids', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    const realRow = makeRow({
      // orch_<32 hex> — exactly what deriveOrchestrationId produces.
      orchestration_id: deriveOrchestrationId('d27fcf21-4876-4be2-96c0-78099bf152de'),
      // sub_issue_id is a Linear UUID in production.
      sub_issue_id: 'a00650a1-4b97-46a3-9977-baede9a8f001',
    });

    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: realRow,
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });

    const ctx = createTaskCore.mock.calls[0][1];
    expect(isValidIdempotencyKey(ctx.idempotencyKey)).toBe(true);
    expect(ctx.idempotencyKey).not.toContain('#');
  });

  test('key stays within the 128-char limit for max-length ids', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({
        orchestration_id: deriveOrchestrationId('x'.repeat(64)),
        sub_issue_id: 'a00650a1-4b97-46a3-9977-baede9a8f001',
      }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(isValidIdempotencyKey(ctx.idempotencyKey)).toBe(true);
  });
});

describe('releaseChild — ABCA-659 retry salts the idempotency key with the prior task id', () => {
  test('retry=true + a prior child_task_id → key salted so a NEW task is created', async () => {
    const createTaskCore = created('T-new');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ child_task_id: '01KX0WFC2DAKSEQY78ZX7WY0W4' }), // the prior FAILED task
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
      retry: true,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    // Salted with the prior task id → distinct from the original 'orch_abc_SUB-1'
    // key, so createTaskCore does NOT idempotently replay the failed task.
    expect(ctx.idempotencyKey).toBe('orch_abc_SUB-1_01KX0WFC2DAKSEQY78ZX7WY0W4');
    expect(isValidIdempotencyKey(ctx.idempotencyKey)).toBe(true);
  });

  test('retry=true but NO prior task id (never-run child) → back-compat key', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(), // no child_task_id
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
      retry: true,
    });
    expect(createTaskCore.mock.calls[0][1].idempotencyKey).toBe('orch_abc_SUB-1');
  });

  test('review #2: key is salted whenever a prior child_task_id exists, even without retry=true', async () => {
    // A child re-released while it still carries a child_task_id inherently means
    // that prior task is TERMINAL (a live child is 'released', not back in
    // ready/blocked). The salt must fire on the id's PRESENCE — NOT the retry
    // flag — else a downstream chain child (reset to blocked, later released by
    // the reconciler with retry=false) replays its dead task under the unsalted
    // key. This is the fix; the OLD behavior (only salt on retry=true) was the bug.
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ child_task_id: 'OLD-TASK' }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
      // NOTE: retry intentionally omitted (defaults false) — the salt still fires.
    });
    expect(createTaskCore.mock.calls[0][1].idempotencyKey).toBe('orch_abc_SUB-1_OLD-TASK');
  });

  test('first release (no prior task id) → unsalted back-compat key', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(), // no child_task_id
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][1].idempotencyKey).toBe('orch_abc_SUB-1');
  });

  test('salted key stays valid + within 128 chars for production-shaped ids (uuid + ulid)', async () => {
    const createTaskCore = created('T-new');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({
        orchestration_id: deriveOrchestrationId('d27fcf21-4876-4be2-96c0-78099bf152de'),
        sub_issue_id: 'a00650a1-4b97-46a3-9977-baede9a8f001',
        child_task_id: '01KX0WFC2DAKSEQY78ZX7WY0W4',
      }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
      retry: true,
    });
    const key = createTaskCore.mock.calls[0][1].idempotencyKey;
    expect(key.length).toBeLessThanOrEqual(128);
    expect(isValidIdempotencyKey(key)).toBe(true);
  });
});

describe('releaseChild — happy path', () => {
  test('creates a task and flips the row to released', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-100');

    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'released', taskId: 'T-100' });

    // createTaskCore called with linear channel + orchestration metadata + idempotency key.
    const [body, ctx, requestId] = createTaskCore.mock.calls[0];
    expect(body).toMatchObject({ repo: 'owner/repo' });
    expect(body.task_description).toContain('ENG-1');
    expect(ctx).toMatchObject({
      userId: 'user-1',
      channelSource: 'linear',
      idempotencyKey: 'orch_abc_SUB-1',
    });
    expect(ctx.channelMetadata).toMatchObject({
      orchestration_id: 'orch_abc',
      orchestration_sub_issue_id: 'SUB-1',
      parent_linear_issue_id: 'PARENT',
    });
    expect(requestId).toBe('orch_abc_SUB-1');

    // review #3 flip-then-create: TWO conditional updates now.
    // Call 0 = the CLAIM (blocked|ready → releasing), BEFORE createTaskCore.
    const claim = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(claim).toBeInstanceOf(UpdateCommand);
    expect(claim.input.ConditionExpression).toContain('child_status IN');
    expect(claim.input.ExpressionAttributeValues![':releasing']).toBe('releasing');
    // Call 1 = the FINALIZE (releasing → released), stamps task id + branch.
    const finalize = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(finalize.input.ConditionExpression).toBe('child_status = :releasing');
    expect(finalize.input.ExpressionAttributeValues![':tid']).toBe('T-100');
    expect(finalize.input.ExpressionAttributeValues![':released']).toBe('released');
  });

  test('PM-4: the planner scope (description) reaches the child task_description below the title', async () => {
    const createTaskCore = created('T-desc');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({
        title: 'Add a team dashboard page',
        description: 'Create `dashboard.html` at the site root showing per-team stats.',
      }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const body = createTaskCore.mock.calls[0][0];
    // Title headline AND the promised deliverable both reach the agent.
    expect(body.task_description).toContain('ENG-1: Add a team dashboard page');
    expect(body.task_description).toContain('dashboard.html');
  });

  test('PM-4: description that just echoes the title is not duplicated', async () => {
    const createTaskCore = created('T-echo');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ title: 'Fix the header', description: 'Fix the header' }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const body = createTaskCore.mock.calls[0][0];
    // "Fix the header" appears once (in the "ENG-1: ..." line), not twice.
    expect(body.task_description.match(/Fix the header/g)?.length).toBe(1);
  });

  test('defaults channelSource to linear when omitted (#247 back-compat)', async () => {
    const createTaskCore = created('T-def');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][1].channelSource).toBe('linear');
  });

  test('threads an explicit channelSource onto the child task (#247 trigger-agnostic)', async () => {
    const createTaskCore = created('T-ch');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      channelSource: 'webhook',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][1].channelSource).toBe('webhook');
  });

  test('threads Linear OAuth metadata when provided', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      linearOauthSecretArn: 'arn:secret',
      linearWorkspaceSlug: 'acme',
      linearProjectId: 'proj-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.channelMetadata).toMatchObject({
      linear_oauth_secret_arn: 'arn:secret',
      linear_workspace_slug: 'acme',
      linear_project_id: 'proj-1',
    });
  });

  test('treats 200 idempotent replay as success', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = jest.fn().mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ data: { task_id: 'T-existing' } }),
    });
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'released', taskId: 'T-existing' });
  });
});

describe('releaseChild — idempotency + failure', () => {
  test('ConditionalCheckFailed on the flip → already_released (no throw)', async () => {
    const conditionalErr = Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
    const ddb = { send: jest.fn().mockRejectedValue(conditionalErr) };
    const createTaskCore = created('T-1');

    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'already_released' });
  });

  test('createTaskCore non-success → create_failed, claim rolled back to ready', async () => {
    // review #3: the claim (call 0) succeeds, createTaskCore fails, so the claim
    // is rolled BACK to 'ready' (call 1) — not left stranded in 'releasing'.
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = jest.fn().mockResolvedValue({ statusCode: 503, body: '{"error":{"message":"down"}}' });

    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result.kind).toBe('create_failed');
    if (result.kind === 'create_failed') expect(result.statusCode).toBe(503);
    expect(ddb.send).toHaveBeenCalledTimes(2);
    const claim = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(claim.input.ExpressionAttributeValues![':releasing']).toBe('releasing');
    const rollback = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(rollback.input.ConditionExpression).toBe('child_status = :releasing');
    expect(rollback.input.ExpressionAttributeValues![':ready']).toBe('ready');
  });

  test('createTaskCore throw → error, claim rolled back to ready', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result.kind).toBe('error');
    // claim (call 0) + rollback (call 1)
    expect(ddb.send).toHaveBeenCalledTimes(2);
    const rollback = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(rollback.input.ExpressionAttributeValues![':ready']).toBe('ready');
  });

  test('review #3: a racing releaser loses the claim (blocked|ready→releasing) and does NOT create a task', async () => {
    // The core exactly-once guarantee: if the atomic claim fails
    // (ConditionalCheckFailed — another releaser already claimed the row),
    // releaseChild returns already_released and NEVER calls createTaskCore.
    const ddb = {
      send: jest.fn().mockRejectedValue(
        Object.assign(new Error('claimed'), { name: 'ConditionalCheckFailedException' }),
      ),
    };
    const createTaskCore = created('SHOULD-NOT-RUN');
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'already_released' });
    expect(createTaskCore).not.toHaveBeenCalled(); // no double-create
    expect(ddb.send).toHaveBeenCalledTimes(1); // only the failed claim
  });

  test('non-conditional DDB error on flip → error', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(new Error('throttle')) };
    const createTaskCore = created('T-1');
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result.kind).toBe('error');
  });

  test('falls back to sub_issue_id in description when title absent', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ title: undefined, linear_identifier: undefined }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][0].task_description).toContain('SUB-1');
  });
});

describe('releaseReadyChildren — #331 concurrency throttle', () => {
  // 5 ready leaves, all roots (no deps) so base selection is trivial.
  const readyRows = (n: number): OrchestrationChildRow[] =>
    Array.from({ length: n }, (_, i) =>
      makeRow({ sub_issue_id: `L${String(i).padStart(2, '0')}`, child_status: 'ready', depends_on: [] }));

  function createOk() {
    let i = 0;
    return jest.fn().mockImplementation(() =>
      Promise.resolve({ statusCode: 201, body: JSON.stringify({ data: { task_id: `T-${i++}` } }) }));
  }

  test('undefined budget → releases ALL ready children (back-compat)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = createOk();
    const results = await releaseReadyChildren(
      ddb as never, 'OrchTable', readyRows(5), { platform_user_id: 'u1' } as never,
      createTaskCore as never, NOW, readyRows(5), 'main', undefined,
    );
    expect(results.filter((r) => r.kind === 'released')).toHaveLength(5);
    expect(createTaskCore).toHaveBeenCalledTimes(5);
  });

  test('budget caps the number released; the rest are NOT created (no fail)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = createOk();
    const rows = readyRows(5);
    const results = await releaseReadyChildren(
      ddb as never, 'OrchTable', rows, { platform_user_id: 'u1' } as never,
      createTaskCore as never, NOW, rows, 'main', 2, // budget = 2 free slots
    );
    // Only 2 tasks created — the other 3 are simply not released this pass.
    expect(createTaskCore).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === 'released')).toBe(true);
  });

  test('budget 0 → releases nothing this pass (no tasks created, no failures)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = createOk();
    const rows = readyRows(5);
    const results = await releaseReadyChildren(
      ddb as never, 'OrchTable', rows, { platform_user_id: 'u1' } as never,
      createTaskCore as never, NOW, rows, 'main', 0,
    );
    expect(createTaskCore).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  test('negative budget is treated as 0 (releases nothing)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = createOk();
    const rows = readyRows(3);
    await releaseReadyChildren(
      ddb as never, 'OrchTable', rows, { platform_user_id: 'u1' } as never,
      createTaskCore as never, NOW, rows, 'main', -4,
    );
    expect(createTaskCore).not.toHaveBeenCalled();
  });

  test('release order is deterministic by sub_issue_id when throttled', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = createOk();
    // Shuffled input; budget 2 should pick L00, L01 (sorted), not input order.
    const rows = [makeRow({ sub_issue_id: 'L02', child_status: 'ready' }),
      makeRow({ sub_issue_id: 'L00', child_status: 'ready' }),
      makeRow({ sub_issue_id: 'L01', child_status: 'ready' })];
    const results = await releaseReadyChildren(
      ddb as never, 'OrchTable', rows, { platform_user_id: 'u1' } as never,
      createTaskCore as never, NOW, rows, 'main', 2,
    );
    expect(results).toHaveLength(2);
    // review #3 flip-then-create: each release now issues TWO UpdateCommands
    // (claim ready→releasing, then finalize releasing→released), both keyed on
    // the same sub_issue_id. Dedup consecutive duplicates to get the release
    // ORDER, which must be sorted L00 then L01 (not the shuffled input order).
    const subsPerCall = (ddb.send.mock.calls as { 0: { input?: { Key?: { sub_issue_id?: string } } } }[])
      .map((c) => c[0]?.input?.Key?.sub_issue_id)
      .filter(Boolean);
    const releaseOrder = subsPerCall.filter((s, i) => s !== subsPerCall[i - 1]);
    expect(releaseOrder).toEqual(['L00', 'L01']);
  });
});

describe('readConcurrencyBudget — #331', () => {
  test('free budget = cap - active_count', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({ Item: { active_count: 3 } }) };
    expect(await readConcurrencyBudget(ddb as never, 'ConcTable', 'u1', 10)).toBe(7);
  });

  test('no row yet → full cap available', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    expect(await readConcurrencyBudget(ddb as never, 'ConcTable', 'u1', 10)).toBe(10);
  });

  test('at cap → 0 (never negative)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({ Item: { active_count: 12 } }) };
    expect(await readConcurrencyBudget(ddb as never, 'ConcTable', 'u1', 10)).toBe(0);
  });

  test('read error → degrades to full cap (admission still gates)', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(new Error('ddb down')) };
    expect(await readConcurrencyBudget(ddb as never, 'ConcTable', 'u1', 10)).toBe(10);
  });
});
