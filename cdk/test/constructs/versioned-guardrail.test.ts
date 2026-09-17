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

import * as bedrock from '@aws-cdk/aws-bedrock-alpha';
import { App, CfnOutput, Lazy, Stack, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnGuardrail } from 'aws-cdk-lib/aws-bedrock';
import { GuardrailVersionBinding, parseGuardrailVersionBinding, VersionedGuardrail } from '../../src/constructs/versioned-guardrail';

const HASH_METADATA = 'abca:guardrail-configuration-sha256';

interface FixtureOptions {
  legacy?: boolean;
  tokenCount?: number;
  strength?: bedrock.ContentFilterStrength;
  versionDescription?: string;
  existingVersion?: GuardrailVersionBinding;
  mutate?: (guardrail: bedrock.Guardrail) => void;
}

function nativeGuardrail(guardrail: bedrock.Guardrail): CfnGuardrail {
  const resources = guardrail.node.children.filter((child): child is CfnGuardrail => child instanceof CfnGuardrail);
  expect(resources).toHaveLength(1);
  return resources[0];
}

function synthesize(options: FixtureOptions = {}) {
  // Allocate unrelated tokens without changing the resulting template.
  for (let i = 0; i < (options.tokenCount ?? 0); i++) Lazy.string({ produce: () => 'unrelated' });
  const app = new App({ autoSynth: false });
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const props: bedrock.GuardrailProps = {
    guardrailName: 'fixture-input',
    description: 'Fixture guardrail',
    contentFilters: [{
      type: bedrock.ContentFilterType.PROMPT_ATTACK,
      inputStrength: options.strength ?? bedrock.ContentFilterStrength.MEDIUM,
      outputStrength: bedrock.ContentFilterStrength.NONE,
    }],
  };
  const guardrail = options.legacy
    ? new bedrock.Guardrail(stack, 'InputGuardrail', props)
    : new VersionedGuardrail(stack, 'InputGuardrail', { ...props, existingVersion: options.existingVersion });
  guardrail.createVersion(options.versionDescription ?? 'Initial version');
  options.mutate?.(guardrail);
  new CfnOutput(stack, 'PublishedVersion', { value: guardrail.guardrailVersion });
  const template = Template.fromStack(stack);
  const versions = Object.entries(template.findResources('AWS::Bedrock::GuardrailVersion'));
  expect(versions).toHaveLength(1);
  const [logicalId, version] = versions[0];
  return { template: template.toJSON(), logicalId, version, hash: version.Metadata?.[HASH_METADATA] as string | undefined };
}

describe('configuration-based guardrail versions', () => {
  let baseline: ReturnType<typeof synthesize>;
  beforeAll(() => { baseline = synthesize(); });

  test('keeps the version and consumer reference stable across unrelated token allocation', () => {
    const other = synthesize({ tokenCount: 25 });
    expect(other.logicalId).toBe(baseline.logicalId);
    expect(other.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(other.template).toEqual(baseline.template);
  });

  test('publishes a new version for a changed policy and updates consumers', () => {
    const changed = synthesize({ strength: bedrock.ContentFilterStrength.HIGH });
    expect(changed.logicalId).not.toBe(baseline.logicalId);
    expect(changed.hash).not.toBe(baseline.hash);
    expect(changed.template.Outputs.PublishedVersion.Value).toEqual({ 'Fn::GetAtt': [changed.logicalId, 'Version'] });
  });

  test('includes policy additions made after createVersion and their removal', () => {
    const changed = synthesize({ mutate: guardrail => guardrail.addWordFilter({ text: 'forbidden-word' }) });
    expect(changed.logicalId).not.toBe(baseline.logicalId);
    expect(synthesize().logicalId).toBe(baseline.logicalId);
  });

  test('hashes escape-hatch property overrides too', () => {
    const changed = synthesize({
      mutate: guardrail => nativeGuardrail(guardrail).addPropertyOverride('BlockedInputMessaging', 'Changed response'),
    });
    expect(changed.logicalId).not.toBe(baseline.logicalId);
    expect(changed.hash).not.toBe(baseline.hash);
  });

  test('ignores property insertion order and deployment tags', () => {
    const reordered = synthesize({
      mutate: guardrail => {
        const resource = nativeGuardrail(guardrail);
        const original = Object.values(baseline.template.Resources)
          .find((entry: any) => entry.Type === 'AWS::Bedrock::Guardrail') as any;
        resource.addPropertyOverride('ContentPolicyConfig',
          Object.fromEntries(Object.entries(original.Properties.ContentPolicyConfig).reverse()));
        Tags.of(guardrail).add('github:run-id', 'another-run');
      },
    });
    const configuration = (template: any) => Object.fromEntries(Object.entries(
      (Object.values(template.Resources).find((entry: any) => entry.Type === 'AWS::Bedrock::Guardrail') as any).Properties,
    ).filter(([key]) => key !== 'Tags'));
    expect(configuration(reordered.template)).toEqual(configuration(baseline.template));
    expect(reordered.logicalId).toBe(baseline.logicalId);
    expect(reordered.hash).toBe(baseline.hash);
  });

  test('retains published versions and waits for the guardrail configuration', () => {
    expect(baseline.version.DeletionPolicy).toBe('Retain');
    expect(baseline.version.UpdateReplacePolicy).toBe('Retain');
    const guardrailIds = Object.entries(baseline.template.Resources)
      .filter(([, resource]: [string, any]) => resource.Type === 'AWS::Bedrock::Guardrail').map(([id]) => id);
    expect(baseline.version.DependsOn).toEqual(guardrailIds);
  });

  test('preserves an explicitly mapped legacy version and its consumer reference', () => {
    const legacy = synthesize({ legacy: true });
    const normalized = synthesize({
      tokenCount: 10,
      existingVersion: { logicalId: legacy.logicalId, configurationHash: baseline.hash! },
    });
    expect(normalized.logicalId).toBe(legacy.logicalId);
    expect(normalized.version.Properties).toEqual(legacy.version.Properties);
    expect(normalized.template.Outputs).toEqual(legacy.template.Outputs);
    expect(normalized.version.DeletionPolicy).toBe('Retain');
    const guardrails = (template: any) => Object.fromEntries(Object.entries(template.Resources)
      .filter(([, resource]: [string, any]) => resource.Type === 'AWS::Bedrock::Guardrail'));
    expect(guardrails(normalized.template)).toEqual(guardrails(legacy.template));
  });

  test('refuses a legacy binding for a different configuration', () => {
    expect(() => synthesize({
      strength: bedrock.ContentFilterStrength.HIGH,
      existingVersion: { logicalId: 'ExistingVersion', configurationHash: baseline.hash! },
    })).toThrow(/guardrailVersionMigration configuration mismatch/);
  });

  test('treats a version description change as a release and rejects it during migration', () => {
    const changed = synthesize({ versionDescription: 'Updated description' });
    expect(changed.logicalId).not.toBe(baseline.logicalId);
    expect(() => synthesize({
      versionDescription: 'Updated description',
      existingVersion: { logicalId: 'ExistingVersion', configurationHash: baseline.hash! },
    })).toThrow(/guardrailVersionMigration configuration mismatch/);
  });

  test('rejects publishing a second version from the same construct', () => {
    expect(() => synthesize({ mutate: guardrail => guardrail.createVersion('another') }))
      .toThrow(/one version per synthesis/);
  });
});

describe('guardrail version migration context', () => {
  const binding = { logicalId: 'ExistingVersion123', configurationHash: 'a'.repeat(64) };

  test('accepts a validated object or CLI JSON string', () => {
    expect(parseGuardrailVersionBinding(binding)).toEqual(binding);
    expect(parseGuardrailVersionBinding(JSON.stringify(binding))).toEqual(binding);
    expect(parseGuardrailVersionBinding(undefined)).toBeUndefined();
  });

  test.each([
    null, [], false, 'not-json', {},
    { ...binding, logicalId: 'not-a-logical-id' },
    { ...binding, logicalId: '1WrongStart' },
    { ...binding, configurationHash: 'short' },
    { ...binding, configurationHash: 'A'.repeat(64) },
    { ...binding, extra: true },
  ])('rejects malformed or incomplete binding %p', value => {
    expect(() => parseGuardrailVersionBinding(value)).toThrow(/guardrailVersionMigration/);
  });
});
