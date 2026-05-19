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

import type { ApiClient } from '../../src/api-client';
import { RealDataSource } from '../../src/tui/api/source-real';
import type {
  GetPendingResponse,
  GetPoliciesResponse,
  PaginatedResponse,
  TaskDetail,
  TaskEvent,
  TaskSummary,
} from '../../src/types';

function taskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    status: 'RUNNING',
    repo: 'aws-samples/foo',
    issue_number: null,
    task_type: 'new_task',
    pr_number: null,
    task_description: 'do a thing',
    branch_name: 'agent/thing',
    session_id: null,
    pr_url: null,
    error_message: null,
    error_classification: null,
    prompt_version: null,
    channel_source: 'api',
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
    started_at: null,
    completed_at: null,
    duration_s: null,
    cost_usd: 0.1,
    build_passed: null,
    max_turns: 8,
    max_budget_usd: null,
    turns_attempted: 3,
    turns_completed: 3,
    trace: false,
    trace_s3_uri: null,
    approval_gate_count: 1,
    approval_gate_cap: 50,
    awaiting_approval_request_id: null,
    ...overrides,
  };
}

function taskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    status: 'RUNNING',
    repo: 'aws-samples/foo',
    issue_number: null,
    task_type: 'new_task',
    pr_number: null,
    task_description: 'do a thing',
    branch_name: 'agent/thing',
    pr_url: null,
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
    ...overrides,
  };
}

function fakeClient(overrides: Partial<Record<keyof ApiClient, jest.Mock>> = {}): ApiClient {
  const client: Partial<Record<keyof ApiClient, jest.Mock>> = {
    listTasks: jest.fn(async (): Promise<PaginatedResponse<TaskSummary>> => ({
      data: [taskSummary()],
      pagination: { next_token: null, has_more: false },
    })),
    getTask: jest.fn(async () => taskDetail()),
    getTaskEvents: jest.fn(async () => ({
      data: [],
      pagination: { next_token: null, has_more: false },
    })),
    listPending: jest.fn(async (): Promise<GetPendingResponse> => ({ pending: [] })),
    listPolicies: jest.fn(async (): Promise<GetPoliciesResponse> => ({
      repo_id: 'aws-samples/foo',
      policies: { hard: [], soft: [] },
    })),
    createTask: jest.fn(async () => taskDetail()),
    approveTask: jest.fn(async () => ({
      task_id: 't',
      request_id: 'r',
      status: 'APPROVED' as const,
      scope: 'this_call' as const,
      decided_at: '2026-05-12T00:00:00Z',
    })),
    denyTask: jest.fn(async () => ({
      task_id: 't',
      request_id: 'r',
      status: 'DENIED' as const,
      decided_at: '2026-05-12T00:00:00Z',
    })),
    ...overrides,
  };
  return client as unknown as ApiClient;
}

describe('RealDataSource', () => {
  it('reports live label', () => {
    const src = new RealDataSource(fakeClient());
    expect(src.label).toBe('live');
  });

  it('listTasks hydrates each summary via getTask', async () => {
    const getTask = jest.fn(async () => taskDetail());
    const client = fakeClient({ getTask: getTask as unknown as jest.Mock });
    const src = new RealDataSource(client);
    const rows = await src.listTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].cost_usd).toBe(0.1);
    expect(rows[0].approval_gate_count).toBe(1);
    expect(getTask).toHaveBeenCalledTimes(1);
  });

  it('listTasks falls back to summary when getTask fails', async () => {
    const getTask = jest.fn(async () => { throw new Error('boom'); });
    const client = fakeClient({ getTask: getTask as unknown as jest.Mock });
    const src = new RealDataSource(client);
    const rows = await src.listTasks();
    expect(rows.length).toBe(1);
    expect(rows[0].cost_usd).toBeNull();
    expect(rows[0].approval_gate_count).toBeNull();
    expect(rows[0].task_id).toBe('01JBX7QNMR5PG4HW3FS8AY2K9');
  });

  it('listPending joins repo + description from cached task list', async () => {
    const listPending = jest.fn(async (): Promise<GetPendingResponse> => ({
      pending: [{
        task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
        request_id: 'r1',
        tool_name: 'Bash',
        tool_input_preview: 'npm install',
        severity: 'high',
        reason: 'bash exec requires approval',
        created_at: '2026-05-12T00:00:00Z',
        timeout_s: 600,
        expires_at: '2026-05-12T00:10:00Z',
        matching_rule_ids: ['bash_exec_gate'],
      }],
    }));
    const client = fakeClient({ listPending: listPending as unknown as jest.Mock });
    const src = new RealDataSource(client);
    await src.listTasks();
    const pending = await src.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].repo).toBe('aws-samples/foo');
    expect(pending[0].task_description).toBe('do a thing');
    expect(pending[0].severity).toBe('HIGH');
  });

  it('listPolicies routes to /repos/{id}/policies', async () => {
    const listPolicies = jest.fn(async (): Promise<GetPoliciesResponse> => ({
      repo_id: 'aws-samples/foo',
      policies: {
        hard: [{ rule_id: 'rm_slash', summary: 'blocks rm -rf /', severity: 'high' }],
        soft: [{ rule_id: 'bash_exec_gate', summary: 'bash requires approval' }],
      },
    }));
    const client = fakeClient({ listPolicies: listPolicies as unknown as jest.Mock });
    const src = new RealDataSource(client);
    const p = await src.listPolicies('aws-samples/foo');
    expect(listPolicies).toHaveBeenCalledWith('aws-samples/foo');
    expect(p.hard[0].tier).toBe('hard');
    expect(p.soft[0].tier).toBe('soft');
  });

  it('listPolicies short-circuits on empty repoId', async () => {
    const listPolicies = jest.fn(async () => ({ repo_id: '', policies: { hard: [], soft: [] } }));
    const client = fakeClient({ listPolicies: listPolicies as unknown as jest.Mock });
    const src = new RealDataSource(client);
    const p = await src.listPolicies('');
    expect(p.hard).toEqual([]);
    expect(p.soft).toEqual([]);
    expect(listPolicies).not.toHaveBeenCalled();
  });

  it('listRegisteredRepos derives from cached task list (deduped)', async () => {
    const listTasks = jest.fn(async (): Promise<PaginatedResponse<TaskSummary>> => ({
      data: [
        taskSummary({ task_id: 'a', repo: 'aws-samples/foo' }),
        taskSummary({ task_id: 'b', repo: 'aws-samples/foo' }),
        taskSummary({ task_id: 'c', repo: 'acme/bar' }),
      ],
      pagination: { next_token: null, has_more: false },
    }));
    // `RealDataSource.listTasks` hydrates each summary via `getTask`
    // to get the gate counters. Stub it to echo the summary's repo
    // so we can observe the dedup behaviour.
    const getTask = jest.fn(async (id: string) => {
      const repo = id === 'c' ? 'acme/bar' : 'aws-samples/foo';
      return taskDetail({ task_id: id, repo });
    });
    const client = fakeClient({
      listTasks: listTasks as unknown as jest.Mock,
      getTask: getTask as unknown as jest.Mock,
    });
    const src = new RealDataSource(client);
    await src.listTasks();
    const repos = await src.listRegisteredRepos();
    expect(repos.map(r => r.repo).sort()).toEqual(['acme/bar', 'aws-samples/foo']);
  });

  it('submitTask passes approval_timeout_s and initial_approvals through', async () => {
    const createTask = jest.fn(async () => taskDetail());
    const client = fakeClient({ createTask: createTask as unknown as jest.Mock });
    const src = new RealDataSource(client);
    await src.submitTask({
      repo: 'aws-samples/foo',
      task_description: 'do',
      approval_timeout_s: 300,
      initial_approvals: ['tool_type:Bash', 'rule:bash_exec_gate'],
    });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'aws-samples/foo',
      task_description: 'do',
      approval_timeout_s: 300,
      initial_approvals: ['tool_type:Bash', 'rule:bash_exec_gate'],
    }));
  });

  it('approve forwards scope to the API client', async () => {
    const approveTask = jest.fn(async () => ({
      task_id: 't',
      request_id: 'r',
      status: 'APPROVED' as const,
      scope: 'tool_type:Bash' as const,
      decided_at: 'x',
    }));
    const client = fakeClient({ approveTask: approveTask as unknown as jest.Mock });
    const src = new RealDataSource(client);
    await src.approve('t', 'r', 'tool_type:Bash');
    expect(approveTask).toHaveBeenCalledWith('t', 'r', 'tool_type:Bash');
  });

  it('deny forwards reason to the API client', async () => {
    const denyTask = jest.fn(async () => ({
      task_id: 't',
      request_id: 'r',
      status: 'DENIED' as const,
      decided_at: 'x',
    }));
    const client = fakeClient({ denyTask: denyTask as unknown as jest.Mock });
    const src = new RealDataSource(client);
    await src.deny('t', 'r', 'please reconsider');
    expect(denyTask).toHaveBeenCalledWith('t', 'r', 'please reconsider');
  });

  describe('getTaskEvents pagination', () => {
    function ev(id: string): TaskEvent {
      return {
        event_id: id,
        event_type: 'agent_turn',
        timestamp: '2026-05-12T00:00:00Z',
        metadata: {},
      };
    }

    it('drains all pages on initial load (no cursor)', async () => {
      // 3-page response: page1 (2 events), page2 (2 events), page3 (1 event)
      const pages: PaginatedResponse<TaskEvent>[] = [
        { data: [ev('01'), ev('02')], pagination: { next_token: 'tok1', has_more: true } },
        { data: [ev('03'), ev('04')], pagination: { next_token: 'tok2', has_more: true } },
        { data: [ev('05')], pagination: { next_token: null, has_more: false } },
      ];
      const getTaskEvents = jest.fn(async () => pages.shift()!);
      const client = fakeClient({ getTaskEvents: getTaskEvents as unknown as jest.Mock });
      const src = new RealDataSource(client);
      const events = await src.getTaskEvents('t');
      expect(events.map(e => e.event_id)).toEqual(['01', '02', '03', '04', '05']);
      // First call: no cursor. Second/third: next_token.
      expect(getTaskEvents).toHaveBeenCalledTimes(3);
      const calls = getTaskEvents.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
      expect(calls[0][1]).toEqual({ limit: 100 });
      expect(calls[1][1]).toEqual({ limit: 100, nextToken: 'tok1' });
    });

    it('uses catchUpEvents with the cursor on incremental polls', async () => {
      const catchUpEvents = jest.fn(async () => [ev('10'), ev('11')]);
      const client = fakeClient({ catchUpEvents: catchUpEvents as unknown as jest.Mock });
      const src = new RealDataSource(client);
      const events = await src.getTaskEvents('t', { after: '09' });
      expect(events.map(e => e.event_id)).toEqual(['10', '11']);
      expect(catchUpEvents).toHaveBeenCalledWith('t', '09', 100);
    });
  });
});
