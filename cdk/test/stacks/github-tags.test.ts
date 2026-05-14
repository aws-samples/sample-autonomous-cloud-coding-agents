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

import { App, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../../src/stacks/agent';

const GITHUB_TAG_KEYS = [
  'github:sha',
  'github:ref',
  'github:ref-type',
  'github:actor',
  'github:head-ref',
  'github:base-ref',
  'github:pr-number',
  'github:run-id',
  'github:run-attempt',
  'github:event',
  'github:workflow',
  'github:repository',
  'github:clean',
] as const;

function synthWithTags(context: Record<string, string> = {}): Template {
  const app = new App({ context });
  const stackName = app.node.tryGetContext('stackName') ?? 'backgroundagent-dev';
  const stack = new AgentStack(app, stackName, {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const githubTagKeys = [
    'sha', 'ref', 'ref-type', 'actor', 'head-ref',
    'base-ref', 'pr-number', 'run-id', 'run-attempt',
    'event', 'workflow', 'repository', 'clean',
  ] as const;

  for (const key of githubTagKeys) {
    const value = app.node.tryGetContext(`github:${key}`);
    Tags.of(stack).add(`github:${key}`, value || 'none');
  }

  return Template.fromStack(stack);
}

describe('github:* resource tags', () => {
  let templateWithDefaults: Template;
  let templateWithValues: Template;

  beforeAll(() => {
    templateWithDefaults = synthWithTags();
    templateWithValues = synthWithTags({
      'github:sha': 'f36d352c5a1bc3a90d3e60e30e2f9d4345426724',
      'github:ref': 'main',
      'github:ref-type': 'branch',
      'github:actor': 'scottschreckengaust',
      'github:head-ref': '',
      'github:base-ref': 'main',
      'github:pr-number': '85',
      'github:run-id': '12345678',
      'github:run-attempt': '1',
      'github:event': 'push',
      'github:workflow': 'deploy.yml',
      'github:repository': 'aws-samples/sample-autonomous-cloud-coding-agents',
      'github:clean': 'true',
    });
  });

  test('all 13 github:* tags default to "none" when no context is provided', () => {
    const resources = templateWithDefaults.findResources('AWS::DynamoDB::Table');
    const firstResource = Object.values(resources)[0];
    const tags: Array<{ Key: string; Value: string }> = firstResource?.Properties?.Tags ?? [];

    for (const tagKey of GITHUB_TAG_KEYS) {
      const tag = tags.find(t => t.Key === tagKey);
      expect(tag).toBeDefined();
      expect(tag!.Value).toBe('none');
    }
  });

  test('github:* tags reflect context values when provided', () => {
    const resources = templateWithValues.findResources('AWS::DynamoDB::Table');
    const firstResource = Object.values(resources)[0];
    const tags: Array<{ Key: string; Value: string }> = firstResource?.Properties?.Tags ?? [];

    expect(tags.find(t => t.Key === 'github:sha')!.Value).toBe('f36d352c5a1bc3a90d3e60e30e2f9d4345426724');
    expect(tags.find(t => t.Key === 'github:ref')!.Value).toBe('main');
    expect(tags.find(t => t.Key === 'github:ref-type')!.Value).toBe('branch');
    expect(tags.find(t => t.Key === 'github:actor')!.Value).toBe('scottschreckengaust');
    expect(tags.find(t => t.Key === 'github:head-ref')!.Value).toBe('none');
    expect(tags.find(t => t.Key === 'github:base-ref')!.Value).toBe('main');
    expect(tags.find(t => t.Key === 'github:pr-number')!.Value).toBe('85');
    expect(tags.find(t => t.Key === 'github:run-id')!.Value).toBe('12345678');
    expect(tags.find(t => t.Key === 'github:run-attempt')!.Value).toBe('1');
    expect(tags.find(t => t.Key === 'github:event')!.Value).toBe('push');
    expect(tags.find(t => t.Key === 'github:workflow')!.Value).toBe('deploy.yml');
    expect(tags.find(t => t.Key === 'github:repository')!.Value).toBe('aws-samples/sample-autonomous-cloud-coding-agents');
    expect(tags.find(t => t.Key === 'github:clean')!.Value).toBe('true');
  });

  test('empty string context values resolve to "none"', () => {
    const template = synthWithTags({
      'github:sha': '',
      'github:head-ref': '',
    });
    const resources = template.findResources('AWS::DynamoDB::Table');
    const firstResource = Object.values(resources)[0];
    const tags: Array<{ Key: string; Value: string }> = firstResource?.Properties?.Tags ?? [];

    expect(tags.find(t => t.Key === 'github:sha')!.Value).toBe('none');
    expect(tags.find(t => t.Key === 'github:head-ref')!.Value).toBe('none');
  });
});
