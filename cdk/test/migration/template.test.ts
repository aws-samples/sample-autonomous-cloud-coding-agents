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

import {
  canonical, digest, MigrationTemplate, references, referencesAny, templateDelta, validateTemplate,
} from '../../src/migration/template';

const fixture = (): MigrationTemplate => ({
  Parameters: { Environment: { Type: 'String' } },
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket' },
    Consumer: {
      Type: 'AWS::IAM::Policy',
      DependsOn: 'Bucket',
      Properties: {
        Resource: { 'Fn::Sub': '${Bucket.Arn}/${Environment}/${AWS::Region}/*' },
      },
    },
  },
  Outputs: { Name: { Value: { Ref: 'Bucket' } } },
});

describe('migration template boundaries', () => {
  test('recognizes Ref, both GetAtt forms, Sub bindings and escaped variables', () => {
    expect(references({
      one: { Ref: 'Role' },
      two: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
      three: { 'Fn::GetAtt': 'Image.ImageArn' },
      four: { 'Fn::Sub': ['${Alias}/${!Literal}/${Target.Arn}/${AWS::Region}', { Alias: { Ref: 'Bound' } }] },
      prose: 'OldBucket',
      Metadata: { Ref: 'NotARealReference' },
    })).toEqual(new Set(['Role', 'Bucket', 'Image', 'Target', 'AWS::Region', 'Bound']));
    expect(referencesAny({ 'Fn::Sub': '${OldBucket.Arn}/*' }, new Set(['OldBucket']))).toBe(true);
    expect(referencesAny('OldBucket', new Set(['OldBucket']))).toBe(false);
  });

  test('hashes object key order consistently without changing ordered arrays or strings', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
    expect(canonical({ policy: '{"Version":"2012-10-17"}' })).not.toBe(
      canonical({ policy: { Version: '2012-10-17' } }),
    );
  });

  test('accepts parameters and AWS pseudo-parameters in nested resource references', () => {
    expect(() => validateTemplate(fixture(), 'prepare')).not.toThrow();
  });

  test.each([
    { Ref: 'OldBucket' },
    { 'Fn::GetAtt': ['OldBucket', 'Arn'] },
    { 'Fn::GetAtt': 'OldBucket.Arn' },
    { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${OldBucket}/*' },
  ])('rejects stale resource references in retirement: %p', (value) => {
    const template = fixture();
    template.Outputs!.Stale = { Value: value };
    expect(() => validateTemplate(template, 'retire')).toThrow('retire: unresolved reference OldBucket');
  });

  test('rejects dangling DependsOn separately from property references', () => {
    const template = fixture();
    template.Resources.Consumer!.DependsOn = ['Deleted'];
    expect(() => validateTemplate(template, 'retire')).toThrow('depends on missing Deleted');
  });

  test.each(['Parameters', 'Outputs'] as const)('rejects oversized %s', (section) => {
    const template = fixture();
    template[section] = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`P${index}`, {}]));
    expect(() => validateTemplate(template, 'cutover')).toThrow(`${section} exceeds`);
  });

  test('rejects overlap exceeding 500 resources instead of dropping legacy resources to fit', () => {
    const template: MigrationTemplate = {
      Resources: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`R${index}`, { Type: 'AWS::S3::Bucket' }])),
    };
    expect(() => validateTemplate(template, 'cutover')).toThrow('501 resources');
  });

  test('rejects oversized templates and malformed resource collections', () => {
    const template = fixture();
    template.Description = 'x'.repeat(1024 * 1024);
    expect(() => validateTemplate(template, 'prepare')).toThrow('1 MiB');
    expect(() => validateTemplate({ Resources: {} }, 'prepare')).toThrow('must contain resources');
    expect(() => references({ 'Fn::Sub': [null, {}] })).toThrow('Invalid Fn::Sub');
  });

  test('reports additions, removals and changes without mutating the baseline', () => {
    const before = fixture();
    const snapshot = structuredClone(before);
    const after = structuredClone(before);
    after.Resources.Bucket!.DeletionPolicy = 'Retain';
    delete after.Resources.Consumer;
    after.Resources.Child = { Type: 'AWS::CloudFormation::Stack' };
    expect(templateDelta(before, after)).toEqual({
      added: ['Child'], removed: ['Consumer'], modified: ['Bucket'],
    });
    expect(before).toEqual(snapshot);
  });
});
