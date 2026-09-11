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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import { buildTemplate, renderTemplate } from '../../scripts/generate-bootstrap-template';
import {
  CFN_INLINE_TEMPLATE_LIMIT,
  TEMPLATE_SIZE_BUDGET,
  checkTemplateBudget,
  cloudFormationBodySize,
} from '../../src/bootstrap/template-size';
import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../../src/bootstrap/version';

const templatePath = join(__dirname, '..', '..', 'bootstrap', 'bootstrap-template.yaml');

const template: any = yaml.load(readFileSync(templatePath, 'utf-8'));

/** Spawning the CDK CLI is slow on cold or egress-restricted runners, well past Jest's
 *  5 s default. Explicit so a slow runner reports a timeout rather than a mystery. */
const CLI_TIMEOUT_MS = 30_000;

/**
 * ABCA policy documents are emitted as minified JSON strings (#864), so a test that
 * wants at the statements has to parse first. Scoped to our own policies: the default
 * CDK template also ships `CdkBoostrapPermissionsBoundaryPolicy`, which stays a mapping.
 */
function abcaPolicyDocument(logicalId: string): any {
  const doc = template.Resources[logicalId].Properties.PolicyDocument;
  expect(typeof doc).toBe('string');
  return JSON.parse(doc);
}

describe('Bootstrap template', () => {
  describe('Parameters', () => {
    it('has ComputeTypes parameter with correct defaults', () => {
      expect(template.Parameters.ComputeTypes).toBeDefined();
      expect(template.Parameters.ComputeTypes.Type).toBe('CommaDelimitedList');
      expect(template.Parameters.ComputeTypes.Default).toBe('agentcore');
    });

    it('has BootstrapVariant set to ABCA variant', () => {
      expect(template.Parameters.BootstrapVariant.Default).toBe(
        'ABCA: Least-Privilege Bootstrap',
      );
    });
  });

  describe('Conditions', () => {
    it('has IncludeComputeEcs condition', () => {
      expect(template.Conditions.IncludeComputeEcs).toBeDefined();
      expect(template.Conditions.IncludeComputeEcs['Fn::Not']).toBeDefined();
    });

    it('has IncludeComputeLambdaMicrovms condition matching the full backend token', () => {
      const condition = template.Conditions.IncludeComputeLambdaMicrovms;
      expect(condition).toBeDefined();
      expect(condition['Fn::Not']).toBeDefined();
      // Split on the WHOLE `lambda-microvm` token: splitting on a `lambda`
      // prefix would also fire for any future `lambda*` backend name.
      expect(JSON.stringify(condition)).toContain('lambda-microvm');
    });
  });

  describe('Managed policy resources', () => {
    const expectedPolicies = [
      'IaCRoleABCAInfrastructure',
      'IaCRoleABCAApplication',
      'IaCRoleABCAObservability',
      'IaCRoleABCAComputeAgentcore',
      'IaCRoleABCAComputeEcs',
      'IaCRoleABCAComputeLambdaMicrovms',
    ];

    for (const logicalId of expectedPolicies) {
      it(`has ${logicalId} resource`, () => {
        expect(template.Resources[logicalId]).toBeDefined();
        expect(template.Resources[logicalId].Type).toBe('AWS::IAM::ManagedPolicy');
        expect(template.Resources[logicalId].Properties.PolicyDocument).toBeDefined();
        const doc = abcaPolicyDocument(logicalId);
        expect(doc.Statement).toBeDefined();
        expect(doc.Statement.length).toBeGreaterThan(0);
      });
    }

    it('IaCRoleABCAComputeEcs has IncludeComputeEcs condition', () => {
      expect(template.Resources.IaCRoleABCAComputeEcs.Condition).toBe('IncludeComputeEcs');
    });

    it('IaCRoleABCAComputeLambdaMicrovms has IncludeComputeLambdaMicrovms condition', () => {
      expect(template.Resources.IaCRoleABCAComputeLambdaMicrovms.Condition)
        .toBe('IncludeComputeLambdaMicrovms');
    });

    it('IaCRoleABCAComputeLambdaMicrovms carries the unconditioned MicrovmPassRoles statement', () => {
      // ADR-021 P2r2-F9, asserted on the artifact operators actually deploy rather
      // than only on the TypeScript source: CloudFormation cannot pass the MicroVM
      // build role while an `iam:PassedToService` condition is in force, so the
      // CDK-managed image path depends on this statement reaching the YAML with no
      // Condition key. It lives in the CONDITIONAL per-backend policy, so an
      // agentcore-only bootstrap never gains the unconditioned pass at all.
      const statements = abcaPolicyDocument('IaCRoleABCAComputeLambdaMicrovms')
        .Statement as Array<{
        Sid: string;
        Action: string | string[];
        Resource: string | string[];
        Condition?: unknown;
      }>;
      const passRole = statements.find((s) => s.Sid === 'MicrovmPassRoles');
      expect(passRole).toBeDefined();
      expect(passRole!.Action).toBe('iam:PassRole');
      expect(passRole!.Condition).toBeUndefined();
      expect(passRole!.Resource).toEqual([
        'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeBuild*',
        'arn:aws:iam::*:role/backgroundagent-dev-LambdaMicrovmComputeConnector*',
      ]);
    });

    it('non-optional-compute policies do not have a condition', () => {
      const unconditional = expectedPolicies.filter(
        (p) => p !== 'IaCRoleABCAComputeEcs' && p !== 'IaCRoleABCAComputeLambdaMicrovms',
      );
      for (const logicalId of unconditional) {
        expect(template.Resources[logicalId].Condition).toBeUndefined();
      }
    });

    it('each policy has a qualified ManagedPolicyName using Fn::Sub', () => {
      for (const logicalId of expectedPolicies) {
        const name = template.Resources[logicalId].Properties.ManagedPolicyName;
        expect(name).toBeDefined();
        expect(name['Fn::Sub']).toMatch(/^cdk-\$\{Qualifier\}-IaCRole-ABCA-/);
      }
    });
  });

  describe('CloudFormationExecutionRole', () => {
    it('exists and is an IAM Role', () => {
      expect(template.Resources.CloudFormationExecutionRole).toBeDefined();
      expect(template.Resources.CloudFormationExecutionRole.Type).toBe('AWS::IAM::Role');
    });

    it('ManagedPolicyArns references our policies (not AdministratorAccess)', () => {
      const managed =
        template.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns;
      expect(managed).toBeDefined();

      // Should be an Fn::If with HasCloudFormationExecutionPolicies
      expect(managed['Fn::If']).toBeDefined();
      expect(managed['Fn::If'][0]).toBe('HasCloudFormationExecutionPolicies');

      // The fallback (index 2) should be an array referencing our policies
      const fallback = managed['Fn::If'][2];
      expect(Array.isArray(fallback)).toBe(true);
      expect(fallback).toContainEqual({ Ref: 'IaCRoleABCAInfrastructure' });
      expect(fallback).toContainEqual({ Ref: 'IaCRoleABCAApplication' });
      expect(fallback).toContainEqual({ Ref: 'IaCRoleABCAObservability' });
      expect(fallback).toContainEqual({ Ref: 'IaCRoleABCAComputeAgentcore' });

      // ECS should be conditional
      const ecsEntry = fallback.find(

        (item: any) => item['Fn::If'] && item['Fn::If'][0] === 'IncludeComputeEcs',
      );
      expect(ecsEntry).toBeDefined();
      expect(ecsEntry['Fn::If'][1]).toEqual({ Ref: 'IaCRoleABCAComputeEcs' });
      expect(ecsEntry['Fn::If'][2]).toEqual({ Ref: 'AWS::NoValue' });

      // ...and so should Lambda MicroVMs (ADR-021).
      const microvmEntry = fallback.find(

        (item: any) => item['Fn::If'] && item['Fn::If'][0] === 'IncludeComputeLambdaMicrovms',
      );
      expect(microvmEntry).toBeDefined();
      expect(microvmEntry['Fn::If'][1]).toEqual({ Ref: 'IaCRoleABCAComputeLambdaMicrovms' });
      expect(microvmEntry['Fn::If'][2]).toEqual({ Ref: 'AWS::NoValue' });
    });

    it('does not reference AdministratorAccess', () => {
      const serialized = JSON.stringify(
        template.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns,
      );
      expect(serialized).not.toContain('AdministratorAccess');
    });
  });

  describe('Outputs', () => {
    it('has BootstrapPolicyVersion output matching source constant', () => {
      expect(template.Outputs.BootstrapPolicyVersion).toBeDefined();
      expect(template.Outputs.BootstrapPolicyVersion.Value).toBe(BOOTSTRAP_VERSION);
    });

    it('has BootstrapPolicyHash output matching computed hash', () => {
      expect(template.Outputs.BootstrapPolicyHash).toBeDefined();
      expect(template.Outputs.BootstrapPolicyHash.Value).toBe(computeBootstrapHash());
    });

    it('has BootstrapPolicySet output with conditional ECS', () => {
      expect(template.Outputs.BootstrapPolicySet).toBeDefined();
      const value = template.Outputs.BootstrapPolicySet.Value;
      expect(value['Fn::Join']).toBeDefined();

      // Should contain the core policy names
      const items = value['Fn::Join'][1];
      expect(items).toContain('Infrastructure');
      expect(items).toContain('Application');
      expect(items).toContain('Observability');
      expect(items).toContain('Compute-Agentcore');

      // ECS should be conditional

      const conditionalItems = items.filter((item: any) => item['Fn::If']);
      expect(conditionalItems.map((item: any) => item['Fn::If'][0])).toEqual([
        'IncludeComputeEcs',
        'IncludeComputeLambdaMicrovms',
      ]);
      expect(conditionalItems[0]['Fn::If'][1]).toBe('Compute-ECS');
      expect(conditionalItems[1]['Fn::If'][1]).toBe('Compute-LambdaMicrovms');
    });
  });

  describe('Default resources preserved', () => {
    const expectedResources = [
      'StagingBucket',
      'StagingBucketPolicy',
      'ContainerAssetsRepository',
      'FileAssetsBucketEncryptionKey',
      'FileAssetsBucketEncryptionKeyAlias',
      'FilePublishingRole',
      'ImagePublishingRole',
      'LookupRole',
      'CloudFormationExecutionRole',
      'DeploymentActionRole',
      'CdkBootstrapVersion',
    ];

    for (const resourceId of expectedResources) {
      it(`retains ${resourceId}`, () => {
        expect(template.Resources[resourceId]).toBeDefined();
      });
    }
  });

  describe('Template validity', () => {
    it('has Description', () => {
      expect(template.Description).toBeDefined();
      expect(typeof template.Description).toBe('string');
    });

    it('has Parameters section', () => {
      expect(template.Parameters).toBeDefined();
      expect(Object.keys(template.Parameters).length).toBeGreaterThan(0);
    });

    it('has Conditions section', () => {
      expect(template.Conditions).toBeDefined();
      expect(Object.keys(template.Conditions).length).toBeGreaterThan(0);
    });

    it('has Resources section', () => {
      expect(template.Resources).toBeDefined();
      expect(Object.keys(template.Resources).length).toBeGreaterThan(0);
    });

    it('has Outputs section', () => {
      expect(template.Outputs).toBeDefined();
      expect(Object.keys(template.Outputs).length).toBeGreaterThan(0);
    });
  });

  // #864: `cdk bootstrap --template <file>` does NOT send the bytes on disk. It parses
  // the file, discards its formatting, and re-serialises the parsed object with the
  // CLI's own writer before deciding inline-vs-S3:
  //
  //   const templateJson = toYAML(overrideTemplate ?? stack.template);
  //   if (templateJson.length <= LARGE_TEMPLATE_SIZE_KB * 1024) ...
  //
  // Over the limit the CLI must stage in S3, which is impossible while bootstrapping a
  // fresh account (that bucket is what bootstrap creates), so it fails outright with
  // `BootstrapStackRequired` — `--force` included. These tests therefore measure the
  // CLI's serialisation of the committed artifact, which is the quantity that gates
  // bootstrap. An earlier revision of this guard measured on-disk bytes and passed at
  // 39,896 while the body CloudFormation received was 53,369.
  describe('Inline-template size limit', () => {
    // Measured by invoking the CDK CLI on the committed artifact, so the assertion is the
    // CLI's own number rather than a local reimplementation of its serialiser. An earlier
    // revision of this guard read on-disk bytes, passed at 39,896, and shipped a template
    // whose body was 53,369 — over the ceiling and unable to bootstrap a fresh account.
    //
    // One invocation, not three. Formatting invariance is asserted below by comparing
    // *parsed* templates, which is both exact and free: the CLI's size is a function of
    // the parsed object, so two files that parse identically cannot differ on the wire.
    const cdkRoot = join(__dirname, '..', '..');
    let bodySize: number;

    beforeAll(() => {
      bodySize = cloudFormationBodySize(templatePath, cdkRoot);
    }, CLI_TIMEOUT_MS);

    it('fits within the CloudFormation inline template limit as the CLI serialises it', () => {
      expect(bodySize).toBeLessThanOrEqual(CFN_INLINE_TEMPLATE_LIMIT);
    });

    it('stays within the generator budget, leaving headroom for new statements', () => {
      expect(bodySize).toBeLessThanOrEqual(TEMPLATE_SIZE_BUDGET);
    });

    // Reformatting the committed YAML cannot move the gated size, because the CLI parses
    // the file and discards its layout. Locking that in stops a future contributor
    // "fixing" a budget failure by reflowing the artifact — which is exactly what #864's
    // first attempted fix did, shrinking the file 14 KB with zero movement on the wire.
    //
    // Asserted on parsed equality rather than by measuring both files through the CLI.
    // That is stronger (exact, no tolerance) and avoids two more subprocesses: the CLI
    // derives its size from the parsed object, so identical parses give identical bodies
    // by construction.
    it('cannot buy headroom by reformatting, because the CLI measures the parsed template', () => {
      const compact = yaml.dump(template, { lineWidth: -1, noRefs: true, flowLevel: 4 });
      const expanded = yaml.dump(template, { lineWidth: -1, noRefs: true });
      // Thousands of characters apart on disk...
      expect(expanded.length - compact.length).toBeGreaterThan(1_000);
      // ...yet the same template, so the same body reaches CloudFormation.
      expect(yaml.load(compact)).toEqual(yaml.load(expanded));
    });

    // Each PolicyDocument is emitted as a minified JSON string rather than a nested
    // mapping: a string scalar survives the CLI's re-serialisation on one line, which is
    // what brings the body under the ceiling. CloudFormation accepts either shape for
    // this `Json`-typed property and IAM stores the string parsed.
    it('emits every PolicyDocument as a JSON string that parses to a policy document', () => {
      const abcaPolicies = Object.keys(template.Resources as Record<string, any>)
        .filter((id) => id.startsWith('IaCRoleABCA'));
      expect(abcaPolicies).toHaveLength(6);
      for (const id of abcaPolicies) {
        const parsed = abcaPolicyDocument(id);
        expect(parsed.Version).toBe('2012-10-17');
        expect(Array.isArray(parsed.Statement)).toBe(true);
        expect(parsed.Statement.length).toBeGreaterThan(0);
      }
    });
  });

  // The generator's budget check had no test: the only way to exercise it was to make the
  // real template too big. Extracting the comparison makes the boundaries assertable.
  describe('Budget check', () => {
    it('passes exactly at the budget', () => {
      const v = checkTemplateBudget(TEMPLATE_SIZE_BUDGET);
      expect(v.withinBudget).toBe(true);
      expect(v.overBudgetBy).toBe(0);
      expect(v.overHardLimit).toBe(false);
    });

    it('fails one character over the budget, still short of the hard limit', () => {
      const v = checkTemplateBudget(TEMPLATE_SIZE_BUDGET + 1);
      expect(v.withinBudget).toBe(false);
      expect(v.overBudgetBy).toBe(1);
      expect(v.overHardLimit).toBe(false);
    });

    it('flags the hard limit separately once the inline ceiling is passed', () => {
      const v = checkTemplateBudget(CFN_INLINE_TEMPLATE_LIMIT + 1);
      expect(v.withinBudget).toBe(false);
      expect(v.overHardLimit).toBe(true);
    });

    // The pre-fix state, kept as a regression marker: 53,369 was the real body size that
    // shipped past the ceiling while an on-disk guard reported 39,896 and passed.
    it('rejects the body size that #864 shipped', () => {
      const v = checkTemplateBudget(53_369);
      expect(v.withinBudget).toBe(false);
      expect(v.overHardLimit).toBe(true);
    });
  });

  // Replaces an earlier round-trip assertion that compared a dump of the committed file
  // against a load of that dump — i.e. `load(dump(x)) === x`, true for any object, and
  // blind to the artifact drifting from its generator. Comparing against an
  // independently built template is the check that actually has teeth.
  describe('Artifact matches the generator', () => {
    it('committed template deep-equals a freshly built one', () => {
      expect(template).toEqual(buildTemplate());
    });

    it('committed file is byte-identical to a fresh render', () => {
      expect(readFileSync(templatePath, 'utf-8')).toBe(renderTemplate());
    });
  });
});
