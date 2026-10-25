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
import { Template } from 'aws-cdk-lib/assertions';
import { AGENTCORE_SUPPORTED_AZ_IDS } from '../../src/constructs/agentcore-azs';
import {
  assertCapabilitiesAvailable,
  Capability,
  CAPABILITY_CATALOG,
  capabilityViolations,
} from '../../src/deployment/capabilities';
import {
  DEPLOYMENT_FEATURES,
  DEPLOYMENT_PROFILE_FILE,
  LEGACY_DEPLOYMENT_FEATURES,
  MINIMAL_DEPLOYMENT_FEATURES,
} from '../../src/deployment/features';
import { buildApp } from '../../src/main';
import { AgentStack } from '../../src/stacks/agent';

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

describe('regional capability catalog', () => {
  test('records its source, verification date and an entry for every feature', () => {
    expect(CAPABILITY_CATALOG.schemaVersion).toBe(1);
    expect(CAPABILITY_CATALOG.source).toMatch(/^https:\/\/docs\.aws\.amazon\.com\//);
    expect(CAPABILITY_CATALOG.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(CAPABILITY_CATALOG.lastVerified))).toBe(false);
    expect(Object.keys(CAPABILITY_CATALOG.features).sort()).toEqual([...DEPLOYMENT_FEATURES].sort());
  });

  const capabilities: Array<[string, Capability]> = [
    ['core', CAPABILITY_CATALOG.core],
    ...DEPLOYMENT_FEATURES.map((feature): [string, Capability] => [feature, CAPABILITY_CATALOG.features[feature]]),
  ];
  test.each(capabilities)(
    '%s has well-formed, de-duplicated Regions and a remediation',
    (_name, capability) => {
      expect(capability.remediation.length).toBeGreaterThan(0);
      if (capability.regions) {
        expect(capability.regions.length).toBeGreaterThan(0);
        expect(new Set(capability.regions).size).toBe(capability.regions.length);
        for (const region of capability.regions) expect(region).toMatch(REGION);
        // A Region-limited capability names the services that limit it.
        expect(capability.requiredServices.length).toBeGreaterThan(0);
      }
    },
  );

  test('pins AWS Agent Registry to its five documented Regions', () => {
    expect([...CAPABILITY_CATALOG.features.agentRegistry.regions!].sort())
      .toEqual(['ap-northeast-1', 'ap-southeast-2', 'eu-west-1', 'us-east-1', 'us-west-2']);
  });

  test('has AgentCore zone data for every core Region so the VPC can be auto-pinned', () => {
    // The zone table tracks Runtime, a superset of Memory, so only this direction holds.
    for (const region of CAPABILITY_CATALOG.core.regions!) {
      expect([region, region in AGENTCORE_SUPPORTED_AZ_IDS]).toEqual([region, true]);
    }
  });
});

describe('capabilityViolations', () => {
  test('accepts the legacy topology in us-east-1', () => {
    expect(capabilityViolations(LEGACY_DEPLOYMENT_FEATURES, 'us-east-1')).toEqual([]);
  });

  test('rejects Agent Registry outside its Regions with the supported list and remediation', () => {
    const [violation, ...rest] = capabilityViolations({ ...MINIMAL_DEPLOYMENT_FEATURES, agentRegistry: true }, 'eu-central-1');
    expect(rest).toEqual([]);
    expect(violation).toContain('AWS Agent Registry is not available in eu-central-1');
    expect(violation).toContain('us-east-1, us-west-2, eu-west-1, ap-southeast-2, ap-northeast-1');
    expect(violation).toContain('disable the Agent Registry');
  });

  test('reports an unsupported core Region even for the minimal profile', () => {
    expect(capabilityViolations(MINIMAL_DEPLOYMENT_FEATURES, 'us-west-1')[0])
      .toContain('ABCA core platform is not available in us-west-1');
  });

  test('ignores disabled features', () => {
    expect(capabilityViolations(MINIMAL_DEPLOYMENT_FEATURES, 'eu-central-1')).toEqual([]);
  });
});

describe('synthesis-time enforcement', () => {
  test('skips environment-agnostic synthesis', () => {
    expect(() => assertCapabilitiesAvailable(LEGACY_DEPLOYMENT_FEATURES, undefined)).not.toThrow();
  });

  test('AgentStack rejects an unsupported feature for a concrete Region independently of the CLI', () => {
    const app = new App();
    expect(() => new AgentStack(app, 'Unsupported', {
      env: { account: '123456789012', region: 'eu-central-1' },
      features: { ...MINIMAL_DEPLOYMENT_FEATURES, agentRegistry: true },
    })).toThrow(/Deployment profile is not deployable in eu-central-1:[\s\S]*AWS Agent Registry/);
  });

  test('AgentStack synthesizes env-agnostic stacks without a Region check', () => {
    const app = new App();
    const stack = new AgentStack(app, 'Agnostic', { features: MINIMAL_DEPLOYMENT_FEATURES });
    expect(Template.fromStack(stack).findOutputs('SlackAppManifestJson')).toEqual({});
  });

  test('rejects the Linear vault when the selection omits Linear', () => {
    const app = new App({ context: { enableLinearIdentityVault: 'true' } });
    expect(() => new AgentStack(app, 'VaultOnly', {
      env: { account: '123456789012', region: 'us-east-1' },
      features: MINIMAL_DEPLOYMENT_FEATURES,
    })).toThrow(/enableLinearIdentityVault requires the linear feature/);
  });
});

describe('buildApp consumes the repository profile', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'abca-build-profile-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const synthOutputs = async (context: Record<string, unknown> = {}) => {
    const app = await buildApp({
      account: '123456789012',
      region: 'eu-central-1',
      profileRoot: root,
      describeAzs: async () => [],
      resolveCallerAccount: async () => '123456789012',
      appProps: { context: { 'aws:cdk:bundling-stacks': [], 'agentcore:availabilityZones': ['eu-central-1a', 'eu-central-1b'], ...context } },
    });
    const stack = app.node.findChild('backgroundagent-dev') as AgentStack;
    return Object.keys(Template.fromStack(stack).toJSON().Outputs ?? {});
  };

  test('fails fast when the legacy default enables a feature the Region lacks', async () => {
    await expect(synthOutputs()).rejects.toThrow(/AWS Agent Registry is not available in eu-central-1/);
  });

  test('deploys the profile selection and honors context overrides on top of it', async () => {
    writeFileSync(path.join(root, DEPLOYMENT_PROFILE_FILE), JSON.stringify({
      schemaVersion: 1, features: { ...MINIMAL_DEPLOYMENT_FEATURES, jira: true },
    }));
    const outputs = await synthOutputs({ enableSlack: true });
    expect(outputs).toEqual(expect.arrayContaining(['JiraWebhookSecretArn', 'SlackAppManifestJson', 'ApiUrl']));
    expect(outputs).not.toContain('LinearWebhookSecretArn');
    expect(outputs).not.toContain('RegistryApiUrl');
  }, 60_000);
});

describe('compute roles read only deployed trackers\' OAuth secrets', () => {
  let minimal: string;
  let linearOnly: string;
  beforeAll(() => {
    const synth = (id: string, features: typeof MINIMAL_DEPLOYMENT_FEATURES) => JSON.stringify(Template.fromStack(new AgentStack(
      new App({ context: { compute_types: 'agentcore,ecs,lambda-microvm' } }), id,
      { env: { account: '123456789012', region: 'us-east-1' }, features },
    )).toJSON());
    minimal = synth('MinimalAllBackends', MINIMAL_DEPLOYMENT_FEATURES);
    linearOnly = synth('LinearAllBackends', { ...MINIMAL_DEPLOYMENT_FEATURES, linear: true });
  }, 120_000);

  test('no backend role is granted tracker secrets when both trackers are off', () => {
    expect(minimal).not.toContain('bgagent-linear-oauth-');
    expect(minimal).not.toContain('bgagent-jira-oauth-');
  });

  test('enabling Linear grants only the Linear prefix', () => {
    expect(linearOnly).toContain('bgagent-linear-oauth-');
    expect(linearOnly).not.toContain('bgagent-jira-oauth-');
  });
});
