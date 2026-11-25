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

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const PERMISSION_MODULUS = 0o10000;
const RENAME_REFUSED = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'EXDEV', 'ENOTSUP']);

export function replaceFile(file: string, content: string, createMode: number, setMode?: number): void {
  const target = regularFileTarget(file);
  const existing = target ? fs.statSync(target, { throwIfNoEntry: false }) : undefined;
  const mode = setMode ?? (existing ? existing.mode % PERMISSION_MODULUS : undefined);

  if (!target || (existing && existing.nlink > 1)) {
    writeInPlace(file, content, createMode, mode);
    return;
  }

  if (existing) {
    fs.accessSync(target, fs.constants.W_OK);
  }
  try {
    swapIn(target, content, mode ?? createMode, mode, existing);
  } catch (err) {
    if (!RENAME_REFUSED.has((err as NodeJS.ErrnoException).code ?? '')) {
      throw err;
    }
    writeInPlace(target, content, createMode, mode);
  }
}

function regularFileTarget(file: string): string | undefined {
  try {
    const real = fs.realpathSync(file);
    return fs.statSync(real).isFile() ? real : undefined;
  } catch (err) {
    const creatable = (err as NodeJS.ErrnoException).code === 'ENOENT'
      && !fs.lstatSync(file, { throwIfNoEntry: false })
      && fs.existsSync(path.dirname(file));
    return creatable ? file : undefined;
  }
}

function writeInPlace(file: string, content: string, createMode: number, mode?: number): void {
  fs.writeFileSync(file, content, { mode: createMode });
  if (mode !== undefined && fs.statSync(file).isFile()) {
    fs.chmodSync(file, mode);
  }
}

function swapIn(target: string, content: string, openMode: number, mode?: number, owner?: fs.Stats): void {
  const { root, dir, base } = path.parse(target);
  const temp = path.format({ root, dir, base: `.${base}.${randomUUID()}.tmp` });
  const fd = fs.openSync(temp, 'wx', openMode);
  try {
    try {
      fs.writeFileSync(fd, content);
      // chown first: it clears setuid and setgid bits
      if (owner) {
        fs.fchownSync(fd, owner.uid, owner.gid);
      }
      if (mode !== undefined) {
        fs.fchmodSync(fd, mode);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      throw err;
    }
    throw err;
  }
}
