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

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { checkRepoOnboarding, notOnboardedGuidance } from '../src/repo-onboarding';

// CloudFormation — `getStackOutput` resolves RepoTableName from here.
const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
  };
});

// DynamoDB DocumentClient — the RepoTable GetItem goes through here.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  };
});

const REPO = 'owner/repo';
const OPTS = { region: 'us-west-2', stackName: 'backgroundagent-dev', repo: REPO };

function stackWithRepoTable(): void {
  cfnSend.mockResolvedValue({
    Stacks: [{ Outputs: [{ OutputKey: 'RepoTableName', OutputValue: 'RepoTable' }] }],
  });
}

describe('checkRepoOnboarding', () => {
  beforeEach(() => {
    cfnSend.mockReset();
    ddbSend.mockReset();
  });

  test('returns onboarded when an active RepoTable row exists', async () => {
    stackWithRepoTable();
    ddbSend.mockResolvedValue({ Item: { repo: REPO, status: 'active' } });
    await expect(checkRepoOnboarding(OPTS)).resolves.toEqual({ kind: 'onboarded' });
    // The GetItem hit the table named by the stack output, keyed by repo.
    const getCall = ddbSend.mock.calls.find((c) => c[0] instanceof GetCommand);
    expect(getCall?.[0].input).toMatchObject({ TableName: 'RepoTable', Key: { repo: REPO } });
  });

  test('returns not-onboarded/missing when no row exists', async () => {
    stackWithRepoTable();
    ddbSend.mockResolvedValue({});
    await expect(checkRepoOnboarding(OPTS)).resolves.toEqual({ kind: 'not-onboarded', reason: 'missing' });
  });

  test('returns not-onboarded/inactive when the row is not active', async () => {
    stackWithRepoTable();
    ddbSend.mockResolvedValue({ Item: { repo: REPO, status: 'removed' } });
    await expect(checkRepoOnboarding(OPTS)).resolves.toEqual({ kind: 'not-onboarded', reason: 'inactive', status: 'removed' });
  });

  test('returns unverifiable when the stack has no RepoTableName output', async () => {
    cfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
    const result = await checkRepoOnboarding(OPTS);
    expect(result.kind).toBe('unverifiable');
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('returns unverifiable when the stack does not exist', async () => {
    const err = Object.assign(new Error('Stack with id backgroundagent-dev does not exist'), { name: 'ValidationError' });
    cfnSend.mockRejectedValue(err);
    const result = await checkRepoOnboarding(OPTS);
    expect(result.kind).toBe('unverifiable');
  });

  test('returns unverifiable (not throw) when reading stack outputs errors', async () => {
    // A non-"does not exist" failure (throttling, IAM) is rethrown by the
    // internal getStackOutput and caught here as inconclusive.
    cfnSend.mockRejectedValue(Object.assign(new Error('Throttling'), { name: 'Throttling' }));
    const result = await checkRepoOnboarding(OPTS);
    expect(result.kind).toBe('unverifiable');
    if (result.kind === 'unverifiable') expect(result.detail).toContain('stack outputs');
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('returns unverifiable (not throw) on a RepoTable read error (e.g. IAM gap)', async () => {
    stackWithRepoTable();
    ddbSend.mockRejectedValue(Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' }));
    const result = await checkRepoOnboarding(OPTS);
    expect(result.kind).toBe('unverifiable');
    if (result.kind === 'unverifiable') expect(result.detail).toContain('RepoTable');
  });
});

describe('notOnboardedGuidance', () => {
  test('mentions the repo, the 422 code, and the --skip escape hatch for a missing row', () => {
    const lines = notOnboardedGuidance(REPO, { kind: 'not-onboarded', reason: 'missing' }).join('\n');
    expect(lines).toContain(REPO);
    expect(lines).toContain('REPO_NOT_ONBOARDED');
    expect(lines).toContain('--skip-onboarding-check');
    expect(lines).toContain('mise //cdk:deploy');
  });

  test('surfaces the offending status for an inactive row', () => {
    const lines = notOnboardedGuidance(REPO, { kind: 'not-onboarded', reason: 'inactive', status: 'removed' }).join('\n');
    expect(lines).toContain("status is 'removed'");
  });
});
