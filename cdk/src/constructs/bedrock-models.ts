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
  // sites derive the `us.`-prefixed inference-profile ARN — the invocable one —
  // from this entry. Opus 4.8 above stays granted: blueprints may pin it
  // per-repo, so removing it would fail those repos at turn 0.
  'anthropic.claude-opus-5',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
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
  const raw = node.tryGetContext(BEDROCK_MODELS_CONTEXT_KEY);
  if (raw === undefined || raw === null) {
    return DEFAULT_BEDROCK_MODEL_IDS;
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
