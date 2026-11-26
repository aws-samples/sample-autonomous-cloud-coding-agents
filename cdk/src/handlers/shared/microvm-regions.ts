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

// A named import, so that a handler bundle carries this section of the catalog only.
import { compute } from '../../../../contracts/deployment-capabilities.json';

/**
 * Regional availability of the AWS Lambda MicroVMs backend (ADR-021,
 * sub-decision 4 — "Regional availability enforcement").
 *
 * The list is declared once, as `compute.lambda-microvm.regions` in the
 * capability catalog (`contracts/deployment-capabilities.json`, ADR-024).
 */
export const LAMBDA_MICROVM_SUPPORTED_REGIONS: readonly string[] = compute['lambda-microvm'].regions;

/**
 * True when `region` is in the statically documented
 * {@link LAMBDA_MICROVM_SUPPORTED_REGIONS} list.
 *
 * A `false` result means "not known to be supported *by this build*", NOT
 * "unsupported by AWS" — the live probes are authoritative. Never use this to
 * reject at runtime what a probe already accepted.
 *
 * @param region - an AWS Region id (e.g. `us-east-1`); compared verbatim.
 */
export function isLambdaMicrovmRegionSupported(region: string | undefined): boolean {
  return !!region && LAMBDA_MICROVM_SUPPORTED_REGIONS.includes(region);
}
