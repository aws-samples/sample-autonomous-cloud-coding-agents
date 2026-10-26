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

/**
 * Sufficiency, not shape: synthesize the real app and check that the bootstrap
 * policy bundle covers what the synthesized templates need.
 *
 * `policies.test.ts` pins each policy's statements. Nothing there notices when
 * the APP starts needing something new — which is how nested stacks shipped
 * without the execution role being allowed to pass itself to CloudFormation, and
 * every fresh-account deploy failed at change-set creation. Each rule below ties
 * a resource type to the permission the CloudFormation execution role needs to
 * deploy it. Add a rule whenever a deploy fails with a bootstrap-policy denial.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Stack } from 'aws-cdk-lib';
import { allPolicies } from '../../src/bootstrap/policies';
import { buildApp } from '../../src/main';
import { FIXTURE, STRUCTURAL_CONTEXT } from '../../src/synthesis/profiles';

interface Statement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action: string | string[];
  readonly Resource?: string | string[];
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

interface CoverageRule {
  /** CloudFormation resource type whose presence triggers the rule. */
  readonly resourceType: string;
  /** What deploying that type needs, in operator-readable terms. */
  readonly needs: string;
  readonly satisfiedBy: (statements: readonly Statement[]) => boolean;
}

const asArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const COVERAGE_RULES: readonly CoverageRule[] = [
  {
    resourceType: 'AWS::CloudFormation::Stack',
    needs: 'iam:PassRole on the CDK cfn-exec-role, passed to cloudformation.amazonaws.com (CloudFormation hands the role to each nested stack)',
    satisfiedBy: (statements) => statements.some((st) =>
      st.Effect === 'Allow'
      && asArray(st.Action).includes('iam:PassRole')
      && asArray(st.Resource).some((r) => r.includes('cfn-exec-role'))
      && asArray(st.Condition?.StringEquals?.['iam:PassedToService']).includes('cloudformation.amazonaws.com')),
  },
];

/** Every resource type across all synthesized templates, nested ones included. */
function resourceTypes(directory: string): Set<string> {
  const types = new Set<string>();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.template.json')) continue;
    const template = JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as {
      Resources?: Record<string, { Type: string }>;
    };
    for (const resource of Object.values(template.Resources ?? {})) types.add(resource.Type);
  }
  return types;
}

describe('bootstrap policy coverage of the synthesized app', () => {
  let directory: string;
  let types: Set<string>;
  let statements: Statement[];

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'bootstrap-coverage-'));
    const app = await buildApp({
      account: FIXTURE.account,
      region: FIXTURE.region,
      describeAzs: async () => [...FIXTURE.zones],
      resolveCallerAccount: async () => FIXTURE.account,
      appProps: {
        outdir: directory,
        autoSynth: false,
        // Optional features on, so every resource type a customer could deploy is present.
        context: {
          enableToolGateway: true,
          enableAgentRegistry: true,
          enableLinearIdentityVault: true,
        },
        postCliContext: STRUCTURAL_CONTEXT,
      },
    });
    app.synth();
    types = resourceTypes(directory);

    const stack = new Stack();
    statements = allPolicies().flatMap((doc) => (stack.resolve(doc) as { Statement: Statement[] }).Statement);
  }, 300_000);

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('synthesizes nested stacks today, so the nested-stack rule is exercised', () => {
    expect(types.has('AWS::CloudFormation::Stack')).toBe(true);
  });

  it.each(COVERAGE_RULES.map((rule) => [rule.resourceType, rule] as const))(
    'covers %s',
    (_type, rule) => {
      if (!types.has(rule.resourceType)) return;
      if (!rule.satisfiedBy(statements)) {
        throw new Error(`The app deploys ${rule.resourceType}, so the bootstrap policies must allow: ${rule.needs}. `
          + 'Add it in cdk/src/bootstrap/policies/ and bump BOOTSTRAP_VERSION.');
      }
    },
  );
});
