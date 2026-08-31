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
 * Regional availability of the AWS Lambda MicroVMs backend (ADR-021,
 * sub-decision 4 — "Regional availability enforcement").
 *
 * ABCA is a single-region deployment, so the constraint is binary per stack:
 * either the stack's Region offers Lambda MicroVMs or the `lambda-microvm`
 * backend does not exist there at all. Enforcement is layered, and THIS module
 * is the one *static* layer:
 *
 *   - **synth/deploy** (static, this constant) — offline determinism is
 *     required, so the CDK gate compares the stack Region against
 *     {@link LAMBDA_MICROVM_SUPPORTED_REGIONS}.
 *   - **repo onboarding / `platform doctor` / orchestration** (live) — a
 *     `ListManagedMicrovmImages` probe, so those layers **self-heal** the day
 *     AWS adds a Region, with no code change and no dependency on this list.
 *
 * ## Documented update path (this list rots by design)
 *
 * When AWS launches Lambda MicroVMs in a new Region:
 *
 *   1. Add the Region id to {@link LAMBDA_MICROVM_SUPPORTED_REGIONS} below
 *      (this is the ONLY place the list is declared — do not copy it).
 *   2. Ship it; nothing else needs changing. The live probes already accepted
 *      the Region before this edit, so the edit only unblocks synth.
 *
 * Until step 1 lands, operators in a newly launched Region use the CDK
 * context-flag escape hatch rather than waiting on a release — which is why a
 * stale list is a friction bug, never an availability outage.
 *
 * Source: ADR-021 capability table ("Regions (launch)"); 5 Regions at the
 * 2026-06-22 launch.
 */
export const LAMBDA_MICROVM_SUPPORTED_REGIONS: readonly string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'ap-northeast-1',
];

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
