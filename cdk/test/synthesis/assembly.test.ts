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

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Annotations, App, CfnResource, NestedStack, Stack } from 'aws-cdk-lib';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { canonicalJson, compareAssemblies, inspectAssembly } from '../../src/synthesis/assembly';

describe('CloudFormation assembly census', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'assembly-census-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  function json(file: string, value: unknown): void {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  }

  function assembly(prefix = ''): void {
    json(`${prefix}manifest.json`, {
      artifacts: {
        Api: {
          type: 'aws:cloudformation:stack',
          properties: { templateFile: 'api.template.json' },
          dependencies: ['Assets'],
          metadata: { '/Api': [{ type: 'aws:cdk:warning', data: 'warning is not an error' }] },
        },
        Assets: { type: 'cdk:asset-manifest', properties: { file: 'assets.json' } },
      },
    });
    json(`${prefix}assets.json`, { files: {} });
    json(`${prefix}api.template.json`, {
      Resources: {
        Metadata: { Type: 'AWS::CDK::Metadata' },
        Child: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'child.template.json' } },
      },
      Parameters: { Config: { Type: 'String' } },
      Outputs: { Value: { Value: 'value' } },
    });
    json(`${prefix}child.template.json`, {
      Resources: {
        Table: {
          Type: 'AWS::DynamoDB::Table',
          Metadata: { 'aws:cdk:path': 'Api/Child/Table' },
          DeletionPolicy: 'Retain',
        },
      },
    });
  }

  test('counts parent and nested templates separately, includes metadata, ignores orphan files', () => {
    assembly();
    json('stale.template.json', { Resources: { Orphan: { Type: 'AWS::S3::Bucket' } } });
    const result = inspectAssembly(directory);
    expect(result.totalResources).toBe(3);
    expect(result.templates).toHaveLength(2);
    expect(result.templates[0]).toMatchObject({
      file: 'api.template.json',
      resources: 2,
      parameters: 1,
      outputs: 1,
      types: { 'AWS::CDK::Metadata': 1, 'AWS::CloudFormation::Stack': 1 },
      bytes: readFileSync(path.join(directory, 'api.template.json')).length,
    });
    expect(result.templates[1].inventory).toEqual([{
      logicalId: 'Table',
      type: 'AWS::DynamoDB::Table',
      constructPath: 'Api/Child/Table',
      deletionPolicy: 'Retain',
      updateReplacePolicy: null,
    }]);
    expect(result.nestedEdges).toEqual([{ parent: 'api.template.json', child: 'child.template.json' }]);
    expect(result.errors).toEqual([]);
  });

  test('traverses stage assemblies and retains error annotations', () => {
    assembly('stage/');
    json('manifest.json', {
      artifacts: {
        Stage: { type: 'cdk:cloud-assembly', properties: { directoryName: 'stage' } },
        Broken: { type: 'tree', metadata: { '/Child': [{ type: 'aws:cdk:error', data: 'missing permission' }] } },
      },
    });
    const result = inspectAssembly(directory);
    expect(result.templates.map(t => t.file)).toEqual(['stage/api.template.json', 'stage/child.template.json']);
    expect(result.errors).toEqual(['/Child: missing permission']);
  });

  test('reads actual CDK asset manifests and metadata sidecars, including nested errors', () => {
    const app = new App({ outdir: directory });
    const stack = new Stack(app, 'Root', { env: { account: '123456789012', region: 'us-east-1' } });
    const child = new NestedStack(stack, 'Child');
    new CfnResource(child, 'Bucket', { type: 'AWS::S3::Bucket' });
    Annotations.of(child).addError('nested error must reach the census');
    app.synth();
    const result = inspectAssembly(directory);
    expect(result.templates).toHaveLength(2);
    expect(result.nestedEdges).toHaveLength(1);
    expect(result.errors).toContain('/Root/Child: nested error must reach the census');
    expect(result.templates.flatMap(t => t.inventory).filter(r => r.type === 'AWS::S3::Bucket')).toHaveLength(1);
  });

  test('resolves identical nested template hashes separately for each owning top-level stack', () => {
    const app = new App({ outdir: directory, autoSynth: false });
    for (const id of ['First', 'Second']) {
      const stack = new Stack(app, id, { env: { account: '123456789012', region: 'us-east-1' } });
      new CfnResource(new NestedStack(stack, 'Child'), 'Bucket', { type: 'AWS::S3::Bucket' });
    }
    app.synth();
    const result = inspectAssembly(directory);
    expect(result.templates).toHaveLength(4);
    expect(result.nestedEdges).toEqual(expect.arrayContaining([
      { parent: 'First.template.json', child: expect.stringMatching(/^FirstChild.*nested.template.json$/) },
      { parent: 'Second.template.json', child: expect.stringMatching(/^SecondChild.*nested.template.json$/) },
    ]));
    const children = result.templates.filter(template => template.file.endsWith('.nested.template.json'));
    expect(children).toHaveLength(2);
    expect(children[0].semanticSha256).toBe(children[1].semanticSha256);
  });

  test('flags unresolved CDK lookups even when app.synth emits templates without error annotations', () => {
    const app = new App({ outdir: directory, autoSynth: false });
    const stack = new Stack(app, 'Root', { env: { account: '123456789012', region: 'us-east-1' } });
    new CfnResource(stack, 'Bucket', {
      type: 'AWS::S3::Bucket',
      properties: { BucketName: StringParameter.valueFromLookup(stack, '/fixture/bucket') },
    });
    app.synth();
    const result = inspectAssembly(directory);
    expect(result.templates).toHaveLength(1);
    expect(result.errors).toEqual([expect.stringContaining('Unresolved CDK context')]);
    expect(result.errors[0]).toContain('parameterName=/fixture/bucket');
  });

  test('retains missing-context failures inside stage assemblies', () => {
    assembly('stage/');
    const file = path.join(directory, 'stage/manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.missing = [{ key: 'fixture', provider: 'ssm', props: {} }];
    json('stage/manifest.json', manifest);
    json('manifest.json', { artifacts: { Stage: { type: 'cdk:cloud-assembly', properties: { directoryName: 'stage' } } } });
    expect(inspectAssembly(directory).errors).toEqual(['Unresolved CDK context in stage: fixture (ssm)']);
  });

  test('rejects template and stage symlinks that escape or revisit their assembly', () => {
    assembly('inside/');
    json('outside.json', { Resources: {} });
    symlinkSync('../outside.json', path.join(directory, 'inside/escape.json'));
    json('inside/api.template.json', {
      Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'escape.json' } } },
    });
    expect(() => inspectAssembly(path.join(directory, 'inside'))).toThrow(/symlink/);
    symlinkSync('.', path.join(directory, 'cycle'));
    json('manifest.json', { artifacts: { Stage: { type: 'cdk:cloud-assembly', properties: { directoryName: 'cycle' } } } });
    expect(() => inspectAssembly(directory)).toThrow(/symlink/);
  });

  test('compares real CDK stack dependencies even when every template is unchanged', () => {
    for (const [name, dependent] of [['first', false], ['second', true]] as const) {
      const app = new App({ outdir: path.join(directory, name), autoSynth: false });
      const producer = new Stack(app, 'Producer');
      new CfnResource(producer, 'Bucket', { type: 'AWS::S3::Bucket' });
      const consumer = new Stack(app, 'Consumer');
      new CfnResource(consumer, 'Queue', { type: 'AWS::SQS::Queue' });
      if (dependent) consumer.addDependency(producer);
      app.synth();
    }
    expect(inspectAssembly(path.join(directory, 'second')).stackDependencies).toEqual({
      'Producer.template.json': [],
      'Consumer.template.json': ['Producer.template.json'],
    });
    expect(compareAssemblies(path.join(directory, 'first'), path.join(directory, 'second'))).toEqual([{
      kind: 'stack-dependencies', file: 'Consumer.template.json', paths: [], totalDifferences: 1,
    }]);
  });

  test('qualifies same-named dependencies by stage and treats dependency order as irrelevant', () => {
    for (const prefix of ['first/one/', 'first/two/', 'second/one/', 'second/two/']) {
      assembly(prefix);
      const file = path.join(directory, prefix, 'manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.artifacts.Producer = { type: 'aws:cloudformation:stack', properties: { templateFile: 'producer.template.json' } };
      manifest.artifacts.Api.dependencies = prefix.startsWith('first') ? ['Producer', 'Assets'] : ['Assets', 'Producer'];
      json(`${prefix}manifest.json`, manifest);
      json(`${prefix}producer.template.json`, { Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } });
    }
    for (const prefix of ['first/', 'second/']) {
      json(`${prefix}manifest.json`, {
        artifacts: {
          One: { type: 'cdk:cloud-assembly', properties: { directoryName: 'one' } },
          Two: { type: 'cdk:cloud-assembly', properties: { directoryName: 'two' } },
        },
      });
    }
    expect(inspectAssembly(path.join(directory, 'first')).stackDependencies).toMatchObject({
      'one/api.template.json': ['one/producer.template.json'],
      'two/api.template.json': ['two/producer.template.json'],
    });
    expect(compareAssemblies(path.join(directory, 'first'), path.join(directory, 'second'))).toEqual([]);
  });

  test('rejects unresolved and cyclic stack dependencies', () => {
    assembly();
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.artifacts.Api.dependencies = ['Missing'];
    json('manifest.json', manifest);
    expect(() => inspectAssembly(directory)).toThrow(/Unknown dependency/);
    manifest.artifacts.Api.dependencies = ['Api'];
    json('manifest.json', manifest);
    expect(() => inspectAssembly(directory)).toThrow(/Stack dependency cycle/);
  });

  test('does not count a referenced template twice', () => {
    assembly();
    json('api.template.json', {
      Resources: {
        First: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'child.template.json' } },
        Second: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'child.template.json' } },
      },
    });
    expect(inspectAssembly(directory).templates).toHaveLength(2);
  });

  test('allows unrelated external file assets but rejects nested templates outside the assembly', () => {
    assembly();
    json('manifest.json', {
      artifacts: {
        Api: { type: 'aws:cloudformation:stack', properties: { templateFile: 'api.template.json' }, dependencies: ['Assets'] },
        Assets: { type: 'cdk:asset-manifest', properties: { file: 'assets.json' } },
      },
    });
    json('assets.json', {
      files: {
        Unrelated: {
          source: { path: '../outside.json', packaging: 'file' },
          destinations: { Fixture: { objectKey: 'outside.json' } },
        },
      },
    });
    expect(inspectAssembly(directory).templates).toHaveLength(2);
    json('api.template.json', {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://example.com/outside.json' },
        },
      },
    });
    expect(() => inspectAssembly(directory)).toThrow(/escapes/);
  });

  test('preserves absent retention policies without assuming a resource-specific default', () => {
    assembly();
    json('api.template.json', { Resources: { Database: { Type: 'AWS::RDS::DBCluster' } } });
    expect(inspectAssembly(directory).templates[0].inventory[0]).toMatchObject({
      deletionPolicy: null, updateReplacePolicy: null,
    });
  });

  test.each([
    ['missing local metadata', { Type: 'AWS::CloudFormation::Stack' }, /Missing local/],
    ['escaping path', { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': '../outside.json' } }, /escapes/],
    ['cycle', { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'api.template.json' } }, /cycle/],
    ['missing type', {}, /Missing resource type/],
    ['invalid resource', null, /Expected object/],
  ])('fails closed for %s', (_name, resource, message) => {
    assembly();
    json('api.template.json', { Resources: { Broken: resource } });
    expect(() => inspectAssembly(directory)).toThrow(message);
  });

  test.each([
    ['empty assembly', { artifacts: {} }, /No stack templates/],
    ['invalid dependencies', {
      artifacts: {
        Api: {
          type: 'aws:cloudformation:stack', properties: { templateFile: 'api.template.json' }, dependencies: [1],
        },
      },
    }, /Invalid dependencies/],
    ['invalid metadata', { artifacts: { Api: { metadata: { '/Api': {} } } } }, /Expected metadata array/],
  ])('rejects %s', (_name, manifest, message) => {
    assembly();
    json('manifest.json', manifest);
    expect(() => inspectAssembly(directory)).toThrow(message);
  });

  test('JSON equality ignores object order but retains arrays and all meaningful values', () => {
    expect(canonicalJson({ b: [true, null, 1], a: 'x' })).toBe(canonicalJson({ a: 'x', b: [true, null, 1] }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test('compares nested templates, preserves timestamp differences, and escapes JSON pointers', () => {
    assembly('first/');
    assembly('second/');
    json('first/child.template.json', {
      Resources: {
        Table: { Type: 'AWS::DynamoDB::Table', Properties: { 'a/b~c': { timestamp: 'first' } } },
      },
    });
    json('second/child.template.json', {
      Resources: {
        Table: { Properties: { 'a/b~c': { timestamp: 'second' } }, Type: 'AWS::DynamoDB::Table' },
      },
    });
    expect(compareAssemblies(path.join(directory, 'first'), path.join(directory, 'second'))).toEqual([{
      kind: 'template',
      file: 'child.template.json',
      paths: ['/Resources/Table/Properties/a~1b~0c/timestamp'],
      totalDifferences: 1,
    }]);
  });

  test('reports removed templates and bounds diagnostics without losing the difference count', () => {
    assembly('first/');
    assembly('second/');
    json('second/api.template.json', { Resources: {}, Description: 'changed' });
    const first = path.join(directory, 'first');
    const second = path.join(directory, 'second');
    expect(compareAssemblies(first, second)).toContainEqual({
      kind: 'template', file: 'child.template.json', paths: ['/'], totalDifferences: 1,
    });
    json('first/api.template.json', { Resources: {}, ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, i])) });
    json('second/api.template.json', { Resources: {}, ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, i + 1])) });
    expect(compareAssemblies(first, second)[0]).toMatchObject({ totalDifferences: 120 });
    expect(compareAssemblies(first, second)[0].paths).toHaveLength(100);
  });

  test('formatting changes do not become semantic changes', () => {
    assembly('first/');
    assembly('second/');
    const file = path.join(directory, 'second/api.template.json');
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 4));
    expect(compareAssemblies(path.join(directory, 'first'), path.join(directory, 'second'))).toEqual([]);
  });
});
