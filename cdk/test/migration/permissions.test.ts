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

import { preserveLegacyPermissions } from '../../src/migration/permissions';
import { MigrationTemplate } from '../../src/migration/template';

const oldObject = { 'Fn::Sub': '${OldPayload.Arn}/*' };
const newObject = { 'Fn::Sub': '${Child.Outputs.PayloadArn}/bootstrap/*' };
const ids = new Set(['OldPayload', 'OldImage']);
const policy = (statements: any[], role = 'Worker') => ({
  Type: 'AWS::IAM::Policy',
  Properties: { Roles: [{ Ref: role }], PolicyDocument: { Statement: statements } },
});
const allow = (resource: any) => ({ Effect: 'Allow', Action: ['s3:GetObject*'], Resource: resource });
const deny = (resource: any) => ({ Effect: 'Deny', Action: ['s3:GetObject*'], NotResource: resource });
const baseline = (): MigrationTemplate => ({ Resources: { WorkerPolicy: policy([allow(oldObject)]) } });
const target = (): MigrationTemplate => ({
  Resources: { WorkerPolicy: policy([allow(newObject), deny(newObject)]) },
});

describe('migration permission overlap', () => {
  test('P2 direct reads remain possible on the original role without granting new-bucket payload reads', () => {
    const original = baseline();
    const next = target();
    const { template, bridgePolicyIds } = preserveLegacyPermissions(original, next, ids);
    const statements = template.Resources.WorkerPolicy!.Properties!.PolicyDocument.Statement;
    expect(statements.filter((statement: any) => statement.Effect === 'Deny')).toEqual([
      { ...deny(newObject), NotResource: [newObject, oldObject] },
    ]);
    expect(bridgePolicyIds).toHaveLength(1);
    expect(template.Resources[bridgePolicyIds[0]!]!.Properties).toMatchObject({
      Roles: [{ Ref: 'Worker' }],
      PolicyDocument: { Statement: [allow(oldObject)] },
    });
    expect(original).toEqual(baseline());
    expect(next).toEqual(target());
  });

  test('P3 flat bootstrap deny merges exceptions into one deny', () => {
    const original = baseline();
    original.Resources.WorkerPolicy = policy([allow(oldObject), deny(oldObject)]);
    const { template } = preserveLegacyPermissions(original, target(), ids);
    const denies = template.Resources.WorkerPolicy!.Properties!.PolicyDocument.Statement
      .filter((statement: any) => statement.Effect === 'Deny');
    expect(denies).toEqual([{ ...deny(newObject), NotResource: [newObject, oldObject] }]);
  });

  test('rejects unmatched legacy NotResource deny rather than denying both buckets', () => {
    const original = baseline();
    original.Resources.WorkerPolicy = policy([{ ...deny(oldObject), Condition: { Bool: { Example: true } } }]);
    expect(() => preserveLegacyPermissions(original, target(), ids)).toThrow('Ambiguous legacy Deny');
  });

  test('does not share a worker bridge with the coordinator or retain unrelated grants', () => {
    const original = baseline();
    original.Resources.WorkerPolicy!.Properties!.PolicyDocument.Statement.push(allow({ 'Fn::Sub': '${Other.Arn}/*' }));
    original.Resources.CoordinatorPolicy = policy([
      { Effect: 'Allow', Action: ['lambda:TerminateMicrovm'], Resource: { Ref: 'OldImage' } },
    ], 'Coordinator');
    const next = target();
    next.Resources.CoordinatorPolicy = policy([
      { Effect: 'Allow', Action: ['lambda:TerminateMicrovm'], Resource: { Ref: 'NewImage' } },
    ], 'Coordinator');
    const { template, bridgePolicyIds } = preserveLegacyPermissions(original, next, ids);
    expect(bridgePolicyIds).toHaveLength(2);
    const worker = bridgePolicyIds.map(id => template.Resources[id]!.Properties!)
      .find(props => props.Roles[0].Ref === 'Worker');
    expect(worker.PolicyDocument.Statement).toEqual([allow(oldObject)]);
  });

  test('finds managed overflow policies attached from the role and preserves JSON-string documents', () => {
    const next = target();
    next.Resources.Worker = {
      Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: [{ Ref: 'Overflow' }] },
    };
    next.Resources.Overflow = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: { PolicyDocument: JSON.stringify({ Statement: [deny(newObject)] }) },
    };
    next.Resources.WorkerPolicy = policy([allow(newObject)]);
    const { template } = preserveLegacyPermissions(baseline(), next, ids);
    expect(typeof template.Resources.Overflow!.Properties!.PolicyDocument).toBe('string');
    expect(JSON.parse(template.Resources.Overflow!.Properties!.PolicyDocument).Statement[0].NotResource)
      .toEqual([newObject, oldObject]);
  });

  test('keeps a removed role or unsupported grant from being silently reassigned', () => {
    const next = target();
    next.Resources.WorkerPolicy!.Properties!.Roles = [{ Ref: 'OtherWorker' }];
    expect(() => preserveLegacyPermissions(baseline(), next, ids)).toThrow('Missing original IAM principal');
    const original = baseline();
    original.Resources.WorkerPolicy!.Properties!.PolicyDocument.Statement[0].Principal = '*';
    expect(() => preserveLegacyPermissions(original, target(), ids)).toThrow('Unsupported legacy identity grant');
  });

  test('rejects duplicate bootstrap denies', () => {
    const next = target();
    next.Resources.WorkerPolicy!.Properties!.PolicyDocument.Statement.push(deny({ Ref: 'Other' }));
    expect(() => preserveLegacyPermissions(baseline(), next, ids)).toThrow('Multiple S3 bootstrap denies');
  });
});
