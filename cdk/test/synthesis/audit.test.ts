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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { inspectAssembly } from '../../src/synthesis/assembly';
import { auditProfile, Budgets, WorkerResult } from '../../src/synthesis/audit';
import { synthesisProfiles } from '../../src/synthesis/profiles';

describe('profile acceptance rules', () => {
  let directory: string;
  const profile = synthesisProfiles()[0];
  const rejected = {
    ...profile,
    name: 'invalid-compute',
    context: { ...profile.context, compute_type: 'unsupported' },
    expectedError: 'compute_type must be agentcore, ecs or lambda-microvm',
  };
  const budgets: Budgets = { resources: 500, bytes: 800_000, parameters: 200, outputs: 200 };
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'profile-audit-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  const retained = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
  function synthesize(target: string, padding = '', template: object = { Resources: { Bucket: { Type: 'AWS::S3::Bucket', ...retained } } }): WorkerResult {
    mkdirSync(target);
    writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
      artifacts: { Api: { type: 'aws:cloudformation:stack', properties: { templateFile: 'api.template.json' } } },
    }));
    writeFileSync(path.join(target, 'api.template.json'), `${JSON.stringify(template)}${padding}`);
    return { kind: 'synthesized', census: inspectAssembly(target) };
  }

  test('accepts two unchanged independent assemblies', () => {
    const worker = jest.fn((_profile, target: string) => synthesize(target));
    const audit = auditProfile(profile, path.join(directory, 'first'), budgets, true, worker);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(audit.failures).toEqual([]);
    expect(audit.differences).toEqual([]);
  });

  test('checks repeat byte limits even if only JSON whitespace changed', () => {
    let calls = 0;
    const worker = jest.fn((_profile, target: string) => synthesize(target, calls++ ? ' '.repeat(1000) : ''));
    const audit = auditProfile(profile, path.join(directory, 'first'), { ...budgets, bytes: 128 }, true, worker);
    expect(audit.differences).toEqual([]);
    expect(audit.failures).toEqual([expect.stringMatching(/^Repeat: api.template.json: \d+ bytes exceeds 128$/)]);
  });

  test('enforces resource, byte, parameter, and output limits', () => {
    const worker = (_profile: unknown, target: string) => synthesize(target, '', {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', ...retained }, Queue: { Type: 'AWS::SQS::Queue', ...retained } },
      Parameters: { A: { Type: 'String' }, B: { Type: 'String' } },
      Outputs: { A: { Value: 'a' }, B: { Value: 'b' } },
    });
    const audit = auditProfile(profile, path.join(directory, 'first'), { resources: 1, bytes: 1, parameters: 1, outputs: 1 }, false, worker);
    expect(audit.failures).toHaveLength(4);
    for (const metric of ['resources', 'bytes', 'parameters', 'outputs']) {
      expect(audit.failures).toContainEqual(expect.stringContaining(`${metric} exceeds 1`));
    }
  });

  test('checks expected rejection in both processes when stability is requested', () => {
    const worker = jest.fn((): WorkerResult => ({ kind: 'rejected', error: `${rejected.expectedError} fixture reason` }));
    const audit = auditProfile(rejected, directory, budgets, true, worker);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(audit.first?.kind).toBe('rejected');
    expect(audit.second?.kind).toBe('rejected');
    expect(audit.failures).toEqual([]);
  });

  test('does not mistake an unrelated repeat failure for the expected guard', () => {
    const worker = jest.fn<WorkerResult, []>()
      .mockReturnValueOnce({ kind: 'rejected', error: `${rejected.expectedError} fixture reason` })
      .mockReturnValueOnce({ kind: 'rejected', error: 'unrelated synthesis failure' });
    expect(auditProfile(rejected, directory, budgets, true, worker).failures).toEqual(['Repeat: unrelated synthesis failure']);
  });

  test('fails if an invalid profile unexpectedly synthesizes', () => {
    const worker = (_profile: unknown, target: string) => synthesize(target);
    const audit = auditProfile(rejected, path.join(directory, 'first'), budgets, false, worker);
    expect(audit.failures).toEqual([expect.stringContaining('Expected rejection was not raised')]);
  });

  test('retains completed evidence when a repeat worker fails', () => {
    const worker = jest.fn((_profile, target: string) => synthesize(target))
      .mockImplementationOnce((_profile, target: string) => synthesize(target))
      .mockImplementationOnce(() => { throw new Error('worker timeout'); });
    const audit = auditProfile(profile, path.join(directory, 'first'), budgets, true, worker);
    expect(audit.first?.kind).toBe('synthesized');
    expect(audit.second).toBeUndefined();
    expect(audit.failures).toEqual(['worker timeout']);
  });

  test('rejects unprotected data and cleanup providers in nested templates', () => {
    const worker = (_profile: unknown, target: string): WorkerResult => {
      synthesize(target);
      writeFileSync(path.join(target, 'child.template.json'), JSON.stringify({
        Resources: {
          Data: { Type: 'AWS::DynamoDB::Table', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Delete' },
          Bucket: { Type: 'AWS::S3::Bucket', ...retained },
          Cleanup: { Type: 'Custom::S3AutoDeleteObjects' },
        },
      }));
      writeFileSync(path.join(target, 'api.template.json'), JSON.stringify({
        Resources: {
          Child: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'child.template.json' } },
        },
      }));
      return { kind: 'synthesized', census: inspectAssembly(target) };
    };
    const audit = auditProfile(profile, path.join(directory, 'first'), budgets, true, worker);
    expect(audit.failures).toEqual([
      expect.stringContaining('child.template.json/Data: AWS::DynamoDB::Table requires'),
      expect.stringContaining('child.template.json/Cleanup: Custom::S3AutoDeleteObjects requires'),
      expect.stringContaining('Repeat: child.template.json/Data:'),
      expect.stringContaining('Repeat: child.template.json/Cleanup:'),
    ]);
  });

  test('carries unresolved-context diagnostics into profile failure', () => {
    const worker = (_profile: unknown, target: string): WorkerResult => {
      const result = synthesize(target);
      if (result.kind !== 'synthesized') throw new Error('fixture must synthesize');
      return { kind: 'synthesized', census: { ...result.census, errors: ['Unresolved CDK context: fixture'] } };
    };
    expect(auditProfile(profile, path.join(directory, 'first'), budgets, false, worker).failures)
      .toEqual(['Unresolved CDK context: fixture']);
  });
});
