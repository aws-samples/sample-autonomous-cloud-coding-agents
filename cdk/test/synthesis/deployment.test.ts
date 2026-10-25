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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import type { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { AGENTCORE_AZS_CONTEXT_KEY, AUTO_PIN_AZ_COUNT } from '../../src/constructs/agentcore-azs';
import { CAPABILITY_CATALOG } from '../../src/deployment/capabilities';
import { DEPLOYMENT_FEATURES, DeploymentFeature, FEATURE_CONTEXT_KEYS } from '../../src/deployment/features';
import { resolveComputeBackends } from '../../src/handlers/shared/compute-backend';
import { buildApp } from '../../src/main';
import { AssemblyCensus, inspectAssembly } from '../../src/synthesis/assembly';
import { auditProfile, DEFAULT_BUDGETS, WorkerResult } from '../../src/synthesis/audit';
import { FIXTURE, STRUCTURAL_CONTEXT, SynthesisProfile, synthesisProfiles } from '../../src/synthesis/profiles';
import { projectContext } from '../../src/synthesis/workspace';

/** Application-stack outputs and resource-path markers that only exist with a feature. */
const FEATURE_MARKERS: Readonly<Record<DeploymentFeature, { output?: string; path: string }>> = {
  slack: { output: 'SlackAppManifestJson', path: '/SlackIntegration/' },
  linear: { output: 'LinearWebhookSecretArn', path: '/LinearIntegration/' },
  jira: { output: 'JiraWebhookSecretArn', path: '/JiraIntegration/' },
  deployPreviewScreenshots: { output: 'GitHubWebhookUrl', path: '/GitHubScreenshotIntegration/' },
  agentRegistry: { output: 'RegistryApiUrl', path: '/AgentRegistryStack/' },
  // Tool Gateway publishes no output; its resources are the marker.
  toolGateway: { path: '/ToolGateway/' },
};
const APPLICATION_TEMPLATE = 'backgroundagent-dev.template.json';
/** Root-stack resource counts of the inline feature cells, reused by the footprint check. */
const featureRootResources = new Map<string, number>();

async function synthesizeInto(directory: string, profile: SynthesisProfile) {
  const app = await buildApp({
    account: FIXTURE.account,
    region: FIXTURE.region,
    describeAzs: async () => [...FIXTURE.zones],
    resolveCallerAccount: async () => FIXTURE.account,
    appProps: {
      outdir: directory,
      autoSynth: false,
      context: { ...projectContext(path.resolve(__dirname, '../../..')), ...profile.context },
      postCliContext: STRUCTURAL_CONTEXT,
    },
  });
  const assembly = app.synth();
  const census = inspectAssembly(directory);
  const featureCell = /^features-(.+)-inline$/.exec(profile.name);
  if (featureCell) {
    featureRootResources.set(featureCell[1], census.templates.find(template => template.file === APPLICATION_TEMPLATE)!.resources);
  }
  return { assembly, census };
}

// Exercise the same full gate product as the offline census in the normal build.
// Each configuration is synthesized once, including real CDK metadata and
// parent/nested templates for all quota checks.
describe.each(synthesisProfiles())('$name deployment', profile => {
  let directory: string;
  let census: AssemblyCensus;
  let assembly: CloudAssembly;
  let result: WorkerResult;
  let apiPermissions: readonly { id: string; sourceArn: string }[];
  let subnetZones: string[];
  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'deployment-profile-'));
    try {
      ({ assembly, census } = await synthesizeInto(directory, profile));
      result = { kind: 'synthesized', census };
      const templates = census.templates.map(({ file }) => ({
        file, template: Template.fromJSON(JSON.parse(readFileSync(path.join(directory, file), 'utf8'))),
      }));
      apiPermissions = templates.flatMap(({ file, template }) => Object.entries(template.findResources('AWS::Lambda::Permission'))
        .filter(([, resource]) => resource.Properties?.Principal === 'apigateway.amazonaws.com')
        .map(([logicalId, resource]) => ({
          id: `${file}/${logicalId}`,
          sourceArn: JSON.stringify(resource.Properties?.SourceArn ?? null),
        })));
      subnetZones = templates.flatMap(({ template }) => Object.values(template.findResources('AWS::EC2::Subnet'))
        .map(resource => resource.Properties.AvailabilityZone as string));
    } catch (error) {
      if (!profile.expectedError) throw error;
      result = { kind: 'rejected', error: error instanceof Error ? error.message : String(error) };
    }
  }, 60_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  test(profile.expectedError ? 'rejects the over-budget configuration at production synthesis'
    : 'keeps every template within budget', () => {
    const audit = auditProfile(profile, directory, DEFAULT_BUDGETS, false, () => result);
    expect(audit.failures).toEqual([]);
  });

  // A deliberate rejection has no assembly to inspect. The audit above verifies
  // the exact guard and also fails if the configuration unexpectedly synthesizes.
  if (profile.expectedError) return;

  if (profile.context.bedrockModels) {
    test('exercises the SessionRole model grants after CDK creates an overflow policy', () => {
      const resources = census.templates.flatMap(template => template.inventory);
      expect(resources.some(resource => resource.type === 'AWS::IAM::ManagedPolicy'
        && resource.constructPath?.includes('/AgentSessionRole/Role/OverflowPolicy'))).toBe(true);
    });
  }

  test('keeps auto-pin at two zones and honors every explicitly pinned zone', () => {
    const override = profile.context[AGENTCORE_AZS_CONTEXT_KEY];
    const expected = Array.isArray(override) ? override
      : FIXTURE.zones.slice(0, AUTO_PIN_AZ_COUNT).map(zone => zone.zoneName);
    expect(subnetZones.sort()).toEqual(expected.flatMap(zone => [zone, zone]).sort());
  });

  test('emits no CDK template-size warnings, including nested stacks', () => {
    const warnings = assembly.stacks.flatMap(stack => stack.messages
      .filter(message => message.level === 'warning' && String(message.entry.data).includes('Template size'))
      .map(message => `${stack.stackName}/${message.id}: ${String(message.entry.data)}`));
    expect(warnings).toEqual([]);
  });

  test('keeps API Gateway Lambda permissions method-scoped without console test-invoke grants', () => {
    expect(apiPermissions.length).toBeGreaterThan(0);
    const offenders = apiPermissions.filter(({ sourceArn }) => {
      const methodScoped = /\/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\//.test(sourceArn);
      const specificAuthorizer = sourceArn.includes('/authorizers/') && !sourceArn.includes('/authorizers/*');
      return sourceArn.includes('test-invoke-stage') || (!methodScoped && !specificAuthorizer);
    });
    expect(offenders).toEqual([]);
  });

  test('keeps stack dependencies one-way for the selected topology', () => {
    const application = 'backgroundagent-dev.template.json';
    const network = 'backgroundagent-dev-network.template.json';
    expect(census.stackDependencies).toEqual(profile.context.networkTopology === 'split'
      ? { [application]: [network], [network]: [] }
      : { [application]: [] });
  });

  test('provisions only the selected compute backends across the assembly', () => {
    const resources = census.templates.flatMap(template => template.inventory);
    const count = (type: string): number => resources.filter(resource => resource.type === type).length;
    const backends = resolveComputeBackends(profile.context.compute_types, profile.context.compute_type);
    expect(count('AWS::BedrockAgentCore::Runtime')).toBe(backends.includes('agentcore') ? 1 : 0);
    expect(count('AWS::ECS::Cluster')).toBe(backends.includes('ecs') ? 1 : 0);
    expect(count('AWS::Lambda::NetworkConnector')).toBe(backends.includes('lambda-microvm') ? 2 : 0);
    expect(count('AWS::CDK::Metadata')).toBeGreaterThan(0);
  });

  if (!profile.name.startsWith('features-')) return;

  test('synthesizes exactly the selected optional features', () => {
    const outputs = Object.keys(JSON.parse(readFileSync(path.join(directory, APPLICATION_TEMPLATE), 'utf8')).Outputs ?? {});
    const paths = census.templates.flatMap(template => template.inventory).map(resource => resource.constructPath ?? '');
    for (const feature of DEPLOYMENT_FEATURES) {
      const enabled = profile.context[FEATURE_CONTEXT_KEYS[feature]] === true;
      const marker = FEATURE_MARKERS[feature];
      if (marker.output) expect([feature, outputs.includes(marker.output)]).toEqual([feature, enabled]);
      expect([feature, paths.some(constructPath => constructPath.includes(marker.path))]).toEqual([feature, enabled]);
    }
    const trackers = profile.context.enableLinear === true || profile.context.enableJira === true;
    for (const shared of ['/IterationHeartbeat/', '/StrandedOrchestrationReconciler/']) {
      expect([shared, paths.some(constructPath => constructPath.includes(shared))]).toEqual([shared, trackers]);
    }
  });

  test('leaves no IAM grant on an omitted tracker\'s secrets or task-table index', () => {
    // Policy documents only: descriptions and nag reasons may name the prefixes.
    const policies = census.templates.flatMap(({ file }) => {
      const resources = JSON.parse(readFileSync(path.join(directory, file), 'utf8')).Resources ?? {};
      return Object.values(resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>)
        .filter(resource => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::Role'].includes(resource.Type))
        .map(resource => JSON.stringify([resource.Properties?.PolicyDocument, resource.Properties?.Policies]));
    }).join('\n');
    const markers: ReadonlyArray<readonly [string, string]> = [
      ['enableLinear', 'bgagent-linear-oauth-'],
      ['enableLinear', '/index/LinearIssueIndex'],
      ['enableJira', 'bgagent-jira-oauth-'],
      ['enableJira', '/index/JiraIssueIndex'],
      ['enableSlack', 'bgagent/slack/'],
    ];
    for (const [key, marker] of markers) {
      if (profile.context[key] !== true) expect([marker, policies.includes(marker)]).toEqual([marker, false]);
    }
    // Each enabled tracker's agents can still read its OAuth bundles.
    if (profile.context.enableLinear === true) expect(policies).toContain('bgagent-linear-oauth-');
    if (profile.context.enableJira === true) expect(policies).toContain('bgagent-jira-oauth-');
  });

  test('routes and Lambda permissions exist only for selected integrations', () => {
    const routes: Readonly<Record<string, string>> = {
      enableSlack: '/slack/', enableLinear: '/linear/', enableJira: '/jira/', enableDeployPreviewScreenshots: '/github/',
    };
    for (const [key, segment] of Object.entries(routes)) {
      const present = apiPermissions.some(({ sourceArn }) => sourceArn.includes(segment));
      expect([key, present]).toEqual([key, profile.context[key] === true]);
    }
  });
});

describe('deployment-profile footprints', () => {
  // Reuses the cells above when they ran; synthesizes any that were filtered out,
  // so this check does not depend on test order or on the cells passing.
  beforeAll(async () => {
    for (const label of ['minimal', ...DEPLOYMENT_FEATURES]) {
      if (featureRootResources.has(label)) continue;
      const cell = synthesisProfiles().find(candidate => candidate.name === `features-${label}-inline`)!;
      const directory = mkdtempSync(path.join(tmpdir(), 'deployment-footprint-'));
      try {
        await synthesizeInto(directory, cell);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 300_000);

  // The wizard shows these numbers; keep the catalog within reach of synthesis.
  test.each(DEPLOYMENT_FEATURES)('catalogs the root-stack footprint of %s', feature => {
    const minimal = featureRootResources.get('minimal');
    const single = featureRootResources.get(feature);
    expect(minimal).toBeDefined();
    expect(single).toBeDefined();
    const delta = single! - minimal!;
    const catalogued = CAPABILITY_CATALOG.features[feature].approximateResources;
    expect(Math.abs(delta - catalogued)).toBeLessThanOrEqual(Math.max(3, Math.ceil(catalogued * 0.15)));
  });
});
