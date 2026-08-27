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
 * Each mistake this catches fails at turn 0 with nothing naming the model as the
 * cause — but NOT with the same error, and the distinction matters when reading a
 * failure: a bare id raises `ValidationException` from Bedrock (the id is not
 * invocable at all), while a wrong geography or an ungranted model raises
 * `AccessDenied` from IAM (the id is fine, the grant is not).
 *
 *  - A **bare** foundation-model id. Bedrock refuses bare ids for on-demand
 *    invocation of Claude 4.x and later ("ValidationException: … isn't supported.
 *    Retry your request with the ID or ARN of an inference profile"), so a bare id
 *    here is always wrong regardless of what is granted.
 *  - A geography that does not match the deployment's. The IAM grant is scoped to
 *    `<geo>.<model>` profile ARNs resolved at synth, so a `us.` model on a stack
 *    deployed with `bedrockGeoRegion=global` is granted nothing.
 *
 * Checks membership in the granted set when the stack exports one (`BedrockModelIds`).
 * An earlier version did not, on the reasoning that the CLI could not read
 * `bedrockModels` — which was wrong: it is recoverable from the deployed template, and
 * is now published as an output. Skipped only when the output is absent, i.e. on a
 * stack deployed before it existed.
 *
 * `deployedGeo` is null on a stack that predates the `BedrockGeoRegion` output — the
 * geography check is then skipped rather than assumed, but the bare-id check still
 * applies because it holds for every geography.
 */
export function assertModelIdUsable(args: {
  modelId: string | undefined;
  deployedGeo: string | null | undefined;
  stackName: string;
  /** Bare ids the stack grants, from its `BedrockModelIds` output. */
  grantedBareIds?: readonly string[];
}): void {
  const { deployedGeo, stackName, grantedBareIds } = args;
  // Trim before anything else. A trailing space survived every check and was written
  // to the RepoTable verbatim, where it never matches a real profile id.
  const modelId = args.modelId?.trim();
  if (!modelId) return;

  const geo = geoPrefixOf(modelId);
  if (!geo) {
    // Suggest a geography only when the stack told us one. Naming `us` on a stack
    // deployed as `global` would hand the operator a value it does not grant —
    // trading one turn-0 failure for another.
    const suggestion = deployedGeo
      ? ` Use the inference-profile form: '${deployedGeo}.${modelId}'.`
      : " Use the inference-profile form, prefixed with the deployment's geography "
        + "(e.g. 'global.' or 'us.').";
    throw new CliError(
      `--model '${modelId}' looks like a bare foundation-model id, which Bedrock cannot `
      + 'invoke on demand — a task using it would fail at turn 0 with a ValidationException.'
      + suggestion,
    );
  }

  // Membership in the granted set. Skipped when the stack does not export it, so an
  // older stack is not blocked — but checked whenever the information exists,
  // because this is the case that otherwise reaches turn 0 with no explanation.
  const bare = modelId.slice(geo.length + 1);
  // `'global.'` — a prefix with nothing after it — yields an empty bare id. It passed
  // every check on a stack with no granted-set output, i.e. every stack deployed
  // before this change, and landed in the RepoTable as-is.
  if (!bare) {
    throw new CliError(
      `--model '${modelId}' is a geography prefix with no model after it. Use `
      + `'${geo}.<model-id>', e.g. '${geo}.anthropic.claude-opus-5'.`,
    );
  }
  // A second geo prefix on the bare half means the operator prefixed twice; the
  // resulting id names no real profile. Caught here rather than left to the grant
  // check, which is skipped on a stack that exports no granted set.
  const doublePrefix = geoPrefixOf(bare);
  if (doublePrefix) {
    throw new CliError(
      `--model '${modelId}' carries two geography prefixes ('${geo}.' then `
      + `'${doublePrefix}.'). Use one: '${geo}.${bare.slice(doublePrefix.length + 1)}'.`,
    );
  }
  if (grantedBareIds && grantedBareIds.length > 0 && !grantedBareIds.includes(bare)) {
    throw new CliError(
      `--model '${modelId}' is not granted by stack '${stackName}'. It grants: `
      + `${grantedBareIds.join(', ')}. A task using an ungranted model fails at turn 0 with `
      + 'AccessDenied. Add it with -c bedrockModels=\'[…]\' and redeploy, or pick a granted one.',
    );
  }

  // An EMPTY deployedGeo is not the same as an absent one: `getStackOutput` returns
  // null when the output is missing, so an empty string means the stack exported a
  // blank value. Treat it as unknown rather than as "matches anything".
  const declaredGeo = deployedGeo?.trim() || undefined;
  if (!declaredGeo || geo === declaredGeo) return;

  throw new CliError(
    `--model '${modelId}' is a '${geo}' inference profile, but stack '${stackName}' grants `
    + `'${deployedGeo}' profiles (BedrockGeoRegion). The IAM grant is scoped to `
    + `'${deployedGeo}.' ARNs, so this model is granted nothing and tasks would fail at turn 0 `
    + `with AccessDenied. Use '${declaredGeo}.${bare}', or redeploy the `
    + `stack with -c bedrockGeoRegion=${geo}.`,
  );
}
