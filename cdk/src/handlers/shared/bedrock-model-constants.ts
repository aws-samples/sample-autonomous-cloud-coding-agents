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

/**
 * Bedrock model/geography constants shared by the RUNTIME handler layer and the CDK
 * construct layer. Deliberately dependency-free: no `aws-cdk-lib`, no
 * `@aws-cdk/aws-bedrock-alpha`, no `constructs`.
 *
 * WHY THIS FILE EXISTS — it is a bundle-size boundary, not a style preference.
 *
 * `constructs/bedrock-models.ts` derives its geography list from the alpha enum
 * (`Object.values(CrossRegionInferenceProfileRegion)`). That is a RUNTIME
 * evaluation of a module whose top level `require`s `aws-cdk-lib`, so esbuild cannot
 * tree-shake it. When `handlers/shared/workflows.ts` imported the list from there,
 * every Lambda that reaches `workflows.ts` — the orchestrator, create-task, the
 * webhook create-task, the Slack/Linear/Jira webhook processors, the reconcilers —
 * pulled the whole CDK library into its deploy artifact. Measured with esbuild
 * (node22/cjs): `workflows.ts` alone went from **6.8 KB with zero `aws-cdk-lib`
 * references to 57 MB with 9,679**. `aws-cdk-lib` is not in any construct's
 * `externalModules` (only `@aws-sdk/*` is), so nothing downstream strips it.
 *
 * It is also a layering fix. The runtime handler layer must not depend on the CDK
 * construct layer — `constructs/blueprint.ts` imports `contracts/constants.json`
 * directly for exactly this reason rather than reusing runtime types.
 *
 * Keeping the values HERE and having the construct layer import them (rather than
 * the reverse) is what makes the direction enforceable: this module cannot import
 * CDK without a lint/type error being obvious, whereas a construct importing a
 * plain array is unremarkable.
 *
 * `test/constructs/bedrock-models.test.ts` asserts {@link BEDROCK_GEO_REGIONS}
 * equals `Object.values(CrossRegionInferenceProfileRegion)`, so a CDK release that
 * adds a geography fails the suite here instead of silently leaving the literal
 * behind.
 */

/**
 * The small/fast model the agent uses for cheap side-calls, as a BARE
 * foundation-model id.
 *
 * Named separately from {@link DEFAULT_BEDROCK_MODEL_IDS} because it has a second
 * consumer: the agent needs it as a runtime *value*
 * (`ANTHROPIC_DEFAULT_HAIKU_MODEL`), not just as an IAM grant. Splicing it out of
 * that list means the granted model and the delivered model id cannot drift — a
 * mismatch would AccessDenied every Haiku call at run time while synth stayed green.
 */
export const DEFAULT_HAIKU_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Single source of truth for the Bedrock **foundation-model IDs** the agent runtime
 * may invoke. Every grant site — the AgentCore runtime in `stacks/agent.ts`, the ECS
 * task role in `constructs/ecs-agent-cluster.ts` — derives its `grantInvoke` / IAM
 * ARNs from this one list, so the backends cannot drift (they were previously
 * hand-synced arrays).
 *
 * Scoping is intentionally per-model (explicit foundation-model + cross-Region
 * inference-profile ARNs), NOT a `Resource: '*'` wildcard. Account-level Bedrock
 * model access remains the outer gate; this list only controls the IAM grant.
 *
 * Every entry must have a live cross-Region inference profile. A granted model
 * WITHOUT one is invisible to every check the platform has — it is on the grant
 * list, so `repo onboard --model` admits it and workflow admission admits it — and
 * then fails at turn 0. `anthropic.claude-opus-4-20250514-v1:0` was exactly that
 * (`GetInferenceProfile` returns not-found for both its `global.` and `us.` forms)
 * and was removed; `bgagent platform doctor` now checks the whole set for it.
 */
export const DEFAULT_BEDROCK_MODEL_IDS: readonly string[] = [
  'anthropic.claude-sonnet-4-6',
  // Claude Opus 4.8. Blueprints may pin it per-repo, so removing it would fail those
  // repos at turn 0.
  'anthropic.claude-opus-4-8',
  // Claude Opus 5 — the platform default. Bare ID by contract: Bedrock refuses the
  // bare ID for on-demand invocation ("ValidationException: … isn't supported. Retry
  // your request with the ID or ARN of an inference profile"), and the grant sites
  // derive the geo-prefixed inference-profile ARN — the invocable one — from this
  // entry plus `bedrockGeoRegion`.
  'anthropic.claude-opus-5',
  DEFAULT_HAIKU_MODEL_ID,
];

/**
 * The bare model ids the platform itself defaults to, as opposed to the full grant
 * list. Both are injected into every substrate as geo-prefixed profile ids so a
 * deploy cannot grant one geography and tell the agent to call another.
 *
 * Distinct from {@link DEFAULT_BEDROCK_MODEL_IDS} because that list is the IAM
 * ALLOWANCE — several models a repo may pin — while these two are what a task uses
 * when it pins nothing. A model can be granted without being a default.
 *
 * The auxiliary default is an ALIAS of {@link DEFAULT_HAIKU_MODEL_ID}, not a second
 * copy of the string: they must name the same model, and two literals could drift.
 */
export const PLATFORM_DEFAULT_MODEL_ID = 'anthropic.claude-opus-5';
export const PLATFORM_DEFAULT_AUX_MODEL_ID = DEFAULT_HAIKU_MODEL_ID;

/**
 * Every cross-Region inference-profile geography, mirroring
 * `CrossRegionInferenceProfileRegion` in `@aws-cdk/aws-bedrock-alpha`.
 *
 * A literal rather than `Object.values(...)` of the enum because this module is on
 * the runtime side of the bundle boundary described above — reading the enum here
 * would reintroduce the 57 MB regression. The parity test named in this file's
 * header is what keeps the two in step.
 */
export const BEDROCK_GEO_REGIONS: readonly string[] = [
  'us', 'us-gov', 'eu', 'apac', 'global', 'jp', 'au',
];

/**
 * The geo-prefixed inference-profile id for a bare model id, in the geography a
 * deploy grants. The single place that prefix is applied.
 *
 * Exists because the main model was previously NOT injected at all: the stack set
 * only the auxiliary var, so the main model came from a Python literal that a
 * geography change does not touch. A deploy then granted one set of profiles while
 * the agent asked for another, and every task with no per-repo override failed at
 * turn 0 with AccessDenied.
 */
export function inferenceProfileId(geoRegion: string, bareModelId: string): string {
  return `${geoRegion}.${bareModelId}`;
}
