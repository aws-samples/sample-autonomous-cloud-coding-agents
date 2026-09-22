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
const LEGACY_DEPLOYMENT = { stackName: 'backgroundagent-dev', computeSubstrate: null };

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
      {
        repo: 'acme/microvm',
        status: 'active',
        compute_type: 'lambda-microvm',
      },
    ]);

    const report = await buildRuntimeStatusReport(
      'us-east-1',
      'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform',
      { deployment: LEGACY_DEPLOYMENT },
    );

    expect(report.agentcore_runtimes).toHaveLength(2);
    expect(report.ecs_substrates).toHaveLength(1);
    expect(report.lambda_microvm_substrates).toEqual([expect.objectContaining({
      compute_type: 'lambda-microvm',
      used_by_repos: ['acme/microvm'],
    })]);
    expect(report.blueprints.find((blueprint) => blueprint.repo === 'acme/microvm')?.runtime_arn)
      .toBeUndefined();
    expect(report.blueprints[0].runtime_arn_source).toBe('platform');
    expect(report.blueprints[1].runtime_arn_source).toBe('blueprint');
    expect(controlPlaneSend).toHaveBeenCalledTimes(2);
  });

  test.each(['ecs', 'lambda-microvm'] as const)('inherits %s without probing AgentCore', async backend => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([{ repo: 'acme/a', status: 'active' }]);
    const report = await buildRuntimeStatusReport('us-east-1', 'RepoTable', null, {
      deployment: { ...LEGACY_DEPLOYMENT, computeSubstrate: backend, computeDeploymentMode: 'exclusive' },
    });
    expect(report.blueprints[0].compute_type).toBe(backend);
    expect(report.blueprints[0].runtime_arn).toBeUndefined();
    expect(controlPlaneSend).not.toHaveBeenCalled();
  });

  test.each(['agentcore', 'ecs', 'lambda-microvm'] as const)(
    'reports incompatible pins and probes only the exclusive %s deployment',
    async backend => {
      (listRepoConfigs as jest.Mock).mockResolvedValue(
        ['agentcore', 'ecs', 'lambda-microvm'].map(compute_type => ({
          repo: `acme/${compute_type}`,
          status: 'active',
          compute_type,
          runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
        })),
      );
      const report = await buildRuntimeStatusReport('us-east-1', 'RepoTable', null, {
        deployment: { ...LEGACY_DEPLOYMENT, computeSubstrate: backend, computeDeploymentMode: 'exclusive' },
      });
      expect(report.compute_deployment).toEqual({
        stack_name: 'backgroundagent-dev',
        compute_substrate: backend,
        compute_deployment_mode: 'exclusive',
        default_compute_type: backend,
      });
      expect(report.blueprints).toHaveLength(3);
      for (const binding of report.blueprints) {
        expect(binding.compute_available).toBe(binding.compute_type === backend);
        if (binding.compute_available) {
          expect(binding.configuration_error).toBeUndefined();
        } else {
          expect(binding.configuration_error).toContain(`deploys only '${backend}'`);
          expect(binding.runtime_arn).toBeUndefined();
        }
      }
      expect(report.ecs_substrates).toHaveLength(backend === 'ecs' ? 1 : 0);
      expect(report.lambda_microvm_substrates).toHaveLength(backend === 'lambda-microvm' ? 1 : 0);
      expect(report.agentcore_runtimes).toHaveLength(backend === 'agentcore' ? 1 : 0);
      expect(controlPlaneSend).toHaveBeenCalledTimes(backend === 'agentcore' ? 1 : 0);
    },
  );

  test('preserves the legacy additive contract while identifying an undeployed optional backend', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([
      { repo: 'acme/default', status: 'active' },
      { repo: 'acme/ecs', status: 'active', compute_type: 'ecs' },
      { repo: 'acme/microvm', status: 'active', compute_type: 'lambda-microvm' },
    ]);
    const report = await buildRuntimeStatusReport('us-east-1', 'RepoTable',
      'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform', {
        deployment: { ...LEGACY_DEPLOYMENT, computeSubstrate: 'ecs' },
      });
    expect(report.compute_deployment.default_compute_type).toBe('agentcore');
    expect(report.compute_deployment.compute_deployment_mode).toBeNull();
    expect(report.blueprints.map(binding => binding.compute_available)).toEqual([true, true, false]);
    expect(report.ecs_substrates).toHaveLength(1);
    expect(report.agentcore_runtimes).toHaveLength(1);
    expect(report.lambda_microvm_substrates).toEqual([]);
  });

  test('does not probe an unsupported repository compute type', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([{
      repo: 'acme/invalid',
      status: 'active',
      compute_type: 'unknown',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
    }]);
    const report = await buildRuntimeStatusReport('us-east-1', 'RepoTable', null, { deployment: LEGACY_DEPLOYMENT });
    expect(report.blueprints[0].compute_available).toBe(false);
    expect(report.blueprints[0].configuration_error).toContain('Unsupported repository compute_type');
    expect(controlPlaneSend).not.toHaveBeenCalled();
  });

  test('rejects malformed exclusive outputs even when there are no repositories', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([]);
    await expect(buildRuntimeStatusReport('us-east-1', 'RepoTable', null, {
      deployment: { ...LEGACY_DEPLOYMENT, computeDeploymentMode: 'exclusive' },
    })).rejects.toThrow('invalid or missing ComputeSubstrate');
    expect(controlPlaneSend).not.toHaveBeenCalled();
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
      { deployment: LEGACY_DEPLOYMENT },
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
      { repo: 'acme/b', deployment: LEGACY_DEPLOYMENT },
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
      { deployment: LEGACY_DEPLOYMENT },
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
      { deployment: LEGACY_DEPLOYMENT },
    );

    expect(report.agentcore_runtimes[0].failure_reason).toBe('image pull failed');
  });

  test('skips agentcore probe when no runtime ARN is resolved', async () => {
    (listRepoConfigs as jest.Mock).mockResolvedValue([{
      repo: 'acme/a',
      status: 'active',
      compute_type: 'agentcore',
    }]);

    const report = await buildRuntimeStatusReport('us-east-1', 'RepoTable', null, { deployment: LEGACY_DEPLOYMENT });

    expect(report.agentcore_runtimes).toHaveLength(0);
    expect(report.blueprints[0].runtime_arn).toBeUndefined();
    expect(controlPlaneSend).not.toHaveBeenCalled();
  });
});
