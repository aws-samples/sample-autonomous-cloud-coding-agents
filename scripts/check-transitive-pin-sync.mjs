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
 * For every package that is pinned in root `resolutions` AND also present in the
 * jira-forge-app lockfile, the version resolved there must meet the root pin's minimum.
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

function releaseTuple(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function floorOf(range) {
  return String(range).trim().replace(/^[\^~]|^>=\s*|^v/i, '');
}

function meetsFloor(version, range) {
  const v = releaseTuple(version);
  const f = releaseTuple(floorOf(range));
  if (!v || !f) return null;
  for (let i = 0; i < 3; i++) {
    if (v[i] > f[i]) return true;
    if (v[i] < f[i]) return false;
  }
  return true;
}

// A yarn `resolutions` key is a package name or a path pattern that ends in one
// (`parent/pkg`, `parent/@scope/pkg`, usually behind a leading glob).
function pinnedPackage(key) {
  const segments = key.split('/');
  const name = segments.pop();
  const scope = segments.pop();
  return scope?.startsWith('@') ? `${scope}/${name}` : name;
}

const rootPkg = readJson(rootPkgPath);
const resolutions = rootPkg.resolutions ?? {};
if (typeof resolutions !== 'object' || Array.isArray(resolutions)) {
  console.error(
    'check-transitive-pin-sync: root package.json `resolutions` is not an object — schema changed.',
  );
  process.exit(2);
}

// npm v2/v3 lockfiles key `packages` by install path; the package name is the
// final segment after the last `node_modules/`, and the root entry is "".
const forgeLock = readJson(forgeLockPath);
if (!forgeLock.packages || typeof forgeLock.packages !== 'object') {
  console.error(
    `check-transitive-pin-sync: ${forgeLockPath} has no \`packages\` map — expected an npm v2/v3 lockfile.`,
  );
  process.exit(2);
}
const forgeVersions = new Map();
for (const [installPath, meta] of Object.entries(forgeLock.packages)) {
  if (installPath === '' || !meta?.version) continue;
  const name = installPath.split('node_modules/').pop();
  if (!forgeVersions.has(name)) forgeVersions.set(name, new Set());
  forgeVersions.get(name).add(meta.version);
}

const drifts = new Map();
const checked = new Set();
for (const [key, range] of Object.entries(resolutions)) {
  const name = pinnedPackage(key);
  const present = forgeVersions.get(name);
  if (!present) continue;
  for (const version of present) {
    const ok = meetsFloor(version, range);
    if (ok === null) {
      console.error(
        `check-transitive-pin-sync: cannot compare ${name}@${version} against pin "${key}": "${range}" ` +
          `(unparseable version or range).`,
      );
      process.exit(2);
    }
    const compared = `${name}@${version} (root pin ${range})`;
    checked.add(compared);
    if (!ok && !drifts.has(compared)) drifts.set(compared, { key, name, range, version });
  }
}

if (drifts.size > 0) {
  console.error('check-transitive-pin-sync: transitive pins have DRIFTED between');
  console.error('root `resolutions` and integrations/jira-forge-app `overrides`.\n');
  for (const { key, name, range, version } of drifts.values()) {
    console.error(
      `  ✖ ${name}: root pins "${range}"${key === name ? '' : ` (resolutions key "${key}")`} ` +
        `but jira-forge-app resolves ${version}`,
    );
    console.error(
      `      fix: add "${name}": "${range}" to integrations/jira-forge-app/package.json "overrides",`,
    );
    console.error(
      `           then \`cd integrations/jira-forge-app && npm install --package-lock-only\`.\n`,
    );
  }
  console.error(
    `Drifted: ${drifts.size}. This is the failure mode #712 guards against — ` +
      `a root resolutions bump that never reached the standalone npm project.`,
  );
  process.exit(1);
}

console.log(
  `check-transitive-pin-sync: OK — ${checked.size} shared pin(s) in sync ` +
    `between root resolutions and jira-forge-app.`,
);
