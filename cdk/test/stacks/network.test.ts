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
import { BlueprintDefinition } from '../../src/blueprints/definitions';
import { requiresStatefulRetention } from '../../src/constructs/stateful-retention';
import { buildApp } from '../../src/main';
import { NetworkTopology, resolveNetworkTopology } from '../../src/stacks/network';
import { AssemblyCensus, inspectAssembly } from '../../src/synthesis/assembly';
import { FIXTURE, STRUCTURAL_CONTEXT } from '../../src/synthesis/profiles';

const APP_NAME = 'backgroundagent-dev';
const NETWORK_NAME = `${APP_NAME}-network`;
const BLUEPRINTS: readonly BlueprintDefinition[] = [
  { id: 'AgentPluginsBlueprint', repo: 'example/plugins', networking: { egressAllowlist: ['packages.example.com'] } },
  {
    id: 'ForkBlueprint',
    repo: 'example/fork',
    networking: { egressAllowlist: ['packages.example.com', '*.internal.example.org'] },
  },
];

type TemplateJson = Record<string, any>;
interface Deployment {
  readonly directory: string;
  readonly census: AssemblyCensus;
  readonly application: TemplateJson;
  readonly network?: TemplateJson;
}

function withoutMetadata(resource: TemplateJson): TemplateJson {
  const { Metadata: _metadata, ...definition } = resource;
  return definition;
}

function isNetworkResource(id: string): boolean {
  return id.startsWith('AgentVpc') || id.startsWith('DnsFirewall');
}

describe('network topology selection', () => {
  test('defaults to the existing inline ownership', () => {
    expect(resolveNetworkTopology(undefined)).toBe('inline');
    expect(resolveNetworkTopology('inline')).toBe('inline');
    expect(resolveNetworkTopology('split')).toBe('split');
  });

  test.each(['', 'typo', true, false, null, 1])('rejects invalid topology %p before an AWS lookup', async value => {
    const describeAzs = jest.fn();
    const resolveCallerAccount = jest.fn();
    await expect(buildApp({
      appProps: { context: { networkTopology: value } }, describeAzs, resolveCallerAccount,
    })).rejects.toThrow('networkTopology must be inline or split');
    expect(describeAzs).not.toHaveBeenCalled();
    expect(resolveCallerAccount).not.toHaveBeenCalled();
  });
});

describe.each(['agentcore', 'ecs', 'lambda-microvm'] as const)('%s network extraction', compute => {
  const directories: string[] = [];
  let inline: Deployment;
  let split: Deployment;
  let network: TemplateJson;

  async function synthesize(topology: NetworkTopology): Promise<Deployment> {
    const directory = mkdtempSync(path.join(tmpdir(), 'network-extraction-'));
    directories.push(directory);
    const app = await buildApp({
      account: FIXTURE.account,
      region: FIXTURE.region,
      describeAzs: async () => [...FIXTURE.zones],
      resolveCallerAccount: async () => FIXTURE.account,
      blueprints: BLUEPRINTS,
      appProps: {
        outdir: directory,
        autoSynth: false,
        context: {
          'stackName': APP_NAME,
          'networkTopology': topology,
          'compute_type': compute,
          'blueprintProvisioning': 'managed',
          'bedrockGeoRegion': 'global',
          'enableToolGateway': true,
          'enableAgentRegistry': true,
          'enableLinearIdentityVault': true,
          'alertEmail': 'census@example.com',
          'github:sha': 'fixture-revision',
          ...(compute === 'lambda-microvm' ? {
            microvm_base_image_arn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
            microvm_base_image_version: '1',
          } : {}),
        },
        postCliContext: STRUCTURAL_CONTEXT,
      },
    });
    const assembly = app.synth();
    return {
      directory,
      census: inspectAssembly(directory),
      application: assembly.getStackByName(APP_NAME).template,
      ...(topology === 'split' ? { network: assembly.getStackByName(NETWORK_NAME).template } : {}),
    };
  }

  beforeAll(async () => {
    inline = await synthesize('inline');
    split = await synthesize('split');
    network = split.network!;
  }, 60_000);

  afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

  test('synthesizes two stacks with only application-to-network dependencies and no nag errors', () => {
    expect(inline.census.stackDependencies).toEqual({ [`${APP_NAME}.template.json`]: [] });
    expect(split.census.stackDependencies).toEqual({
      [`${APP_NAME}.template.json`]: [`${NETWORK_NAME}.template.json`],
      [`${NETWORK_NAME}.template.json`]: [],
    });
    expect(inline.census.errors).toEqual([]);
    expect(split.census.errors).toEqual([]);
    expect(JSON.stringify(network)).not.toContain('Fn::ImportValue');
    expect(JSON.stringify(split.application)).toContain('Fn::ImportValue');
    expect(Object.keys(split.application.Resources).length).toBeLessThan(Object.keys(inline.application.Resources).length - 45);
  });

  test('exports the complete network interface even when this backend leaves a value unused', () => {
    const resources = Object.entries(network.Resources as Record<string, TemplateJson>);
    const vpc = resources.find(([, resource]) => resource.Type === 'AWS::EC2::VPC')!;
    const runtimeGroup = resources.find(([, resource]) => resource.Type === 'AWS::EC2::SecurityGroup'
      && resource.Properties.GroupDescription === 'AgentCore Runtime - egress TCP 443 only')!;
    const privateSubnets = resources.filter(([, resource]) => resource.Type === 'AWS::EC2::Subnet'
      && resource.Properties.Tags.some((tag: { Key: string; Value: string }) => tag.Key === 'aws-cdk:subnet-type' && tag.Value === 'Private'));
    expect(privateSubnets).toHaveLength(2);
    const expected = [
      { Ref: vpc[0] },
      { 'Fn::GetAtt': [runtimeGroup[0], 'GroupId'] },
      ...privateSubnets.map(([id]) => ({ Ref: id })),
    ];
    const outputs = Object.values(network.Outputs as Record<string, TemplateJson>);
    expect(outputs.map(output => JSON.stringify(output.Value)).sort()).toEqual(expected.map(value => JSON.stringify(value)).sort());
    for (const output of outputs) expect(output.Export.Name).toMatch(`${NETWORK_NAME}:ExportsOutput`);
  });

  test('moves the VPC and DNS definitions with the same logical IDs and service properties', () => {
    const moved = Object.entries(inline.application.Resources).filter(([id]) => isNetworkResource(id));
    expect(moved.length).toBeGreaterThan(45);
    for (const [id, original] of moved) {
      expect(split.application.Resources).not.toHaveProperty(id);
      expect({ [id]: withoutMetadata(network.Resources[id]) }).toEqual({ [id]: withoutMetadata(original as TemplateJson) });
    }
  });

  test('preserves every application data resource and its lifecycle policies', () => {
    const retained = Object.entries(inline.application.Resources as Record<string, TemplateJson>)
      .filter(([id, resource]) => requiresStatefulRetention(resource.Type) && !isNetworkResource(id));
    expect(retained.length).toBeGreaterThan(20);
    for (const [id, original] of retained) {
      expect({ [id]: split.application.Resources[id] }).toEqual({ [id]: original });
    }
    const logs = Object.values(network.Resources as Record<string, TemplateJson>).filter(resource => resource.Type === 'AWS::Logs::LogGroup');
    expect(logs).toHaveLength(2);
    for (const resource of logs) expect(resource).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  test('keeps shared API routes, CORS, authorizers, permissions and deployment dependencies in the application', () => {
    const apiResources = (template: TemplateJson): TemplateJson => Object.fromEntries(
      Object.entries(template.Resources as Record<string, TemplateJson>)
        .filter(([, resource]) => resource.Type.startsWith('AWS::ApiGateway::') || resource.Type === 'AWS::Lambda::Permission'),
    );
    expect(apiResources(split.application)).toEqual(apiResources(inline.application));
    expect(apiResources(network)).toEqual({});
    expect(split.application.Outputs).toEqual(inline.application.Outputs);
  });

  test('resolves network imports to the same references without changing application service properties', () => {
    const exports = new Map(Object.values(network.Outputs as Record<string, TemplateJson>)
      .map(output => [JSON.stringify(output.Export.Name), output.Value]));
    const imports = new Set<string>();
    const versionOf = (template: TemplateJson): [string, TemplateJson] => {
      const versions = Object.entries(template.Resources as Record<string, TemplateJson>)
        .filter(([id, resource]) => resource.Type === 'AWS::Lambda::Version' && id.startsWith('TaskOrchestratorOrchestratorFnCurrentVersion'));
      expect(versions).toHaveLength(1);
      return versions[0];
    };
    const [beforeVersionId, beforeVersion] = versionOf(inline.application);
    const [afterVersionId, afterVersion] = versionOf(split.application);
    expect(withoutMetadata(afterVersion)).toEqual(withoutMetadata(beforeVersion));
    // CDK hashes the ECS orchestrator's subnet environment expression. Imports
    // therefore publish a new version even when the referenced subnets are moved.
    // Only this immutable version ID and its references may change in the app.
    expect(beforeVersionId === afterVersionId).toBe(compute !== 'ecs');
    const originalId = (id: string): string => id === afterVersionId ? beforeVersionId : id;
    function normalize(value: any): any {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') {
        if (Object.hasOwn(value, 'Fn::ImportValue')) {
          const name = JSON.stringify(value['Fn::ImportValue']);
          expect(exports.has(name)).toBe(true);
          imports.add(name);
          return exports.get(name);
        }
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'Metadata')
          .map(([key, child]) => [key, normalize(child)]));
      }
      return typeof value === 'string' ? originalId(value) : value;
    }
    for (const [id, resource] of Object.entries(split.application.Resources as Record<string, TemplateJson>)
      .filter(([, value]) => value.Type !== 'AWS::CDK::Metadata')) {
      const key = originalId(id);
      expect({ [key]: normalize(resource) }).toEqual({ [key]: normalize(inline.application.Resources[key]) });
    }
    expect(imports.size).toBeGreaterThan(0);
    expect(imports.size).toBeLessThanOrEqual(exports.size);
    const applicationIds = new Set(Object.keys(split.application.Resources).map(originalId));
    for (const [id, resource] of Object.entries(inline.application.Resources as Record<string, TemplateJson>)
      .filter(([key]) => !applicationIds.has(key))) {
      expect({ [id]: withoutMetadata(network.Resources[id]) }).toEqual({ [id]: withoutMetadata(resource) });
    }
  });

  test('keeps every API Gateway Lambda permission scoped to a method or a specific authorizer', () => {
    const resources = split.census.templates.flatMap(template => Object.values(
      JSON.parse(readFileSync(path.join(split.directory, template.file), 'utf8')).Resources as Record<string, TemplateJson>,
    ));
    const permissions = resources.filter(resource => resource.Type === 'AWS::Lambda::Permission'
      && resource.Properties.Principal === 'apigateway.amazonaws.com');
    expect(permissions.length).toBeGreaterThan(20);
    const unscoped = permissions.filter(resource => {
      const arn = JSON.stringify(resource.Properties.SourceArn);
      return !/\/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\//.test(arn) && !arn.includes('/authorizers/');
    });
    expect(unscoped).toEqual([]);
    expect(permissions.some(resource => JSON.stringify(resource).includes('test-invoke-stage'))).toBe(false);
  });

  test('feeds the same Blueprint domain configuration into DNS and repository provisioning', () => {
    const additional = Object.values(network.Resources as Record<string, TemplateJson>)
      .find(resource => resource.Type === 'AWS::Route53Resolver::FirewallDomainList' && resource.Properties.Name === 'blueprint-additional');
    expect(additional!.Properties.Domains).toEqual(['packages.example.com', '*.internal.example.org']);
    const repositories = Object.values(split.application.Resources as Record<string, TemplateJson>)
      .filter(resource => resource.Type === 'Custom::BlueprintRepoConfig');
    expect(repositories).toHaveLength(2);
    for (const blueprint of BLUEPRINTS) {
      const row = repositories.find(resource => resource.Properties.Repo === blueprint.repo)!;
      expect(JSON.parse(row.Properties.Configuration).egress_allowlist).toEqual({
        L: blueprint.networking!.egressAllowlist!.map(S => ({ S })),
      });
    }
  });

  test('keeps deployment attribution on both stacks without tagging replacement-sensitive DNS logging resources', () => {
    for (const template of [split.application, network]) {
      const functions = Object.entries(template.Resources as Record<string, TemplateJson>)
        .filter(([, resource]) => resource.Type === 'AWS::Lambda::Function');
      for (const [id, fn] of functions) {
        expect(fn.Properties.Environment?.Variables?.AWS_SDK_UA_APP_ID).toBe(`uksb-wt64nei4u6#${APP_NAME}`);
        // Core CDK providers use generic CfnResource without a TagManager;
        // require parity with their existing tags as well as attributed SDK calls.
        expect(fn.Properties.Tags).toEqual(inline.application.Resources[id].Properties.Tags);
      }
      const tagged = functions.filter(([, fn]) => fn.Properties.Tags);
      expect(tagged.length).toBeGreaterThan(0);
      for (const [, fn] of tagged) {
        expect(fn.Properties.Tags).toEqual(expect.arrayContaining([
          { Key: 'github:sha', Value: 'fixture-revision' },
          { Key: 'compute_type', Value: compute },
        ]));
      }
    }
    for (const resource of Object.values(network.Resources as Record<string, TemplateJson>)
      .filter(candidate => ['AWS::Route53Resolver::ResolverQueryLoggingConfig',
        'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation'].includes(candidate.Type))) {
      expect(resource.Properties).not.toHaveProperty('Tags');
    }
  });

  test('emits compact JSON for both top-level stacks and every nested template', () => {
    for (const template of split.census.templates) {
      expect(readFileSync(path.join(split.directory, template.file), 'utf8')).not.toContain('\n  ');
    }
  });
});
