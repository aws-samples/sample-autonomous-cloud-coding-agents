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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import * as path from 'node:path';
import { createOutputDirectory, projectContext, sourceProvenance } from '../../src/synthesis/workspace';

describe('census workspace evidence', () => {
  let directory: string;
  let checkout: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'census-workspace-'));
    checkout = path.join(directory, 'checkout');
    mkdirSync(checkout);
    const git = (...args: string[]) => execFileSync('git', [
      '-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Census Test', '-c', 'user.email=census@example.com', ...args,
    ], { cwd: checkout, stdio: 'pipe' });
    git('init', '--quiet', '-b', 'census-fixture');
    writeFileSync(path.join(checkout, 'yarn.lock'), 'fixture lock');
    writeFileSync(path.join(checkout, '.gitignore'), 'build/\n');
    writeFileSync(path.join(checkout, 'input.txt'), '<deleted>');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  test('detects tracked deletion even when the former bytes equal the old deletion sentinel', () => {
    const before = sourceProvenance(checkout);
    rmSync(path.join(checkout, 'input.txt'));
    const after = sourceProvenance(checkout);
    expect(after.sourceSha256).not.toBe(before.sourceSha256);
    expect(before.dirty).toBe(false);
    expect(after.dirty).toBe(true);
  });

  test('distinguishes a symlink target from identical ordinary file bytes', () => {
    const before = sourceProvenance(checkout);
    rmSync(path.join(checkout, 'input.txt'));
    symlinkSync('<deleted>', path.join(checkout, 'input.txt'));
    expect(sourceProvenance(checkout).sourceSha256).not.toBe(before.sourceSha256);
  });

  test('detects executable changes and untracked input changes, but excludes ignored build output', () => {
    const input = path.join(checkout, 'input.txt');
    chmodSync(input, 0o644);
    const before = sourceProvenance(checkout);
    chmodSync(input, 0o755);
    const executable = sourceProvenance(checkout);
    expect(executable.sourceSha256).not.toBe(before.sourceSha256);
    writeFileSync(path.join(checkout, 'new\ninput.ts'), 'new input');
    const untracked = sourceProvenance(checkout);
    expect(untracked.sourceSha256).not.toBe(executable.sourceSha256);
    expect(untracked.fileCount).toBe(executable.fileCount + 1);
    mkdirSync(path.join(checkout, 'build'));
    writeFileSync(path.join(checkout, 'build/output.js'), 'ignored');
    expect(sourceProvenance(checkout).sourceSha256).toBe(untracked.sourceSha256);
  });

  test('ignores an inherited alternate Git index', () => {
    const before = sourceProvenance(checkout);
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(directory, 'foreign-index');
    try {
      expect(sourceProvenance(checkout)).toEqual(before);
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
    }
  });

  test('rejects output through a symlink to the checkout before writing anything', () => {
    const alias = path.join(directory, 'alias');
    symlinkSync(checkout, alias);
    const before = readdirSync(checkout);
    expect(() => createOutputDirectory(checkout, path.join(alias, 'output'))).toThrow(/outside the checkout/);
    expect(() => createOutputDirectory(alias, path.join(checkout, 'output'))).toThrow(/outside the checkout/);
    expect(() => createOutputDirectory(checkout, undefined, alias)).toThrow(/outside the checkout/);
    expect(readdirSync(checkout)).toEqual(before);
  });

  test('allocates fresh external output and refuses to reuse existing directories or symlinks', () => {
    const output = createOutputDirectory(checkout, path.join(directory, 'output'));
    expect(output).toBe(realpathSync(path.join(directory, 'output')));
    expect(() => createOutputDirectory(checkout, output)).toThrow(/EEXIST/);
    const alias = path.join(directory, 'existing-link');
    symlinkSync(checkout, alias);
    expect(() => createOutputDirectory(checkout, alias)).toThrow(/EEXIST/);
    const temporary = createOutputDirectory(checkout, undefined, directory);
    expect(existsSync(temporary)).toBe(true);
    expect(temporary).not.toBe(output);
  });

  test('reads versioned CDK context and rejects malformed context', () => {
    mkdirSync(path.join(checkout, 'cdk'));
    const file = path.join(checkout, 'cdk/cdk.json');
    writeFileSync(file, JSON.stringify({ context: { '@aws-cdk/core:fixture': true, 'bedrockGeoRegion': 'global' } }));
    expect(projectContext(checkout)).toEqual({ '@aws-cdk/core:fixture': true, 'bedrockGeoRegion': 'global' });
    writeFileSync(file, JSON.stringify({ context: [] }));
    expect(() => projectContext(checkout)).toThrow(/context must be an object/);
  });
});
