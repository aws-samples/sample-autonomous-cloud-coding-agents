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
 * Bootstrap preflight validator (#126): is the account's CDKToolkit stack carrying
 * the bootstrap policy bundle this checkout needs?
 *
 * A stale bundle does not fail fast on its own. `cdk deploy` builds and uploads
 * every asset (the agent image alone is several hundred MB) BEFORE CloudFormation
 * evaluates the execution role's permissions, so a missing statement surfaces as
 * an `iam:...` AccessDenied many minutes in. The CDKToolkit stack publishes
 * `BootstrapPolicyVersion`, `BootstrapPolicyHash` and `BootstrapPolicySet`;
 * comparing them up front turns that into an actionable result in seconds.
 *
 * Results, per #126: PASS deploys; WARN (same version, different hash: likely
 * console drift) is advisory and deploys; FAIL stops the deploy.
 */

import type { ComputeBackend } from '../handlers/shared/compute-backend';

export interface CfnOutput {
  readonly OutputKey?: string;
  readonly OutputValue?: string;
}

export interface BootstrapExpectation {
  readonly version: string;
  readonly hash: string;
  /** Policy names the app needs, as listed in the `BootstrapPolicySet` output. */
  readonly policySet: readonly string[];
}

export type PreflightStatus = 'PASS' | 'WARN' | 'FAIL';

export interface BootstrapVerdict {
  readonly status: PreflightStatus;
  readonly message: string;
}

const REBOOTSTRAP = 'Re-bootstrap with `mise //cdk:bootstrap` (same account, Region and profile), then deploy again.';

/** Enough of a SHA-256 to tell two bundles apart in a message. */
const HASH_DISPLAY_LENGTH = 12;

const BASE_POLICIES = ['Infrastructure', 'Application', 'Observability', 'Compute-Agentcore'] as const;
const BACKEND_POLICIES: Partial<Record<ComputeBackend, string>> = {
  'ecs': 'Compute-ECS',
  'lambda-microvm': 'Compute-LambdaMicrovms',
};

/** The `BootstrapPolicySet` entries an app deploying these compute backends needs. */
export function requiredPolicySet(backends: readonly ComputeBackend[]): string[] {
  return [...BASE_POLICIES, ...backends.flatMap((b) => (BACKEND_POLICIES[b] ? [BACKEND_POLICIES[b]] : []))];
}

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
    return { status: 'FAIL', message: 'This account/Region is not bootstrapped (no CDKToolkit stack). Run `mise //cdk:bootstrap` first.' };
  }
  const get = (key: string) => outputs.find((o) => o.OutputKey === key)?.OutputValue;
  const version = get('BootstrapPolicyVersion');
  const hash = get('BootstrapPolicyHash');
  const deployedSet = get('BootstrapPolicySet');

  if (!version) {
    return {
      status: 'FAIL',
      message: 'CDKToolkit is a default CDK bootstrap (no BootstrapPolicyVersion output), whose execution role has '
        + 'AdministratorAccess. ABCA expects its least-privilege bootstrap. Run `mise //cdk:bootstrap`, or bypass '
        + 'deliberately with ABCA_SKIP_BOOTSTRAP_PREFLIGHT=1.',
    };
  }
  if (compareVersions(version, expected.version) < 0) {
    return {
      status: 'FAIL',
      message: `The account's bootstrap policy bundle is ${version}, but this checkout needs ${expected.version}. `
        + `Deploying now would fail with an IAM AccessDenied after uploading every asset. ${REBOOTSTRAP}`,
    };
  }
  if (deployedSet !== undefined) {
    const deployed = new Set(deployedSet.split(',').map((p) => p.trim()).filter(Boolean));
    const missing = expected.policySet.filter((p) => !deployed.has(p));
    if (missing.length > 0) {
      return {
        status: 'FAIL',
        message: `The account's bootstrap is missing policies this app needs: ${missing.join(', ')}. `
          + 'Re-bootstrap with `ComputeTypes` including the matching compute backend (see docs/guides/DEPLOYMENT_GUIDE.md).',
      };
    }
  }
  if (compareVersions(version, expected.version) === 0 && hash && hash !== expected.hash) {
    return {
      status: 'WARN',
      message: `Bootstrap policy bundle ${version} matches, but its policies differ from this checkout's `
        + `(hash ${hash.slice(0, HASH_DISPLAY_LENGTH)}… vs ${expected.hash.slice(0, HASH_DISPLAY_LENGTH)}…). `
        + 'Possible console edits, or local policy changes without a BOOTSTRAP_VERSION bump. Continuing; re-bootstrap if the deploy is denied.',
    };
  }
  if (compareVersions(version, expected.version) > 0) {
    return { status: 'PASS', message: `Bootstrap policy bundle ${version} is newer than this checkout's ${expected.version}.` };
  }
  return { status: 'PASS', message: `Bootstrap policy bundle ${version} matches this checkout.` };
}
