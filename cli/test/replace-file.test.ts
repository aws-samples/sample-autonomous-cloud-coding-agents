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
import * as os from 'os';
import * as path from 'path';
import { replaceFile } from '../src/replace-file';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof fs>('fs');
  return {
    ...actual,
    openSync: jest.fn(actual.openSync),
    fchownSync: jest.fn(actual.fchownSync),
    renameSync: jest.fn(actual.renameSync),
    rmSync: jest.fn(actual.rmSync),
  };
});

const errno = (code: string) => Object.assign(new Error(`${code}: refused`), { code });
const codeOf = (write: () => void) => {
  let code: string | undefined;
  try {
    write();
  } catch (err) {
    code = (err as NodeJS.ErrnoException).code;
  }
  return code;
};

describe('replaceFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-replace-'));
    file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
  });

  afterEach(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('creates the temporary file with the final mode, so it is never looser than the result', () => {
    fs.chmodSync(file, 0o600);

    replaceFile(file, 'new', 0o644);

    expect(fs.openSync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), 'wx', 0o600);
    expect(fs.statSync(file).mode % 0o1000).toBe(0o600);
  });

  test('keeps the owner and group of the file it replaces', () => {
    const { uid, gid } = fs.statSync(file);

    replaceFile(file, 'new', 0o600, 0o600);

    expect(fs.fchownSync).toHaveBeenCalledWith(expect.any(Number), uid, gid);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
  });

  test.each(['EBUSY', 'EXDEV', 'EPERM', 'EACCES'])(
    'writes in place when the rename is refused with %s, as for a bind mounted file',
    (code) => {
      const { ino } = fs.statSync(file);
      jest.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw errno(code);
      });

      replaceFile(file, 'new', 0o600, 0o600);

      expect(fs.readFileSync(file, 'utf-8')).toBe('new');
      expect(fs.statSync(file).ino).toBe(ino);
      expect(fs.statSync(file).mode % 0o1000).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['credentials.json']);
    },
  );

  test('writes in place when the file belongs to an owner the temporary file cannot take', () => {
    const { ino } = fs.statSync(file);
    jest.mocked(fs.fchownSync).mockImplementationOnce(() => {
      throw errno('EPERM');
    });

    replaceFile(file, 'new', 0o600, 0o600);

    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(fs.statSync(file).ino).toBe(ino);
    expect(fs.readdirSync(dir)).toEqual(['credentials.json']);
  });

  test('writes in place when the directory is not writable but the file is', () => {
    fs.chmodSync(dir, 0o555);

    replaceFile(file, 'new', 0o600, 0o600);

    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(fs.statSync(file).mode % 0o1000).toBe(0o600);
  });

  test('treats a read only file exactly as a plain write does', () => {
    const plain = path.join(dir, 'plain.json');
    fs.writeFileSync(plain, 'old');
    fs.chmodSync(plain, 0o444);
    fs.chmodSync(file, 0o444);

    const plainCode = codeOf(() => fs.writeFileSync(plain, 'new'));
    const code = codeOf(() => replaceFile(file, 'new', 0o600, 0o600));

    expect(code).toBe(plainCode);
    expect(fs.readFileSync(file, 'utf-8')).toBe(fs.readFileSync(plain, 'utf-8'));
  });

  test('writes a hard linked file in place, so every link sees the new content', () => {
    const other = path.join(dir, 'other.json');
    fs.linkSync(file, other);

    replaceFile(file, 'new', 0o600, 0o600);

    expect(fs.readFileSync(other, 'utf-8')).toBe('new');
    expect(fs.statSync(file).ino).toBe(fs.statSync(other).ino);
  });

  test('reports the original error when removing the temporary file fails too', () => {
    jest.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw errno('ENOSPC');
    });
    jest.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw errno('EIO');
    });

    expect(() => replaceFile(file, 'new', 0o600, 0o600)).toThrow('ENOSPC');

    expect(fs.readFileSync(file, 'utf-8')).toBe('old');
  });
});
