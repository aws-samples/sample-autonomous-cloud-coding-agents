/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import { MockDataSource } from '../../src/tui/api/source-mock';

describe('MockDataSource', () => {
  const src = new MockDataSource();

  it('reports mock label', () => {
    expect(src.label).toBe('mock');
  });

  it('lists tasks with normalized view fields', async () => {
    const tasks = await src.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    // `turn` is derived: prefer turns_completed, fallback to
    // turns_attempted, null on both missing.
    for (const t of tasks) {
      if (t.turns_completed != null) {
        expect(t.turn).toBe(t.turns_completed);
      }
    }
  });

  it('exposes approval_gate counters on task rows', async () => {
    const tasks = await src.listTasks();
    const withGates = tasks.filter(
      (t) => t.approval_gate_count != null && t.approval_gate_cap != null,
    );
    expect(withGates.length).toBeGreaterThan(0);
  });

  it('lists pending approvals with UPPERCASE severity', async () => {
    const pending = await src.listPending();
    expect(pending.length).toBeGreaterThan(0);
    for (const a of pending) {
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(a.severity);
    }
  });

  it('returns hard + soft policies bucketed', async () => {
    const p = await src.listPolicies('aws-samples/my-project');
    expect(p.hard.length).toBeGreaterThan(0);
    expect(p.soft.length).toBeGreaterThan(0);
    for (const r of p.hard) expect(r.tier).toBe('hard');
    for (const r of p.soft) expect(r.tier).toBe('soft');
  });

  it('lists registered repos (active only)', async () => {
    const repos = await src.listRegisteredRepos();
    expect(repos.length).toBeGreaterThan(0);
    for (const r of repos) {
      expect(r.repo).toMatch(/^[^/]+\/[^/]+$/);
      expect(typeof r.default_branch).toBe('string');
    }
  });

  it('submitTask seeds a new task with sensible defaults', async () => {
    const before = (await src.listTasks()).length;
    const row = await src.submitTask({
      repo: 'aws-samples/new-repo',
      task_description: 'test submission',
      approval_timeout_s: 300,
      initial_approvals: ['tool_type:Bash'],
    });
    expect(row.status).toBe('SUBMITTED');
    expect(row.repo).toBe('aws-samples/new-repo');
    expect(row.approval_gate_count).toBe(0);
    expect(row.approval_gate_cap).toBe(50);
    const after = (await src.listTasks()).length;
    expect(after).toBe(before + 1);
  });

  it('approve/deny are no-ops that satisfy the interface', async () => {
    await expect(src.approve('t', 'r', 'this_call')).resolves.toBeUndefined();
    await expect(src.deny('t', 'r', 'nope')).resolves.toBeUndefined();
  });
});
