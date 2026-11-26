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
 * `CrossRegionInferenceProfileRegion` in `@aws-cdk/aws-bedrock-alpha`.
 */
export const BEDROCK_GEO_PREFIXES = [
  'global', 'us-gov', 'us', 'eu', 'apac', 'jp', 'au',
] as const;

/** The `<geo>.` prefix on a model id, or undefined for a bare foundation-model id. */
export function geoPrefixOf(modelId: string): string | undefined {
  return BEDROCK_GEO_PREFIXES.find((geo) => modelId.startsWith(`${geo}.`));
}

/**
 * Reject a `--model` value that cannot work. Throws CliError for:
 *  - a bare foundation-model id: Bedrock refuses bare ids for on-demand invocation of
 *    Claude 4.x and later with a `ValidationException`;
 *  - a geography prefix with no model after it, or two geography prefixes;
 *  - a model outside `grantedBareIds`, when the stack exports that set;
 *  - a geography other than `deployedGeo`, when the stack exports one.
 *
 * An undefined or blank `modelId` passes.
 */
export function assertModelIdUsable(args: {
  modelId: string | undefined;
  deployedGeo: string | null | undefined;
  stackName: string;
  /** Bare ids the stack grants, from its `BedrockModelIds` output. */
  grantedBareIds?: readonly string[];
}): void {
  const { deployedGeo, stackName, grantedBareIds } = args;
  const modelId = args.modelId?.trim();
  if (!modelId) return;

  const geo = geoPrefixOf(modelId);
  if (!geo) {
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

  const bare = modelId.slice(geo.length + 1);
  if (!bare) {
    throw new CliError(
      `--model '${modelId}' is a geography prefix with no model after it. Use `
      + `'${geo}.<model-id>', e.g. '${geo}.anthropic.claude-opus-5-5'.`,
    );
  }
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
