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

// Semver constraint matching + highest-version selection for the agent asset
// registry (#246). AgentCore stores a plain version STRING with no native `^`/`~`
// matching, so ranking is always done here in code (this is substrate-agnostic
// ABCA logic — it does not import the AWS SDK).

import { type ParsedConstraint, parseConstraint } from './ref';

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, or [] for a release version. */
  readonly prerelease: readonly string[];
  readonly raw: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse a plain version string (no operator). Returns null if not valid semver. */
export function parseVersion(raw: string): SemVer | null {
  const m = SEMVER.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw,
  };
}

function isNumeric(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Compare two prerelease identifier lists per semver §11: a release (empty list)
 * outranks any prerelease; numeric identifiers compare numerically; identifiers
 * are compared field by field; a longer list wins when all shared fields tie.
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a is a release → higher
  if (b.length === 0) return -1; // b is a release → higher
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;
    const an = isNumeric(ai);
    const bn = isNumeric(bi);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1; // numeric identifiers have lower precedence than alphanumeric
    if (bn) return 1;
    return ai < bi ? -1 : 1;
  }
  return a.length - b.length;
}

/** Total order over versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function coreEquals(v: SemVer, c: ParsedConstraint): boolean {
  return v.major === c.major && v.minor === c.minor && v.patch === c.patch;
}

/**
 * Does a version satisfy a constraint?
 *
 * - exact: identical core AND identical prerelease.
 * - caret `^1.4.1`: `>=1.4.1 <2.0.0` (same major; `^0.x` keeps minor per npm).
 * - tilde `~1.4.1`: `>=1.4.1 <1.5.0` (same major.minor).
 *
 * A prerelease version only satisfies a range when the constraint itself pins the
 * same core version and carries a prerelease (npm semantics) — otherwise
 * prereleases are excluded from range matches so `^1.4.1` never picks `1.5.0-rc.1`.
 */
export function satisfies(v: SemVer, c: ParsedConstraint): boolean {
  const constraintCore: SemVer = {
    major: c.major,
    minor: c.minor,
    patch: c.patch,
    prerelease: c.prerelease ? c.prerelease.split('.') : [],
    raw: c.raw,
  };

  if (c.op === 'exact') {
    return compareVersions(v, constraintCore) === 0;
  }

  // Range ops: v must be >= the constraint's core.
  if (compareVersions(v, constraintCore) < 0) return false;

  // Exclude prereleases from range matches unless the constraint pins the same
  // core version and is itself a prerelease.
  if (v.prerelease.length > 0) {
    if (!(coreEquals(v, c) && constraintCore.prerelease.length > 0)) return false;
  }

  if (c.op === 'caret') {
    if (c.major > 0) return v.major === c.major;
    // ^0.x.y → same major.minor (npm behavior for 0.x)
    if (c.minor > 0) return v.major === 0 && v.minor === c.minor;
    // ^0.0.z → exact patch
    return v.major === 0 && v.minor === 0 && v.patch === c.patch;
  }

  // tilde: same major.minor
  return v.major === c.major && v.minor === c.minor;
}

/**
 * From a set of candidate versions (plain strings), pick the highest that
 * satisfies the constraint. Unparseable versions are skipped. Returns the
 * winning raw string, or null when nothing matches.
 */
export function selectHighest(
  candidates: readonly string[],
  constraint: ParsedConstraint,
): string | null {
  let best: SemVer | null = null;
  for (const raw of candidates) {
    const v = parseVersion(raw);
    if (!v || !satisfies(v, constraint)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best ? best.raw : null;
}

/** Convenience: parse a constraint string then select. Null on bad constraint. */
export function selectHighestForConstraint(
  candidates: readonly string[],
  constraintRaw: string,
): string | null {
  const c = parseConstraint(constraintRaw);
  return c ? selectHighest(candidates, c) : null;
}
