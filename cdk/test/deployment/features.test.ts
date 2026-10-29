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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import {
  DEPLOYMENT_FEATURES,
  DEPLOYMENT_PROFILE_CONTEXT,
  deploymentProfileCandidates,
  DEPLOYMENT_PROFILE_FILE,
  LEGACY_DEPLOYMENT_FEATURES,
  MINIMAL_DEPLOYMENT_FEATURES,
  parseDeploymentProfile,
  readDeploymentProfile,
  resolveDeploymentFeatures,
} from '../../src/deployment/features';

const profileJson = (features: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ schemaVersion: 1, features: { ...MINIMAL_DEPLOYMENT_FEATURES, ...features }, ...extra });

describe('parseDeploymentProfile', () => {
  test('accepts a complete schemaVersion 1 profile', () => {
    expect(parseDeploymentProfile(profileJson({ slack: true }), 'p')).toEqual({ features: { ...MINIMAL_DEPLOYMENT_FEATURES, slack: true } });
  });

  test.each([
    ['a non-object', [], /expected a JSON object/],
    ['an unknown schemaVersion', { ...profileJson({}), schemaVersion: 2 }, /schemaVersion must be 1/],
    ['a missing schemaVersion', { features: MINIMAL_DEPLOYMENT_FEATURES }, /schemaVersion must be 1/],
    ['an unknown top-level key', profileJson({}, { network: 'split' }), /unknown top-level key 'network'/],
    ['an unknown feature (typo)', profileJson({ slak: true }), /unknown feature 'slak'/],
    ['a non-boolean feature', profileJson({ jira: 'yes' }), /features.jira must be true or false/],
    ['features as an array', { schemaVersion: 1, features: [] }, /features must be an object/],
  ])('rejects %s', (_label, raw, error) => {
    expect(() => parseDeploymentProfile(raw, 'p')).toThrow(error);
  });

  test('accepts an ordered compute selection', () => {
    expect(parseDeploymentProfile(profileJson({}, { compute: ['ecs', 'agentcore'] }), 'p').compute).toEqual(['ecs', 'agentcore']);
  });

  test.each([
    ['an empty compute list', [], /non-empty array/],
    ['an unknown backend', ['lambda'], /unknown compute backend "lambda"/],
    ['a duplicate backend', ['ecs', 'ecs'], /more than once/],
    ['a non-array', 'ecs', /non-empty array/],
  ])('rejects %s', (_label, compute, error) => {
    expect(() => parseDeploymentProfile(profileJson({}, { compute }), 'p')).toThrow(error);
  });

  test('requires every feature explicitly so new and legacy defaults cannot be confused', () => {
    const { toolGateway: _omitted, ...partial } = MINIMAL_DEPLOYMENT_FEATURES;
    expect(() => parseDeploymentProfile({ schemaVersion: 1, features: partial }, 'p'))
      .toThrow(/features.toolGateway must be true or false/);
  });
});

describe('readDeploymentProfile', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'abca-profile-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const node = (context: Record<string, unknown> = {}) => new App({ context }).node;

  test('returns undefined when the repository has no profile (legacy topology)', () => {
    expect(readDeploymentProfile(node(), root)).toBeUndefined();
  });

  test('reads the repository-root profile', () => {
    writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), JSON.stringify(profileJson({ jira: true })));
    expect(readDeploymentProfile(node(), root)).toEqual({ features: { ...MINIMAL_DEPLOYMENT_FEATURES, jira: true } });
  });

  test('prefers a per-stack profile for additional deployments and falls back to the shared one', () => {
    writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), JSON.stringify(profileJson({ jira: true })));
    expect(readDeploymentProfile(node({ stackName: 'second-dev' }), root)?.features.jira).toBe(true);
    writeFileSync(path.join(root, 'abca.deployment.second-dev.json'), JSON.stringify(profileJson({ slack: true })));
    expect(readDeploymentProfile(node({ stackName: 'second-dev' }), root)?.features).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true });
    // The default stack keeps using the shared file.
    expect(readDeploymentProfile(node({ stackName: 'backgroundagent-dev' }), root)?.features.jira).toBe(true);
    expect(readDeploymentProfile(node(), root)?.features.jira).toBe(true);
  });

  test('never builds a profile path from an invalid stack name', () => {
    expect(deploymentProfileCandidates('../etc/passwd')).toEqual([DEPLOYMENT_PROFILE_FILE]);
    expect(deploymentProfileCandidates(42)).toEqual([DEPLOYMENT_PROFILE_FILE]);
  });

  test('ignores the repository profile under deploymentProfile=none', () => {
    writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), JSON.stringify(profileJson({})));
    expect(readDeploymentProfile(node({ [DEPLOYMENT_PROFILE_CONTEXT]: 'none' }), root)).toBeUndefined();
  });

  test('reads an explicit path relative to the repository root', () => {
    writeFileSync(path.join(root, 'ci.json'), JSON.stringify(profileJson({ slack: true })));
    expect(readDeploymentProfile(node({ [DEPLOYMENT_PROFILE_CONTEXT]: 'ci.json' }), root)?.features.slack).toBe(true);
  });

  test('fails when an explicit profile path is missing instead of falling back', () => {
    expect(() => readDeploymentProfile(node({ [DEPLOYMENT_PROFILE_CONTEXT]: 'missing.json' }), root))
      .toThrow(/Cannot read deployment profile/);
  });

  test('reports malformed JSON with the file name', () => {
    writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), '{ not json');
    expect(() => readDeploymentProfile(node(), root)).toThrow(new RegExp(`Invalid deployment profile .*${DEPLOYMENT_PROFILE_FILE}`));
  });

  test('rejects an empty deploymentProfile context value', () => {
    expect(() => readDeploymentProfile(node({ [DEPLOYMENT_PROFILE_CONTEXT]: ' ' }), root)).toThrow(/file path or 'none'/);
  });
});

describe('resolveDeploymentFeatures', () => {
  const node = (context: Record<string, unknown> = {}) => new App({ context }).node;

  test('preserves the legacy topology without a profile', () => {
    expect(resolveDeploymentFeatures(node())).toEqual(LEGACY_DEPLOYMENT_FEATURES);
    expect(LEGACY_DEPLOYMENT_FEATURES).toEqual({
      slack: true, linear: true, jira: true, deployPreviewScreenshots: true, agentRegistry: true, toolGateway: false,
    });
  });

  test('uses the profile when present', () => {
    expect(resolveDeploymentFeatures(node(), MINIMAL_DEPLOYMENT_FEATURES)).toEqual(MINIMAL_DEPLOYMENT_FEATURES);
  });

  test('lets each context switch override the profile in both directions', () => {
    const resolved = resolveDeploymentFeatures(
      node({ enableSlack: 'true', enableAgentRegistry: false }),
      { ...MINIMAL_DEPLOYMENT_FEATURES, agentRegistry: true },
    );
    expect(resolved).toEqual({ ...MINIMAL_DEPLOYMENT_FEATURES, slack: true });
  });

  test.each(DEPLOYMENT_FEATURES)('keeps the existing context switch for %s working', feature => {
    const keys = {
      slack: 'enableSlack',
      linear: 'enableLinear',
      jira: 'enableJira',
      deployPreviewScreenshots: 'enableDeployPreviewScreenshots',
      agentRegistry: 'enableAgentRegistry',
      toolGateway: 'enableToolGateway',
    } as const;
    expect(resolveDeploymentFeatures(node({ [keys[feature]]: true }), MINIMAL_DEPLOYMENT_FEATURES)[feature]).toBe(true);
    expect(resolveDeploymentFeatures(node({ [keys[feature]]: 'false' }))[feature]).toBe(false);
  });

  test('rejects malformed switch values instead of treating them as false', () => {
    expect(() => resolveDeploymentFeatures(node({ enableToolGateway: 'yes' }))).toThrow(/enableToolGateway must be true or false/);
  });

  test('rejects the Linear vault without Linear', () => {
    expect(() => resolveDeploymentFeatures(node({ enableLinearIdentityVault: true }), MINIMAL_DEPLOYMENT_FEATURES))
      .toThrow(/enableLinearIdentityVault requires the linear feature/);
    expect(resolveDeploymentFeatures(node({ enableLinearIdentityVault: true })).linear).toBe(true);
  });
});
