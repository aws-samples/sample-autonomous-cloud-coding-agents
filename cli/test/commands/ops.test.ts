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

import { makeOpsCommand } from '../../src/commands/ops';
import { findStuckTasks, buildConcurrencyReport } from '../../src/ops-queries';
import { getStackOutput } from '../../src/stack-outputs';

jest.mock('../../src/ops-queries');
jest.mock('../../src/stack-outputs');
jest.mock('../../src/cognito-admin', () => ({
  resolveCognitoAdminContext: jest.fn().mockResolvedValue({
    region: 'us-east-1',
    userPoolId: 'us-east-1_pool',
    configureBundle: null,
  }),
  buildCognitoEmailByUsername: jest.fn().mockResolvedValue(new Map([
    ['user-1', 'you@example.com'],
    ['e4c80468-8051-7062-032c-01689f5711d3', 'ops@example.com'],
  ])),
  resolveUserEmailForDisplay: jest.requireActual('../../src/cognito-admin').resolveUserEmailForDisplay,
}));

describe('ops command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'TaskTableName') return 'TaskTable';
      if (key === 'UserConcurrencyTableName') return 'ConcurrencyTable';
      return null;
    });
    (findStuckTasks as jest.Mock).mockResolvedValue([]);
    (buildConcurrencyReport as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('stuck-tasks prints empty message', async () => {
    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'stuck-tasks', '--region', 'us-east-1']);

    expect(findStuckTasks).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('No stuck tasks found.');
  });

  test('stuck-tasks fails when TaskTable output missing', async () => {
    (getStackOutput as jest.Mock).mockResolvedValue(null);

    const cmd = makeOpsCommand();
    await expect(cmd.parseAsync(['node', 'test', 'stuck-tasks', '--region', 'us-east-1']))
      .rejects.toThrow('TaskTableName');
  });

  test('concurrency fails when concurrency table output missing', async () => {
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'TaskTableName') return 'TaskTable';
      return null;
    });

    const cmd = makeOpsCommand();
    await expect(cmd.parseAsync(['node', 'test', 'concurrency', '--region', 'us-east-1']))
      .rejects.toThrow('UserConcurrencyTableName');
  });

  test('stuck-tasks prints dash when repo absent', async () => {
    (findStuckTasks as jest.Mock).mockResolvedValue([{
      task_id: 'task-1',
      user_id: 'user-1',
      status: 'SUBMITTED',
      created_at: '2026-01-01T00:00:00Z',
      age_seconds: 1300,
      threshold_seconds: 1200,
    }]);

    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'stuck-tasks', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('task-1');
    expect(output).toContain(' -');
  });

  test('stuck-tasks prints table rows with resolved email', async () => {
    (findStuckTasks as jest.Mock).mockResolvedValue([{
      task_id: 'task-1',
      user_id: 'user-1',
      status: 'SUBMITTED',
      repo: 'acme/a',
      created_at: '2026-01-01T00:00:00Z',
      age_seconds: 1300,
      threshold_seconds: 1200,
    }]);

    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'stuck-tasks', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('task-1');
    expect(output).toContain('you@example.com');
    expect(output).toContain('user-1');
    expect(output).toContain('acme/a');
  });

  test('stuck-tasks outputs JSON', async () => {
    (findStuckTasks as jest.Mock).mockResolvedValue([{
      task_id: 'task-1',
      user_id: 'user-1',
      status: 'HYDRATING',
      created_at: '2026-01-01T00:00:00Z',
      age_seconds: 1300,
      threshold_seconds: 1200,
    }]);

    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'stuck-tasks', '--region', 'us-east-1', '--output', 'json']);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0].user_email).toBe('you@example.com');
  });

  test('concurrency prints text table with resolved email', async () => {
    (buildConcurrencyReport as jest.Mock).mockResolvedValue([{
      user_id: 'e4c80468-8051-7062-032c-01689f5711d3',
      stored_count: 3,
      actual_count: 2,
      limit: 3,
      drift: 1,
    }]);

    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'concurrency', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('ops@example.com');
    expect(output).toContain('e4c80468-8051-7062-032c-01689f5711d3');
    expect(output).toContain('+1');
  });

  test('concurrency reports empty table', async () => {
    (buildConcurrencyReport as jest.Mock).mockResolvedValue([]);

    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'concurrency', '--region', 'us-east-1']);

    expect(consoleSpy).toHaveBeenCalledWith('No users in UserConcurrencyTable.');
  });

  test('concurrency outputs JSON', async () => {
    (buildConcurrencyReport as jest.Mock).mockResolvedValue([{
      user_id: 'user-1',
      stored_count: 2,
      actual_count: 2,
      limit: 3,
      drift: 0,
    }]);

    const cmd = makeOpsCommand();
    await cmd.parseAsync(['node', 'test', 'concurrency', '--region', 'us-east-1', '--output', 'json']);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.concurrency).toHaveLength(1);
    expect(payload.concurrency[0].user_email).toBe('you@example.com');
    expect(payload.limit_per_user).toBe(3);
  });
});
