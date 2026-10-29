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

const send = jest.fn();
const resolveToken = jest.fn();
const lookupTask = jest.fn();
const linear = {
  listOpenProjectIssues: jest.fn(),
  getIssueForStart: jest.fn(),
  findTriggerLabelId: jest.fn(),
  addIssueLabel: jest.fn(),
  writeStartClaim: jest.fn(),
  consumeStartClaim: jest.fn(),
};
const order: string[] = [];

jest.mock('../../src/handlers/shared/ua', () => ({ makeDocClient: () => ({ send }) }));
jest.mock('../../src/handlers/shared/linear-oauth-resolver', () => ({ resolveLinearOauthToken: (...a: unknown[]) => resolveToken(...a) }));
jest.mock('../../src/handlers/shared/linear-task-by-issue', () => ({ lookupTaskByLinearIssue: (...a: unknown[]) => lookupTask(...a) }));
jest.mock('../../src/handlers/shared/linear-console', () => {
  const actual = jest.requireActual('../../src/handlers/shared/linear-console');
  return {
    LinearApiError: actual.LinearApiError,
    listOpenProjectIssues: (...a: unknown[]) => linear.listOpenProjectIssues(...a),
    getIssueForStart: (...a: unknown[]) => linear.getIssueForStart(...a),
    findTriggerLabelId: (...a: unknown[]) => linear.findTriggerLabelId(...a),
    addIssueLabel: (...a: unknown[]) => { order.push('label'); return linear.addIssueLabel(...a); },
    writeStartClaim: (...a: unknown[]) => { order.push('claim'); return linear.writeStartClaim(...a); },
    consumeStartClaim: (...a: unknown[]) => linear.consumeStartClaim(...a),
  };
});
jest.mock('ulid', () => ({ ulid: () => 'REQ1' }));

process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'Mapping';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'Registry';
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = 'Dedup';
process.env.TASK_TABLE_NAME = 'Tasks';

import { handler } from '../../src/handlers/console-linear';

const ISSUE = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const MAPPING = { linear_project_id: PROJECT, repo: 'acme/game', label_filter: 'bgagent', linear_workspace_id: 'w1', status: 'active' };

function event(method: string, resource: string, params: Record<string, string>, body?: unknown, sub: string | null = 'user-1'): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    resource,
    pathParameters: params,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: sub ? { claims: { sub } } : undefined },
  } as unknown as APIGatewayProxyEvent;
}
const list = (repo = 'acme%2Fgame') => event('GET', '/repos/{repo_id}/linear-issues', { repo_id: repo });
const start = (body: unknown = { project_id: PROJECT }, issueId = ISSUE) => event('POST', '/linear-issues/{issue_id}/start', { issue_id: issueId }, body);
const json = (r: { body: string }) => JSON.parse(r.body);

function issue(id: string, labels: string[] = []) {
  return { id, identifier: `MON-${id}`, title: `Issue ${id}`, url: `https://linear.app/x/${id}`, state: 'Todo', state_type: 'unstarted', priority_label: '', labels, assignee: null, updated_at: '2026-10-29T10:00:00Z' };
}

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  resolveToken.mockResolvedValue({ accessToken: 'lin_tok' });
  send.mockImplementation(async (cmd: { input: { Key?: unknown } }) => (cmd.input.Key ? { Item: MAPPING } : { Items: [MAPPING] }));
  linear.getIssueForStart.mockResolvedValue({ id: ISSUE, identifier: 'MON-4', projectId: PROJECT, teamId: 't1', labels: [] });
  linear.findTriggerLabelId.mockResolvedValue('label-1');
  linear.addIssueLabel.mockResolvedValue(undefined);
  linear.writeStartClaim.mockResolvedValue(undefined);
  linear.consumeStartClaim.mockResolvedValue(null);
});

describe('GET /repos/{repo_id}/linear-issues', () => {
  test('lists each mapped project\'s open issues with what the agent is doing', async () => {
    linear.listOpenProjectIssues.mockResolvedValue([issue('a'), issue('b', ['bgagent']), issue('c', ['BGAgent'])]);
    lookupTask.mockImplementation(async (_d: unknown, _t: unknown, issueId: string) => (issueId === 'b'
      ? { kind: 'found', task: { task_id: 't-b', user_id: 'user-1', status: 'RUNNING', pr_url: null } }
      : { kind: 'found', task: { task_id: 't-c', user_id: 'someone-else', status: 'COMPLETED', pr_url: 'https://github.com/acme/game/pull/9' } }));
    const res = await handler(list());
    expect(res.statusCode).toBe(200);
    const [project] = json(res).data.projects;
    expect(project).toMatchObject({ project_id: PROJECT, trigger_label: 'bgagent' });
    expect(project.issues.map((i: { agent: unknown }) => i.agent)).toEqual([
      { kind: 'available' },
      { kind: 'task', task_id: 't-b', status: 'RUNNING', pr_url: null, mine: true },
      // Someone else's task: shown as worked on, without a link into it.
      { kind: 'task', task_id: null, status: 'COMPLETED', pr_url: 'https://github.com/acme/game/pull/9', mine: false },
    ]);
    expect(resolveToken).toHaveBeenCalledWith('w1', 'Registry');
    expect(res.body).not.toContain('lin_tok');
  });

  test('shows a labeled issue without a task yet as starting', async () => {
    linear.listOpenProjectIssues.mockResolvedValue([issue('a', ['bgagent'])]);
    lookupTask.mockResolvedValue({ kind: 'none' });
    expect(json(await handler(list())).data.projects[0].issues[0].agent).toEqual({ kind: 'starting' });
  });

  test('says how to fix a workspace ABCA can no longer reach, instead of failing the page', async () => {
    resolveToken.mockResolvedValue(null);
    const res = await handler(list());
    expect(res.statusCode).toBe(200);
    expect(json(res).data.projects[0]).toMatchObject({ issues: [], problem: expect.stringMatching(/re-authorize/) });
  });

  test('returns no projects for a repo that is not mapped to Linear', async () => {
    send.mockResolvedValue({ Items: [] });
    expect(json(await handler(list())).data.projects).toEqual([]);
  });

  test('requires a signed-in caller and a valid repo', async () => {
    expect((await handler(event('GET', '/repos/{repo_id}/linear-issues', { repo_id: 'acme%2Fgame' }, undefined, null))).statusCode).toBe(401);
    expect((await handler(list('not-a-repo'))).statusCode).toBe(400);
  });
});

describe('POST /linear-issues/{issue_id}/start', () => {
  test('writes the start claim for the caller, then adds the trigger label', async () => {
    const res = await handler(start());
    expect(res.statusCode).toBe(202);
    expect(json(res).data).toEqual({ issue_id: ISSUE, identifier: 'MON-4', repo: 'acme/game' });
    expect(order).toEqual(['claim', 'label']);
    expect(linear.writeStartClaim).toHaveBeenCalledWith(expect.anything(), 'Dedup', { issueId: ISSUE, workspaceId: 'w1', platformUserId: 'user-1' });
    expect(linear.addIssueLabel).toHaveBeenCalledWith('lin_tok', ISSUE, 'label-1');
  });

  test('refuses an issue from a different project than the one named', async () => {
    linear.getIssueForStart.mockResolvedValue({ id: ISSUE, identifier: 'X-1', projectId: '33333333-3333-4333-8333-333333333333', teamId: 't1', labels: [] });
    expect((await handler(start())).statusCode).toBe(404);
    expect(linear.writeStartClaim).not.toHaveBeenCalled();
  });

  test('refuses an issue that is already with the agent', async () => {
    linear.getIssueForStart.mockResolvedValue({ id: ISSUE, identifier: 'MON-4', projectId: PROJECT, teamId: 't1', labels: [{ id: 'l', name: 'BGAGENT' }] });
    const res = await handler(start());
    expect(res.statusCode).toBe(409);
    expect(json(res).error.message).toBe('MON-4 is already handed to the agent.');
  });

  test('explains a missing trigger label', async () => {
    linear.findTriggerLabelId.mockResolvedValue(null);
    const res = await handler(start());
    expect(res.statusCode).toBe(422);
    expect(json(res).error.message).toMatch(/Create it in Linear/);
  });

  test('refuses a project that is not mapped', async () => {
    send.mockResolvedValue({ Item: undefined });
    expect((await handler(start())).statusCode).toBe(422);
  });

  test('removes the claim again when Linear will not add the label', async () => {
    const { LinearApiError } = jest.requireActual('../../src/handlers/shared/linear-console');
    linear.addIssueLabel.mockRejectedValue(new LinearApiError('Linear rejected the request: forbidden'));
    const res = await handler(start());
    expect(res.statusCode).toBe(503);
    expect(json(res).error.message).toBe('Linear rejected the request: forbidden');
    expect(linear.consumeStartClaim).toHaveBeenCalledWith(expect.anything(), 'Dedup', ISSUE, 'w1');
  });

  test.each([
    ['a bad issue id', { project_id: PROJECT }, 'nope'],
    ['a missing project id', {}, ISSUE],
  ])('rejects %s', async (_label, body, issueId) => {
    expect((await handler(start(body, issueId))).statusCode).toBe(400);
  });
});
