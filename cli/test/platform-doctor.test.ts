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

const healthMock = jest.fn();
const vaultMinterMock = jest.fn();
jest.mock('../src/linear-auth-health', () => ({
  checkLinearWorkspaceAuth: (...args: unknown[]) => healthMock(...args),
  makeLinearVaultTokenMinter: (...args: unknown[]) => vaultMinterMock(...args),
}));

const stackOutputMock = jest.fn();
const stackOutputsMock = jest.fn(async (region: string, stack: string, keys: readonly string[]) => {
  const outputs: Record<string, string | null> = {};
  for (const key of keys) outputs[key] = await stackOutputMock(region, stack, key);
  return outputs;
});
jest.mock('../src/stack-outputs', () => ({
  getStackOutputs: (...args: [string, string, readonly string[]]) => stackOutputsMock(...args),
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

import { BEDROCK_GEO_PREFIXES } from '../src/model-id';
import {
  checkJiraAppIdentity,
  checkLinearProjectWorkspaces,
  checkLinearSecretProvenance,
  runPlatformDoctor,
  type DoctorCheckResult,
} from '../src/platform-doctor';

const REGISTRY = 'LinearWorkspaceRegistry';

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

describe('doctor stack outputs', () => {
  test('reads every output it needs with one stack read', async () => {
    await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });

    expect(stackOutputsMock).toHaveBeenCalledTimes(1);
    expect(stackOutputsMock).toHaveBeenCalledWith('us-east-1', 'Abca', expect.any(Array));
  });

  test('hands the vault workload and the project mapping table to their own checks', async () => {
    stackOutputMock.mockImplementation(async (_region: string, _stack: string, output: string) => ({
      LinearWorkspaceRegistryTableName: REGISTRY,
      LinearVaultWorkloadName: 'vault-workload',
      LinearProjectMappingTableName: 'ProjectMapping',
    } as Record<string, string>)[output] ?? null);
    healthMock.mockResolvedValue([]);

    const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });

    expect(vaultMinterMock).toHaveBeenCalledWith('us-east-1', 'vault-workload');
    const scanned = ddbSendMock.mock.calls.map(([command]) => (command as { input: { TableName?: string } }).input.TableName);
    expect(scanned).toContain('ProjectMapping');
    expect(checks.find((c) => c.id === 'linear_project_workspaces')?.detail).toBe('No active Linear project mappings yet.');
  });
});

describe('doctor verdict for Linear signing-secret provenance', () => {
  const REG = 'LinearWorkspaceRegistry';

  test('warns and names the workspaces whose deliveries are now rejected', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [
        { workspace_slug: 'acme', status: 'active', webhook_secret_owned: true },
        { workspace_slug: 'shared-one', status: 'active' },
        { workspace_slug: 'shared-two', status: 'active' },
      ],
    });

    const check = await checkLinearSecretProvenance('us-east-1', REG);

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('shared-one');
    expect(check.detail).toContain('shared-two');
    expect(check.detail).not.toContain('acme');
    expect(check.detail).toContain('backfill-secret-provenance');
  });

  test('passes on a single-workspace stack even with no provenance recorded', async () => {
    ddbSendMock.mockResolvedValue({ Items: [{ workspace_slug: 'solo', status: 'active' }] });

    const check = await checkLinearSecretProvenance('us-east-1', REG);

    expect(check.status).toBe('pass');
    expect(check.detail).toContain('cannot reach another tenant');
  });

  test('passes when every active workspace owns its secret', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [
        { workspace_slug: 'a', status: 'active', webhook_secret_owned: true },
        { workspace_slug: 'b', status: 'active', webhook_secret_owned: true },
      ],
    });
    const check = await checkLinearSecretProvenance('us-east-1', REG);
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('All 2 active');
  });

  test('ignores revoked rows when counting tenants', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [
        { workspace_slug: 'live', status: 'active' },
        { workspace_slug: 'dead', status: 'revoked' },
      ],
    });
    expect((await checkLinearSecretProvenance('us-east-1', REG)).status).toBe('pass');
  });

  test('warns when the registry cannot be read', async () => {
    ddbSendMock.mockRejectedValue(new Error('AccessDeniedException'));
    expect((await checkLinearSecretProvenance('us-east-1', REG)).status).toBe('warn');
  });

  test('passes when Linear is not deployed', async () => {
    expect((await checkLinearSecretProvenance('us-east-1', null)).status).toBe('pass');
  });

  test('is reported by the full doctor run', async () => {
    stackOutputMock.mockImplementation(async (_r: string, _s: string, output: string) =>
      (output === 'LinearWorkspaceRegistryTableName' ? REG : null));
    const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
    expect(checks.map((c) => c.id)).toContain('linear_secret_provenance');
  });
});

describe('doctor verdict for Linear project → workspace binding', () => {
  const MAPPING = 'LinearProjectMapping';

  test('warns and names the rows that record no owning workspace', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [
        { linear_project_id: 'proj-backed', linear_workspace_id: 'org-1', status: 'active' },
        { linear_project_id: 'proj-unbacked', status: 'active' },
      ],
    });

    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING);

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('proj-unbacked');
    expect(check.detail).not.toContain('proj-backed');
    expect(check.detail).toContain('bgagent linear onboard-project');
    expect(check.detail).toMatch(/`bgagent linear onboard-project [^`]* --repo [^`]* --label [^`]*`/);
  });

  function tables(mapping: unknown[], registry: unknown[] | Error): void {
    ddbSendMock.mockImplementation(async (cmd: { input: { TableName: string } }) => {
      if (cmd.input.TableName === 'Reg') {
        if (registry instanceof Error) throw registry;
        return { Items: registry };
      }
      return { Items: mapping };
    });
  }
  const UNBACKED = [{ linear_project_id: 'proj-unbacked', status: 'active' }];

  test('FAILS when more than one workspace is active — the exposure is live, not hypothetical', async () => {
    tables(UNBACKED, [{ status: 'active' }, { status: 'active' }, { status: 'revoked' }]);
    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING, 'Reg');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/2 workspaces are active, so any of them can name these projects/);
    expect(check.detail).not.toMatch(/Harmless/);
  });

  test('only claims "harmless" when exactly one workspace is active', async () => {
    tables(UNBACKED, [{ status: 'active' }, { status: 'revoked' }]);
    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING, 'Reg');
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/Harmless while only one workspace is active/);
  });

  test('makes no claim about the exposure when the registry cannot be read', async () => {
    tables(UNBACKED, new Error('AccessDeniedException'));
    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING, 'Reg');
    expect(check.status).toBe('warn');
    expect(check.detail).not.toMatch(/Harmless/);
    expect(check.detail).toMatch(/matters as soon as a second workspace is active/);
  });

  test('caps the named ids so a large install does not bury the rest of the report', async () => {
    ddbSendMock.mockResolvedValue({
      Items: Array.from({ length: 14 }, (_, i) => ({ linear_project_id: `proj-${i}`, status: 'active' })),
    });

    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING);

    expect(check.detail).toContain('(and 4 more)');
    expect(check.detail).toContain('proj-9');
    expect(check.detail).not.toContain('proj-10');
  });

  test('passes once every active mapping records an owning workspace', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [{ linear_project_id: 'proj-1', linear_workspace_id: 'org-1', status: 'active' }],
    });

    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING);

    expect(check.status).toBe('pass');
    expect(check.detail).toContain('All 1 active');
  });

  test('ignores inactive rows — an offboarded mapping is not work to do', async () => {
    ddbSendMock.mockResolvedValue({
      Items: [{ linear_project_id: 'proj-old', status: 'inactive' }],
    });

    expect((await checkLinearProjectWorkspaces('us-east-1', MAPPING)).status).toBe('pass');
  });

  test('passes when the Linear integration is not deployed', async () => {
    expect((await checkLinearProjectWorkspaces('us-east-1', null)).status).toBe('pass');
  });

  test('warns when the mapping table cannot be read', async () => {
    ddbSendMock.mockRejectedValue(new Error('AccessDeniedException'));
    const check = await checkLinearProjectWorkspaces('us-east-1', MAPPING);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('AccessDeniedException');
  });

  test('is reported by the full doctor run', async () => {
    stackOutputMock.mockImplementation(async (_region: string, _stack: string, output: string) =>
      (output === 'LinearProjectMappingTableName' ? MAPPING : null));
    const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
    expect(checks.map((c) => c.id)).toContain('linear_project_workspaces');
  });
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
    healthMock.mockResolvedValue([workspace('expired_indeterminate')]);

    const check = await linearCheck();
    expect(check.status).toBe('warn');
    expect(check.status).not.toBe('pass');
    expect(check.detail).toContain('--verify-refresh');
  });

  test('a disabled (admin-removed) workspace passes and is not counted as authorized', async () => {
    healthMock.mockResolvedValue([workspace('disabled', 'removed'), workspace('active', 'live')]);
    const check = await linearCheck();
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/^1 workspace\(s\) authorized, 1 disabled by design/);
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
    const { PLATFORM_REPO_DEFAULTS } = await import('../src/repo-display');

    for (const geo of BEDROCK_GEO_PREFIXES) {
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
      expect(bedrock.label).toContain('anthropic.claude-opus-5');
      expect(bedrock.label).not.toContain(`${geo}.anthropic`);
    }
  });
});

describe('doctor Bedrock catalog check error classification', () => {
  async function catalogCheck(err: unknown): Promise<DoctorCheckResult> {
    bedrockSendMock.mockRejectedValue(err);
    stackOutputMock.mockImplementation(async (_r: string, _s: string, output: string) =>
      (output === 'LinearWorkspaceRegistryTableName' ? REGISTRY : null));
    const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
    const check = checks.find((c) => c.id === 'bedrock_model');
    if (!check) throw new Error('doctor no longer reports a Bedrock catalog check');
    return check;
  }

  it.each([
    ['ThrottlingException', 'Rate exceeded'],
    ['InternalServerException', 'Internal server error'],
    ['TimeoutError', 'socket hang up'],
  ])('warns without prescribing console changes on a %s', async (name, msg) => {
    const err = new Error(msg);
    err.name = name;
    const check = await catalogCheck(err);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/did not complete/);
    expect(check.detail).not.toMatch(/Enable model access/);
  });

  it('warns on a denial — a least-privilege caller says nothing about the model', async () => {
    const denied = new Error('User: … is not authorized to perform: bedrock:GetFoundationModel');
    denied.name = 'AccessDeniedException';
    const check = await catalogCheck(denied);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/permissions gap on the caller/);
    expect(check.detail).toMatch(/re-run with credentials holding bedrock:GetFoundationModel/);
    expect(check.detail).not.toMatch(/Enable model access/);
  });

  it('FAILS, with the console remedy, when the model is definitively absent', async () => {
    const absent = new Error('ResourceNotFoundException: model not found');
    absent.name = 'ResourceNotFoundException';
    const check = await catalogCheck(absent);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/Enable model access/);
  });
});

describe('doctor Bedrock inference-profile check', () => {
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
    const send = jest.fn().mockResolvedValue({});
    const check = await profileCheck('global', send);
    expect(check.status).toBe('pass');
    expect(check.label).toContain('global.anthropic.claude-opus-5-5');

    const queried = send.mock.calls
      .map(([c]) => (c as { _type?: string; input?: { inferenceProfileIdentifier?: string } }))
      .filter((c) => c._type === 'GetInferenceProfile')
      .map((c) => c.input?.inferenceProfileIdentifier);
    expect(queried).toContain('global.anthropic.claude-opus-5-5');
  });

  it('uses the geography the stack reports, not a hardcoded one', async () => {
    const send = jest.fn().mockResolvedValue({});
    const check = await profileCheck('us', send);
    expect(check.label).toContain('us.anthropic.claude-opus-5-5');
    expect(check.label).not.toContain('global.');
  });

  it('fails, with the geography named, when the profile does not resolve', async () => {
    const check = await profileCheck(
      'jp',
      jest.fn().mockRejectedValue(new Error('ResourceNotFoundException: profile not found')),
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('jp');
    expect(check.detail).toMatch(/bedrockGeoRegion/);
  });

  it('warns on a denial WITHOUT asserting anything about the profile', async () => {
    const denied = new Error(
      'User: arn:aws:sts::1:assumed-role/probe/s is not authorized to perform: '
      + 'bedrock:GetInferenceProfile on resource: …',
    );
    denied.name = 'AccessDeniedException';
    const check = await profileCheck('global', jest.fn().mockRejectedValue(denied));
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/permissions gap on the caller/);
    expect(check.detail).not.toMatch(/has no profile in that geography/);
    expect(check.detail).not.toMatch(/would fail at turn 0/);
    expect(check.detail).toMatch(/bedrock:GetInferenceProfile/);
  });

  it('warns, not fails, on a transient error — the check did not run', async () => {
    const err = new Error('Rate exceeded');
    err.name = 'ThrottlingException';
    const check = await profileCheck('global', jest.fn().mockRejectedValue(err));
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/check did not complete/);
    expect(check.detail).not.toMatch(/has no profile in that geography/);
    expect(check.detail).not.toMatch(/would fail at turn 0/);
  });

  it('warns rather than passing when the stack does not export the geography', async () => {
    const check = await profileCheck(null);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/BedrockGeoRegion/);
  });
});

describe('doctor granted-model profile check', () => {
  async function grantedCheck(
    modelIds: string | null,
    geo: string | null,
    send: jest.Mock = jest.fn().mockResolvedValue({}),
  ): Promise<DoctorCheckResult> {
    bedrockSendMock.mockImplementation((...args: unknown[]) => send(...args));
    stackOutputMock.mockImplementation(async (_r: string, _s: string, output: string) => {
      if (output === 'BedrockGeoRegion') return geo;
      if (output === 'BedrockModelIds') return modelIds;
      if (output === 'LinearWorkspaceRegistryTableName') return REGISTRY;
      return null;
    });
    const checks = await runPlatformDoctor({ region: 'us-east-1', stackName: 'Abca' });
    const check = checks.find((c) => c.id === 'bedrock_granted_model_profiles');
    if (!check) throw new Error('doctor no longer reports a granted-model profile check');
    return check;
  }

  it('probes EVERY granted model, not only the platform default', async () => {
    const send = jest.fn().mockResolvedValue({});
    const check = await grantedCheck('anthropic.claude-opus-5,anthropic.claude-sonnet-4-6', 'global', send);
    expect(check.status).toBe('pass');
    const queried = send.mock.calls
      .map(([c]) => (c as { _type?: string; input?: { inferenceProfileIdentifier?: string } }))
      .filter((c) => c._type === 'GetInferenceProfile')
      .map((c) => c.input?.inferenceProfileIdentifier);
    expect(queried).toContain('global.anthropic.claude-opus-5');
    expect(queried).toContain('global.anthropic.claude-sonnet-4-6');
  });

  it('fails and NAMES the offender when a granted model has no profile', async () => {
    const send = jest.fn().mockImplementation((cmd: { input?: { inferenceProfileIdentifier?: string } }) => {
      if (cmd.input?.inferenceProfileIdentifier === 'global.anthropic.claude-opus-4-20250514-v1:0') {
        return Promise.reject(new Error('ResourceNotFoundException: profile not found'));
      }
      return Promise.resolve({});
    });
    const check = await grantedCheck(
      'anthropic.claude-opus-5,anthropic.claude-opus-4-20250514-v1:0', 'global', send,
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('global.anthropic.claude-opus-4-20250514-v1:0');
    expect(check.detail).not.toContain('global.anthropic.claude-opus-5,');
    expect(check.detail).toMatch(/bedrockModels|geography where it resolves/);
  });

  it('warns, not fails, when the operator lacks GetInferenceProfile', async () => {
    const denied = new Error('User: … is not authorized to perform: bedrock:GetInferenceProfile');
    denied.name = 'AccessDeniedException';
    const check = await grantedCheck('anthropic.claude-opus-5', 'global', jest.fn().mockRejectedValue(denied));
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/permissions gap on the caller/);
  });

  it.each([
    ['ThrottlingException', 'Rate exceeded'],
    ['InternalServerException', 'Internal server error'],
    ['TimeoutError', 'socket hang up'],
    ['ExpiredTokenException', 'The security token included in the request is expired'],
  ])('does not tell the operator to remove a model on a %s', async (name, msg) => {
    const err = new Error(msg);
    err.name = name;
    const check = await grantedCheck('anthropic.claude-opus-5', 'global', jest.fn().mockRejectedValue(err));
    expect(check.status).toBe('warn');
    expect(check.detail).not.toMatch(/Remove it from/);
    expect(check.detail).not.toMatch(/have no inference profile/);
    expect(check.detail).toMatch(/could not be checked/);
    expect(check.detail).toMatch(/do NOT remove anything/);
  });

  it('still FAILS, with the remove remedy, when the service says the profile is absent', async () => {
    const err = new Error('ResourceNotFoundException: inference profile not found');
    err.name = 'ResourceNotFoundException';
    const check = await grantedCheck(
      'anthropic.claude-opus-5,anthropic.made-up-model', 'global',
      jest.fn().mockImplementation((cmd: { input?: { inferenceProfileIdentifier?: string } }) =>
        cmd.input?.inferenceProfileIdentifier === 'global.anthropic.made-up-model'
          ? Promise.reject(err) : Promise.resolve({})),
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('global.anthropic.made-up-model');
    expect(check.detail).toMatch(/Remove it from/);
  });

  it('warns rather than passing when the stack exports no granted set', async () => {
    const check = await grantedCheck(null, 'global');
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/BedrockModelIds/);
    expect(check.detail).not.toMatch(/BedrockGeoRegion/);
  });

  it('names only the geography when that is the output the stack lacks', async () => {
    const check = await grantedCheck('anthropic.claude-opus-5', null);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/does not export BedrockGeoRegion,/);
    expect(check.detail).not.toMatch(/BedrockModelIds/);
  });

  it('names both outputs when the stack exports neither', async () => {
    const check = await grantedCheck(null, null);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/does not export BedrockModelIds and BedrockGeoRegion,/);
  });

  it.each([',', '  ', ',,,'])('does not pass %p as a verified grant list', async (value) => {
    const send = jest.fn().mockResolvedValue({});
    const check = await grantedCheck(value, 'global', send);
    expect(check.status).toBe('warn');
    expect(check.detail).not.toMatch(/All 0 granted/);
  });
});
