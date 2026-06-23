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

import { makeRuntimeCommand } from '../../src/commands/runtime';
import { buildRuntimeStatusReport } from '../../src/runtime-status';
import { getStackOutput } from '../../src/stack-outputs';

jest.mock('../../src/runtime-status');
jest.mock('../../src/stack-outputs');

describe('runtime status command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return 'RepoTable';
      if (key === 'RuntimeArn') return 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform';
      return null;
    });
    (buildRuntimeStatusReport as jest.Mock).mockResolvedValue({
      platform_default_runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      blueprints: [{
        repo: 'acme/a',
        status: 'active',
        compute_type: 'agentcore',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        runtime_arn_source: 'platform',
      }],
      agentcore_runtimes: [{
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        compute_type: 'agentcore',
        used_by_repos: ['acme/a'],
        probe_status: 'ok',
        control_plane_status: 'READY',
      }],
      ecs_substrates: [],
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('prints per-blueprint runtime summary', async () => {
    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Per-blueprint effective compute');
    expect(output).toContain('acme/a');
    expect(output).toContain('READY');
  });

  test('prints ECS blueprint without runtime ARN', async () => {
    (buildRuntimeStatusReport as jest.Mock).mockResolvedValue({
      platform_default_runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      blueprints: [{
        repo: 'acme/ecs',
        status: 'active',
        compute_type: 'ecs',
        runtime_arn: undefined,
        runtime_arn_source: 'platform',
      }],
      agentcore_runtimes: [],
      ecs_substrates: [{
        compute_type: 'ecs',
        used_by_repos: ['acme/ecs'],
        note: 'ECS note',
      }],
    });

    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1', '--repo', 'acme/ecs']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('n/a — ECS uses platform cluster');
  });

  test('prints ECS substrate note', async () => {
    (buildRuntimeStatusReport as jest.Mock).mockResolvedValue({
      platform_default_runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      blueprints: [{
        repo: 'acme/ecs',
        status: 'active',
        compute_type: 'ecs',
        runtime_arn: undefined,
        runtime_arn_source: 'platform',
      }],
      agentcore_runtimes: [],
      ecs_substrates: [{
        compute_type: 'ecs',
        used_by_repos: ['acme/ecs'],
        note: 'ECS note',
      }],
    });

    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('ECS compute substrates');
    expect(output).toContain('ECS note');
  });

  test('fails when RepoTable output is missing', async () => {
    (getStackOutput as jest.Mock).mockImplementation(async (_r: string, _s: string, key: string) => {
      if (key === 'RepoTableName') return null;
      return 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform';
    });

    const cmd = makeRuntimeCommand();
    await expect(cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1']))
      .rejects.toThrow('RepoTableName');
  });

  test('reports empty blueprint set', async () => {
    (buildRuntimeStatusReport as jest.Mock).mockResolvedValue({
      platform_default_runtime_arn: null,
      blueprints: [],
      agentcore_runtimes: [],
      ecs_substrates: [],
    });

    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1']);

    expect(consoleSpy).toHaveBeenCalledWith('No matching repositories found.');
  });

  test('shows successful probe metadata', async () => {
    (buildRuntimeStatusReport as jest.Mock).mockResolvedValue({
      platform_default_runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      blueprints: [{
        repo: 'acme/a',
        status: 'active',
        compute_type: 'agentcore',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        runtime_arn_source: 'platform',
      }],
      agentcore_runtimes: [{
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        compute_type: 'agentcore',
        used_by_repos: ['acme/a'],
        probe_status: 'ok',
        control_plane_status: 'READY',
        agent_runtime_name: 'runtime-a',
        last_updated_at: '2026-01-01T00:00:00Z',
        failure_reason: 'none',
      }],
      ecs_substrates: [],
    });

    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('runtime-a');
    expect(output).toContain('last_updated_at');
    expect(output).toContain('failure_reason');
  });

  test('shows probe error details', async () => {
    (buildRuntimeStatusReport as jest.Mock).mockResolvedValue({
      platform_default_runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      blueprints: [{
        repo: 'acme/a',
        status: 'active',
        compute_type: 'agentcore',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        runtime_arn_source: 'platform',
      }],
      agentcore_runtimes: [{
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
        compute_type: 'agentcore',
        used_by_repos: ['acme/a'],
        probe_status: 'error',
        error: 'AccessDenied',
      }],
      ecs_substrates: [],
    });

    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('probe error');
    expect(output).toContain('AccessDenied');
  });

  test('outputs JSON report', async () => {
    const cmd = makeRuntimeCommand();
    await cmd.parseAsync(['node', 'test', 'status', '--region', 'us-east-1', '--output', 'json']);

    const payload = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(payload.blueprints).toHaveLength(1);
  });
});
