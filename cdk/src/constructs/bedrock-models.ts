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

/**
 * The small/fast model the agent uses for cheap side-calls, as a BARE
 * foundation-model id.
 *
 * Named separately from {@link DEFAULT_BEDROCK_MODEL_IDS} because it has a second
 * consumer: the agent needs it as a runtime *value*
 * (`ANTHROPIC_DEFAULT_HAIKU_MODEL`), not just as an IAM grant. Splicing it out of
 * that list means the granted model and the delivered model id cannot drift — a
 * mismatch would AccessDenied every Haiku call at run time while synth stayed
 * green.
 *
 * Declared ABOVE the list rather than beside {@link haikuInferenceProfileId}
 * below it because the list interpolates it: a `const` referenced before its
 * declaration is a TDZ `ReferenceError` at module load, and re-inlining the
 * literal into the list is exactly the drift this constant exists to prevent.
 */
export const DEFAULT_HAIKU_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Single source of truth for the Bedrock **foundation-model IDs** the agent
 * runtime may invoke. Both grant sites — the AgentCore runtime in
 * `stacks/agent.ts` and the ECS task role in `constructs/ecs-agent-cluster.ts`
 * — derive their `grantInvoke` / IAM ARNs from this one list, so the two
 * backends can never drift (they were previously two hand-synced arrays).
 *
 * Scoping is intentionally per-model (explicit foundation-model +
 * cross-Region inference-profile ARNs), NOT a `Resource: '*'` wildcard — that
 * hardening is preserved. Account-level Bedrock model access remains the outer
 * gate; this list only controls the IAM grant.
 */
export const DEFAULT_BEDROCK_MODEL_IDS: readonly string[] = [
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-20250514-v1:0',
  // Claude Opus 4.8 — the agent's fallback model when a repo pins none
  // (``agent/src/config.py``). REQUIRED in this grant list or the agent's
  // InvokeModel gets AccessDenied at turn 0: both the AgentCore runtime and the
  // ECS task role scope Bedrock to these IDs via resolveBedrockModelIds. Keep
  // this entry and that default in the same change — a fallback the role cannot
  // invoke fails every task on the stack, not just an edge case.
  'anthropic.claude-opus-4-8',
  // Claude Opus 5 — granted ahead of anything selecting it (#744). The grant
  // must be DEPLOYED before the platform default flips, or every task fails at
  // turn 0 with AccessDenied. Bare ID by contract: Bedrock refuses the bare ID
  // for on-demand invocation ("ValidationException: … isn't supported. Retry
  // your request with the ID or ARN of an inference profile"), and both grant
  // sites derive the geo-prefixed inference-profile ARN — the invocable one —
  // from this entry plus `bedrockGeoRegion` (default `us`). Opus 4.8 above
  // stays granted: blueprints may pin it per-repo, so removing it would fail
  // those repos at turn 0.
  'anthropic.claude-opus-5',
  DEFAULT_HAIKU_MODEL_ID,
];

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
 * The geographies `@aws-cdk/aws-bedrock-alpha` actually models — the single
 * source of truth for both the {@link resolveBedrockGeoRegion} allow-list and
 * the region-prefix rejection in {@link resolveBedrockModelIds}. Derived from
 * the enum, so a future CDK release that adds a geography widens both at once
 * instead of leaving one of them silently behind.
 */
export const BEDROCK_GEO_REGIONS: readonly CrossRegionInferenceProfileRegion[] =
  Object.values(CrossRegionInferenceProfileRegion);

/**
 * `global|us-gov|apac|eu|us|jp|au` — an alternation over
 * {@link BEDROCK_GEO_REGIONS}, sorted longest-first so the pattern reads
 * unambiguously with `us-gov` ahead of `us`. Readability only: because
 * {@link GEO_PREFIX_RE} anchors a literal `.` after the alternation, a `us`-first
 * order would still reject `us-gov.…` correctly (the engine backtracks when the
 * `.` fails against `-`). Sorting just means nobody has to reason about that.
 */
const GEO_ALTERNATION = [...BEDROCK_GEO_REGIONS]
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
  if (typeof override !== 'string' || !BEDROCK_GEO_REGIONS.includes(override as CrossRegionInferenceProfileRegion)) {
    throw new Error(
      `Context '${BEDROCK_GEO_REGION_CONTEXT_KEY}' must be one of `
      + `${BEDROCK_GEO_REGIONS.map((g) => `'${g}'`).join(', ')}; got ${JSON.stringify(override)}.`,
    );
  }
  return override as CrossRegionInferenceProfileRegion;
}

/**
 * The `ANTHROPIC_DEFAULT_HAIKU_MODEL` value delivered to the agent, for the
 * geography `geoRegion` (from {@link resolveBedrockGeoRegion}).
 *
 * A **cross-Region inference-profile** id, not the bare foundation-model id:
 * Claude 4.x cannot be invoked on-demand by bare id (400 "on-demand throughput
 * isn't supported"). The prefix is the resolved geography rather than a hardcoded
 * `us.` so this auxiliary model routes through the same geography as the granted
 * profiles — every grant site derives its inference-profile ARN from the same
 * value, so the delivered id is always one of the granted profiles.
 * (`agent/src/runner.py` re-sets the env var at spawn time from whatever arrives.)
 *
 * A function rather than a `const` for exactly that reason: the geography is a
 * per-deployment context read (`bedrockGeoRegion`, #764), so a module-level
 * constant could only ever bake one geography in — which is the split this
 * function exists to make impossible.
 *
 * TWO delivery sites call it, and both must — the second is the easy one to
 * forget:
 *  1. the AgentCore runtime env block (`stacks/agent.ts`);
 *  2. the lambda-microvm `platform_config` block (`stacks/agent.ts`) — a MicroVM
 *     restored from a snapshot cannot inherit a baked env, so the orchestrator
 *     forwards the value on the `/run` payload instead (ADR-021 P2). This is the
 *     "third site" flagged on #746 (after the two Bedrock ARN derivations in
 *     `stacks/agent.ts` and `constructs/ecs-agent-cluster.ts`): a geo change that
 *     missed it would leave one substrate calling a profile the role does not
 *     grant.
 *
 * The ECS container env is deliberately NOT in that list — it never carried
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL`, so an ECS agent falls back to
 * `agent/src/config.py`'s own `us.`-prefixed default. That is correct on the
 * default geography and a pre-existing gap on any other; it predates this merge
 * and is left alone here rather than fixed in a conflict resolution.
 */
export function haikuInferenceProfileId(geoRegion: CrossRegionInferenceProfileRegion): string {
  return `${geoRegion}.${DEFAULT_HAIKU_MODEL_ID}`;
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
 * {@link resolveBedrockGeoRegion} (`bedrockGeoRegion`, default `us`), so passing
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
  const override = node.tryGetContext(BEDROCK_MODELS_CONTEXT_KEY);
  if (override === undefined || override === null) {
    return DEFAULT_BEDROCK_MODEL_IDS;
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
  }
  return override as string[];
}
