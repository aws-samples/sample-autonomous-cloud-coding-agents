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

    // Conditional update flips status + stamps task id.
    const update = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.ConditionExpression).toContain('child_status IN');
    expect(update.input.ExpressionAttributeValues![':tid']).toBe('T-100');
    expect(update.input.ExpressionAttributeValues![':released']).toBe('released');
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

  test('createTaskCore non-success → create_failed, no row update', async () => {
    const ddb = { send: jest.fn() };
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
    expect(ddb.send).not.toHaveBeenCalled();
  });

  test('createTaskCore throw → error', async () => {
    const ddb = { send: jest.fn() };
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
    expect(ddb.send).not.toHaveBeenCalled();
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
    // The two UpdateCommands that flip ready→released name L00 then L01.
    const releasedSubs = (ddb.send.mock.calls as { 0: { input?: { Key?: { sub_issue_id?: string } } } }[])
      .map((c) => c[0]?.input?.Key?.sub_issue_id)
      .filter(Boolean);
    expect(releasedSubs).toEqual(['L00', 'L01']);
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
