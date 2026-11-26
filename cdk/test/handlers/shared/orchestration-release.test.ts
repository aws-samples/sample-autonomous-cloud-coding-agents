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
  applyTerminalCreateFailures,
  readConcurrencyBudget,
  releaseChild,
  releaseReadyChildren,
} from '../../../src/handlers/shared/orchestration-release';
import { deriveOrchestrationId, type OrchestrationChildRow } from '../../../src/handlers/shared/orchestration-store';
import {
  isValidIdempotencyKey,
  isValidTaskDescriptionLength,
  MAX_TASK_DESCRIPTION_LENGTH,
} from '../../../src/handlers/shared/validation';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const NOW = '2026-06-09T12:00:00.000Z';

function makeRow(overrides: Partial<OrchestrationChildRow> = {}): OrchestrationChildRow {
  return {
    orchestration_id: 'orch_abc',
    sub_issue_id: 'SUB-1',
    parent_issue_ref: 'PARENT',
    credentials_ref: 'WS',
    repo: 'owner/repo',
    depends_on: [],
    child_status: 'ready',
    display_id: 'ENG-1',
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
  test('PARALLEL children each receive the parent\'s shared contract, verbatim', async () => {
    const parentContext = {
      title: 'Booking flow for Kyoto trips',
      description: 'Slug is `kyoto`. Dates are `checkIn`/`checkOut` (ISO-8601).',
    };
    const descriptions: string[] = [];
    for (const [id, title] of [['api', 'Add the booking API'], ['ui', 'Add the booking form']]) {
      const createTaskCore = created(`T-${id}`);
      await releaseChild({
        ddb: { send: jest.fn().mockResolvedValue({}) } as never,
        tableName: 'OrchestrationTable',
        row: makeRow({ sub_issue_id: id, title }),
        platformUserId: 'user-1',
        createTaskCore: createTaskCore as never,
        parentContext,
        now: NOW,
      });
      descriptions.push(createTaskCore.mock.calls[0][0].task_description as string);
    }

    for (const d of descriptions) {
      expect(d).toContain('--- SHARED ORCHESTRATION CONTEXT (the parent epic) ---');
      expect(d).toContain('--- END SHARED ORCHESTRATION CONTEXT ---');
      expect(d).toContain('Slug is `kyoto`');
      expect(d).toContain('`checkIn`/`checkOut`');
      expect(d).toMatch(/in parallel/i);
    }
    expect(descriptions[0]).toContain('Add the booking API');
    expect(descriptions[1]).toContain('Add the booking form');
  });

  test('the shared-context preamble stays DESCRIPTIVE, so the guardrail admits the child', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({}),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      parentContext: { title: 'Epic', description: 'Key is `quickNote`.' },
      now: NOW,
    });
    const d = createTaskCore.mock.calls[0][0].task_description as string;
    const preamble = d.slice(0, d.indexOf('Epic:'));
    expect(preamble).not.toMatch(/\buse it exactly\b/i);
    expect(preamble).not.toMatch(/\bdo not invent\b/i);
    expect(preamble).not.toMatch(/\byou must\b/i);
    expect(preamble).toMatch(/in parallel/i);
    expect(preamble).toMatch(/shared with/i);
  });

  test('an epic with no context does not pad the child prompt with an empty heading', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({}),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][0].task_description).not.toContain('SHARED ORCHESTRATION CONTEXT');
  });

  test('the integration child ALSO gets the shared contract — it verifies the boundary', async () => {
    const createTaskCore = created('T-int');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'orch_abc__integration', depends_on: ['api', 'ui'] }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      parentContext: { title: 'Booking flow', description: 'Slug is `kyoto`.' },
      now: NOW,
    });
    const d = createTaskCore.mock.calls[0][0].task_description as string;
    expect(d).toContain('SHARED ORCHESTRATION CONTEXT');
    expect(d).toContain('Slug is `kyoto`');
    expect(d).toContain('Integrate the completed sub-issue branches');
  });

  test('pins the coding workflow — a child must never fall back to the repo-less default', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({}),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const body = createTaskCore.mock.calls[0][0];
    expect(body.workflow_ref).toBe('coding/new-task-v1');
  });

  test('an INTEGRATION node also pins the coding workflow — it is the case that breaks', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-int');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'orch_abc__integration', depends_on: ['SUB-1', 'SUB-2'] }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][0].workflow_ref).toBe('coding/new-task-v1');
  });

  test('generated key passes isValidIdempotencyKey for real-world ids', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    const realRow = makeRow({
      orchestration_id: deriveOrchestrationId('d27fcf21-4876-4be2-96c0-78099bf152de'),
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

describe('releaseChild — the shared context gives way to the description limit', () => {
  const OWN_TITLE = 'ENG-1: Build the thing';
  const EPIC = { title: 'Booking flow', description: 'E'.repeat(4000) };

  async function taskDescription(
    description: string,
    parentContext: { title?: string; description?: string } = EPIC,
  ): Promise<string> {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ description }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      parentContext,
      now: NOW,
    });
    return createTaskCore.mock.calls[0][0].task_description as string;
  }

  test('a long sub-issue under a long epic keeps all of its own text and stays inside the limit', async () => {
    const own = 'c'.repeat(6000);
    const d = await taskDescription(own);

    expect(d.length).toBeLessThanOrEqual(MAX_TASK_DESCRIPTION_LENGTH);
    expect(isValidTaskDescriptionLength(d)).toBe(true);
    expect(d.endsWith(`${OWN_TITLE}\n\n${own}`)).toBe(true);
    expect(d.startsWith('--- SHARED ORCHESTRATION CONTEXT (the parent epic) ---\n')).toBe(true);
    expect(d).toContain('Epic: Booking flow\n\nEEEE');
    expect(d).toContain('E\n… [truncated]\n\n--- END SHARED ORCHESTRATION CONTEXT ---\n\nENG-1');
    expect(d).toHaveLength(MAX_TASK_DESCRIPTION_LENGTH);
  });

  test('a cut does not leave half of a character behind', async () => {
    for (const ownLength of [6000, 6001]) {
      const d = await taskDescription('c'.repeat(ownLength), { title: EPIC.title, description: '😀'.repeat(2000) });
      expect(d).not.toMatch(/\p{Surrogate}/u);
      expect(d).toContain('😀\n… [truncated]\n\n--- END SHARED ORCHESTRATION CONTEXT ---');
      expect(isValidTaskDescriptionLength(d)).toBe(true);
    }
  });

  test('a block that fits is not cut', async () => {
    const d = await taskDescription('c'.repeat(5000));
    expect(d).toContain(`${EPIC.description}\n\n--- END SHARED ORCHESTRATION CONTEXT ---`);
    expect(d).not.toContain('[truncated]');
  });

  test('the epic title stays when there is no room for any of the body', async () => {
    const frame = (await taskDescription('short', { title: EPIC.title })).length - `\n\n${OWN_TITLE}\n\nshort`.length;
    const own = 'c'.repeat(MAX_TASK_DESCRIPTION_LENGTH - frame - 5 - `\n\n${OWN_TITLE}\n\n`.length);
    const d = await taskDescription(own);

    expect(isValidTaskDescriptionLength(d)).toBe(true);
    expect(d).toContain('Epic: Booking flow\n\n--- END SHARED ORCHESTRATION CONTEXT ---\n\nENG-1');
    expect(d).not.toContain('[truncated]');
    expect(d.endsWith(`${OWN_TITLE}\n\n${own}`)).toBe(true);
  });

  test('room for half a character of the body is room for none of it', async () => {
    const frame = (await taskDescription('short', { title: EPIC.title })).length - `\n\n${OWN_TITLE}\n\nshort`.length;
    const own = 'c'.repeat(MAX_TASK_DESCRIPTION_LENGTH - frame - 17 - `\n\n${OWN_TITLE}\n\n`.length);
    const d = await taskDescription(own, { title: EPIC.title, description: '😀'.repeat(2000) });

    expect(d).not.toMatch(/\p{Surrogate}/u);
    expect(d).toContain('Epic: Booking flow\n\n--- END SHARED ORCHESTRATION CONTEXT ---\n\nENG-1');
    expect(d).not.toContain('[truncated]');
  });

  test('a sub-issue that leaves no room for the block is sent without it', async () => {
    const own = 'c'.repeat(9900);
    expect(await taskDescription(own)).toBe(`${OWN_TITLE}\n\n${own}`);
    expect(await taskDescription(own, { description: EPIC.description })).toBe(`${OWN_TITLE}\n\n${own}`);
  });

  test('a sub-issue that is too long on its own is sent as it is, so the refusal is about its own text', async () => {
    const own = 'c'.repeat(MAX_TASK_DESCRIPTION_LENGTH);
    const d = await taskDescription(own);
    expect(d).toBe(`${OWN_TITLE}\n\n${own}`);
    expect(isValidTaskDescriptionLength(d)).toBe(false);
  });
});

describe('releaseChild — a retry salts the idempotency key with the prior task id', () => {
  test('a prior child_task_id → key salted so a NEW task is created', async () => {
    const createTaskCore = created('T-new');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ child_task_id: '01KX0WFC2DAKSEQY78ZX7WY0W4' }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.idempotencyKey).toBe('orch_abc_SUB-1_01KX0WFC2DAKSEQY78ZX7WY0W4');
    expect(isValidIdempotencyKey(ctx.idempotencyKey)).toBe(true);
  });

  test('the key is salted whenever a prior child_task_id exists, whoever releases the child', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ child_task_id: 'OLD-TASK' }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][1].idempotencyKey).toBe('orch_abc_SUB-1_OLD-TASK');
  });

  test('first release (no prior task id) → unsalted back-compat key', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
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
    });
    const key = createTaskCore.mock.calls[0][1].idempotencyKey;
    expect(key.length).toBeLessThanOrEqual(128);
    expect(isValidIdempotencyKey(key)).toBe(true);
  });
});

describe('releaseChild — happy path', () => {
  test('forwards adapter metadata while protecting orchestration-owned keys', async () => {
    const createTaskCore = created('T-jira');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({
        channel_metadata: {
          jira_cloud_id: 'cloud-1',
          jira_issue_key: 'ENG-2',
          orchestration_id: 'adapter-cannot-override',
        },
      }),
      platformUserId: 'user-1',
      channelSource: 'jira',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });

    expect(createTaskCore.mock.calls[0][1].channelMetadata).toMatchObject({
      jira_cloud_id: 'cloud-1',
      jira_issue_key: 'ENG-2',
      orchestration_id: 'orch_abc',
      orchestration_sub_issue_id: 'SUB-1',
    });
  });

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

    const claim = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(claim).toBeInstanceOf(UpdateCommand);
    expect(claim.input.ConditionExpression).toContain('child_status IN');
    expect(claim.input.ExpressionAttributeValues![':releasing']).toBe('releasing');
    const finalize = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(finalize.input.ConditionExpression).toBe('child_status = :releasing');
    expect(finalize.input.ExpressionAttributeValues![':tid']).toBe('T-100');
    expect(finalize.input.ExpressionAttributeValues![':released']).toBe('released');
  });

  test('starting a task removes the reason of an earlier start that was refused', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ child_task_id: 'T-old', failure_reason: "Couldn't start — a monthly budget is exhausted." }),
      platformUserId: 'user-1',
      createTaskCore: created('T-new') as never,
      now: NOW,
    });

    const finalize = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(finalize.input.ExpressionAttributeValues![':tid']).toBe('T-new');
    expect(finalize.input.UpdateExpression).toMatch(/ REMOVE failure_reason$/);
  });

  test('the planner scope (description) reaches the child task_description below the title', async () => {
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
    expect(body.task_description).toContain('ENG-1: Add a team dashboard page');
    expect(body.task_description).toContain('dashboard.html');
  });

  test('a description that just echoes the title is not duplicated', async () => {
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
    expect(body.task_description.match(/Fix the header/g)?.length).toBe(1);
  });

  test('defaults channelSource to linear when omitted (back-compat)', async () => {
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

  test('threads an explicit channelSource onto the child task (trigger-agnostic)', async () => {
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

  test('a non-Linear child carries the neutral orchestration keys and NO Linear ids', async () => {
    const createTaskCore = created('T-neutral');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ display_id: 'ENG-1' }),
      platformUserId: 'user-1',
      channelSource: 'webhook',
      linearProjectId: 'proj-1',
      linearOauthSecretArn: 'arn:secret',
      linearWorkspaceSlug: 'acme',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const cm = createTaskCore.mock.calls[0][1].channelMetadata as Record<string, string>;
    expect(cm.orchestration_id).toBeDefined();
    expect(cm.orchestration_sub_issue_id).toBeDefined();
    for (const key of [
      'linear_workspace_id',
      'linear_issue_id',
      'linear_issue_identifier',
      'linear_project_id',
      'linear_oauth_secret_arn',
      'linear_workspace_slug',
      'parent_linear_issue_id',
    ]) {
      expect(cm[key]).toBeUndefined();
    }
  });

  test('a Linear child still carries every Linear key it did before', async () => {
    const createTaskCore = created('T-linear');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ display_id: 'ENG-1' }),
      platformUserId: 'user-1',
      channelSource: 'linear',
      linearProjectId: 'proj-1',
      linearOauthSecretArn: 'arn:secret',
      linearWorkspaceSlug: 'acme',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const cm = createTaskCore.mock.calls[0][1].channelMetadata as Record<string, string>;
    expect(cm).toMatchObject({
      linear_workspace_id: 'WS',
      linear_issue_identifier: 'ENG-1',
      linear_project_id: 'proj-1',
      linear_oauth_secret_arn: 'arn:secret',
      linear_workspace_slug: 'acme',
    });
    expect(cm.linear_issue_id).toBeDefined();
    expect(cm.parent_linear_issue_id).toBeDefined();
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
    expect(ddb.send).toHaveBeenCalledTimes(2);
    const rollback = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(rollback.input.ExpressionAttributeValues![':ready']).toBe('ready');
  });

  test('a guardrail 400 → create_failed_terminal, claim flipped to failed (NOT ready) + reason', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = jest.fn().mockResolvedValue({
      statusCode: 400,
      body: '{"error":{"message":"Task description was blocked by content policy."}}',
    });
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result.kind).toBe('create_failed_terminal');
    if (result.kind === 'create_failed_terminal') {
      expect(result.statusCode).toBe(400);
      expect(result.failureReason.toLowerCase()).toContain('content policy');
    }
    expect(ddb.send).toHaveBeenCalledTimes(2);
    const fail = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(fail.input.ConditionExpression).toBe('child_status = :releasing');
    expect(fail.input.ExpressionAttributeValues![':failed']).toBe('failed');
    expect(fail.input.ExpressionAttributeValues![':ready']).toBeUndefined();
    expect(fail.input.ExpressionAttributeValues![':reason']).toContain('content policy');
  });

  test.each([
    ['the content policy', 'Task description was blocked by content policy.', /^Blocked by content policy — reword this sub-issue, /],
    ['validation', 'task_description exceeds maximum length of 10000 characters.', /^Couldn't start \(validation error\) — edit this sub-issue, /],
  ])('a text refused by %s is to be changed and then retried', async (_name, message, start) => {
    const result = await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: jest.fn().mockResolvedValue({ statusCode: 400, body: JSON.stringify({ error: { message } }) }) as never,
      now: NOW,
    });
    expect(result.kind).toBe('create_failed_terminal');
    const reason = result.kind === 'create_failed_terminal' ? result.failureReason : '';
    expect(reason).toMatch(start);
    expect(reason).toMatch(/, then reply `@bgagent retry` on the epic to re-run\.$/);
  });

  test.each([422, 429])('a %i refusal has nothing to do with the text and asks for a retry as well', async (statusCode) => {
    const result = await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: jest.fn().mockResolvedValue({ statusCode, body: '{}' }) as never,
      now: NOW,
    });
    const reason = result.kind === 'create_failed_terminal' ? result.failureReason : '';
    expect(reason).toMatch(/, then reply `@bgagent retry` on the epic to re-run\.$/);
  });

  test('422 REPO_NOT_ONBOARDED is TERMINAL with an "onboard it" reason (sweep can\'t bound it)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = jest.fn().mockResolvedValue({
      statusCode: 422,
      body: '{"error":{"code":"REPO_NOT_ONBOARDED","message":"not onboarded"}}',
    });
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result.kind).toBe('create_failed_terminal');
    if (result.kind === 'create_failed_terminal') expect(result.failureReason).toMatch(/onboard/i);
    const fail = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(fail.input.ExpressionAttributeValues![':failed']).toBe('failed');
  });

  test('429 BUDGET_EXCEEDED is TERMINAL with an actionable budget reason', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = jest.fn().mockResolvedValue({
      statusCode: 429,
      body: '{"error":{"code":"BUDGET_EXCEEDED","message":"monthly budget exhausted"}}',
    });
    const result = await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow(),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(result.kind).toBe('create_failed_terminal');
    if (result.kind === 'create_failed_terminal') {
      expect(result.failureReason).toMatch(/monthly budget/i);
      expect(result.failureReason).toMatch(/next UTC month/i);
    }
    const fail = ddb.send.mock.calls[1][0] as UpdateCommand;
    expect(fail.input.ExpressionAttributeValues![':failed']).toBe('failed');
    expect(fail.input.ExpressionAttributeValues![':reason']).toContain('monthly budget');
  });

  test('5xx (server) + 409 (duplicate replay) are TRANSIENT — roll back to ready', async () => {
    for (const statusCode of [503, 500, 409]) {
      const ddb = { send: jest.fn().mockResolvedValue({}) };
      const createTaskCore = jest.fn().mockResolvedValue({ statusCode, body: '{"error":{"message":"later"}}' });
      const result = await releaseChild({
        ddb: ddb as never,
        tableName: 'OrchestrationTable',
        row: makeRow(),
        platformUserId: 'user-1',
        createTaskCore: createTaskCore as never,
        now: NOW,
      });
      expect(result.kind).toBe('create_failed');
      const rollback = ddb.send.mock.calls[1][0] as UpdateCommand;
      expect(rollback.input.ExpressionAttributeValues![':ready']).toBe('ready');
    }
  });

  test('a racing releaser loses the claim (blocked|ready→releasing) and does NOT create a task', async () => {
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
    expect(createTaskCore).not.toHaveBeenCalled();
    expect(ddb.send).toHaveBeenCalledTimes(1);
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
      row: makeRow({ title: undefined, display_id: undefined }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][0].task_description).toContain('SUB-1');
  });
});

describe('releaseReadyChildren — the concurrency throttle', () => {
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
      createTaskCore as never, NOW, rows, 'main', 2,
    );
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
    const rows = [makeRow({ sub_issue_id: 'L02', child_status: 'ready' }),
      makeRow({ sub_issue_id: 'L00', child_status: 'ready' }),
      makeRow({ sub_issue_id: 'L01', child_status: 'ready' })];
    const results = await releaseReadyChildren(
      ddb as never, 'OrchTable', rows, { platform_user_id: 'u1' } as never,
      createTaskCore as never, NOW, rows, 'main', 2,
    );
    expect(results).toHaveLength(2);
    const subsPerCall = (ddb.send.mock.calls as { 0: { input?: { Key?: { sub_issue_id?: string } } } }[])
      .map((c) => c[0]?.input?.Key?.sub_issue_id)
      .filter(Boolean);
    const releaseOrder = subsPerCall.filter((s, i) => s !== subsPerCall[i - 1]);
    expect(releaseOrder).toEqual(['L00', 'L01']);
  });
});

describe('readConcurrencyBudget', () => {
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

describe('releaseChild — parent attachments inherited by children', () => {
  const ATT = [{
    attachment_id: 'a1',
    type: 'file',
    content_type: 'application/pdf',
    filename: 'spec.pdf',
    s3_key: 'attachments/user-1/epic-P/a1/spec.pdf',
    s3_version_id: 'v1',
    size_bytes: 42,
    screening: { status: 'passed', screened_at: NOW },
    checksum_sha256: 'x'.repeat(64),
  }] as never;

  test('a real feature child receives the parent preScreenedAttachments', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'uuid-A' }),
      platformUserId: 'user-1',
      preScreenedAttachments: ATT,
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.preScreenedAttachments).toHaveLength(1);
    expect(ctx.preScreenedAttachments[0].s3_key).toBe('attachments/user-1/epic-P/a1/spec.pdf');
  });

  test('an INTEGRATION node does NOT receive attachments (pure merge, no spec needed)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'orch_abc__integration' }),
      platformUserId: 'user-1',
      preScreenedAttachments: ATT,
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.preScreenedAttachments).toBeUndefined();
  });

  test('no attachments provided → context omits the field (back-compat)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: ddb as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'uuid-A' }),
      platformUserId: 'user-1',
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    expect(createTaskCore.mock.calls[0][1].preScreenedAttachments).toBeUndefined();
  });

  const ownRec = (id: string, name: string) => ({
    attachment_id: id,
    type: 'file',
    content_type: 'image/png',
    filename: name,
    s3_key: `attachments/user-1/child-SUB/${id}/${name}`,
    s3_version_id: 'v1',
    size_bytes: 10,
    screening: { status: 'passed', screened_at: NOW },
    checksum_sha256: 'y'.repeat(64),
  });

  test('a child with its OWN attachment receives parent spec + own (merged, own first)', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'uuid-A', pre_screened_attachments: [ownRec('own1', 'mock.png')] as never }),
      platformUserId: 'user-1',
      preScreenedAttachments: ATT,
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.preScreenedAttachments).toHaveLength(2);
    expect(ctx.preScreenedAttachments.map((r: { attachment_id: string }) => r.attachment_id)).toEqual(['own1', 'a1']);
  });

  test('a file on BOTH parent and child is de-duped by attachment_id', async () => {
    const createTaskCore = created('T-1');
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'uuid-A', pre_screened_attachments: [ownRec('a1', 'dup.pdf')] as never }),
      platformUserId: 'user-1',
      preScreenedAttachments: ATT,
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.preScreenedAttachments).toHaveLength(1);
    expect(ctx.preScreenedAttachments[0].attachment_id).toBe('a1');
  });

  test('merged set over the per-task cap is trimmed to 10, dropping parent-spec files first', async () => {
    const createTaskCore = created('T-1');
    const own = Array.from({ length: 8 }, (_, i) => ownRec(`own${i}`, `own${i}.png`));
    const parent = Array.from({ length: 5 }, (_, i) => ({ ...ownRec(`par${i}`, `par${i}.pdf`), attachment_id: `par${i}` }));
    await releaseChild({
      ddb: { send: jest.fn().mockResolvedValue({}) } as never,
      tableName: 'OrchestrationTable',
      row: makeRow({ sub_issue_id: 'uuid-A', pre_screened_attachments: own as never }),
      platformUserId: 'user-1',
      preScreenedAttachments: parent as never,
      createTaskCore: createTaskCore as never,
      now: NOW,
    });
    const ctx = createTaskCore.mock.calls[0][1];
    expect(ctx.preScreenedAttachments).toHaveLength(10);
    const ids = ctx.preScreenedAttachments.map((r: { attachment_id: string }) => r.attachment_id);
    expect(ids.filter((i: string) => i.startsWith('own'))).toHaveLength(8);
    expect(ids.filter((i: string) => i.startsWith('par'))).toHaveLength(2);
  });
});

describe('applyTerminalCreateFailures — a child that never became a task', () => {
  const ORCH = 'orch_1';
  const row = (id: string, status: string, deps: string[] = []): OrchestrationChildRow => ({
    orchestration_id: ORCH,
    sub_issue_id: id,
    parent_issue_ref: 'PARENT',
    credentials_ref: 'WS',
    repo: 'o/r',
    depends_on: deps,
    child_status: status as OrchestrationChildRow['child_status'],
    created_at: NOW,
    updated_at: NOW,
  });

  test('skips the failed root\'s dependents and reports them as terminal', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const children = [row('A', 'releasing'), row('B', 'blocked', ['A'])];

    const out = await applyTerminalCreateFailures(
      ddb as never, 'OrchestrationTable', ORCH, children,
      [{ kind: 'create_failed_terminal', subIssueId: 'A', statusCode: 400, failureReason: 'Blocked by content policy' }] as never,
      NOW,
    );

    expect(out.find((c) => c.sub_issue_id === 'A')).toMatchObject({
      child_status: 'failed', failure_reason: 'Blocked by content policy',
    });
    expect(out.find((c) => c.sub_issue_id === 'B')?.child_status).toBe('skipped');
    const writes = ddb.send.mock.calls.map((c) => c[0] as UpdateCommand)
      .filter((cmd) => (cmd.input.ExpressionAttributeValues as Record<string, unknown>)?.[':s'] === 'skipped');
    expect(writes).toHaveLength(1);
    expect((writes[0].input.Key as { sub_issue_id: string }).sub_issue_id).toBe('B');
  });

  test('a skip write can never stamp a LIVE sibling terminal', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await applyTerminalCreateFailures(
      ddb as never, 'OrchestrationTable', ORCH,
      [row('A', 'releasing'), row('B', 'blocked', ['A'])],
      [{ kind: 'create_failed_terminal', subIssueId: 'A', statusCode: 400, failureReason: 'r' }] as never,
      NOW,
    );
    const cmd = ddb.send.mock.calls[0][0] as UpdateCommand;
    expect(cmd.input.ConditionExpression).toBe('child_status IN (:blocked, :ready)');
  });

  test('returns the SAME array when nothing failed terminally (callers key on identity)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const children = [row('A', 'released')];

    const out = await applyTerminalCreateFailures(
      ddb as never, 'OrchestrationTable', ORCH, children,
      [{ kind: 'released', subIssueId: 'A' }] as never, NOW,
    );

    expect(out).toBe(children);
    expect(ddb.send).not.toHaveBeenCalled();
  });

  test('a diamond whose two failed roots share a leaf skips that leaf once', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    const out = await applyTerminalCreateFailures(
      ddb as never, 'OrchestrationTable', ORCH,
      [row('A', 'releasing'), row('B', 'releasing'), row('C', 'blocked', ['A', 'B'])],
      [
        { kind: 'create_failed_terminal', subIssueId: 'A', statusCode: 400, failureReason: 'r' },
        { kind: 'create_failed_terminal', subIssueId: 'B', statusCode: 400, failureReason: 'r' },
      ] as never,
      NOW,
    );
    expect(out.find((c) => c.sub_issue_id === 'C')?.child_status).toBe('skipped');
    const skipWrites = ddb.send.mock.calls.map((c) => c[0] as UpdateCommand)
      .filter((cmd) => (cmd.input.ExpressionAttributeValues as Record<string, unknown>)?.[':s'] === 'skipped');
    expect(skipWrites).toHaveLength(1);
  });

  test('an already-skipped dependent is not re-written', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await applyTerminalCreateFailures(
      ddb as never, 'OrchestrationTable', ORCH,
      [row('A', 'releasing'), row('B', 'skipped', ['A'])],
      [{ kind: 'create_failed_terminal', subIssueId: 'A', statusCode: 400, failureReason: 'r' }] as never,
      NOW,
    );
    expect(ddb.send).not.toHaveBeenCalled();
  });
});
