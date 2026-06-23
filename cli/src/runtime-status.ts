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

import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { PLATFORM_REPO_DEFAULTS } from './repo-display';
import { listRepoConfigs, RepoConfigRow } from './repo-lookup';

export interface BlueprintRuntimeBinding {
  readonly repo: string;
  readonly status: RepoConfigRow['status'];
  readonly compute_type: string;
  readonly runtime_arn?: string;
  readonly runtime_arn_source: 'blueprint' | 'platform';
}

interface RuntimeProbeBase {
  readonly runtime_arn: string;
  readonly compute_type: 'agentcore';
  readonly used_by_repos: readonly string[];
}

/**
 * AgentCore runtime probe outcome, discriminated on `probe_status` so the
 * control-plane fields and the error string can never coexist: an `'ok'` probe
 * carries the GetAgentRuntime response, an `'error'` probe carries only the
 * failure message.
 */
export type RuntimeProbeResult =
  | (RuntimeProbeBase & {
    readonly probe_status: 'ok';
    readonly agent_runtime_id?: string;
    readonly agent_runtime_name?: string;
    readonly control_plane_status?: string;
    readonly last_updated_at?: string;
    readonly failure_reason?: string;
  })
  | (RuntimeProbeBase & {
    readonly probe_status: 'error';
    readonly error: string;
  });

export interface EcsSubstrateSummary {
  readonly compute_type: 'ecs';
  readonly used_by_repos: readonly string[];
  readonly note: string;
}

export interface RuntimeStatusReport {
  readonly platform_default_runtime_arn: string | null;
  readonly blueprints: readonly BlueprintRuntimeBinding[];
  readonly agentcore_runtimes: readonly RuntimeProbeResult[];
  readonly ecs_substrates: readonly EcsSubstrateSummary[];
}

/** Parse ``agentRuntimeId`` (and optional version) from an AgentCore runtime ARN. */
export function parseAgentRuntimeArn(runtimeArn: string): { agentRuntimeId: string; agentRuntimeVersion?: string } {
  const resource = runtimeArn.split(':').pop() ?? '';
  const match = resource.match(/^runtime\/([^/]+)(?:\/version\/(\d+))?$/);
  if (!match) {
    throw new Error(`Unrecognized AgentCore runtime ARN resource: ${resource}`);
  }
  return {
    agentRuntimeId: match[1],
    agentRuntimeVersion: match[2],
  };
}

function bindingForRepo(
  config: RepoConfigRow,
  platformRuntimeArn: string | null,
): BlueprintRuntimeBinding {
  const computeType = config.compute_type ?? PLATFORM_REPO_DEFAULTS.compute_type;
  const hasBlueprintRuntime = config.runtime_arn !== undefined;
  const runtimeArn = hasBlueprintRuntime ? config.runtime_arn : platformRuntimeArn ?? undefined;

  return {
    repo: config.repo,
    status: config.status,
    compute_type: computeType,
    runtime_arn: runtimeArn,
    runtime_arn_source: hasBlueprintRuntime ? 'blueprint' : 'platform',
  };
}

async function probeAgentCoreRuntime(
  region: string,
  runtimeArn: string,
  usedByRepos: readonly string[],
): Promise<RuntimeProbeResult> {
  try {
    const { agentRuntimeId, agentRuntimeVersion } = parseAgentRuntimeArn(runtimeArn);
    const client = new BedrockAgentCoreControlClient({ region });
    const response = await client.send(new GetAgentRuntimeCommand({
      agentRuntimeId,
      agentRuntimeVersion,
    }));

    return {
      runtime_arn: runtimeArn,
      compute_type: 'agentcore',
      used_by_repos: usedByRepos,
      probe_status: 'ok',
      agent_runtime_id: response.agentRuntimeId,
      agent_runtime_name: response.agentRuntimeName,
      control_plane_status: response.status,
      last_updated_at: response.lastUpdatedAt instanceof Date
        ? response.lastUpdatedAt.toISOString()
        : response.lastUpdatedAt,
      failure_reason: response.failureReason,
    };
  } catch (err) {
    return {
      runtime_arn: runtimeArn,
      compute_type: 'agentcore',
      used_by_repos: usedByRepos,
      probe_status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build per-blueprint runtime view and probe unique AgentCore runtimes. */
export async function buildRuntimeStatusReport(
  region: string,
  repoTableName: string,
  platformRuntimeArn: string | null,
  options: { readonly repo?: string } = {},
): Promise<RuntimeStatusReport> {
  let repos = await listRepoConfigs(region, repoTableName);
  if (options.repo) {
    repos = repos.filter((r) => r.repo === options.repo);
  }

  const blueprints = repos.map((r) => bindingForRepo(r, platformRuntimeArn));

  const agentcoreMap = new Map<string, string[]>();
  const ecsRepos: string[] = [];

  for (const binding of blueprints) {
    if (binding.status !== 'active') continue;
    if (binding.compute_type === 'ecs') {
      ecsRepos.push(binding.repo);
      continue;
    }
    if (binding.runtime_arn) {
      const list = agentcoreMap.get(binding.runtime_arn) ?? [];
      list.push(binding.repo);
      agentcoreMap.set(binding.runtime_arn, list);
    }
  }

  const agentcore_runtimes = await Promise.all(
    [...agentcoreMap.entries()].map(([arn, usedByRepos]) =>
      probeAgentCoreRuntime(region, arn, usedByRepos)),
  );

  const ecs_substrates: EcsSubstrateSummary[] = ecsRepos.length > 0
    ? [{
      compute_type: 'ecs',
      used_by_repos: ecsRepos,
      note: 'ECS tasks use the platform cluster and task definition configured on the orchestrator Lambda. '
        + 'Per-blueprint runtime_arn overrides do not apply to ECS compute.',
    }]
    : [];

  return {
    platform_default_runtime_arn: platformRuntimeArn,
    blueprints,
    agentcore_runtimes,
    ecs_substrates,
  };
}
