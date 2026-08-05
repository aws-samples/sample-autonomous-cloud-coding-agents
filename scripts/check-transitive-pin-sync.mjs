#!/usr/bin/env node
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
 * Transitive-pin sync guard (issue #712).
 *
 * The repo pins transitive npm dependencies in TWO independent places that do
 * not share state:
 *   - root `package.json` -> `resolutions`   governs the yarn workspace (yarn.lock)
 *   - `integrations/jira-forge-app/package.json` -> `overrides`
 *                                             governs that standalone npm project
 *                                             (its own package-lock.json)
 * jira-forge-app is OUTSIDE the yarn `workspaces` array, so a bump applied via
 * root `resolutions` never reaches it. A maintainer remediating a shared
 * transitive advisory (e.g. fast-uri, undici) can clear yarn.lock and pass the
 * LOCAL `security:deps`, while the same advisory silently persists in the
 * jira-forge-app lockfile until the scheduled/CI scan fails days later.
 *
 * This guard fails fast, locally, when the two drift: for every package that is
 * pinned in root `resolutions` AND also present in the jira-forge-app lockfile,
 * the version resolved there must meet the root pin's minimum. If it does not,
 * the fix is to mirror the pin into jira-forge-app `overrides` and re-lock
 * (`npm install --package-lock-only`).
 *
 * It intentionally does NOT require every root pin to appear in jira-forge-app —
 * only packages actually present in both trees must agree. A pin for a package
 * jira-forge-app doesn't depend on is a no-op there and is not flagged.
 *
 * No third-party deps by design: every other script in scripts/ uses only
 * `node:` builtins, and scripts/** is knip-ignored, so pulling in `semver`
 * would be an undeclared/transitive import that could vanish on a re-lock. The
 * repo's transitive pins are all `^`/`>=`-style minimum FLOORS, so a
 * "resolved >= floor" numeric compare on the leading `major.minor.patch` is the
 * exact check we need — no range engine required.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkgPath = join(repoRoot, 'package.json');
const forgeLockPath = join(
  repoRoot,
  'integrations',
  'jira-forge-app',
  'package-lock.json',
);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`check-transitive-pin-sync: cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
}

/** Parse the leading numeric release of a semver into [major, minor, patch]. */
function releaseTuple(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Strip a range operator (^, ~, >=, v) to the bare minimum version string. */
function floorOf(range) {
  return String(range).trim().replace(/^[\^~]|^>=\s*|^v/i, '');
}

/** True iff `version` is >= the minimum implied by `range`; null if unparseable. */
function meetsFloor(version, range) {
  const v = releaseTuple(version);
  const f = releaseTuple(floorOf(range));
  if (!v || !f) return null;
  for (let i = 0; i < 3; i++) {
    if (v[i] > f[i]) return true;
    if (v[i] < f[i]) return false;
  }
  return true; // exactly equal
}

const rootPkg = readJson(rootPkgPath);
const resolutions = rootPkg.resolutions ?? {};
if (typeof resolutions !== 'object' || Array.isArray(resolutions)) {
  console.error(
    'check-transitive-pin-sync: root package.json `resolutions` is not an object — schema changed.',
  );
  process.exit(2);
}

// Collect every resolved version of every package present in the jira-forge-app
// lockfile. npm v2/v3 lockfiles key `packages` by install path; the package name
// is the final segment after the last `node_modules/`. The root entry ("") is
// skipped.
const forgeLock = readJson(forgeLockPath);
if (!forgeLock.packages || typeof forgeLock.packages !== 'object') {
  console.error(
    `check-transitive-pin-sync: ${forgeLockPath} has no \`packages\` map — expected an npm v2/v3 lockfile.`,
  );
  process.exit(2);
}
const forgeVersions = new Map(); // name -> Set<version>
for (const [installPath, meta] of Object.entries(forgeLock.packages)) {
  if (installPath === '' || !meta?.version) continue;
  const name = installPath.split('node_modules/').pop();
  if (!forgeVersions.has(name)) forgeVersions.set(name, new Set());
  forgeVersions.get(name).add(meta.version);
}

const drifts = [];
const checked = [];
for (const [name, range] of Object.entries(resolutions)) {
  const present = forgeVersions.get(name);
  if (!present) continue; // not a jira-forge-app dependency — pin is a no-op there
  for (const version of present) {
    const ok = meetsFloor(version, range);
    if (ok === null) {
      console.error(
        `check-transitive-pin-sync: cannot compare ${name}@${version} against pin "${range}" ` +
          `(unparseable version or range).`,
      );
      process.exit(2);
    }
    checked.push(`${name}@${version} (root pin ${range})`);
    if (!ok) drifts.push({ name, range, version });
  }
}

if (drifts.length > 0) {
  console.error('check-transitive-pin-sync: transitive pins have DRIFTED between');
  console.error('root `resolutions` and integrations/jira-forge-app `overrides`.\n');
  for (const { name, range, version } of drifts) {
    console.error(
      `  ✖ ${name}: root pins "${range}" but jira-forge-app resolves ${version}`,
    );
    console.error(
      `      fix: add "${name}": "${range}" to integrations/jira-forge-app/package.json "overrides",`,
    );
    console.error(
      `           then \`cd integrations/jira-forge-app && npm install --package-lock-only\`.\n`,
    );
  }
  console.error(
    `Drifted: ${drifts.length}. This is the failure mode #712 guards against — ` +
      `a root resolutions bump that never reached the standalone npm project.`,
  );
  process.exit(1);
}

console.log(
  `check-transitive-pin-sync: OK — ${checked.length} shared pin(s) in sync ` +
    `between root resolutions and jira-forge-app.`,
);
