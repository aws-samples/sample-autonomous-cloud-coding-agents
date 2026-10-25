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
import { CAPABILITY_CATALOG } from './deployment-capabilities';
import { CliError } from './errors';

/** Mirrors ``cdk/src/deployment/features.ts``; parity is enforced by tests. */
export const DEPLOYMENT_FEATURES = [
  'slack', 'linear', 'jira', 'deployPreviewScreenshots', 'agentRegistry', 'toolGateway',
] as const;
export type DeploymentFeature = typeof DEPLOYMENT_FEATURES[number];
export type DeploymentFeatures = Readonly<Record<DeploymentFeature, boolean>>;

export const DEPLOYMENT_PROFILE_FILE = 'abca.deployment.json';
export const DEPLOYMENT_PROFILE_SCHEMA_VERSION = 1;
/** Stack output listing deployed features; absent on stacks that predate profiles. */
export const DEPLOYMENT_FEATURES_OUTPUT = 'DeploymentFeatures';

export const MINIMAL_DEPLOYMENT_FEATURES: DeploymentFeatures = {
  slack: false,
  linear: false,
  jira: false,
  deployPreviewScreenshots: false,
  agentRegistry: false,
  toolGateway: false,
};

/** Outputs that identify each feature on stacks deployed before `DeploymentFeatures` existed. */
const LEGACY_FEATURE_OUTPUTS: Readonly<Record<Exclude<DeploymentFeature, 'toolGateway'>, string>> = {
  slack: 'SlackAppManifestJson',
  linear: 'LinearWebhookSecretArn',
  jira: 'JiraWebhookSecretArn',
  deployPreviewScreenshots: 'GitHubWebhookUrl',
  agentRegistry: 'RegistryApiUrl',
};

function isFeature(value: string): value is DeploymentFeature {
  return (DEPLOYMENT_FEATURES as readonly string[]).includes(value);
}

/** Same validation as CDK synthesis, so the CLI never writes a profile synthesis rejects. */
export function parseDeploymentProfile(raw: unknown, source: string): DeploymentFeatures {
  const fail = (detail: string): never => {
    throw new CliError(`Invalid deployment profile ${source}: ${detail}`);
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
    if (!isFeature(key)) fail(`unknown feature '${key}' (expected ${DEPLOYMENT_FEATURES.join(', ')})`);
  }
  const result = {} as Record<DeploymentFeature, boolean>;
  for (const feature of DEPLOYMENT_FEATURES) {
    const value = selection[feature];
    if (typeof value !== 'boolean') fail(`features.${feature} must be true or false`);
    result[feature] = value as boolean;
  }
  return result;
}

export function serializeDeploymentProfile(features: DeploymentFeatures): string {
  const ordered = Object.fromEntries(DEPLOYMENT_FEATURES.map(feature => [feature, features[feature]]));
  return `${JSON.stringify({ schemaVersion: DEPLOYMENT_PROFILE_SCHEMA_VERSION, features: ordered }, null, 2)}\n`;
}

/** The profile inside an operator-chosen checkout; the file name is a literal. */
export function profilePath(repoRoot: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoRoot is the operator's own checkout (cwd or --repo-root) and the joined segment is a literal; no privilege boundary is crossed
  return path.join(repoRoot, DEPLOYMENT_PROFILE_FILE);
}

export function readDeploymentProfile(repoRoot: string): DeploymentFeatures | undefined {
  const file = profilePath(repoRoot);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return parseDeploymentProfile(JSON.parse(text), file);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Invalid deployment profile ${file}: ${(err as Error).message}`);
  }
}

/** Write atomically so an interrupted run never leaves a half-written profile for CI to synthesize. */
export function writeDeploymentProfile(repoRoot: string, features: DeploymentFeatures): string {
  const file = profilePath(repoRoot);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, serializeDeploymentProfile(features), { encoding: 'utf-8', mode: 0o644 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}

/** The ABCA checkout `bgagent setup` deploys from: the nearest ancestor with `cdk/cdk.json`. */
export function findRepoRoot(start: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- start is the operator's cwd or --repo-root; this walk only probes for marker files
  const origin = path.resolve(start);
  let dir = origin;
  for (;;) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- literal segments under a directory the operator chose
    if (fs.existsSync(path.join(dir, 'cdk', 'cdk.json')) && fs.existsSync(path.join(dir, 'mise.toml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliError(
        `No ABCA repository found at or above ${origin}. `
        + 'Run `bgagent setup` from your ABCA checkout or pass --repo-root.',
      );
    }
    dir = parent;
  }
}

/** Parse `--features slack,jira` or `--features none`; unknown names fail rather than being dropped. */
export function parseFeatureList(value: string): DeploymentFeatures {
  const names = value.split(',').map(name => name.trim()).filter(Boolean);
  if (names.length === 1 && names[0] === 'none') return MINIMAL_DEPLOYMENT_FEATURES;
  if (names.length === 0) throw new CliError('--features must list features or be `none`.');
  const result: Record<DeploymentFeature, boolean> = { ...MINIMAL_DEPLOYMENT_FEATURES };
  for (const name of names) {
    if (!isFeature(name)) {
      throw new CliError(`Unknown feature '${name}'. Valid features: ${DEPLOYMENT_FEATURES.join(', ')}, or none.`);
    }
    result[name] = true;
  }
  return result;
}

export interface DeployedFeatureSet {
  readonly features: DeploymentFeatures;
  /** `output` when read from `DeploymentFeatures`; `inferred` for stacks that predate it. */
  readonly source: 'output' | 'inferred';
}

/**
 * Features present in an existing stack. `hasToolGateway` is consulted only for
 * stacks that predate the `DeploymentFeatures` output, which have no gateway output.
 */
export function detectDeployedFeatures(
  outputs: ReadonlyMap<string, string>,
  hasToolGateway: () => boolean,
): DeployedFeatureSet {
  const published = outputs.get(DEPLOYMENT_FEATURES_OUTPUT);
  if (published !== undefined) {
    const unknown = publishedFeatureNames(published).filter(name => !isFeature(name));
    if (unknown.length > 0) {
      // Never let an older CLI rewrite a profile it cannot fully represent.
      throw new CliError(
        `The stack deploys features this bgagent does not know (${unknown.join(', ')}). Upgrade the CLI before running setup.`,
      );
    }
    return { features: parseFeatureList(published), source: 'output' };
  }
  const result: Record<DeploymentFeature, boolean> = { ...MINIMAL_DEPLOYMENT_FEATURES };
  for (const [feature, output] of Object.entries(LEGACY_FEATURE_OUTPUTS)) {
    result[feature as DeploymentFeature] = outputs.has(output);
  }
  result.toolGateway = hasToolGateway();
  return { features: result, source: 'inferred' };
}

/** Names in a `DeploymentFeatures` output value, without validating them. */
export function publishedFeatureNames(value: string): string[] {
  return value.split(',').map(name => name.trim()).filter(name => name && name !== 'none');
}

export function enabledFeatures(features: DeploymentFeatures): DeploymentFeature[] {
  return DEPLOYMENT_FEATURES.filter(feature => features[feature]);
}

/** Actionable error for commands whose module the stack omits. */
export function featureNotDeployedError(feature: DeploymentFeature, stackName: string): CliError {
  const { label } = CAPABILITY_CATALOG.features[feature];
  return new CliError(
    `${label} is not deployed in stack '${stackName}'. Run \`bgagent setup\`, enable ${label} `
    + `(feature '${feature}'), and deploy before retrying.`,
  );
}
