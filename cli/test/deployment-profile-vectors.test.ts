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
import { conflictingContextOverrides } from '../src/commands/setup';
import { DeploymentFeatures, deploymentProfileCandidates, parseDeploymentProfile } from '../src/deployment-profile';
import { CliError } from '../src/errors';

/**
 * CLI runner of the shared deployment-profile vectors (#1016). The CLI cannot import the
 * CDK package, so it carries its own copy of the profile parser, the context-switch names
 * and the per-stack file rule. ``cdk/test/deployment/deployment-profile-vectors.test.ts``
 * runs the same files against the CDK originals, so neither copy can change alone. The
 * cases and their shape are described in ``contracts/deployment-profile-vectors/README.md``.
 */
const VECTOR_DIR = path.join(__dirname, '..', '..', 'contracts', 'deployment-profile-vectors');
/** The parser quotes the file it read in every message. */
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
  readonly expected: { readonly conflicts: readonly string[] };
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
      // A CliError, not its text: toThrow matches a string as a fragment, and an error by its class and whole message.
      expect(() => parseDeploymentProfile(profile, SOURCE)).toThrow(new CliError(`Invalid deployment profile ${SOURCE}: ${expected.error}`));
    }
  });
});

describe('deployment-profile vectors: context switches', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-cli-profile-vectors-'));
    fs.mkdirSync(path.join(root, 'cdk'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // The CLI resolves no selection of its own: setup refuses to deploy while persistent
  // context holds a switch that synthesis would let override the selection.
  test.each(load<ContextCase>('context.json'))('$name', ({ features, context, expected }) => {
    fs.writeFileSync(path.join(root, 'cdk', 'cdk.context.json'), JSON.stringify(context));
    expect(conflictingContextOverrides(root, features))
      .toEqual(expected.conflicts.map(key => `cdk/cdk.context.json sets ${key}=${String(context[key])}`));
  });
});

describe('deployment-profile vectors: the profile file of a stack', () => {
  test.each(load<ProfileFileCase>('profile-files.json'))('$name', ({ stackName, expected }) => {
    expect(deploymentProfileCandidates(stackName)).toEqual(expected);
  });
});
