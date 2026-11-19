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

import * as fs from 'fs';
import * as path from 'path';

/** A JSON file's content; `undefined` when the file does not exist; the error when it cannot be read. */
function readJson(file: string): { version?: unknown; commit?: unknown } | Error | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** What the compile recorded (`lib/build-info.json`) and the package manifest, beside `lib/`. */
const CLI_FILES = {
  buildInfo: path.join(__dirname, 'build-info.json'),
  packageJson: path.join(__dirname, '..', 'package.json'),
};

/**
 * What `bgagent --version` prints: the version and commit the compile recorded in
 * `lib/build-info.json` (`cli/scripts/write-build-info.mjs`), so a bug report names
 * the commit it was built from. Without that file (a plain `tsc` build), the
 * `package.json` version, read rather than copied so the two cannot drift (#913).
 *
 * It never throws: it runs at start-up, before any command, so an unreadable file is
 * reported in the version string instead of stopping the CLI.
 *
 * @param files the two files to read; the compiled CLI's own unless a test passes others.
 */
export function cliVersion(files: { buildInfo: string; packageJson: string } = CLI_FILES): string {
  const info = readJson(files.buildInfo);
  const pkg = readJson(files.packageJson);
  const fromInfo = info instanceof Error ? undefined : info?.version;
  const fromPkg = pkg instanceof Error ? undefined : pkg?.version;
  const version = typeof fromInfo === 'string' ? fromInfo : typeof fromPkg === 'string' ? fromPkg : 'unknown';
  if (info instanceof Error) return `${version} (build info unreadable)`;
  return typeof info?.commit === 'string' ? `${version} (${info.commit})` : version;
}
