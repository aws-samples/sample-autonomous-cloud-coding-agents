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
import * as os from 'os';
import * as path from 'path';
import {
  DEPLOYMENT_PROFILE_FILE,
  deploymentProfileCandidates,
  detectDeployedFeatures,
  featureNotDeployedError,
  findRepoRoot,
  MINIMAL_DEPLOYMENT_FEATURES,
  parseDeploymentProfile,
  parseComputeList,
  parseFeatureList,
  readDeploymentProfile,
  serializeDeploymentProfile,
  writeDeploymentProfile,
} from '../src/deployment-profile';
import { CliError } from '../src/errors';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cli-profile-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('profile parsing and serialization', () => {
  test('round-trips through the documented file format', () => {
    const features = { ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, jira: true };
    const text = serializeDeploymentProfile({ features });
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      features: {
        slack: true, linear: false, jira: true, deployPreviewScreenshots: false, agentRegistry: false, toolGateway: false,
      },
    });
    expect(parseDeploymentProfile(JSON.parse(text), 'x')).toEqual({ features });
  });

  test('round-trips an optional compute selection', () => {
    const text = serializeDeploymentProfile({ features: MINIMAL_DEPLOYMENT_FEATURES, compute: ['agentcore', 'ecs'] });
    expect(JSON.parse(text).compute).toEqual(['agentcore', 'ecs']);
    expect(parseDeploymentProfile(JSON.parse(text), 'x').compute).toEqual(['agentcore', 'ecs']);
  });

  test.each([
    [[], /non-empty array/],
    [['lambda'], /unknown compute backend "lambda"/],
    [['ecs', 'ecs'], /more than once/],
  ])('rejects compute %j', (compute, error) => {
    expect(() => parseDeploymentProfile({ schemaVersion: 1, features: MINIMAL_DEPLOYMENT_FEATURES, compute }, 'x')).toThrow(error);
  });

  test('parseComputeList validates backend names', () => {
    expect(parseComputeList('agentcore, ecs')).toEqual(['agentcore', 'ecs']);
    expect(() => parseComputeList('fargate')).toThrow(/Unknown compute backend 'fargate'/);
    expect(() => parseComputeList('ecs,ecs')).toThrow(/more than once/);
    expect(() => parseComputeList(' ')).toThrow(/must list/);
  });

  test.each([
    [{ schemaVersion: 2, features: MINIMAL_DEPLOYMENT_FEATURES }, /schemaVersion must be 1/],
    [{ schemaVersion: 1, features: { ...MINIMAL_DEPLOYMENT_FEATURES, teams: true } }, /unknown feature 'teams'/],
    [{ schemaVersion: 1, features: { ...MINIMAL_DEPLOYMENT_FEATURES, slack: 1 } }, /features.slack must be true or false/],
    [{ schemaVersion: 1, features: MINIMAL_DEPLOYMENT_FEATURES, extra: 1 }, /unknown top-level key 'extra'/],
    ['nope', /expected a JSON object/],
  ])('rejects invalid profile %#', (raw, error) => {
    expect(() => parseDeploymentProfile(raw, 'x')).toThrow(error);
  });

  test('reads nothing when the repository has no profile', () => {
    expect(readDeploymentProfile(root)).toBeUndefined();
  });

  test('writes atomically and reads back', () => {
    const file = writeDeploymentProfile(root, { features: { ...MINIMAL_DEPLOYMENT_FEATURES, linear: true } });
    expect(file).toBe(path.join(root, DEPLOYMENT_PROFILE_FILE));
    expect(fs.readdirSync(root)).toEqual([DEPLOYMENT_PROFILE_FILE]);
    expect(readDeploymentProfile(root)?.features.linear).toBe(true);
  });

  test('reports malformed JSON as a CliError naming the file', () => {
    fs.writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), '{');
    expect(() => readDeploymentProfile(root)).toThrow(CliError);
    expect(() => readDeploymentProfile(root)).toThrow(DEPLOYMENT_PROFILE_FILE);
  });
});

describe('per-stack profile files', () => {
  test('mirrors the CDK lookup order', () => {
    expect(deploymentProfileCandidates('backgroundagent-dev')).toEqual([DEPLOYMENT_PROFILE_FILE]);
    expect(deploymentProfileCandidates('team-b')).toEqual(['abca.deployment.team-b.json', DEPLOYMENT_PROFILE_FILE]);
    expect(deploymentProfileCandidates('../x')).toEqual([DEPLOYMENT_PROFILE_FILE]);
  });

  test('writes the stack file and reads it back before the shared one', () => {
    writeDeploymentProfile(root, { features: { ...MINIMAL_DEPLOYMENT_FEATURES, jira: true } });
    expect(readDeploymentProfile(root, 'team-b')?.features.jira).toBe(true);
    writeDeploymentProfile(root, { features: MINIMAL_DEPLOYMENT_FEATURES }, 'team-b');
    expect(readDeploymentProfile(root, 'team-b')?.features.jira).toBe(false);
    expect(readDeploymentProfile(root)?.features.jira).toBe(true);
  });
});

describe('parseFeatureList', () => {
  test('accepts a comma-separated list and none', () => {
    expect(parseFeatureList('slack, jira')).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true, jira: true });
    expect(parseFeatureList('none')).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
  });

  test('fails on unknown or empty input instead of dropping it', () => {
    expect(() => parseFeatureList('slack,teams')).toThrow(/Unknown feature 'teams'/);
    expect(() => parseFeatureList(' , ')).toThrow(/must list features/);
  });
});

describe('findRepoRoot', () => {
  test('walks up to the ABCA checkout', () => {
    fs.mkdirSync(path.join(root, 'cdk'));
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.json'), '{}');
    fs.writeFileSync(path.join(root, 'mise.toml'), '');
    fs.mkdirSync(path.join(root, 'cli', 'src'), { recursive: true });
    expect(findRepoRoot(path.join(root, 'cli', 'src'))).toBe(root);
  });

  test('fails outside a checkout', () => {
    expect(() => findRepoRoot(root)).toThrow(/No ABCA repository found/);
  });
});

describe('detectDeployedFeatures', () => {
  test('trusts the DeploymentFeatures output when present', () => {
    const result = detectDeployedFeatures(new Map([['DeploymentFeatures', 'jira,toolGateway'], ['SlackAppManifestJson', '{}']]), () => true);
    expect(result).toEqual({ source: 'output', features: { ...MINIMAL_DEPLOYMENT_FEATURES, jira: true, toolGateway: true } });
  });

  test('treats DeploymentFeatures=none as the minimal deployment', () => {
    expect(detectDeployedFeatures(new Map([['DeploymentFeatures', 'none']]), () => true).features).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
  });

  test('infers features from outputs on stacks that predate profiles', () => {
    const outputs = new Map(['SlackAppManifestJson', 'LinearWebhookSecretArn', 'JiraWebhookSecretArn', 'GitHubWebhookUrl', 'RegistryApiUrl']
      .map(key => [key, 'v']));
    expect(detectDeployedFeatures(outputs, () => false)).toEqual({
      source: 'inferred',
      features: { slack: true, linear: true, jira: true, deployPreviewScreenshots: true, agentRegistry: true, toolGateway: false },
    });
    expect(detectDeployedFeatures(new Map(), () => true).features.toolGateway).toBe(true);
  });
});

test('featureNotDeployedError names the stack, feature and remedy', () => {
  const error = featureNotDeployedError('slack', 'my-stack');
  expect(error).toBeInstanceOf(CliError);
  expect(error.message).toBe(
    "Slack is not deployed in stack 'my-stack'. Run `bgagent setup`, enable Slack (feature 'slack'), and deploy before retrying.",
  );
});
