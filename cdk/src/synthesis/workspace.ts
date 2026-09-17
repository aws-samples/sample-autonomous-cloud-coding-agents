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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const GIT_OUTPUT_LIMIT = 8_388_608;
const EXECUTABLE_PERMISSION_BITS = 0o111;

export interface SourceProvenance {
  readonly commit: string;
  readonly dirty: boolean;
  readonly sourceSha256: string;
  readonly lockfileSha256: string;
  readonly fingerprintFormat: 'git-visible-v2';
  readonly fileCount: number;
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Fingerprint Git-visible files and symlink identities, including uncommitted changes.
 * Ignored build output/dependencies and external symlink targets are not release attestations.
 */
export function sourceProvenance(root: string): SourceProvenance {
  // Git hook variables (e.g. GIT_INDEX_FILE) must not redirect the checkout being measured.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, env, encoding: 'utf8', maxBuffer: GIT_OUTPUT_LIMIT,
  });
  const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256').update('git-visible-v2\n');
  for (const file of files) {
    const absolute = path.join(root, file);
    let entry: object;
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entry = { file, kind: 'symlink', target: readlinkSync(absolute) };
      } else if (stat.isFile()) {
        // eslint-disable-next-line no-bitwise -- POSIX file modes encode executable permissions as bits.
        const executable = (stat.mode & EXECUTABLE_PERMISSION_BITS) !== 0;
        entry = { file, kind: 'file', executable, sha256: hash(readFileSync(absolute)) };
      } else {
        throw new Error(`Unsupported Git-visible source entry: ${file}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entry = { file, kind: 'deleted' };
    }
    // Typed, framed records distinguish deletions, file bytes, symlinks, and modes.
    digest.update(JSON.stringify(entry)).update('\n');
  }
  return {
    commit: git('rev-parse', '--verify', 'HEAD').trim(),
    dirty: git('status', '--porcelain').trim().length > 0,
    sourceSha256: digest.digest('hex'),
    lockfileSha256: hash(readFileSync(path.join(root, 'yarn.lock'))),
    fingerprintFormat: 'git-visible-v2',
    fileCount: files.length,
  };
}

/** Use versioned CDK defaults, then let the named profile and structural overrides win. */
export function projectContext(root: string): Record<string, unknown> {
  const config = JSON.parse(readFileSync(path.join(root, 'cdk/cdk.json'), 'utf8'));
  const context: unknown = config.context ?? {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('cdk.json context must be an object');
  return context as Record<string, unknown>;
}

/** Allocate a fresh directory, checking real paths before writing even through symlinked parents. */
export function createOutputDirectory(root: string, output?: string, temporaryRoot = tmpdir()): string {
  const checkout = realpathSync(root);
  const requested = output === undefined ? undefined : path.resolve(output);
  const parent = realpathSync(requested ? path.dirname(requested) : temporaryRoot);
  const target = requested ? path.join(parent, path.basename(requested)) : parent;
  if (target === checkout || target.startsWith(`${checkout}${path.sep}`)) {
    throw new Error('Census output must be outside the checkout to avoid recursive asset fingerprinting');
  }
  if (requested) {
    mkdirSync(target); // Reject existing directories and symlinks, including dangling symlinks.
    return target;
  }
  return mkdtempSync(path.join(parent, 'abca-census-'));
}
