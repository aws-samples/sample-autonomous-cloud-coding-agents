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

import { BOOTSTRAP_VERSION, computeBootstrapHash } from '../../src/bootstrap/version';

const templatePath = join(__dirname, '..', '..', 'bootstrap', 'bootstrap-template.yaml');

const template: any = yaml.load(readFileSync(templatePath, 'utf-8'));

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
  });

  describe('Managed policy resources', () => {
    const expectedPolicies = [
      'IaCRoleABCAInfrastructure',
      'IaCRoleABCAApplication',
      'IaCRoleABCAObservability',
      'IaCRoleABCAComputeAgentcore',
      'IaCRoleABCAComputeEcs',
    ];

    for (const logicalId of expectedPolicies) {
      it(`has ${logicalId} resource`, () => {
        expect(template.Resources[logicalId]).toBeDefined();
        expect(template.Resources[logicalId].Type).toBe('AWS::IAM::ManagedPolicy');
        expect(template.Resources[logicalId].Properties.PolicyDocument).toBeDefined();
        expect(template.Resources[logicalId].Properties.PolicyDocument.Statement).toBeDefined();
        expect(
          template.Resources[logicalId].Properties.PolicyDocument.Statement.length,
        ).toBeGreaterThan(0);
      });
    }

    it('IaCRoleABCAComputeEcs has IncludeComputeEcs condition', () => {
      expect(template.Resources.IaCRoleABCAComputeEcs.Condition).toBe('IncludeComputeEcs');
    });

    it('non-ECS policies do not have a condition', () => {
      const nonEcs = expectedPolicies.filter((p) => p !== 'IaCRoleABCAComputeEcs');
      for (const logicalId of nonEcs) {
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

      const ecsItem = items.find((item: any) => item['Fn::If']);
      expect(ecsItem).toBeDefined();
      expect(ecsItem['Fn::If'][0]).toBe('IncludeComputeEcs');
      expect(ecsItem['Fn::If'][1]).toBe('Compute-ECS');
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
});
