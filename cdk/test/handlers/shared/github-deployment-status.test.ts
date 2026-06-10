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
  type GitHubDeploymentStatusPayload,
  validateDeploymentStatusPayload,
} from '../../../src/handlers/shared/github-deployment-status';

// The payload interface is deeply `readonly`, so each case constructs a
// fresh literal from parts rather than mutating a shared fixture.
function build(parts: {
  status?: { id?: number; state?: string; environment_url?: string };
  deployment?: { id?: number; sha?: string; environment?: string };
  repository?: { full_name?: string };
}): GitHubDeploymentStatusPayload {
  return {
    deployment_status: parts.status,
    deployment: parts.deployment,
    repository: parts.repository,
  };
}

const FULL = {
  status: { id: 99, state: 'success', environment_url: 'https://preview.example.com' },
  deployment: { id: 42, sha: 'abc1234', environment: 'Preview' },
  repository: { full_name: 'owner/repo' },
};

describe('validateDeploymentStatusPayload', () => {
  test('returns the narrowed shape when every required field is present', () => {
    expect(validateDeploymentStatusPayload(build(FULL))).toEqual({
      state: 'success',
      statusId: 99,
      environmentUrl: 'https://preview.example.com',
      deploymentId: 42,
      sha: 'abc1234',
      environment: 'Preview',
      repoFullName: 'owner/repo',
    });
  });

  test('non-success states still validate (state filtering is the caller’s job)', () => {
    // The validator only checks presence/type, not the value — the
    // receiver applies the `success` filter separately before calling.
    const raw = build({ ...FULL, status: { ...FULL.status, state: 'failure' } });
    expect(validateDeploymentStatusPayload(raw)?.state).toBe('failure');
  });

  test('statusId of 0 is a valid id (checked by type, not truthiness)', () => {
    const raw = build({ ...FULL, status: { ...FULL.status, id: 0 } });
    expect(validateDeploymentStatusPayload(raw)?.statusId).toBe(0);
  });

  // Each case drops or empties exactly one required field; all reject.
  const rejects: Array<[string, GitHubDeploymentStatusPayload]> = [
    ['missing state', build({ ...FULL, status: { id: 99, environment_url: 'https://x' } })],
    ['empty state', build({ ...FULL, status: { ...FULL.status, state: '' } })],
    ['missing statusId', build({ ...FULL, status: { state: 'success', environment_url: 'https://x' } })],
    ['missing environmentUrl', build({ ...FULL, status: { id: 99, state: 'success' } })],
    ['empty environmentUrl', build({ ...FULL, status: { ...FULL.status, environment_url: '' } })],
    ['missing deploymentId', build({ ...FULL, deployment: { sha: 'abc1234', environment: 'Preview' } })],
    ['missing sha', build({ ...FULL, deployment: { id: 42, environment: 'Preview' } })],
    ['empty sha', build({ ...FULL, deployment: { ...FULL.deployment, sha: '' } })],
    ['missing environment', build({ ...FULL, deployment: { id: 42, sha: 'abc1234' } })],
    ['empty environment', build({ ...FULL, deployment: { ...FULL.deployment, environment: '' } })],
    ['missing repoFullName', build({ ...FULL, repository: {} })],
    ['empty repoFullName', build({ ...FULL, repository: { full_name: '' } })],
    ['absent deployment_status object', build({ deployment: FULL.deployment, repository: FULL.repository })],
    ['absent deployment object', build({ status: FULL.status, repository: FULL.repository })],
    ['absent repository object', build({ status: FULL.status, deployment: FULL.deployment })],
  ];

  test.each(rejects)('rejects when %s', (_label, raw) => {
    expect(validateDeploymentStatusPayload(raw)).toBeNull();
  });

  test('rejects a wholly empty envelope', () => {
    expect(validateDeploymentStatusPayload({})).toBeNull();
  });
});
