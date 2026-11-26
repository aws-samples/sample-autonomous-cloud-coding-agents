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

const DEFAULT_HAIKU_MODEL_ID = 'anthropic.claude-haiku-5-5';

/**
 * The bare Bedrock foundation-model IDs the agent runtime may invoke. Every grant
 * site derives its IAM ARNs from this list. Every entry must have a live
 * cross-Region inference profile.
 */
export const DEFAULT_BEDROCK_MODEL_IDS: readonly string[] = [
  // Previous-generation models stay granted after a default bump: a blueprint may pin any of them (#744, #953).
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  // Bedrock refuses the bare ID of these two for on-demand invocation: only an inference profile is invocable (#953).
  'anthropic.claude-opus-5-5',
  DEFAULT_HAIKU_MODEL_ID,
];

/**
 * The bare model ids the platform itself defaults to, as opposed to the full grant
 * list: what a task uses when it pins nothing.
 */
export const PLATFORM_DEFAULT_MODEL_ID = 'anthropic.claude-opus-5-5';
export const PLATFORM_DEFAULT_AUX_MODEL_ID = DEFAULT_HAIKU_MODEL_ID;

/**
 * Every cross-Region inference-profile geography, mirroring
 * `CrossRegionInferenceProfileRegion` in `@aws-cdk/aws-bedrock-alpha`.
 */
export const BEDROCK_GEO_REGIONS: readonly string[] = [
  'us', 'us-gov', 'eu', 'apac', 'global', 'jp', 'au',
];

/**
 * The `<geo>.` prefix on a model id, or undefined for a bare foundation-model id.
 *
 * Matches `<geo>` followed by a literal `.`, so `us` cannot claim `us-gov.…`, and a
 * vendor name that merely starts with a geography word (`august-labs.…`) is not a
 * prefix.
 */
export function geoPrefixOf(modelId: string): string | undefined {
  return BEDROCK_GEO_REGIONS.find((geo) => modelId.startsWith(`${geo}.`));
}

/**
 * The geo-prefixed inference-profile id for a bare model id, in the geography a
 * deploy grants. The single place that prefix is applied.
 *
 * Throws when `geoRegion` is not in {@link BEDROCK_GEO_REGIONS}, or when
 * `bareModelId` already carries a geography prefix.
 */
export function inferenceProfileId(geoRegion: string, bareModelId: string): string {
  if (!BEDROCK_GEO_REGIONS.includes(geoRegion)) {
    throw new Error(
      `inferenceProfileId: '${geoRegion}' is not an inference-profile geography `
      + `(one of ${BEDROCK_GEO_REGIONS.join(', ')}).`,
    );
  }
  if (geoPrefixOf(bareModelId) !== undefined) {
    throw new Error(
      `inferenceProfileId: expected a bare foundation-model id, but '${bareModelId}' `
      + 'already carries a geography prefix.',
    );
  }
  return `${geoRegion}.${bareModelId}`;
}
