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
 * Deploy preflight decision: is the account's CDKToolkit stack carrying the
 * bootstrap policy bundle this checkout needs?
 *
 * A stale bundle does not fail fast on its own. `cdk deploy` builds and uploads
 * every asset (the agent image alone is several hundred MB) BEFORE CloudFormation
 * evaluates the execution role's permissions, so a missing statement surfaces as
 * an `iam:...` AccessDenied many minutes in. The CDKToolkit stack already
 * publishes `BootstrapPolicyVersion` and `BootstrapPolicyHash`; comparing them
 * up front turns that into an actionable error in seconds.
 */

export interface CfnOutput {
  readonly OutputKey?: string;
  readonly OutputValue?: string;
}

export interface BootstrapExpectation {
  readonly version: string;
  readonly hash: string;
}

export type BootstrapVerdict =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

const REBOOTSTRAP = 'Re-bootstrap with `mise //cdk:bootstrap` (same account, Region and profile), then deploy again.';

/** Enough of a SHA-256 to tell two bundles apart in a message. */
const HASH_DISPLAY_LENGTH = 12;

/** Compares dotted numeric versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Decides from the CDKToolkit stack's outputs. `outputs === null` means the
 * stack does not exist (the account/Region was never bootstrapped).
 */
export function evaluateBootstrap(outputs: readonly CfnOutput[] | null, expected: BootstrapExpectation): BootstrapVerdict {
  if (outputs === null) {
    return { ok: false, message: 'This account/Region is not bootstrapped (no CDKToolkit stack). Run `mise //cdk:bootstrap` first.' };
  }
  const get = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;
  const version = get('BootstrapPolicyVersion');
  const hash = get('BootstrapPolicyHash');

  if (!version) {
    // A plain `cdk bootstrap` (AdministratorAccess execution role) has no ABCA outputs.
    // It can deploy anything, so there is nothing to compare; say so rather than guess.
    return { ok: true, message: 'CDKToolkit is not the ABCA least-privilege bootstrap (no BootstrapPolicyVersion output); skipping the policy check.' };
  }
  const order = compareVersions(version, expected.version);
  if (order < 0) {
    return {
      ok: false,
      message: `The account's bootstrap policy bundle is ${version}, but this checkout needs ${expected.version}. `
        + `Deploying now would fail with an IAM AccessDenied after uploading every asset. ${REBOOTSTRAP}`,
    };
  }
  if (order === 0 && hash && hash !== expected.hash) {
    return {
      ok: false,
      message: `The account's bootstrap policies (bundle ${version}) differ from this checkout's (hash ${hash.slice(0, HASH_DISPLAY_LENGTH)}… vs ${expected.hash.slice(0, HASH_DISPLAY_LENGTH)}…). `
        + `If you changed policies locally, bump BOOTSTRAP_VERSION. ${REBOOTSTRAP}`,
    };
  }
  if (order > 0) {
    return { ok: true, message: `Bootstrap policy bundle ${version} is newer than this checkout's ${expected.version}; continuing.` };
  }
  return { ok: true, message: `Bootstrap policy bundle ${version} matches this checkout.` };
}
