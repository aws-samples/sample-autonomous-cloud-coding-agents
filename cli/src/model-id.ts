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

import { CliError } from './errors';

/**
 * Every cross-Region inference-profile geography, mirroring
 * `CrossRegionInferenceProfileRegion` in `@aws-cdk/aws-bedrock-alpha`. The CLI is a
 * separate package and does not depend on CDK — the same mirroring `platform-doctor`
 * and `PLATFORM_REPO_DEFAULTS` already do.
 *
 * Order does NOT matter here, and that is worth stating because it looks like it
 * should: `geoPrefixOf` matches `<geo>` followed by a literal `.`, so `us.` cannot
 * match `us-gov.…` — the dot fails against the hyphen. Listed longest-first only so
 * the list reads unambiguously; a reader should not have to reason about the
 * matcher to trust it. (`platform-doctor` builds a REGEX from a similar list, where
 * alternation order does matter more visibly — same reasoning recorded there.)
 */
export const BEDROCK_GEO_PREFIXES = [
  'global', 'us-gov', 'us', 'eu', 'apac', 'jp', 'au',
] as const;

/** The `<geo>.` prefix on a model id, or undefined for a bare foundation-model id. */
export function geoPrefixOf(modelId: string): string | undefined {
  return BEDROCK_GEO_PREFIXES.find((geo) => modelId.startsWith(`${geo}.`));
}

/**
 * Reject a `--model` value that cannot work, at the point the operator can still
 * fix it.
 *
 * Both mistakes this catches produce the SAME opaque outcome today: the task
 * dispatches, runs, and dies at turn 0 with `AccessDenied` — with nothing at
 * onboard time and nothing in the failure naming the model as the cause.
 *
 *  - A **bare** foundation-model id. Bedrock refuses bare ids for on-demand
 *    invocation of Claude 4.x and later ("ValidationException: … isn't supported.
 *    Retry your request with the ID or ARN of an inference profile"), so a bare id
 *    here is always wrong regardless of what is granted.
 *  - A geography that does not match the deployment's. The IAM grant is scoped to
 *    `<geo>.<model>` profile ARNs resolved at synth, so a `us.` model on a stack
 *    deployed with `bedrockGeoRegion=global` is granted nothing.
 *
 * Deliberately does NOT check membership in the granted model set: the CLI has no
 * way to read `bedrockModels` today, and a guess dressed as validation is worse
 * than no check. `platform doctor` covers the profile-resolves question; see #805.
 *
 * `deployedGeo` is null on a stack that predates the `BedrockGeoRegion` output — the
 * geography check is then skipped rather than assumed, but the bare-id check still
 * applies because it holds for every geography.
 */
export function assertModelIdUsable(args: {
  modelId: string | undefined;
  deployedGeo: string | null | undefined;
  stackName: string;
}): void {
  const { modelId, deployedGeo, stackName } = args;
  if (!modelId) return;

  const geo = geoPrefixOf(modelId);
  if (!geo) {
    throw new CliError(
      `--model '${modelId}' looks like a bare foundation-model id, which Bedrock cannot `
      + 'invoke on demand — a task using it would fail at turn 0 with a ValidationException. '
      + `Use the inference-profile form: '${deployedGeo ?? 'us'}.${modelId}'.`,
    );
  }

  if (!deployedGeo || geo === deployedGeo) return;

  throw new CliError(
    `--model '${modelId}' is a '${geo}' inference profile, but stack '${stackName}' grants `
    + `'${deployedGeo}' profiles (BedrockGeoRegion). The IAM grant is scoped to `
    + `'${deployedGeo}.' ARNs, so this model is granted nothing and tasks would fail at turn 0 `
    + `with AccessDenied. Use '${deployedGeo}.${modelId.slice(geo.length + 1)}', or redeploy the `
    + `stack with -c bedrockGeoRegion=${geo}.`,
  );
}
