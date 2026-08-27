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

const ddbSendMock = jest.fn();
jest.mock('../src/dynamo-clients', () => ({
  documentClient: () => ({ send: (...args: unknown[]) => ddbSendMock(...args) }),
}));

const bedrockSendMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: jest.fn(() => ({ send: (...args: unknown[]) => bedrockSendMock(...args) })),
  GetFoundationModelCommand: jest.fn((input: unknown) => ({ _type: 'GetFoundationModel', input })),
  GetInferenceProfileCommand: jest.fn((input: unknown) => ({ _type: 'GetInferenceProfile', input })),
}));

import {
  checkJiraAppIdentity,
  runPlatformDoctor,
  type DoctorCheckResult,
} from '../src/platform-doctor';

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
  ddbSendMock.mockResolvedValue({ Items: [] });
  stackOutputMock.mockImplementation(async (_region: string, _stack: string, output: string) =>
    (output === 'LinearWorkspaceRegistryTableName' ? REGISTRY : null));
});

describe('doctor verdict for Jira app identity', () => {
  test('warns when an active tenant still writes through OAuth', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [{
        jira_cloud_id: 'cloud-1',
        status: 'active',
        outbound_identity: 'oauth',
      }],
    });

    const check = await checkJiraAppIdentity('us-east-1', 'JiraRegistry');

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cloud-1');
    expect(check.detail).toContain('bgagent jira app-setup');
  });

  test('passes when every active tenant has complete Forge metadata', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [{
        jira_cloud_id: 'cloud-1',
        status: 'active',
        outbound_identity: 'app',
        app_actor_account_id: 'app-account',
        app_actor_display_name: 'bgagent',
        app_actor_configured_at: '2026-08-10T12:00:00.000Z',
      }],
    });

    const check = await checkJiraAppIdentity('us-east-1', 'JiraRegistry');

    expect(check.status).toBe('pass');
    expect(check.detail).toContain('1 active Jira tenant');
  });

  test('warns when app identity metadata is incomplete', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [{
        jira_cloud_id: 'cloud-1',
        status: 'active',
        outbound_identity: 'app',
        app_actor_display_name: 'bgagent',
      }],
    });

    expect((await checkJiraAppIdentity('us-east-1', 'JiraRegistry')).status).toBe('warn');
  });

  test('passes when Jira is not deployed or no tenant is active', async () => {
    expect((await checkJiraAppIdentity('us-east-1', null)).status).toBe('pass');
    expect((await checkJiraAppIdentity('us-east-1', 'JiraRegistry')).status).toBe('pass');
  });

  test('warns when the registry cannot be read', async () => {
    ddbSendMock.mockRejectedValue(new Error('AccessDeniedException'));

    const check = await checkJiraAppIdentity('us-east-1', 'JiraRegistry');

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('AccessDeniedException');
  });
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

describe('doctor Bedrock catalog check', () => {
  it('strips ANY geo prefix before calling GetFoundationModel', async () => {
    // GetFoundationModel resolves BARE foundation-model ids only; handed a
    // `<geo>.`-prefixed inference-profile id it returns ResourceNotFoundException
    // (verified against the live API). So the one Bedrock check doctor performs
    // would report a false failure.
    //
    // This regressed once: the strip matched `us|eu|apac` only, and when the
    // platform default moved to a `global.` profile it silently stopped stripping.
    // Asserting every geography the CDK models means a future default on any of
    // them cannot reopen the hole.
    const { PLATFORM_REPO_DEFAULTS } = await import('../src/repo-display');
    const GEOS = ['global', 'us-gov', 'us', 'eu', 'apac', 'jp', 'au'];

    for (const geo of GEOS) {
      jest.clearAllMocks();
      jest.resetModules();
      jest.doMock('../src/repo-display', () => ({
        ...jest.requireActual('../src/repo-display'),
        PLATFORM_REPO_DEFAULTS: {
          ...PLATFORM_REPO_DEFAULTS,
          model_id: `${geo}.anthropic.claude-opus-5`,
        },
      }));
      const { runPlatformDoctor: run } = await import('../src/platform-doctor');
      const checks = await run({ region: 'us-east-1', stackName: 'Abca' });
      const bedrock = checks.find((c) => c.id === 'bedrock_model');
      if (!bedrock) throw new Error('doctor no longer reports a Bedrock check');
      // The label carries the id that was queried, so it proves what was sent
      // without reaching into the mocked client.
      expect(bedrock.label).toContain('anthropic.claude-opus-5');
      expect(bedrock.label).not.toContain(`${geo}.anthropic`);
    }
  });
});

describe('doctor Bedrock inference-profile check', () => {
  /** Drive the doctor with a given BedrockGeoRegion output and Bedrock behaviour. */
  async function profileCheck(
    geo: string | null,
    send: jest.Mock = jest.fn().mockResolvedValue({}),
  ): Promise<DoctorCheckResult> {
    bedrockSendMock.mockImplementation((...args: unknown[]) => send(...args));
    stackOutputMock.mockImplementation(async (_r: string, _s: string, output: string) => {
      if (output === 'BedrockGeoRegion') return geo;
      if (output === 'LinearWorkspaceRegistryTableName') return REGISTRY;
      return null;
    });
    const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
    const check = checks.find((c) => c.id === 'bedrock_inference_profile');
    if (!check) throw new Error('doctor no longer reports an inference-profile check');
    return check;
  }

  it('probes the profile the deployment will invoke, not just the catalog', async () => {
    // The catalog check answers "is this model published in this Region"; the agent
    // invokes a `<geo>.<model>` PROFILE and the IAM grant is scoped to profile ARNs.
    // A stack whose geography has no profile passes the catalog check and then fails
    // every task at turn 0 with AccessDenied — the thing doctor exists to pre-empt.
    const send = jest.fn().mockResolvedValue({});
    const check = await profileCheck('global', send);
    expect(check.status).toBe('pass');
    expect(check.label).toContain('global.anthropic.claude-opus-5');

    // The queried identifier is the geo-prefixed profile, not the bare model id.
    const queried = send.mock.calls
      .map(([c]) => (c as { _type?: string; input?: { inferenceProfileIdentifier?: string } }))
      .filter((c) => c._type === 'GetInferenceProfile')
      .map((c) => c.input?.inferenceProfileIdentifier);
    expect(queried).toContain('global.anthropic.claude-opus-5');
  });

  it('uses the geography the stack reports, not a hardcoded one', async () => {
    // The whole point of reading the output: a residency-constrained deployment runs
    // `us` and must be checked against `us.`, not against the current default.
    const send = jest.fn().mockResolvedValue({});
    const check = await profileCheck('us', send);
    expect(check.label).toContain('us.anthropic.claude-opus-5');
    expect(check.label).not.toContain('global.');
  });

  it('fails, with the geography named, when the profile does not resolve', async () => {
    // Verified against the live API: an absent profile returns
    // ResourceNotFoundException. The remedy has to name the configured geography,
    // because "not found" alone does not tell an operator which knob is wrong.
    const check = await profileCheck(
      'jp',
      jest.fn().mockRejectedValue(new Error('ResourceNotFoundException: profile not found')),
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('jp');
    expect(check.detail).toMatch(/bedrockGeoRegion/);
  });

  it('warns rather than passing when the stack does not export the geography', async () => {
    // An older stack has no BedrockGeoRegion output. Defaulting to `us` and passing
    // would report a verification that never happened.
    const check = await profileCheck(null);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/BedrockGeoRegion/);
  });
});
