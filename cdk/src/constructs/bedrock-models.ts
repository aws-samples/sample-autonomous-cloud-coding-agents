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

import { CrossRegionInferenceProfileRegion } from '@aws-cdk/aws-bedrock-alpha';
import { Node } from 'constructs';
import {
  BEDROCK_GEO_REGIONS as GEO_REGIONS,
  DEFAULT_BEDROCK_MODEL_IDS as MODEL_IDS,
} from '../handlers/shared/bedrock-model-constants';

export {
  BEDROCK_GEO_REGIONS,
  DEFAULT_BEDROCK_MODEL_IDS,
  PLATFORM_DEFAULT_AUX_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  geoPrefixOf,
  inferenceProfileId,
} from '../handlers/shared/bedrock-model-constants';

/** CDK context key whose value (a string array) overrides the model set. */
export const BEDROCK_MODELS_CONTEXT_KEY = 'bedrockModels';

/** CDK context key selecting the cross-Region inference-profile geography. */
export const BEDROCK_GEO_REGION_CONTEXT_KEY = 'bedrockGeoRegion';

/**
 * Default inference-profile geography: the US cross-Region profiles
 * (`us.anthropic.…`).
 */
export const DEFAULT_BEDROCK_GEO_REGION = CrossRegionInferenceProfileRegion.US;

const GEO_REGION_ENUM_VALUES: readonly CrossRegionInferenceProfileRegion[] =
  Object.values(CrossRegionInferenceProfileRegion);

const GEO_ALTERNATION = [...GEO_REGION_ENUM_VALUES]
  .sort((a, b) => b.length - a.length)
  .join('|');

const GEO_PREFIX_RE = new RegExp(`^(?:${GEO_ALTERNATION})\\.`);

/**
 * Resolves the cross-Region inference-profile geography: CDK context
 * `bedrockGeoRegion` when provided, else {@link DEFAULT_BEDROCK_GEO_REGION}
 * (`us`). Set via `cdk.json` `context` or `-c bedrockGeoRegion=global`.
 *
 * Throws at synth on an unrecognized value.
 */
export function resolveBedrockGeoRegion(node: Node): CrossRegionInferenceProfileRegion {
  const override = node.tryGetContext(BEDROCK_GEO_REGION_CONTEXT_KEY);
  if (override === undefined || override === null) {
    return DEFAULT_BEDROCK_GEO_REGION;
  }
  if (typeof override !== 'string' || !GEO_REGIONS.includes(override as CrossRegionInferenceProfileRegion)) {
    throw new Error(
      `Context '${BEDROCK_GEO_REGION_CONTEXT_KEY}' must be one of `
      + `${GEO_REGIONS.map((g) => `'${g}'`).join(', ')}; got ${JSON.stringify(override)}.`,
    );
  }
  return override as CrossRegionInferenceProfileRegion;
}

/**
 * Resolves the invocable foundation-model IDs: CDK context `bedrockModels`
 * (an array of **bare foundation-model IDs**) when provided, else
 * {@link DEFAULT_BEDROCK_MODEL_IDS}. Set via `cdk.json` `context` or
 * `-c bedrockModels='["anthropic.claude-opus-4-8", …]'`.
 *
 * Throws on a malformed override (non-array, non-string / empty entries, or a
 * geo-prefixed ID).
 */
export function resolveBedrockModelIds(node: Node): readonly string[] {
  const raw = node.tryGetContext(BEDROCK_MODELS_CONTEXT_KEY);
  if (raw === undefined || raw === null) {
    return MODEL_IDS;
  }
  // The CDK CLI's `-c key=value` delivers a raw string where `cdk.json` delivers an array.
  let override: unknown = raw;
  if (typeof raw === 'string') {
    try {
      override = JSON.parse(raw);
    } catch {
      override = raw;
    }
  }
  if (!Array.isArray(override) || override.length === 0) {
    throw new Error(
      `Context '${BEDROCK_MODELS_CONTEXT_KEY}' must be a non-empty array of foundation-model IDs `
      + `(e.g. ["anthropic.claude-sonnet-4-6"]); got ${JSON.stringify(override)}.`,
    );
  }
  for (const id of override) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(
        `Context '${BEDROCK_MODELS_CONTEXT_KEY}' entries must be non-empty strings; got ${JSON.stringify(id)}.`,
      );
    }
    if (GEO_PREFIX_RE.test(id)) {
      throw new Error(
        `Context '${BEDROCK_MODELS_CONTEXT_KEY}' expects bare foundation-model IDs, not geo-prefixed `
        + `inference-profile IDs — got '${id}'. Use '${id.replace(GEO_PREFIX_RE, '')}'; `
        + `the inference-profile ARN is derived automatically from the '${BEDROCK_GEO_REGION_CONTEXT_KEY}' `
        + 'context key (default \'us\').',
      );
    }
    if (id.includes('*') || id.includes('?')) {
      throw new Error(
        `Context '${BEDROCK_MODELS_CONTEXT_KEY}' entries must be literal foundation-model IDs, not `
        + `patterns — got '${id}'. These IDs form the resource half of the Bedrock IAM grant, so a `
        + 'wildcard would grant every inference profile in the account. List each model explicitly.',
      );
    }
  }

  return override as string[];
}
