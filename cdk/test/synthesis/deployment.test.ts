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
import { buildApp } from '../../src/main';
import { AssemblyCensus, inspectAssembly } from '../../src/synthesis/assembly';
import { auditProfile, DEFAULT_BUDGETS } from '../../src/synthesis/audit';
import { FIXTURE, STRUCTURAL_CONTEXT, synthesisProfiles } from '../../src/synthesis/profiles';
import { projectContext } from '../../src/synthesis/workspace';

// Exercise the same full gate product as the offline census in the normal build.
// Managed Blueprint provisioning avoids legacy timestamp churn; the CLI can still
// measure every handoff mode explicitly. Each configuration is synthesized once,
// including real CDK metadata and parent/nested templates for all quota checks.
describe.each(synthesisProfiles('managed'))('$name deployment', profile => {
  let directory: string;
  let census: AssemblyCensus;
  let assembly: CloudAssembly;
  let apiPermissions: readonly { id: string; sourceArn: string }[];
  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'deployment-profile-'));
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
    assembly = app.synth();
    census = inspectAssembly(directory);
    apiPermissions = census.templates.flatMap(({ file }) => {
      const template = Template.fromJSON(JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
      return Object.entries(template.findResources('AWS::Lambda::Permission'))
        .filter(([, resource]) => resource.Properties?.Principal === 'apigateway.amazonaws.com')
        .map(([logicalId, resource]) => ({
          id: `${file}/${logicalId}`,
          sourceArn: JSON.stringify(resource.Properties?.SourceArn ?? null),
        }));
    });
  }, 60_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  test('keeps every template within budget and protects its stateful resources', () => {
    const audit = auditProfile(profile, directory, DEFAULT_BUDGETS, false,
      () => ({ kind: 'synthesized', census }));
    expect(audit.failures).toEqual([]);
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

  test('provisions only the selected compute backend across the assembly', () => {
    const resources = census.templates.flatMap(template => template.inventory);
    const count = (type: string): number => resources.filter(resource => resource.type === type).length;
    expect(count('AWS::BedrockAgentCore::Runtime')).toBe(profile.context.compute_type === 'agentcore' ? 1 : 0);
    expect(count('AWS::ECS::Cluster')).toBe(profile.context.compute_type === 'ecs' ? 1 : 0);
    expect(count('AWS::Lambda::NetworkConnector')).toBe(profile.context.compute_type === 'lambda-microvm' ? 2 : 0);
    expect(count('AWS::CDK::Metadata')).toBeGreaterThan(0);
  });
});
