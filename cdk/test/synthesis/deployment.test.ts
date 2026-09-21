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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../../src/main';
import { AssemblyCensus, inspectAssembly } from '../../src/synthesis/assembly';
import { auditProfile, DEFAULT_BUDGETS } from '../../src/synthesis/audit';
import { FIXTURE, STRUCTURAL_CONTEXT, synthesisProfiles } from '../../src/synthesis/profiles';
import { projectContext } from '../../src/synthesis/workspace';

// Exercise the same full gate product as the offline census in the normal build.
// Managed Blueprint provisioning avoids legacy timestamp churn; the CLI can still
// measure every handoff mode explicitly. Each configuration is synthesized once.
describe.each(synthesisProfiles('managed'))('$name deployment', profile => {
  let directory: string;
  let census: AssemblyCensus;
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
    app.synth();
    census = inspectAssembly(directory);
  }, 60_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  test('keeps every template within budget and protects its stateful resources', () => {
    const audit = auditProfile(profile, directory, DEFAULT_BUDGETS, false,
      () => ({ kind: 'synthesized', census }));
    expect(audit.failures).toEqual([]);
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
