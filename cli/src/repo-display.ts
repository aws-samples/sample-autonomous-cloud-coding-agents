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

import type { GithubTokenSecretSource } from './github-token';
import { redactSecretArn } from './operator-context';
import { RepoConfigRow } from './repo-lookup';

export type FieldSource = 'blueprint' | 'platform';

/** Stack outputs + constants used to resolve platform defaults for display. */
export interface PlatformStackContext {
  readonly runtimeArn: string | null;
  readonly githubTokenSecretArn: string | null;
}

/**
 * Platform defaults when a Blueprint field is absent from RepoTable.
 * Keep aligned with ``docs/design/REPO_ONBOARDING.md`` and orchestrator merge logic.
 */
export const PLATFORM_REPO_DEFAULTS = {
  compute_type: 'agentcore',
  /** Documented stack default; runtime may use the cross-region inference profile ID. */
  model_id: 'us.anthropic.claude-sonnet-4-6',
  max_turns: 100,
  poll_interval_ms: 30_000,
  approval_gate_cap: 50,
} as const;

/** How `repo show` resolved the effective GitHub token (subset of the resolver's sources). */
export type GithubTokenSource = Exclude<GithubTokenSecretSource, 'explicit'>;

/** Enriched RepoConfig for operator display (repo show / JSON output). */
export interface RepoConfigDisplay {
  readonly repo: string;
  readonly status: RepoConfigRow['status'];
  readonly onboarded_at?: string;
  readonly updated_at?: string;
  /** Raw RepoTable values (absent when the Blueprint did not override). */
  readonly blueprint_overrides: Record<string, unknown>;
  /** Values used at task time after merging with platform defaults. */
  readonly effective: {
    readonly compute_type: string;
    readonly runtime_arn?: string;
    readonly model_id: string;
    readonly max_turns: number;
    readonly max_budget_usd: string;
    readonly poll_interval_ms: number;
    readonly approval_gate_cap: number;
    readonly github_token_source: GithubTokenSource;
    readonly github_token_secret_arn?: string;
  };
  readonly field_sources: Record<string, FieldSource>;
}

export interface RepoShowLine {
  readonly key: string;
  readonly text: string;
}

/**
 * Build operator-facing repo config with explicit platform-default resolution.
 *
 * Blueprint constructs only write optional fields to RepoTable when configured in
 * CDK. Absence does not mean "disabled" — the orchestrator merges platform defaults.
 */
export function formatRepoConfigForDisplay(
  config: RepoConfigRow,
  platform: PlatformStackContext,
): RepoConfigDisplay {
  const usesBlueprintToken = Boolean(config.github_token_secret_arn);
  const effectiveTokenArn = usesBlueprintToken
    ? config.github_token_secret_arn
    : platform.githubTokenSecretArn ?? undefined;

  const fieldSources: Record<string, FieldSource> = {};
  const mark = (key: string, overridden: boolean) => {
    fieldSources[key] = overridden ? 'blueprint' : 'platform';
  };

  mark('compute_type', config.compute_type !== undefined);
  mark('runtime_arn', config.runtime_arn !== undefined);
  mark('model_id', config.model_id !== undefined);
  mark('max_turns', config.max_turns !== undefined);
  mark('max_budget_usd', config.max_budget_usd !== undefined);
  mark('poll_interval_ms', config.poll_interval_ms !== undefined);
  mark('approval_gate_cap', config.approval_gate_cap !== undefined);
  fieldSources.github_token_secret_arn = usesBlueprintToken ? 'blueprint' : 'platform';

  const blueprintOverrides: Record<string, unknown> = {};
  for (const key of [
    'compute_type', 'runtime_arn', 'model_id', 'max_turns', 'max_budget_usd',
    'poll_interval_ms', 'approval_gate_cap', 'system_prompt_overrides',
    'egress_allowlist', 'cedar_policies', 'github_token_secret_arn',
  ] as const) {
    const value = config[key];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      // `repo show` (text and JSON) must never echo a raw secret ARN — redact
      // here so the JSON branch, which serializes blueprint_overrides wholesale,
      // honors the command's "secret ARNs redacted" contract.
      blueprintOverrides[key] = key === 'github_token_secret_arn'
        ? redactSecretArn(String(value))
        : value;
    }
  }

  return {
    repo: config.repo,
    status: config.status,
    onboarded_at: config.onboarded_at,
    updated_at: config.updated_at,
    blueprint_overrides: blueprintOverrides,
    effective: {
      compute_type: config.compute_type ?? PLATFORM_REPO_DEFAULTS.compute_type,
      runtime_arn: config.runtime_arn ?? platform.runtimeArn ?? undefined,
      model_id: config.model_id ?? PLATFORM_REPO_DEFAULTS.model_id,
      max_turns: config.max_turns ?? PLATFORM_REPO_DEFAULTS.max_turns,
      max_budget_usd: config.max_budget_usd !== undefined
        ? String(config.max_budget_usd)
        : 'unlimited',
      poll_interval_ms: config.poll_interval_ms ?? PLATFORM_REPO_DEFAULTS.poll_interval_ms,
      approval_gate_cap: config.approval_gate_cap ?? PLATFORM_REPO_DEFAULTS.approval_gate_cap,
      github_token_source: usesBlueprintToken ? 'blueprint' : 'platform',
      github_token_secret_arn: effectiveTokenArn
        ? redactSecretArn(effectiveTokenArn)
        : undefined,
    },
    field_sources: fieldSources,
  };
}

function formatSourcedValue(value: string, source: FieldSource): string {
  if (source === 'blueprint') {
    return `${value} (per-blueprint override)`;
  }
  return `(platform default) ${value}`;
}

/** Text lines for ``repo show`` — omits unset optional customization fields. */
export function buildRepoShowLines(display: RepoConfigDisplay): RepoShowLine[] {
  const lines: RepoShowLine[] = [
    { key: 'status', text: display.status },
    { key: 'onboarded_at', text: display.onboarded_at ?? '-' },
    { key: 'updated_at', text: display.updated_at ?? '-' },
    {
      key: 'compute_type',
      text: formatSourcedValue(display.effective.compute_type, display.field_sources.compute_type),
    },
    {
      key: 'runtime_arn',
      text: display.effective.runtime_arn
        ? formatSourcedValue(display.effective.runtime_arn, display.field_sources.runtime_arn)
        : '(platform default — RuntimeArn stack output not found)',
    },
    {
      key: 'model_id',
      text: formatSourcedValue(display.effective.model_id, display.field_sources.model_id),
    },
    {
      key: 'max_turns',
      text: formatSourcedValue(String(display.effective.max_turns), display.field_sources.max_turns),
    },
    {
      key: 'max_budget_usd',
      text: display.field_sources.max_budget_usd === 'blueprint'
        ? `${display.effective.max_budget_usd} (per-blueprint override)`
        : '(platform default) unlimited',
    },
    {
      key: 'poll_interval_ms',
      text: formatSourcedValue(
        String(display.effective.poll_interval_ms),
        display.field_sources.poll_interval_ms,
      ),
    },
    {
      key: 'approval_gate_cap',
      text: formatSourcedValue(
        String(display.effective.approval_gate_cap),
        display.field_sources.approval_gate_cap,
      ),
    },
  ];

  if (typeof display.blueprint_overrides.system_prompt_overrides === 'string') {
    lines.push({
      key: 'system_prompt_overrides',
      text: `${display.blueprint_overrides.system_prompt_overrides} (per-blueprint override)`,
    });
  }
  const egress = display.blueprint_overrides.egress_allowlist;
  if (Array.isArray(egress) && egress.length > 0) {
    lines.push({
      key: 'egress_allowlist',
      text: `${egress.join(', ')} (per-blueprint override)`,
    });
  }
  const cedar = display.blueprint_overrides.cedar_policies;
  if (Array.isArray(cedar) && cedar.length > 0) {
    lines.push({
      key: 'cedar_policies',
      text: `${cedar.length} policy/policies (per-blueprint override)`,
    });
  }

  lines.push({
    key: 'github_token_secret_arn',
    text: formatGithubTokenSecretLine(display),
  });

  return lines;
}

/** Text-mode label for GitHub PAT resolution. */
export function formatGithubTokenSecretLine(display: RepoConfigDisplay): string {
  if (display.effective.github_token_source === 'blueprint') {
    return `${display.effective.github_token_secret_arn} (per-blueprint override)`;
  }
  if (!display.effective.github_token_secret_arn) {
    return '(platform default — GitHubTokenSecretArn stack output not found)';
  }
  return `(platform default) ${display.effective.github_token_secret_arn}`;
}
