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
 * Generates a custom CDK bootstrap template that replaces AdministratorAccess
 * with ABCA least-privilege managed policies. The template supports per-compute-variant
 * selection via the ComputeTypes parameter.
 *
 * Usage: npx tsx scripts/generate-bootstrap-template.ts
 * Output: cdk/bootstrap/bootstrap-template.yaml
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import {
  applicationPolicy,
  computeAgentcorePolicy,
  computeEcsPolicy,
  computeLambdaMicrovmPolicy,
  infrastructurePolicy,
  observabilityPolicy,
} from '../src/bootstrap/policies';
import {
  CFN_INLINE_TEMPLATE_LIMIT,
  TEMPLATE_SIZE_BUDGET,
  checkTemplateBudget,
  cloudFormationBodySize,
} from '../src/bootstrap/template-size';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../src/bootstrap/version';

// --- Paths ---
// aws-cdk is hoisted to the workspace root node_modules; use require.resolve to find it
const awsCdkDir = join(require.resolve('aws-cdk/package.json'), '..');
const cdkBootstrapTemplatePath = join(
  awsCdkDir,
  'lib',
  'api',
  'bootstrap',
  'bootstrap-template.yaml',
);
const outputDir = join(__dirname, '..', 'bootstrap');
const outputPath = join(outputDir, 'bootstrap-template.yaml');

/**
 * Build the bootstrap template object.
 *
 * Exported so tests can compare the committed artifact against an independently
 * constructed template. A test that only round-trips the committed file through a
 * parser proves nothing — `load(dump(x)) === x` holds for any object — so it cannot
 * detect the artifact drifting from the generator that is supposed to produce it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTemplate(): any {
  // --- Read and parse the default template ---
  const rawTemplate = readFileSync(cdkBootstrapTemplatePath, 'utf-8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const template: any = yaml.load(rawTemplate);

  // --- Step 1: Update BootstrapVariant default ---
  template.Parameters.BootstrapVariant.Default = 'ABCA: Least-Privilege Bootstrap';

  // --- Step 2: Add ComputeTypes parameter ---
  template.Parameters.ComputeTypes = {
    Type: 'CommaDelimitedList',
    Default: 'agentcore',
    Description:
      'Comma-separated list of compute backends to enable. Valid values: agentcore, ecs, lambda-microvm.',
  };

  // --- Step 3: Add conditions ---
  /**
   * "The joined ComputeTypes list contains `needle`" as a CloudFormation
   * condition. There is no `Fn::Contains`, so the trick is: split the joined list
   * on the needle and compare element 0 against the whole string — they differ
   * only if the needle was actually present. Extracted into a helper (it was
   * inline for ECS) so a third backend cannot introduce a subtly different
   * variant of the same expression.
   */
  function includesComputeType(needle: string): Record<string, unknown> {
    const joined = { 'Fn::Join': ['', { Ref: 'ComputeTypes' }] };
    return {
      'Fn::Not': [
        {
          'Fn::Equals': [
            { 'Fn::Select': [0, { 'Fn::Split': [needle, joined] }] },
            joined,
          ],
        },
      ],
    };
  }

  template.Conditions.IncludeComputeEcs = includesComputeType('ecs');
  // ADR-021: matched on the full `lambda-microvm` token, NOT a prefix — a bare
  // `Fn::Split` on `lambda` would also fire for any future `lambda*` backend name.
  template.Conditions.IncludeComputeLambdaMicrovms = includesComputeType('lambda-microvm');

  // --- Step 4: Add managed policy resources ---
  interface PolicyDef {
    logicalId: string;
    policyName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    policyFn: () => any;
    condition?: string;
  }

  const policyDefs: PolicyDef[] = [
    {
      logicalId: 'IaCRoleABCAInfrastructure',
      policyName: 'IaCRole-ABCA-Infrastructure',
      policyFn: infrastructurePolicy,
    },
    {
      logicalId: 'IaCRoleABCAApplication',
      policyName: 'IaCRole-ABCA-Application',
      policyFn: applicationPolicy,
    },
    {
      logicalId: 'IaCRoleABCAObservability',
      policyName: 'IaCRole-ABCA-Observability',
      policyFn: observabilityPolicy,
    },
    {
      logicalId: 'IaCRoleABCAComputeAgentcore',
      policyName: 'IaCRole-ABCA-Compute-Agentcore',
      policyFn: computeAgentcorePolicy,
    },
    {
      logicalId: 'IaCRoleABCAComputeEcs',
      policyName: 'IaCRole-ABCA-Compute-ECS',
      policyFn: computeEcsPolicy,
      condition: 'IncludeComputeEcs',
    },
    {
      logicalId: 'IaCRoleABCAComputeLambdaMicrovms',
      policyName: 'IaCRole-ABCA-Compute-LambdaMicrovms',
      policyFn: computeLambdaMicrovmPolicy,
      condition: 'IncludeComputeLambdaMicrovms',
    },
  ];

  for (const { logicalId, policyName, policyFn, condition } of policyDefs) {
    const policyDoc = policyFn().toJSON();
    // Ensure Version is present in the policy document
    if (!policyDoc.Version) {
      policyDoc.Version = '2012-10-17';
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resource: any = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        ManagedPolicyName: {
          'Fn::Sub': `cdk-\${Qualifier}-${policyName}-\${AWS::AccountId}-\${AWS::Region}`,
        },
        // Minified JSON string, not a nested mapping. `PolicyDocument` is a `Json`-typed
        // property, so CloudFormation accepts either — but the shape decides whether the
        // template fits inline. As a mapping, the CLI's re-serialisation expands every
        // statement key and every action onto its own line and the body lands at 53,369,
        // over the 51,200 inline ceiling; a string scalar survives re-serialisation on one
        // line and brings it to 45,743 (#864). No permission changes: IAM parses the string
        // and stores it as a normal policy document (verified end-to-end — CFN creates the
        // policy and `iam:GetPolicyVersion` returns parsed JSON, not a literal string).
        PolicyDocument: JSON.stringify(policyDoc),
        Description: `ABCA Bootstrap: ${policyName} permissions for CloudFormation execution role`,
      },
    };

    if (condition) {
      resource.Condition = condition;
    }

    template.Resources[logicalId] = resource;
  }

  // --- Step 5: Modify CloudFormationExecutionRole ManagedPolicyArns ---
  // Replace the conditional that falls back to AdministratorAccess with our inline policies.
  // Keep the CloudFormationExecutionPolicies parameter override for flexibility.
  const coreRefs = [
    { Ref: 'IaCRoleABCAInfrastructure' },
    { Ref: 'IaCRoleABCAApplication' },
    { Ref: 'IaCRoleABCAObservability' },
    { Ref: 'IaCRoleABCAComputeAgentcore' },
    { 'Fn::If': ['IncludeComputeEcs', { Ref: 'IaCRoleABCAComputeEcs' }, { Ref: 'AWS::NoValue' }] },
    {
      'Fn::If': [
        'IncludeComputeLambdaMicrovms',
        { Ref: 'IaCRoleABCAComputeLambdaMicrovms' },
        { Ref: 'AWS::NoValue' },
      ],
    },
  ];

  template.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns = {
    'Fn::If': [
      'HasCloudFormationExecutionPolicies',
      { Ref: 'CloudFormationExecutionPolicies' },
      coreRefs,
    ],
  };

  // --- Step 6: Add outputs ---
  template.Outputs.BootstrapPolicyVersion = {
    Description: 'The version of the ABCA bootstrap policy bundle',
    Value: BOOTSTRAP_VERSION,
  };

  template.Outputs.BootstrapPolicyHash = {
    Description: 'SHA-256 hash of the ABCA bootstrap policy bundle for drift detection',
    Value: computeBootstrapHash(),
  };

  template.Outputs.BootstrapPolicySet = {
    Description: 'Comma-separated list of active ABCA bootstrap policy names',
    Value: {
      'Fn::Join': [
        ',',
        [
          'Infrastructure',
          'Application',
          'Observability',
          'Compute-Agentcore',
          { 'Fn::If': ['IncludeComputeEcs', 'Compute-ECS', { Ref: 'AWS::NoValue' }] },
          {
            'Fn::If': [
              'IncludeComputeLambdaMicrovms',
              'Compute-LambdaMicrovms',
              { Ref: 'AWS::NoValue' },
            ],
          },
        ],
      ],
    },
  };

  return template;
}

/**
 * Render the committed artifact: header comment + YAML body.
 *
 * Exported alongside {@link buildTemplate} so the drift test can assert the committed
 * file is exactly what the generator produces today.
 */
export function renderTemplate(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const template: any = buildTemplate();

  const yamlOutput = yaml.dump(template, {
    lineWidth: 120,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
  });

  // Add a header comment
  const header = [
    '# GENERATED FILE - DO NOT EDIT DIRECTLY',
    '# This template is generated by: npx tsx scripts/generate-bootstrap-template.ts',
    `# ABCA Bootstrap Policy Version: ${BOOTSTRAP_VERSION}`,
    `# ABCA Bootstrap Policy Hash: ${computeBootstrapHash()}`,
    '#',
    '# Based on the default CDK bootstrap template with the following modifications:',
    '#   - BootstrapVariant set to "ABCA: Least-Privilege Bootstrap"',
    '#   - ComputeTypes parameter added for compute-variant selection',
    '#   - IncludeComputeEcs / IncludeComputeLambdaMicrovms conditions added',
    '#   - 6 AWS::IAM::ManagedPolicy resources replace AdministratorAccess; each',
    '#     PolicyDocument is a minified JSON string so the template stays under the',
    '#     51,200-char CloudFormation inline-template limit (#864)',
    '#   - CloudFormationExecutionRole references our least-privilege policies',
    '#   - BootstrapPolicyVersion, BootstrapPolicyHash, BootstrapPolicySet outputs added',
    '',
  ].join('\n');

  return header + yamlOutput;
}


/** Generate the artifact, refusing to emit one that cannot bootstrap a fresh account. */
function main(): void {
  mkdirSync(outputDir, { recursive: true });

  const rendered = renderTemplate();

  // Measure a temporary sibling, then rename on success. Writing the real artifact first
  // would leave an over-budget template on disk after a failed run, so the next command
  // that reads it — including `cdk bootstrap` — would use a file the generator rejected.
  // A sibling rather than the OS temp dir keeps the rename atomic on one filesystem.
  const stagingPath = `${outputPath}.tmp`;
  writeFileSync(stagingPath, rendered);

  let bodySize: number;
  try {
    // Gate on what CloudFormation actually receives, which is NOT `rendered`. The CLI
    // re-serialises the parsed object and compares that; on-disk formatting is discarded.
    // See src/bootstrap/template-size.ts for the CLI code path this mirrors.
    bodySize = cloudFormationBodySize(stagingPath, join(__dirname, '..'));

    const verdict = checkTemplateBudget(bodySize);
    if (!verdict.withinBudget) {
      throw new Error(
        `Bootstrap template body is ${bodySize} chars as CloudFormation receives it, over the `
        + `${TEMPLATE_SIZE_BUDGET}-char budget by ${verdict.overBudgetBy} (inline limit is `
        + `${CFN_INLINE_TEMPLATE_LIMIT}${verdict.overHardLimit ? ' \u2014 ALREADY EXCEEDED' : ''}).`
        + ' Past the inline limit `cdk bootstrap` cannot bootstrap a fresh account at all (#864).'
        + " Note this is the CLI's re-serialisation of the parsed template, so reformatting the"
        + ' committed YAML will not move it \u2014 the *content* has to shrink: fewer or merged'
        + ' statements, or more compute-variant policies behind a Condition. Verify with:'
        + ' npx cdk bootstrap --show-template --no-ci --template bootstrap/bootstrap-template.yaml | wc -c',
      );
    }
  } catch (err) {
    rmSync(stagingPath, { force: true });
    throw err;
  }

  renameSync(stagingPath, outputPath);

  console.log(
    `Generated bootstrap template (v${BOOTSTRAP_VERSION}) -> ${outputPath}`
    + ` [on disk ${rendered.length}; CloudFormation body ${bodySize}, `
    + `${TEMPLATE_SIZE_BUDGET - bodySize} under budget]`,
  );
}

// Only write when invoked as a script, so importing for tests has no side effects.
if (require.main === module) {
  main();
}

