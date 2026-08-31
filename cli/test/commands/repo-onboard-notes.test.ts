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

import { buildRepoOnboardNotes } from '../../src/repo-onboard-notes';

const PLATFORM_RUNTIME = 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/platform';
const PLATFORM_SECRET = 'arn:aws:secretsmanager:us-east-1:123:secret:platform';

describe('buildRepoOnboardNotes', () => {
  test('includes baseline guidance for platform-default onboarding', () => {
    const notes = buildRepoOnboardNotes({
      config: { repo: 'acme/a', status: 'active' },
      platformRuntimeArn: PLATFORM_RUNTIME,
      platformGithubTokenSecretArn: PLATFORM_SECRET,
    });

    expect(notes.some((n) => n.includes('RepoTable only'))).toBe(true);
    expect(notes.some((n) => n.includes('CDK Blueprint'))).toBe(true);
    expect(notes.some((n) => n.startsWith('WARNING:'))).toBe(false);
  });

  test('warns when runtime_arn differs from platform default', () => {
    const notes = buildRepoOnboardNotes({
      config: {
        repo: 'acme/a',
        status: 'active',
        runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
      },
      platformRuntimeArn: PLATFORM_RUNTIME,
      platformGithubTokenSecretArn: PLATFORM_SECRET,
    });

    expect(notes.some((n) => n.includes('additionalRuntimeArns'))).toBe(true);
  });

  test('warns when github_token_secret_arn differs from platform default', () => {
    const notes = buildRepoOnboardNotes({
      config: {
        repo: 'acme/a',
        status: 'active',
        github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:repo',
      },
      platformRuntimeArn: PLATFORM_RUNTIME,
      platformGithubTokenSecretArn: PLATFORM_SECRET,
    });

    expect(notes.some((n) => n.includes('additionalSecretArns'))).toBe(true);
  });

  test('notes ECS compute requirement', () => {
    const notes = buildRepoOnboardNotes({
      config: { repo: 'acme/a', status: 'active', compute_type: 'ecs' },
      platformRuntimeArn: PLATFORM_RUNTIME,
      platformGithubTokenSecretArn: PLATFORM_SECRET,
    });

    expect(notes.some((n) => n.includes('ecsConfig'))).toBe(true);
  });

  test('notes lambda-microvm compute requirement, including the image step', () => {
    const notes = buildRepoOnboardNotes({
      config: { repo: 'acme/a', status: 'active', compute_type: 'lambda-microvm' },
      platformRuntimeArn: PLATFORM_RUNTIME,
      platformGithubTokenSecretArn: PLATFORM_SECRET,
    });

    expect(notes.some((n) => n.includes('microvmConfig'))).toBe(true);
    // The substrate gate in `repo onboard` can prove the substrate exists but NOT
    // that an image is configured — a deployed-but-imageless stack still rejects
    // every task, so the note has to carry the packaging remedy.
    expect(notes.some((n) => n.includes('package-microvm-artifact.sh'))).toBe(true);
    expect(notes.some((n) => n.includes('microvm_base_image_arn'))).toBe(true);
    // ...and the P1 honesty warning, matching the synth-time annotation id.
    expect(notes.some((n) => n.includes('abca:microvm-image-p1-smoke-unverified'))).toBe(true);
  });

  test('emits no compute note for agentcore', () => {
    const notes = buildRepoOnboardNotes({
      config: { repo: 'acme/a', status: 'active', compute_type: 'agentcore' },
      platformRuntimeArn: PLATFORM_RUNTIME,
      platformGithubTokenSecretArn: PLATFORM_SECRET,
    });

    expect(notes.some((n) => n.includes('ecsConfig'))).toBe(false);
    expect(notes.some((n) => n.includes('microvmConfig'))).toBe(false);
  });
});
