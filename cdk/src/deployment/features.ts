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

import * as fs from 'fs';
import * as path from 'path';
import { Node } from 'constructs';

/** Optional modules selectable per deployment (#836). Core governance is never optional. */
export const DEPLOYMENT_FEATURES = [
  'slack', 'linear', 'jira', 'deployPreviewScreenshots', 'agentRegistry', 'toolGateway',
] as const;
export type DeploymentFeature = typeof DEPLOYMENT_FEATURES[number];
export type DeploymentFeatures = Readonly<Record<DeploymentFeature, boolean>>;

export const DEPLOYMENT_PROFILE_FILE = 'abca.deployment.json';
export const DEPLOYMENT_PROFILE_SCHEMA_VERSION = 1;
/** Path to an alternative profile, or `none` to ignore the repository profile. */
export const DEPLOYMENT_PROFILE_CONTEXT = 'deploymentProfile';

/** Per-feature context switches; they take precedence over the profile file. */
export const FEATURE_CONTEXT_KEYS: Readonly<Record<DeploymentFeature, string>> = {
  slack: 'enableSlack',
  linear: 'enableLinear',
  jira: 'enableJira',
  deployPreviewScreenshots: 'enableDeployPreviewScreenshots',
  agentRegistry: 'enableAgentRegistry',
  toolGateway: 'enableToolGateway',
};

/** Topology of deployments that predate profiles; an absent profile must not delete anything. */
export const LEGACY_DEPLOYMENT_FEATURES: DeploymentFeatures = {
  slack: true,
  linear: true,
  jira: true,
  deployPreviewScreenshots: true,
  agentRegistry: true,
  toolGateway: false,
};

/** Recommended for new installations: core CLI + GitHub workflow only. */
export const MINIMAL_DEPLOYMENT_FEATURES: DeploymentFeatures = {
  slack: false,
  linear: false,
  jira: false,
  deployPreviewScreenshots: false,
  agentRegistry: false,
  toolGateway: false,
};

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** Validate a parsed `abca.deployment.json`; unknown keys are rejected so typos fail closed. */
export function parseDeploymentProfile(raw: unknown, source: string): DeploymentFeatures {
  const fail = (detail: string): never => {
    throw new Error(`Invalid deployment profile ${source}: ${detail}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('expected a JSON object');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'schemaVersion' && key !== 'features') fail(`unknown top-level key '${key}'`);
  }
  if (record.schemaVersion !== DEPLOYMENT_PROFILE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${DEPLOYMENT_PROFILE_SCHEMA_VERSION}, got ${JSON.stringify(record.schemaVersion)}`);
  }
  const features = record.features;
  if (typeof features !== 'object' || features === null || Array.isArray(features)) fail('features must be an object');
  const selection = features as Record<string, unknown>;
  for (const key of Object.keys(selection)) {
    if (!(DEPLOYMENT_FEATURES as readonly string[]).includes(key)) {
      fail(`unknown feature '${key}' (expected ${DEPLOYMENT_FEATURES.join(', ')})`);
    }
  }
  const result = {} as Record<DeploymentFeature, boolean>;
  for (const feature of DEPLOYMENT_FEATURES) {
    const value = selection[feature];
    // Every feature is explicit: a missing key would otherwise inherit a default
    // that differs between new and legacy installations.
    if (typeof value !== 'boolean') fail(`features.${feature} must be true or false`);
    result[feature] = value as boolean;
  }
  return result;
}

/** Read the profile named by context, or the repository-root file when present. */
export function readDeploymentProfile(node: Node, repoRoot: string = REPO_ROOT): DeploymentFeatures | undefined {
  const configured: unknown = node.tryGetContext(DEPLOYMENT_PROFILE_CONTEXT);
  if (configured === 'none') return undefined;
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim())) {
    throw new Error(`Context '${DEPLOYMENT_PROFILE_CONTEXT}' must be a file path or 'none'`);
  }
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the path comes from the operator's own CDK context at synth time; reading any file they name is the feature, and no privilege boundary is crossed
  const file = path.resolve(repoRoot, configured ?? DEPLOYMENT_PROFILE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    // Only the implicit repository profile is optional; an explicit path must exist.
    if (configured === undefined && (err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read deployment profile ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid deployment profile ${file}: ${(err as Error).message}`);
  }
  return parseDeploymentProfile(parsed, file);
}

function contextBoolean(node: Node, key: string): boolean | undefined {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${key} must be true or false, got '${String(value)}'`);
}

/**
 * The one feature selection every construct consumes. Precedence: per-feature
 * context switch, then the profile, then the legacy topology.
 */
export function resolveDeploymentFeatures(node: Node, profile?: DeploymentFeatures): DeploymentFeatures {
  const base = profile ?? LEGACY_DEPLOYMENT_FEATURES;
  const result = {} as Record<DeploymentFeature, boolean>;
  for (const feature of DEPLOYMENT_FEATURES) {
    result[feature] = contextBoolean(node, FEATURE_CONTEXT_KEYS[feature]) ?? base[feature];
  }
  // The vault is a Linear sub-option; accepting it alone would deploy an
  // identity nothing can use.
  // Same lenient reading AgentStack has always applied to this switch.
  const vault: unknown = node.tryGetContext('enableLinearIdentityVault');
  if ((vault === true || vault === 'true') && !result.linear) {
    throw new Error('enableLinearIdentityVault requires the linear feature; enable Linear or drop the vault switch');
  }
  return result;
}

/** Linear and Jira OAuth bundle names written by `bgagent linear|jira setup`, outside CloudFormation. */
export const CHANNEL_OAUTH_SECRET_PATTERNS: readonly string[] = ['bgagent-linear-oauth-*', 'bgagent-jira-oauth-*'];

/** The OAuth bundles an agent may read: only those of deployed trackers. */
export function channelOauthSecretPatterns(features: DeploymentFeatures): string[] {
  return [
    ...(features.linear ? [CHANNEL_OAUTH_SECRET_PATTERNS[0]] : []),
    ...(features.jira ? [CHANNEL_OAUTH_SECRET_PATTERNS[1]] : []),
  ];
}

/** Features enabled in a selection, in catalog order. */
export function enabledFeatures(features: DeploymentFeatures): DeploymentFeature[] {
  return DEPLOYMENT_FEATURES.filter(feature => features[feature]);
}
