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
  resolveBedrockGeoRegion,
  resolveBedrockModelIds,
} from '../../src/constructs/bedrock-models';

function nodeWithContext(context?: Record<string, unknown>) {
  const app = new App({ context });
  return new Stack(app, 'TestStack').node;
}

/**
 * The bundle boundary, asserted.
 *
 * `BEDROCK_GEO_REGIONS` is now a hand-written literal in the dependency-free
 * `handlers/shared/bedrock-model-constants.ts` rather than
 * `Object.values(CrossRegionInferenceProfileRegion)`. That was not a style choice:
 * reading the alpha enum is a RUNTIME use of a module that top-level `require`s
 * `aws-cdk-lib`, so when `handlers/shared/workflows.ts` imported the list from the
 * construct layer, esbuild put the entire CDK into every Lambda reaching that file
 * — measured at 6.8 KB → 57 MB with 9,679 `aws-cdk-lib` references, on the
 * orchestrator, create-task, webhook create-task, three channel webhook processors
 * and the reconcilers. `aws-cdk-lib` is in no construct's `externalModules`, so
 * nothing downstream strips it.
 *
 * The cost of a literal is drift, and this is the test that pays it: a CDK release
 * adding a geography fails HERE, loudly, instead of silently leaving the literal
 * one short — which would make `resolveBedrockGeoRegion` accept a geography the
 * workflow allow-list rejects.
 */
describe('the geography literal stays in step with the CDK enum', () => {
  it('equals Object.values(CrossRegionInferenceProfileRegion), as a set', () => {
    expect([...BEDROCK_GEO_REGIONS].sort())
      .toEqual(Object.values(CrossRegionInferenceProfileRegion).sort());
  });

  it('is the same LENGTH, so neither side has a stray or duplicate entry', () => {
    // Set equality above would pass if one side repeated a value.
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
    // CDK delivers `-c bedrockModels=[...]` as a raw string, not a parsed array;
    // the documented `-c` form must work identically to the file/array form.
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
    // Guards the us.us.… double-prefix footgun: both grant sites derive the
    // inference-profile ARN by prefixing the geo, so the context wants the bare id.
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['us.anthropic.claude-opus-4-8'] })),
    ).toThrow(/bare foundation-model IDs/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['eu.anthropic.claude-sonnet-4-6'] })),
    ).toThrow(/bare foundation-model IDs/);
  });

  // The guard used to test only /^(us|eu|apac)\./, so a `global.`-, `us-gov.`-,
  // `jp.`- or `au.`-prefixed entry sailed through and produced a syntactically
  // valid but non-existent `us.global.anthropic.…` inference-profile ARN — the
  // grant then authorized nothing and the agent failed at turn 0 with
  // AccessDenied, with nothing at synth to say why. Every geography the CDK enum
  // models must be rejected, so the hole cannot reopen when a geography is added.
  it.each([...BEDROCK_GEO_REGIONS])('throws on a %s-prefixed entry (no silent double-prefix)', (geo) => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [`${geo}.anthropic.claude-opus-5`] })),
    ).toThrow(/bare foundation-model IDs/);
  });

  // These entries become the RESOURCE half of the Bedrock IAM grant, so a `*` is
  // not a malformed model name — it is a working wildcard. `bedrockModels: ['*']`
  // synthed clean and produced `inference-profile/global.*`, i.e. every profile in
  // the account, which is the `Resource: '*'` grant the per-model scoping exists to
  // avoid, arrived at through a context value rather than a reviewable policy edit.
  it.each(['*', 'anthropic.*', 'anthropic.claude-opus-?', '*.anthropic.claude-opus-5'])(
    'throws on the pattern entry %p rather than granting it as a resource wildcard',
    (pattern) => {
      expect(() =>
        resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [pattern] })),
      ).toThrow(/literal foundation-model IDs, not patterns/);
    },
  );

  it('says WHY a pattern is refused, not just that it is', () => {
    // An operator reading "invalid id" would reasonably retry with a different
    // pattern. The message has to name the consequence — the grant is what widens.
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['*'] })),
    ).toThrow(/grant every inference profile in the account/);
  });

  it('still accepts every shipped default (the guard is not over-broad)', () => {
    // `?` and `*` are the only rejected characters, and no real model id contains
    // them — but `:` and `.` and digits abound, so assert the default list survives.
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [...DEFAULT_BEDROCK_MODEL_IDS] })),
    ).not.toThrow();
  });

  it('names the bare id and the geo context key in the rejection message', () => {
    // The error is the only place the bare-ids-only contract is stated at the
    // moment an operator gets it wrong, so it must carry the fix, not just the
    // complaint: strip the geo the operator actually typed (`us-gov`, not `us`,
    // for a `us-gov.` entry) and point at where geo really belongs.
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['us-gov.anthropic.claude-opus-5'] })),
    ).toThrow(/Use 'anthropic\.claude-opus-5'/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['global.anthropic.claude-opus-5'] })),
    ).toThrow(new RegExp(BEDROCK_GEO_REGION_CONTEXT_KEY));
  });

  it('still accepts a bare id whose name merely starts with a geo word', () => {
    // The rejection keys on the `<geo>.` separator, not a bare prefix match, so a
    // hypothetical `august.…`/`european.…` model id is not collateral damage.
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
    // Derived from the enum rather than hand-listed: a CDK release that adds a
    // geography must widen the allow-list automatically, and one that REMOVES a
    // geography must not leave us granting an ARN the SDK no longer builds.
    expect([...BEDROCK_GEO_REGIONS].sort())
      .toEqual(['apac', 'au', 'eu', 'global', 'jp', 'us', 'us-gov']);
  });

  it('throws at synth on an unknown geography rather than granting an invalid ARN', () => {
    // A typo'd geo yields a well-formed but non-existent inference-profile ARN.
    // The grant would be accepted by IAM and authorize nothing, so the failure
    // would surface as a turn-0 AccessDenied on a deployed stack instead of here.
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

/**
 * Drift guard: the agent picks a fallback model when a repo pins none, and the
 * IAM grant that lets it invoke that model is derived from
 * DEFAULT_BEDROCK_MODEL_IDS. If the two disagree, every task on the stack fails
 * at turn 0 with AccessDenied — and nothing else in the suite notices, because
 * the agent-side default and the CDK-side grant live in different languages.
 */
describe('DEFAULT_BEDROCK_MODEL_IDS covers the agent runtime default', () => {
  it('grants the fallback model the agent falls back to', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../agent/src/config.py'), 'utf8',
    );
    // The fallback is the second argument to the ANTHROPIC_MODEL env lookup.
    const match = configPy.match(/"ANTHROPIC_MODEL",\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const agentDefault = match![1];

    // The agent names a cross-Region inference profile (`<geo>.anthropic.…`); the
    // grant list holds bare foundation-model IDs and both grant sites add the geo
    // prefix from `bedrockGeoRegion`. Accept any geography the CDK enum models —
    // deliberately NOT `.*`: the assertion's teeth are that a BARE id here is a
    // bug, because Bedrock refuses a bare Claude 4.x/5 id for on-demand
    // invocation ("ValidationException: … on-demand throughput isn't supported").
    // Widening to `.*` would let that un-invokable default land unnoticed.
    const geoPrefix = agentDefault.match(new RegExp(`^(${[...BEDROCK_GEO_REGIONS].join('|')})\\.`));
    expect(geoPrefix).not.toBeNull();
    const bare = agentDefault.slice(geoPrefix![0].length);
    expect(DEFAULT_BEDROCK_MODEL_IDS).toContain(bare);
  });

  it('rejects a bare foundation-model id as the agent default', () => {
    // Mutation-proof for the assertion above: if someone "simplifies" the geo
    // regex to `.*`, or drops it, this test is what still fails. Exercises the
    // same matcher against the shape the guard exists to catch.
    const bareDefault = 'anthropic.claude-opus-4-8';
    expect(bareDefault.match(new RegExp(`^(${[...BEDROCK_GEO_REGIONS].join('|')})\\.`))).toBeNull();
  });
});

describe('the shipped cdk.json geography', () => {
  it('is a value resolveBedrockGeoRegion accepts, and is what tests claim it is', () => {
    // Nothing read cdk.json, so the suite exercised the CODE default (`us`) while every
    // deployment shipped `global`. Deleting the context block, or setting it to a
    // different geography, survived the whole suite — the value the thesis rests on was
    // unguarded.
    const cdkJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../cdk.json'), 'utf8'),
    ) as { context?: Record<string, unknown> };
    const shipped = cdkJson.context?.[BEDROCK_GEO_REGION_CONTEXT_KEY];
    expect(typeof shipped).toBe('string');
    // Must be resolvable — a typo here fails every deploy at synth, but only if
    // something checks.
    expect(() => resolveBedrockGeoRegion(
      nodeWithContext({ [BEDROCK_GEO_REGION_CONTEXT_KEY]: shipped }),
    )).not.toThrow();
    // Pinned deliberately: this is a deploy-affecting default with data-residency
    // implications, so changing it should require changing a test that says so.
    expect(shipped).toBe('global');
  });
});
