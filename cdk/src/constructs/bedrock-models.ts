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

import { Node } from 'constructs';

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
/**
 * The small/fast model the agent uses for cheap side-calls, as a BARE
 * foundation-model id.
 *
 * Named separately from the list below because it has a second consumer: the
 * agent needs it as a runtime *value* (`ANTHROPIC_DEFAULT_HAIKU_MODEL`), not just
 * as an IAM grant. Splicing it out of the list here means the granted model and
 * the delivered model id cannot drift — a mismatch would AccessDenied every
 * Haiku call at run time while synth stayed green.
 */
export const DEFAULT_HAIKU_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` value delivered to the agent on every backend
 * (AgentCore runtime env, and `platform_config` for lambda-microvm).
 *
 * The **cross-region inference-profile** id, not the bare foundation-model id:
 * Claude 4.x cannot be invoked on-demand by bare id (400 "on-demand throughput
 * isn't supported"). The `us.` prefix matches how both grant sites derive their
 * inference-profile ARNs, so the value is always one of the granted profiles.
 * (`agent/src/runner.py` re-sets this at spawn time from the same value.)
 */
export const DEFAULT_HAIKU_INFERENCE_PROFILE_ID = `us.${DEFAULT_HAIKU_MODEL_ID}`;

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
  DEFAULT_HAIKU_MODEL_ID,
];

/** CDK context key whose value (a string array) overrides the model set. */
export const BEDROCK_MODELS_CONTEXT_KEY = 'bedrockModels';

/**
 * Resolves the invocable foundation-model IDs: CDK context `bedrockModels`
 * (an array of **bare foundation-model IDs**) when provided, else
 * {@link DEFAULT_BEDROCK_MODEL_IDS}. Set via `cdk.json` `context` or
 * `-c bedrockModels='["anthropic.claude-opus-4-8", …]'`, then redeploy, to add
 * a model the runtime may invoke — no construct edits needed.
 *
 * **Use the bare foundation-model ID (`anthropic.claude-…`), NOT the
 * `us.`-prefixed inference-profile ID.** Both grant sites derive the US
 * inference-profile ARN by prefixing `us.`, so passing `us.anthropic.…` here
 * would produce an invalid `us.us.anthropic.…` ARN. The resolver rejects a
 * `us.`/`eu.`/`apac.`-prefixed entry to catch that early.
 *
 * Throws on a malformed override (non-array, non-string / empty entries, or a
 * region-prefixed ID) so a typo fails synth loudly instead of silently
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
    if (/^(us|eu|apac)\./.test(id)) {
      throw new Error(
        `Context '${BEDROCK_MODELS_CONTEXT_KEY}' expects bare foundation-model IDs, not region-prefixed `
        + `inference-profile IDs — got '${id}'. Use '${id.replace(/^(us|eu|apac)\./, '')}'; `
        + 'the US inference-profile ARN is derived automatically.',
      );
    }
  }
  return override as string[];
}
