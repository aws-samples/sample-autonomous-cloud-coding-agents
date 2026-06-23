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

import { listRepoConfigs } from '../../src/repo-lookup';
import { buildRuntimeStatusReport } from '../../src/runtime-status';

const controlPlaneSend = jest.fn();

jest.mock('../../src/repo-lookup');
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn(() => ({ send: controlPlaneSend })),
  GetAgentRuntimeCommand: jest.fn((input) => ({ input })),
}));

describe('buildRuntimeStatusReport', () => {
  beforeEach(() => {
    controlPlaneSend.mockReset();
    controlPlaneSend.mockResolvedValue({
      agentRuntimeId: 'test',
      agentRuntimeName: 'platform-runtime',
      status: 'READY',
      lastUpdatedAt: '2026-01-01T00:00:00Z',
    });
  });

  test('groups agentcore repos by runtime ARN and probes control plane', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([
      {
        repo: 'acme/a',
        status: 'active',
        compute_type: 'agentcore',
      },
      {
        repo: 'acme/b',
        status: 'active',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
        compute_type: 'agentcore',
      },
      {
        repo: 'acme/ecs',
        status: 'active',
        compute_type: 'ecs',
      },
    ]);

    const report = await buildRuntimeStatusReport(
      'us-east-1',
      'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
    );

    expect(report.agentcore_runtimes).toHaveLength(2);
    expect(report.ecs_substrates).toHaveLength(1);
    expect(report.blueprints[0].runtime_arn_source).toBe('platform');
    expect(report.blueprints[1].runtime_arn_source).toBe('blueprint');
    expect(controlPlaneSend).toHaveBeenCalledTimes(2);
  });

  test('records probe errors without failing the report', async () => {
    controlPlaneSend.mockRejectedValue(new Error('AccessDenied'));
    (listRepoConfigs as jest.Mock).mockResolvedValue([{
      repo: 'acme/a',
      status: 'active',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      compute_type: 'agentcore',
    }]);

    const report = await buildRuntimeStatusReport(
      'us-east-1',
      'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
    );

    expect(report.agentcore_runtimes[0].probe_status).toBe('error');
    expect(report.agentcore_runtimes[0].error).toContain('AccessDenied');
  });

  test('filters by repo and skips non-active blueprints for probes', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([
      { repo: 'acme/a', status: 'removed', compute_type: 'agentcore' },
      { repo: 'acme/b', status: 'active', compute_type: 'agentcore' },
    ]);

    const report = await buildRuntimeStatusReport(
      'us-east-1',
      'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      { repo: 'acme/b' },
    );

    expect(report.blueprints).toHaveLength(1);
    expect(report.agentcore_runtimes).toHaveLength(1);
    expect(controlPlaneSend).toHaveBeenCalledTimes(1);
  });

  test('handles Date lastUpdatedAt from control plane', async () => {
    controlPlaneSend.mockResolvedValue({
      agentRuntimeId: 'test',
      status: 'READY',
      lastUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    (listRepoConfigs as jest.Mock).mockResolvedValue([{
      repo: 'acme/a',
      status: 'active',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      compute_type: 'agentcore',
    }]);

    const report = await buildRuntimeStatusReport(
      'us-east-1',
      'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
    );

    expect(report.agentcore_runtimes[0].last_updated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('handles control plane failure_reason on successful probe', async () => {
    controlPlaneSend.mockResolvedValue({
      agentRuntimeId: 'test',
      agentRuntimeName: 'runtime-a',
      status: 'CREATE_FAILED',
      failureReason: 'image pull failed',
    });
    (listRepoConfigs as jest.Mock).mockResolvedValue([{
      repo: 'acme/a',
      status: 'active',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      compute_type: 'agentcore',
    }]);

    const report = await buildRuntimeStatusReport(
      'us-east-1',
      'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
    );

    expect(report.agentcore_runtimes[0].failure_reason).toBe('image pull failed');
  });

  test('skips agentcore probe when no runtime ARN is resolved', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([{
      repo: 'acme/a',
      status: 'active',
      compute_type: 'agentcore',
    }]);

    const report = await buildRuntimeStatusReport('us-east-1', 'RepoTable', null);

    expect(report.agentcore_runtimes).toHaveLength(0);
    expect(report.blueprints[0].runtime_arn).toBeUndefined();
    expect(controlPlaneSend).not.toHaveBeenCalled();
  });
});
