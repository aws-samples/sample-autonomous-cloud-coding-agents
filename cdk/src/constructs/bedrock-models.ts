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
// Aliased locals: the re-export block below makes these part of this module's public
// API, but a re-export does not bind names in local scope, so the functions here need
// their own import.
import {
  BEDROCK_GEO_REGIONS as GEO_REGIONS,
  DEFAULT_BEDROCK_MODEL_IDS as MODEL_IDS,
} from '../handlers/shared/bedrock-model-constants';

/**
 * The model/geography values themselves live in the RUNTIME-side constants module
 * and are re-exported here, so the many construct-layer importers keep working
 * unchanged.
 *
 * The direction is deliberate and load-bearing. `handlers/shared/workflows.ts` needs
 * the same two lists, and importing them FROM this file dragged `aws-cdk-lib` into
 * every Lambda that reaches it (6.8 KB → 57 MB, 9,679 references) because
 * {@link BEDROCK_GEO_REGIONS} used to be `Object.values()` of an alpha-CDK enum — a
 * runtime read of a module that top-level `require`s the CDK, which esbuild cannot
 * tree-shake. Values live on the dependency-free side; only the enum-typed helpers
 * below stay here.
 */
export {
  BEDROCK_GEO_REGIONS,
  DEFAULT_BEDROCK_MODEL_IDS,
  DEFAULT_HAIKU_MODEL_ID,
  PLATFORM_DEFAULT_AUX_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  inferenceProfileId,
} from '../handlers/shared/bedrock-model-constants';

/** CDK context key whose value (a string array) overrides the model set. */
export const BEDROCK_MODELS_CONTEXT_KEY = 'bedrockModels';

/** CDK context key selecting the cross-Region inference-profile geography. */
export const BEDROCK_GEO_REGION_CONTEXT_KEY = 'bedrockGeoRegion';

/**
 * Default inference-profile geography: the US cross-Region profiles
 * (`us.anthropic.…`). Documented here rather than in `cdk.json` so a deploy that
 * passes no context at all still resolves — `cdk.json` context is not present
 * when the app is synthesized from a test or another CDK app.
 */
export const DEFAULT_BEDROCK_GEO_REGION = CrossRegionInferenceProfileRegion.US;

/**
 * The geographies `@aws-cdk/aws-bedrock-alpha` actually models, as ENUM members.
 *
 * Used for ONE thing: building {@link GEO_PREFIX_RE}, the prefix rejection in
 * `resolveBedrockModelIds`. `resolveBedrockGeoRegion` validates against the exported
 * `BEDROCK_GEO_REGIONS` literal instead, so widening the accepted set means editing
 * that — not this.
 *
 * Construct-layer only, and deliberately NOT exported: this is the
 * `Object.values()` read of the alpha enum that pulls in `aws-cdk-lib`, so a runtime
 * handler importing it would put the whole CDK in its bundle. The exported
 * `BEDROCK_GEO_REGIONS` is the dependency-free literal re-exported above; a test
 * asserts the two are equal, so a CDK release adding a geography fails the suite
 * rather than silently leaving the literal behind.
 */
const GEO_REGION_ENUM_VALUES: readonly CrossRegionInferenceProfileRegion[] =
  Object.values(CrossRegionInferenceProfileRegion);

/**
 * `global|us-gov|apac|eu|us|jp|au` — an alternation over the geographies.
 *
 * Sorted longest-first so `us-gov` reads ahead of `us`. Presentation only: because
 * {@link GEO_PREFIX_RE} anchors a literal `.` after the alternation, a `us`-first
 * order still rejects `us-gov.…` correctly (the engine backtracks when the `.` fails
 * against `-`). Sorting just means nobody has to reason about that to trust it.
 */
const GEO_ALTERNATION = [...GEO_REGION_ENUM_VALUES]
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Matches a leading `<geo>.` inference-profile prefix on a model ID. */
const GEO_PREFIX_RE = new RegExp(`^(?:${GEO_ALTERNATION})\\.`);

/**
 * Resolves the cross-Region inference-profile geography: CDK context
 * `bedrockGeoRegion` when provided, else {@link DEFAULT_BEDROCK_GEO_REGION}
 * (`us`). Set via `cdk.json` `context` or `-c bedrockGeoRegion=global`, then
 * redeploy, to move the deployment's inference profiles to another geography —
 * no construct edits needed.
 *
 * Both grant sites derive their inference-profile ARNs from this one value (the
 * AgentCore runtime in `stacks/agent.ts` via
 * `CrossRegionInferenceProfile.fromConfig`, the ECS task role in
 * `constructs/ecs-agent-cluster.ts` via the `<geo>.<modelId>` ARN resource
 * name), and the agent's auxiliary-model env var (`ANTHROPIC_DEFAULT_HAIKU_MODEL`)
 * takes the same prefix via {@link haikuInferenceProfileId} — so the main and
 * auxiliary models can never route through different geographies.
 *
 * Throws at synth on an unrecognized value: an invented geography would produce
 * a syntactically valid but non-existent inference-profile ARN, and the grant
 * would silently authorize nothing (the agent then fails at turn 0 with
 * AccessDenied). A typo must fail the synth, not the deployment.
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
 * `-c bedrockModels='["anthropic.claude-opus-4-8", …]'`, then redeploy, to add
 * a model the runtime may invoke — no construct edits needed.
 *
 * **Use the bare foundation-model ID (`anthropic.claude-…`), NOT a
 * geo-prefixed inference-profile ID.** Both grant sites derive the
 * inference-profile ARN by prefixing the geography from
 * {@link resolveBedrockGeoRegion} (`bedrockGeoRegion` — `global` in the shipped cdk.json, `us` absent any context), so passing
 * `us.anthropic.…` here would produce an invalid `us.us.anthropic.…` ARN. The
 * resolver rejects an entry carrying ANY modelled geo prefix
 * ({@link BEDROCK_GEO_REGIONS}) to catch that early — including `global.`,
 * which previously slipped through and silently yielded
 * `us.global.anthropic.…`.
 *
 * Throws on a malformed override (non-array, non-string / empty entries, or a
 * geo-prefixed ID) so a typo fails synth loudly instead of silently
 * granting nothing or an invalid ARN.
 */
export function resolveBedrockModelIds(node: Node): readonly string[] {
  const raw = node.tryGetContext(BEDROCK_MODELS_CONTEXT_KEY);
  if (raw === undefined || raw === null) {
    return MODEL_IDS;
  }
  // `cdk.context.json` delivers a real array, but the `-c key=value` form
  // documented above delivers a raw string. Parse the string form so both
  // behave identically. A non-JSON string — a true typo — is left as-is and
  // fails the array check below with the same clear, key-named error.
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
    // An IAM wildcard character. These entries become the resource half of the
    // Bedrock grant, so '*' synths cleanly into `inference-profile/<geo>.*` —
    // the account-wide grant the resource scoping above exists to avoid,
    // reached through a context value rather than a policy edit. Nothing
    // downstream can distinguish it from a model name, and the rendered
    // template shows a resource-scoped statement that happens to match
    // everything. An operator who wants a broader grant should widen the policy
    // deliberately, where a reviewer sees it.
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
