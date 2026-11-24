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
 * ABCA is a single-region deployment, so the constraint is binary per stack:
 * either the stack's Region offers Lambda MicroVMs or the `lambda-microvm`
 * backend does not exist there at all. Enforcement is layered, and THIS list
 * is the one *static* layer:
 *
 *   - **synth/deploy and `bgagent setup`** (static, this list) — offline
 *     determinism is required, so the CDK gate compares the stack Region
 *     against {@link LAMBDA_MICROVM_SUPPORTED_REGIONS}, and setup checks the
 *     CLI mirror of the same catalog entry before it runs the diff.
 *   - **repo onboarding / `platform doctor` / orchestration** (live) — a
 *     `ListManagedMicrovmImages` probe, so those layers **self-heal** the day
 *     AWS adds a Region, with no code change and no dependency on this list.
 *
 * ## Documented update path (this list rots by design)
 *
 * The list is declared once, as `compute.lambda-microvm.regions` in the
 * capability catalog (`contracts/deployment-capabilities.json`, ADR-024). This
 * module only hands it to handler code, which must not import
 * `deployment/capabilities.ts` (that module loads `aws-cdk-lib`). When AWS
 * launches Lambda MicroVMs in a new Region:
 *
 *   1. Add the Region id to that catalog entry and mirror it into
 *      `cli/src/deployment-capabilities.ts` (a parity test fails until both
 *      agree). Do not copy the list anywhere else.
 *   2. Ship it; nothing else needs changing. The live probes already accepted
 *      the Region before this edit, so the edit only unblocks synth and setup.
 *
 * Until step 1 lands, operators in a newly launched Region use the CDK
 * context-flag escape hatch rather than waiting on a release — which is why a
 * stale list is a friction bug, never an availability outage.
 *
 * Source: ADR-021 capability table ("Regions (launch)"); 5 Regions at the
 * 2026-06-22 launch.
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
