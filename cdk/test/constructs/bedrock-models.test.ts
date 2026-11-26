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

import * as fs from 'fs';
import * as path from 'path';
import { CrossRegionInferenceProfileRegion } from '@aws-cdk/aws-bedrock-alpha';
import { App, Stack } from 'aws-cdk-lib';
import {
  BEDROCK_GEO_REGION_CONTEXT_KEY,
  BEDROCK_GEO_REGIONS,
  BEDROCK_MODELS_CONTEXT_KEY,
  DEFAULT_BEDROCK_GEO_REGION,
  DEFAULT_BEDROCK_MODEL_IDS,
  geoPrefixOf,
  inferenceProfileId,
  resolveBedrockGeoRegion,
  resolveBedrockModelIds,
} from '../../src/constructs/bedrock-models';

function nodeWithContext(context?: Record<string, unknown>) {
  const app = new App({ context });
  return new Stack(app, 'TestStack').node;
}

describe('the geography literal stays in step with the CDK enum', () => {
  it('equals Object.values(CrossRegionInferenceProfileRegion), as a set', () => {
    expect([...BEDROCK_GEO_REGIONS].sort())
      .toEqual(Object.values(CrossRegionInferenceProfileRegion).sort());
  });

  it('is the same LENGTH, so neither side has a stray or duplicate entry', () => {
    expect(BEDROCK_GEO_REGIONS).toHaveLength(Object.values(CrossRegionInferenceProfileRegion).length);
    expect(new Set(BEDROCK_GEO_REGIONS).size).toBe(BEDROCK_GEO_REGIONS.length);
  });
});

describe('resolveBedrockModelIds', () => {
  it('returns the default set when no context override is present', () => {
    const ids = resolveBedrockModelIds(nodeWithContext());
    expect(ids).toEqual(DEFAULT_BEDROCK_MODEL_IDS);
  });

  it('returns the context override when provided', () => {
    const override = ['anthropic.claude-opus-4-8', 'anthropic.claude-sonnet-4-6'];
    const ids = resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: override }));
    expect(ids).toEqual(override);
  });

  it('parses a JSON-string override (the `-c key=value` CLI form)', () => {
    const ids = resolveBedrockModelIds(
      nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: '["anthropic.claude-opus-4-8","anthropic.claude-sonnet-4-6"]' }),
    );
    expect(ids).toEqual(['anthropic.claude-opus-4-8', 'anthropic.claude-sonnet-4-6']);
  });

  it('throws on a JSON string that does not parse to an array', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: '"anthropic.claude-sonnet-4-6"' })),
    ).toThrow(/must be a non-empty array/);
  });

  it('throws on a non-array override (typo guard)', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: 'anthropic.claude-opus-4-8' })),
    ).toThrow(/must be a non-empty array/);
  });

  it('throws on an empty-array override', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [] })),
    ).toThrow(/must be a non-empty array/);
  });

  it('throws on a non-string / empty entry', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['anthropic.claude-sonnet-4-6', ''] })),
    ).toThrow(/non-empty strings/);
  });

  it('throws on a geo-prefixed inference-profile ID', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['us.anthropic.claude-opus-4-8'] })),
    ).toThrow(/bare foundation-model IDs/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['eu.anthropic.claude-sonnet-4-6'] })),
    ).toThrow(/bare foundation-model IDs/);
  });

  it.each([...BEDROCK_GEO_REGIONS])('throws on a %s-prefixed entry (no silent double-prefix)', (geo) => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [`${geo}.anthropic.claude-opus-5`] })),
    ).toThrow(/bare foundation-model IDs/);
  });

  it.each(['*', 'anthropic.*', 'anthropic.claude-opus-?', '*.anthropic.claude-opus-5'])(
    'throws on the pattern entry %p rather than granting it as a resource wildcard',
    (pattern) => {
      expect(() =>
        resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [pattern] })),
      ).toThrow(/literal foundation-model IDs, not patterns/);
    },
  );

  it('says WHY a pattern is refused, not just that it is', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['*'] })),
    ).toThrow(/grant every inference profile in the account/);
  });

  it('still accepts every shipped default (the guard is not over-broad)', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [...DEFAULT_BEDROCK_MODEL_IDS] })),
    ).not.toThrow();
  });

  it('names the bare id and the geo context key in the rejection message', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['us-gov.anthropic.claude-opus-5'] })),
    ).toThrow(/Use 'anthropic\.claude-opus-5'/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['global.anthropic.claude-opus-5'] })),
    ).toThrow(new RegExp(BEDROCK_GEO_REGION_CONTEXT_KEY));
  });

  it('still accepts a bare id whose name merely starts with a geo word', () => {
    expect(resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['august-labs.model-1'] })))
      .toEqual(['august-labs.model-1']);
  });
});

describe('resolveBedrockGeoRegion', () => {
  it('defaults to the US geography so an existing deploy is unchanged', () => {
    expect(resolveBedrockGeoRegion(nodeWithContext())).toBe(CrossRegionInferenceProfileRegion.US);
    expect(DEFAULT_BEDROCK_GEO_REGION).toBe(CrossRegionInferenceProfileRegion.US);
  });

  it.each([...BEDROCK_GEO_REGIONS])('accepts the %s geography the CDK enum models', (geo) => {
    expect(resolveBedrockGeoRegion(nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: geo }))).toBe(geo);
  });

  it('covers exactly the geographies @aws-cdk/aws-bedrock-alpha models', () => {
    expect([...BEDROCK_GEO_REGIONS].sort())
      .toEqual(['apac', 'au', 'eu', 'global', 'jp', 'us', 'us-gov']);
  });

  it('throws at synth on an unknown geography rather than granting an invalid ARN', () => {
    expect(() => resolveBedrockGeoRegion(nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: 'usa' })))
      .toThrow(/must be one of/);
    expect(() => resolveBedrockGeoRegion(nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: 'US' })))
      .toThrow(/must be one of/);
    expect(() => resolveBedrockGeoRegion(nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: 'us-east-1' })))
      .toThrow(/must be one of/);
  });

  it('throws on a non-string value', () => {
    expect(() => resolveBedrockGeoRegion(nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: ['us'] })))
      .toThrow(/must be one of/);
  });
});

describe('geoPrefixOf', () => {
  it.each([...BEDROCK_GEO_REGIONS])('recognizes the %s prefix', (geo) => {
    expect(geoPrefixOf(`${geo}.anthropic.claude-opus-5`)).toBe(geo);
  });

  it('returns undefined for a bare id, and for a name that merely starts with a geography word', () => {
    expect(geoPrefixOf('anthropic.claude-opus-5')).toBeUndefined();
    expect(geoPrefixOf('august-labs.model-1')).toBeUndefined();
  });
});

describe('inferenceProfileId', () => {
  it.each([...BEDROCK_GEO_REGIONS])('prefixes a bare model id with the %s geography', (geo) => {
    expect(inferenceProfileId(geo, 'anthropic.claude-opus-5')).toBe(`${geo}.anthropic.claude-opus-5`);
  });

  it('accepts a bare id whose vendor name starts with a geography word', () => {
    expect(inferenceProfileId('au', 'august-labs.model-1')).toBe('au.august-labs.model-1');
  });

  it('throws when the arguments are swapped', () => {
    expect(() => inferenceProfileId('anthropic.claude-opus-5', 'global'))
      .toThrow(/'anthropic\.claude-opus-5' is not an inference-profile geography/);
  });

  it('throws on a geography the platform does not model', () => {
    expect(() => inferenceProfileId('usa', 'anthropic.claude-opus-5'))
      .toThrow(/'usa' is not an inference-profile geography/);
  });

  it.each(['global.anthropic.claude-opus-5', 'us-gov.anthropic.claude-opus-5'])(
    'throws on %s, which already carries a geography prefix',
    (prefixed) => {
      expect(() => inferenceProfileId('global', prefixed)).toThrow(/already carries a geography prefix/);
    },
  );
});

describe('DEFAULT_BEDROCK_MODEL_IDS covers the agent runtime default', () => {
  it('grants the fallback model the agent falls back to', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../agent/src/config.py'), 'utf8',
    );
    const match = configPy.match(/"ANTHROPIC_MODEL",\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const agentDefault = match![1];

    // Bedrock refuses a bare Claude 4.x/5 id for on-demand invocation
    // ("ValidationException: … on-demand throughput isn't supported").
    const geoPrefix = agentDefault.match(new RegExp(`^(${[...BEDROCK_GEO_REGIONS].join('|')})\\.`));
    expect(geoPrefix).not.toBeNull();
    const bare = agentDefault.slice(geoPrefix![0].length);
    expect(DEFAULT_BEDROCK_MODEL_IDS).toContain(bare);
  });

  it('rejects a bare foundation-model id as the agent default', () => {
    const bareDefault = 'anthropic.claude-opus-4-8';
    expect(bareDefault.match(new RegExp(`^(${[...BEDROCK_GEO_REGIONS].join('|')})\\.`))).toBeNull();
  });
});

describe('the shipped cdk.json geography', () => {
  it('is a value resolveBedrockGeoRegion accepts, and is what tests claim it is', () => {
    const cdkJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../cdk.json'), 'utf8'),
    ) as { context?: Record<string, unknown> };
    const shipped = cdkJson.context?.[BEDROCK_GEO_REGION_CONTEXT_KEY];
    expect(typeof shipped).toBe('string');
    expect(() => resolveBedrockGeoRegion(
      nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: shipped }),
    )).not.toThrow();
    expect(shipped).toBe('global');
  });
});
