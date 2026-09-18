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

import type { AttributeValue } from '@aws-sdk/client-dynamodb';

export const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
export const ASSET_FIELDS = ['mcp_servers', 'cedar_policy_modules', 'skills'] as const;
export const CONFIGURATION_FIELDS = {
  compute_type: 'S',
  runtime_arn: 'S',
  model_id: 'S',
  max_turns: 'N',
  max_budget_usd: 'N',
  system_prompt_overrides: 'S',
  github_token_secret_arn: 'S',
  poll_interval_ms: 'N',
  build_command: 'S',
  lint_command: 'S',
  egress_allowlist: 'L',
  cedar_policies: 'L',
  approval_gate_cap: 'N',
  mcp_servers: 'L',
  cedar_policy_modules: 'L',
  skills: 'L',
} as const;
export type BlueprintConfiguration = Partial<Record<keyof typeof CONFIGURATION_FIELDS, AttributeValue>>;
export type BlueprintProvisioningMode = 'legacy' | 'prepare' | 'adopt' | 'managed';

export function blueprintProvisioningMode(value: unknown): BlueprintProvisioningMode {
  if (value === undefined) return 'legacy';
  if (value === 'legacy' || value === 'prepare' || value === 'adopt' || value === 'managed') return value;
  throw new Error('blueprintProvisioning must be legacy, prepare, adopt, or managed');
}

/** These are only the fields owned by a Blueprint, never arbitrary DynamoDB attributes. */
export function parseConfiguration(json: string): BlueprintConfiguration {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid blueprint configuration');
  for (const [key, value] of Object.entries(parsed)) {
    const kind = CONFIGURATION_FIELDS[key as keyof typeof CONFIGURATION_FIELDS];
    if (!Object.hasOwn(CONFIGURATION_FIELDS, key) || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
      throw new Error(`Invalid blueprint configuration field: ${key}`);
    }
    const attribute = value as Record<string, unknown>;
    const valid = kind === 'S' ? typeof attribute.S === 'string'
      : kind === 'N' ? typeof attribute.N === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(attribute.N) && Number.isFinite(Number(attribute.N))
        : Array.isArray(attribute.L) && attribute.L.every(v =>
          v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.S === 'string');
    if (!valid) throw new Error(`Invalid blueprint configuration value for ${key}`);
  }
  return parsed as BlueprintConfiguration;
}
