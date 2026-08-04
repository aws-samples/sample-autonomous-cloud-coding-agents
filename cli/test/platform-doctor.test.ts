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

// Scope: how doctor TURNS workspace auth health into an operator verdict. That
// mapping is where a real outage hid — a workspace whose events were all being
// dropped was reported as needing no action — so each state gets a pinned
// verdict here. The individual health states are classified (and tested) in
// linear-auth-health; this file only covers the pass/warn/fail decision.

const healthMock = jest.fn();
jest.mock('../src/linear-auth-health', () => ({
  checkLinearWorkspaceAuth: (...args: unknown[]) => healthMock(...args),
}));

// Only the Linear registry output is wanted; every other check short-circuits on
// a missing stack output rather than reaching AWS.
const stackOutputMock = jest.fn();
jest.mock('../src/stack-outputs', () => ({
  getStackOutput: (...args: unknown[]) => stackOutputMock(...args),
}));

jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(new Error('not under test')) })),
  GetFoundationModelCommand: jest.fn(),
}));

import { runPlatformDoctor, type DoctorCheckResult } from '../src/platform-doctor';

const REGISTRY = 'LinearWorkspaceRegistry';

/** One health entry, defaulting to the shape the live incident had. */
function workspace(state: string, slug = 'maguireb') {
  return { workspaceId: `ws-${slug}`, workspaceSlug: slug, state, detail: `${state} detail` };
}

async function linearCheck(): Promise<DoctorCheckResult> {
  const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
  const check = checks.find((c) => c.id === 'linear_workspace_auth');
  if (!check) throw new Error('doctor no longer reports a Linear auth check');
  return check;
}

beforeEach(() => {
  jest.clearAllMocks();
  stackOutputMock.mockImplementation(async (_region: string, _stack: string, output: string) =>
    (output === 'LinearWorkspaceRegistryTableName' ? REGISTRY : null));
});

describe('doctor verdict for Linear workspace auth', () => {
  test('an indeterminate workspace does NOT pass — it warns, with the remedy', async () => {
    // The regression this pins: reporting indeterminate as a pass is how a fully
    // broken workspace read as healthy while every event it produced was dropped.
    healthMock.mockResolvedValue([workspace('expired_indeterminate')]);

    const check = await linearCheck();
    expect(check.status).toBe('warn');
    expect(check.status).not.toBe('pass');
    expect(check.detail).toContain('--verify-refresh');
  });

  test('a revoked workspace fails, and the detail carries its re-authorize remedy', async () => {
    healthMock.mockResolvedValue([workspace('revoked')]);

    const check = await linearCheck();
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('revoked detail');
  });

  test('revoked outranks indeterminate — the actionable outage is the headline', async () => {
    healthMock.mockResolvedValue([workspace('expired_indeterminate', 'quiet'), workspace('revoked', 'dead')]);

    const check = await linearCheck();
    expect(check.status).toBe('fail');
    // Both still appear in the summary, so the warn isn't lost behind the fail.
    expect(check.detail).toContain('quiet=expired_indeterminate');
    expect(check.detail).toContain('dead=revoked');
  });

  test('all-active passes', async () => {
    healthMock.mockResolvedValue([workspace('active')]);
    expect((await linearCheck()).status).toBe('pass');
  });

  test('an unassessable workspace warns rather than passing', async () => {
    healthMock.mockResolvedValue([workspace('unknown')]);
    expect((await linearCheck()).status).toBe('warn');
  });

  test('a stack with no Linear registry passes — the integration is optional', async () => {
    stackOutputMock.mockResolvedValue(null);
    expect((await linearCheck()).status).toBe('pass');
    expect(healthMock).not.toHaveBeenCalled();
  });

  test('a registry read failure warns — a partial answer is not a clean bill of health', async () => {
    healthMock.mockRejectedValue(new Error('AccessDeniedException on Scan'));
    const check = await linearCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('AccessDeniedException');
  });

  test('the refresh verifier reaches the health check only when the operator opts in', async () => {
    healthMock.mockResolvedValue([workspace('active')]);
    const verify = jest.fn();

    await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
    expect(healthMock.mock.calls[0][0]).not.toHaveProperty('verifyRefresh');

    await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca', linearVerifyRefresh: verify as never });
    expect(healthMock.mock.calls[1][0]).toHaveProperty('verifyRefresh', verify);
  });
});
