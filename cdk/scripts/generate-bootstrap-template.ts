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

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import { nestedStackExecutionPolicy } from '../src/bootstrap/nested-stack-policy';
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

export function buildTemplate(): any {
  const rawTemplate = readFileSync(cdkBootstrapTemplatePath, 'utf-8');
  const template: any = yaml.load(rawTemplate);

  template.Parameters.BootstrapVariant.Default = 'ABCA: Least-Privilege Bootstrap';

  template.Parameters.ComputeTypes = {
    Type: 'CommaDelimitedList',
    Default: 'agentcore',
    Description:
      'Comma-separated list of compute backends to enable. Valid values: agentcore, ecs, lambda-microvm.',
  };

  // CloudFormation conditions have no `Fn::Contains`.
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
  template.Conditions.IncludeComputeLambdaMicrovms = includesComputeType('lambda-microvm');

  interface PolicyDef {
    logicalId: string;
    policyName: string;
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
    if (!policyDoc.Version) {
      policyDoc.Version = '2012-10-17';
    }

    const resource: any = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        ManagedPolicyName: {
          'Fn::Sub': `cdk-\${Qualifier}-${policyName}-\${AWS::AccountId}-\${AWS::Region}`,
        },
        // A JSON string, not a mapping: the CLI re-serialises a mapping with every statement key
        // and action on its own line, which puts the body over the 51,200 inline ceiling (#864).
        PolicyDocument: JSON.stringify(policyDoc),
        Description: `ABCA Bootstrap: ${policyName} permissions for CloudFormation execution role`,
      },
    };

    if (condition) {
      resource.Condition = condition;
    }

    template.Resources[logicalId] = resource;
  }

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

  // Nested stacks inherit the parent execution role. CloudFormation checks that
  // the caller can pass it, including during change-set validation (#645).
  const executionRole = template.Resources.CloudFormationExecutionRole.Properties;
  executionRole.Policies = [
    ...(executionRole.Policies ?? []),
    {
      PolicyName: 'PassExecutionRoleToCloudFormation',
      PolicyDocument: nestedStackExecutionPolicy(),
    },
  ];

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

/** Render the committed artifact: header comment + YAML body. */
export function renderTemplate(): string {
  const template: any = buildTemplate();

  const yamlOutput = yaml.dump(template, {
    lineWidth: 120,
    noRefs: true,
    quoteStyle: 'single',
    forceQuotes: false,
  });

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
    '#   - Execution role may pass only itself to CloudFormation for nested stacks',
    '#   - 6 AWS::IAM::ManagedPolicy resources replace AdministratorAccess; each',
    '#     PolicyDocument is a minified JSON string so the template stays under the',
    '#     51,200-char CloudFormation inline-template limit (#864)',
    '#   - CloudFormationExecutionRole references our least-privilege policies',
    '#   - BootstrapPolicyVersion, BootstrapPolicyHash, BootstrapPolicySet outputs added',
    '',
  ].join('\n');

  return header + yamlOutput;
}

function main(): void {
  mkdirSync(outputDir, { recursive: true });

  const rendered = renderTemplate();

  const stagingPath = `${outputPath}.tmp`;
  writeFileSync(stagingPath, rendered);

  let bodySize: number;
  try {
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

if (require.main === module) {
  main();
}
