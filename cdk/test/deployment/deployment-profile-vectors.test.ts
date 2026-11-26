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
import { App } from 'aws-cdk-lib';
import {
  DEPLOYMENT_FEATURES,
  DeploymentFeatures,
  deploymentProfileCandidates,
  FEATURE_CONTEXT_KEYS,
  parseDeploymentProfile,
  resolveDeploymentFeatures,
} from '../../src/deployment/features';

const VECTOR_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployment-profile-vectors');
const SOURCE = 'abca.deployment.json';

interface ParseCase {
  readonly name: string;
  readonly profile: unknown;
  readonly expected: { readonly profile?: unknown; readonly error?: string };
}

interface ContextCase {
  readonly name: string;
  readonly features: DeploymentFeatures;
  readonly context: Record<string, unknown>;
  readonly expected: { readonly features?: DeploymentFeatures; readonly error?: string; readonly conflicts: readonly string[] };
}

interface ProfileFileCase {
  readonly name: string;
  readonly stackName: string;
  readonly expected: readonly string[];
}

function load<T>(file: string): T[] {
  return (JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, file), 'utf-8')) as { cases: T[] }).cases;
}

describe('deployment-profile vectors: parsing a profile', () => {
  test.each(load<ParseCase>('parse.json'))('$name', ({ profile, expected }) => {
    if (expected.error === undefined) {
      expect(parseDeploymentProfile(profile, SOURCE)).toEqual(expected.profile);
    } else {
      // An Error, not its text: toThrow matches a string as a fragment and an Error by its whole message.
      expect(() => parseDeploymentProfile(profile, SOURCE)).toThrow(new Error(`Invalid deployment profile ${SOURCE}: ${expected.error}`));
    }
  });
});

describe('deployment-profile vectors: context switches', () => {
  const cases = load<ContextCase>('context.json');

  test.each(cases)('$name', ({ features, context, expected }) => {
    const resolve = () => resolveDeploymentFeatures(new App({ context }).node, features);
    if (expected.error !== undefined) {
      expect(resolve).toThrow(new Error(expected.error));
      return;
    }
    const resolved = resolve();
    expect(resolved).toEqual(expected.features);
    const changed = DEPLOYMENT_FEATURES.filter(feature => resolved[feature] !== features[feature]);
    expect(changed.map(feature => FEATURE_CONTEXT_KEYS[feature])).toEqual(expected.conflicts);
  });

  test('every context switch overrides a profile in at least one case', () => {
    const overriding = cases.filter(({ expected }) => expected.error === undefined).flatMap(({ expected }) => expected.conflicts);
    expect([...new Set(overriding)].sort()).toEqual(Object.values(FEATURE_CONTEXT_KEYS).sort());
  });
});

describe('deployment-profile vectors: the profile file of a stack', () => {
  test.each(load<ProfileFileCase>('profile-files.json'))('$name', ({ stackName, expected }) => {
    expect(deploymentProfileCandidates(stackName)).toEqual(expected);
  });
});
