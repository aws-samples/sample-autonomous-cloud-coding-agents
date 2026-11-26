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

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, loadCredentials, saveConfig, saveCredentials, writeSecretFile } from '../src/config';
import { CliError } from '../src/errors';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveConfig / loadConfig', () => {
    test('saves and loads config', () => {
      const config = {
        api_url: 'https://api.example.com/v1',
        region: 'us-east-1',
        user_pool_id: 'us-east-1_abc',
        client_id: 'client123',
      };
      saveConfig(config);
      expect(loadConfig()).toEqual(config);
    });

    test('throws when config does not exist', () => {
      expect(() => loadConfig()).toThrow('Not configured');
    });

    test.each([
      [
        'is cut short',
        (file: string) => fs.writeFileSync(file, '{\n  "api_url": "https://api.example.com/v1",\n  "region":'),
        'Unexpected end of JSON input',
      ],
      ['cannot be read', (file: string) => fs.mkdirSync(file), 'EISDIR: illegal operation on a directory, read'],
    ])('reports a config file that %s, with its path and the reason', (_how, damage, reason) => {
      const file = path.join(tmpDir, 'config.json');
      damage(file);

      expect(() => loadConfig()).toThrow(new CliError(
        `Cannot read the config file ${file}: ${reason}. Fix or remove the file, or run \`bgagent configure\` to replace it.`,
      ));
    });
  });

  describe('saveCredentials / loadCredentials', () => {
    test('saves and loads credentials', () => {
      const creds = {
        id_token: 'tok-id',
        refresh_token: 'tok-refresh',
        token_expiry: '2026-01-01T00:00:00.000Z',
      };
      saveCredentials(creds);
      expect(loadCredentials()).toEqual(creds);
    });

    test('returns null when credentials file does not exist', () => {
      expect(loadCredentials()).toBeNull();
    });

    test('throws a CliError pointing at `bgagent login` on corrupt JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{ not valid json');
      expect(() => loadCredentials()).toThrow('bgagent login');
    });

    test('credentials file has restricted permissions', () => {
      saveCredentials({
        id_token: 'tok',
        refresh_token: 'ref',
        token_expiry: '2026-01-01T00:00:00.000Z',
      });
      const stat = fs.statSync(path.join(tmpDir, 'credentials.json'));
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    });

    test('tightens a credentials file that already exists with loose permissions', () => {
      const p = path.join(tmpDir, 'credentials.json');
      fs.writeFileSync(p, '{}');
      fs.chmodSync(p, 0o644);

      saveCredentials({
        id_token: 'tok',
        refresh_token: 'ref',
        token_expiry: '2026-01-01T00:00:00.000Z',
      });

      expect(fs.statSync(p).mode % 0o1000).toBe(0o600);
    });
  });

  describe('writing the credentials file', () => {
    const OLD = { id_token: 'old-id', refresh_token: 'old-refresh', token_expiry: '2026-01-01T00:00:00.000Z' };
    const NEW = { id_token: 'new-id', refresh_token: 'new-refresh', token_expiry: '2026-02-01T00:00:00.000Z' };
    // `import * as fs` is a read-only view of the module, here and in config.ts: a spy goes on the module itself.
    const nodeFs = jest.requireActual<typeof fs>('fs');
    const credentials = (): string => path.join(tmpDir, 'credentials.json');

    function failure(code: string): NodeJS.ErrnoException {
      return Object.assign(new Error(`${code}: simulated`), { code });
    }

    // Only root can change an owner, and on macOS fs.linkSync gives the second name to the file a symbolic link names, not to the link.
    function report(call: 'lstatSync' | 'statSync', entry: string, as: { uid?: number; nlink?: number }): void {
      const real = nodeFs[call];
      jest.spyOn(nodeFs, call).mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
        const stats = real(file, options) as fs.Stats | undefined;
        if (stats && file === entry) Object.assign(stats, as);
        return stats;
      }) as typeof fs.statSync);
    }

    function runAs(uid: number | undefined): void {
      process.geteuid = uid === undefined ? undefined : () => uid;
    }
    const geteuid = process.geteuid;

    const ANOTHER_USER = 'belongs to another user';
    const SECOND_NAME = 'has more than one name, so someone else may have put it there';
    function refusal(entry: string, kind: string, reason: string): CliError {
      return new CliError(`Refusing to write to ${entry}: the ${kind} there ${reason}. Remove it, or choose another path.`);
    }

    afterEach(() => {
      process.geteuid = geteuid;
      jest.restoreAllMocks();
    });

    test('replaces the file in one step, so a reader gets the old login or the new one', () => {
      saveCredentials(OLD);
      const rename = fs.renameSync;
      const atRename: unknown[] = [];
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce((from, to) => {
        atRename.push({
          read: loadCredentials(),
          from: path.dirname(String(from)),
          staged: JSON.parse(fs.readFileSync(from, 'utf-8')),
          mode: fs.statSync(from).mode % 0o1000,
        });
        rename(from, to);
      });

      saveCredentials(NEW);

      expect(atRename).toEqual([{ read: OLD, from: tmpDir, staged: NEW, mode: 0o600 }]);
      expect(loadCredentials()).toEqual(NEW);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test.each([
      ['an error without a code', new Error('rename failed')],
      ['an error that is not about replacing the file', failure('ENOSPC')],
    ])('keeps the old file and leaves no temporary file when the replacement fails with %s', (_what, error) => {
      saveCredentials(OLD);
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw error; });

      expect(() => saveCredentials(NEW)).toThrow(error);

      expect(loadCredentials()).toEqual(OLD);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('reports the failure of the replacement, not that of the cleanup after it', () => {
      saveCredentials(OLD);
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename failed'); });
      jest.spyOn(nodeFs, 'rmSync').mockImplementationOnce(() => { throw new Error('cleanup failed'); });

      expect(() => saveCredentials(NEW)).toThrow('rename failed');

      expect(loadCredentials()).toEqual(OLD);
    });

    test('reports the failure of the write, not that of the close after it', () => {
      saveCredentials(OLD);
      jest.spyOn(nodeFs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('write failed'); });
      const close = fs.closeSync;
      const closes = jest.spyOn(nodeFs, 'closeSync').mockImplementationOnce((fd) => {
        close(fd);
        throw new Error('close failed');
      });

      expect(() => saveCredentials(NEW)).toThrow('write failed');

      expect(closes).toHaveBeenCalled();
      expect(loadCredentials()).toEqual(OLD);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('refuses a temporary name that is taken, and leaves what is there', () => {
      const victim = path.join(tmpDir, 'victim');
      fs.writeFileSync(victim, 'untouched');
      const open = fs.openSync;
      let planted = '';
      jest.spyOn(nodeFs, 'openSync').mockImplementationOnce((file, flags, mode) => {
        planted = String(file);
        fs.symlinkSync(victim, planted);
        return open(file, flags, mode);
      });

      expect(() => saveCredentials(NEW)).toThrow('EEXIST');

      expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
      expect(fs.readlinkSync(planted)).toBe(victim);
    });

    test('gives every save a temporary file of its own, so two can run at once', () => {
      const rename = fs.renameSync;
      const renames = jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce((from, to) => {
        saveCredentials(OLD);
        rename(from, to);
      });

      saveCredentials(NEW);

      expect(renames).toHaveBeenCalledTimes(2);
      expect(loadCredentials()).toEqual(NEW);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test.each(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'EXDEV', 'ENOENT', 'ENAMETOOLONG'])(
      'writes the file in place when the rename fails with %s',
      (code) => {
        saveCredentials(OLD);
        fs.chmodSync(credentials(), 0o644);
        jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw failure(code); });

        saveCredentials(NEW);

        expect(loadCredentials()).toEqual(NEW);
        expect(fs.statSync(credentials()).mode % 0o1000).toBe(0o600);
        expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
      },
    );

    test('writes the file in place when the temporary file cannot be created', () => {
      saveCredentials(OLD);
      jest.spyOn(nodeFs, 'openSync').mockImplementationOnce(() => { throw failure('EACCES'); });

      saveCredentials(NEW);

      expect(loadCredentials()).toEqual(NEW);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('writes the file in place in a directory that takes no new file', () => {
      saveCredentials(OLD);
      fs.chmodSync(credentials(), 0o644);
      fs.chmodSync(tmpDir, 0o500);
      try {
        saveCredentials(NEW);
      } finally {
        fs.chmodSync(tmpDir, 0o700);
      }

      expect(loadCredentials()).toEqual(NEW);
      expect(fs.statSync(credentials()).mode % 0o1000).toBe(0o600);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test.each([
      ['writes a file in place', true],
      ['creates a file in place', false],
    ])('%s whose name is too long to take the suffix of the temporary file', (_how, exists) => {
      const file = path.join(tmpDir, `${'n'.repeat(250)}.json`);
      if (exists) {
        fs.writeFileSync(file, 'old');
        fs.chmodSync(file, 0o644);
      }

      writeSecretFile(file, 'new');

      expect(fs.readFileSync(file, 'utf-8')).toBe('new');
      expect(fs.statSync(file).mode % 0o1000).toBe(0o600);
      expect(fs.readdirSync(tmpDir)).toEqual([path.basename(file)]);
    });

    test('makes a file owner-only before it writes the new content in place', () => {
      saveCredentials(OLD);
      fs.chmodSync(credentials(), 0o644);
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw failure('EBUSY'); });
      const write = fs.writeFileSync;
      const modes: number[] = [];
      jest.spyOn(nodeFs, 'writeFileSync').mockImplementation((file, data, options) => {
        if (file === credentials()) modes.push(fs.statSync(credentials()).mode % 0o1000);
        write(file, data, options);
      });

      saveCredentials(NEW);

      expect(modes).toEqual([0o600]);
    });

    test.each([
      ["writes the user's own file in place", { user: 1000, file: 1000 }, NEW],
      ['leaves the file of another user alone', { user: 1000, file: 2000 }, OLD],
      ['writes the file of another user in place when the user is root', { user: 0, file: 2000 }, NEW],
      ['writes the file in place where there are no user ids', { user: undefined, file: 2000 }, NEW],
    ])('%s, when the file cannot be replaced', (_rule, ids, expected) => {
      saveCredentials(OLD);
      runAs(ids.user);
      report('lstatSync', credentials(), { uid: ids.file });
      const error = failure('EPERM');
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw error; });

      if (expected === OLD) {
        expect(() => saveCredentials(NEW)).toThrow(error);
      } else {
        saveCredentials(NEW);
      }

      expect(loadCredentials()).toEqual(expected);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('creates the file in place when none was there and it cannot be put in place by a rename', () => {
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw failure('EXDEV'); });

      saveCredentials(NEW);

      expect(loadCredentials()).toEqual(NEW);
      expect(fs.statSync(credentials()).mode % 0o1000).toBe(0o600);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('does not write through an entry that appeared where no file was', () => {
      const victim = path.join(tmpDir, 'victim');
      fs.writeFileSync(victim, 'untouched');
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce((_from, to) => {
        fs.symlinkSync(victim, String(to));
        throw failure('EPERM');
      });

      expect(() => saveCredentials(NEW)).toThrow('EEXIST');

      expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
      expect(fs.readdirSync(tmpDir).sort()).toEqual(['credentials.json', 'victim']);
    });

    test('replaces the file that a symbolic link names, and keeps the link', () => {
      const elsewhere = path.join(tmpDir, 'dotfiles', 'credentials.json');
      const between = path.join(tmpDir, 'current.json');
      fs.mkdirSync(path.dirname(elsewhere));
      fs.writeFileSync(elsewhere, JSON.stringify(OLD));
      fs.chmodSync(elsewhere, 0o644);
      fs.symlinkSync(path.join('dotfiles', 'credentials.json'), between);
      fs.symlinkSync('current.json', credentials());
      // On macOS the temporary directory is itself behind a link.
      const real = fs.realpathSync(elsewhere);
      const rename = fs.renameSync;
      const atRename: unknown[] = [];
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce((from, to) => {
        atRename.push({ read: loadCredentials(), from: path.dirname(String(from)), to });
        rename(from, to);
      });

      saveCredentials(NEW);

      expect(atRename).toEqual([{ read: OLD, from: path.dirname(real), to: real }]);
      expect(fs.readlinkSync(credentials())).toBe('current.json');
      expect(fs.readlinkSync(between)).toBe(path.join('dotfiles', 'credentials.json'));
      expect(loadCredentials()).toEqual(NEW);
      expect(fs.statSync(elsewhere).mode % 0o1000).toBe(0o600);
      expect(fs.readdirSync(path.dirname(elsewhere))).toEqual(['credentials.json']);
    });

    test('writes the file that a symbolic link names in place when its directory takes no new file', () => {
      const elsewhere = path.join(tmpDir, 'dotfiles', 'credentials.json');
      fs.mkdirSync(path.dirname(elsewhere));
      fs.writeFileSync(elsewhere, JSON.stringify(OLD));
      fs.chmodSync(elsewhere, 0o644);
      fs.symlinkSync(elsewhere, credentials());
      fs.chmodSync(path.dirname(elsewhere), 0o500);
      try {
        saveCredentials(NEW);
      } finally {
        fs.chmodSync(path.dirname(elsewhere), 0o700);
      }

      expect(fs.readlinkSync(credentials())).toBe(elsewhere);
      expect(loadCredentials()).toEqual(NEW);
      expect(fs.statSync(elsewhere).mode % 0o1000).toBe(0o600);
      expect(fs.readdirSync(path.dirname(elsewhere))).toEqual(['credentials.json']);
    });

    test('writes through a symbolic link that leads nowhere', () => {
      const elsewhere = path.join(tmpDir, 'not-there-yet.json');
      fs.symlinkSync(elsewhere, credentials());

      saveCredentials(NEW);

      expect(fs.readlinkSync(credentials())).toBe(elsewhere);
      expect(JSON.parse(fs.readFileSync(elsewhere, 'utf-8'))).toEqual(NEW);
      expect(fs.statSync(elsewhere).mode % 0o1000).toBe(0o600);
    });

    test('writes through a symbolic link whose file has no path, and makes that file owner-only', () => {
      const elsewhere = path.join(tmpDir, 'elsewhere.json');
      fs.writeFileSync(elsewhere, '{}');
      fs.chmodSync(elsewhere, 0o644);
      fs.symlinkSync(elsewhere, credentials());
      jest.spyOn(nodeFs, 'realpathSync').mockImplementationOnce(() => { throw failure('ENOENT'); });

      saveCredentials(NEW);

      expect(fs.readlinkSync(credentials())).toBe(elsewhere);
      expect(JSON.parse(fs.readFileSync(elsewhere, 'utf-8'))).toEqual(NEW);
      expect(fs.statSync(elsewhere).mode % 0o1000).toBe(0o600);
    });

    test('writes through a symbolic link that names a device, and leaves the device as it is', () => {
      const device = fs.statSync('/dev/null');
      fs.symlinkSync('/dev/null', credentials());

      saveCredentials(NEW);

      expect(fs.readlinkSync(credentials())).toBe('/dev/null');
      expect(fs.statSync('/dev/null').isCharacterDevice()).toBe(true);
      expect(fs.statSync('/dev/null').mode).toBe(device.mode);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('writes a file that is named by one of its open descriptors, /dev/fd/N', () => {
      // On macOS /dev/fd/N is the open file itself and no file can be created beside it; on Linux it is a symbolic link to the file.
      const file = path.join(tmpDir, 'bundle.json');
      const fd = fs.openSync(file, 'w', 0o644);
      try {
        const link = fs.lstatSync(`/dev/fd/${fd}`).isSymbolicLink();

        writeSecretFile(`/dev/fd/${fd}`, 'new');

        expect(fs.readFileSync(file, 'utf-8')).toBe('new');
        expect(fs.statSync(file).mode % 0o1000).toBe(0o600);
        expect(fs.fstatSync(fd).ino === fs.statSync(file).ino).toBe(!link);
        expect(fs.readdirSync(tmpDir)).toEqual(['bundle.json']);
      } finally {
        fs.closeSync(fd);
      }
    });

    test.each([
      ['follows a symbolic link that the user made', { user: 1000, link: 1000, directory: 2000, names: 1 }, undefined],
      ['follows a symbolic link that root made', { user: 1000, link: 0, directory: 2000, names: 1 }, undefined],
      ['follows a symbolic link that the owner of its directory made', { user: 1000, link: 2000, directory: 2000, names: 1 }, undefined],
      ['refuses a symbolic link that another user made', { user: 1000, link: 3000, directory: 2000, names: 1 }, ANOTHER_USER],
      ['refuses a symbolic link that another user made when the user is root', { user: 0, link: 3000, directory: 2000, names: 1 }, ANOTHER_USER],
      ["refuses a symbolic link of root's that has a second name", { user: 1000, link: 0, directory: 2000, names: 2 }, SECOND_NAME],
      ['follows any symbolic link where there are no user ids', { user: undefined, link: 3000, directory: 2000, names: 2 }, undefined],
    ])('%s', (_rule, ids, reason) => {
      const elsewhere = path.join(tmpDir, 'elsewhere.json');
      fs.writeFileSync(elsewhere, JSON.stringify(OLD));
      fs.symlinkSync(elsewhere, credentials());
      runAs(ids.user);
      report('lstatSync', credentials(), { uid: ids.link, nlink: ids.names });
      report('statSync', tmpDir, { uid: ids.directory });

      if (reason) {
        expect(() => saveCredentials(NEW)).toThrow(refusal(credentials(), 'symbolic link', reason));
      } else {
        saveCredentials(NEW);
      }

      expect(JSON.parse(fs.readFileSync(elsewhere, 'utf-8'))).toEqual(reason ? OLD : NEW);
      expect(fs.readdirSync(tmpDir).sort()).toEqual(['credentials.json', 'elsewhere.json']);
    });

    test.each([
      ['writes to a FIFO that the user made', { uid: 1000 }, undefined],
      ['refuses a FIFO that another user made', { uid: 3000 }, ANOTHER_USER],
      ['refuses a FIFO that has a second name', { uid: 1000, nlink: 2 }, SECOND_NAME],
    ])('%s', (_rule, reported, reason) => {
      execFileSync('mkfifo', [credentials()]);
      // eslint-disable-next-line no-bitwise
      const reader = fs.openSync(credentials(), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        runAs(1000);
        report('lstatSync', credentials(), reported);
        report('statSync', tmpDir, { uid: 2000 });

        if (reason) {
          expect(() => writeSecretFile(credentials(), 'new')).toThrow(refusal(credentials(), 'FIFO', reason));
        } else {
          writeSecretFile(credentials(), 'new');
        }

        const received = Buffer.alloc(8);
        expect(received.toString('utf-8', 0, fs.readSync(reader, received))).toBe(reason ? '' : 'new');
      } finally {
        fs.closeSync(reader);
      }
    });

    test('refuses a directory that belongs to another user', () => {
      fs.mkdirSync(credentials());
      runAs(1000);
      report('lstatSync', credentials(), { uid: 3000 });
      report('statSync', tmpDir, { uid: 2000 });

      expect(() => writeSecretFile(credentials(), 'new')).toThrow(refusal(credentials(), 'entry', ANOTHER_USER));
    });

    test('writes to a device whoever it belongs to and however many names it has', () => {
      const mode = fs.statSync('/dev/null').mode;
      runAs(1000);
      report('lstatSync', '/dev/null', { uid: 3000, nlink: 2 });
      report('statSync', '/dev', { uid: 2000 });

      writeSecretFile('/dev/null', 'new');

      expect(fs.statSync('/dev/null').mode).toBe(mode);
    });

    test('does not take the link count of a directory for a second name', () => {
      fs.mkdirSync(credentials());
      runAs(1000);
      report('lstatSync', credentials(), { uid: 1000, nlink: 2 });

      expect(() => saveCredentials(NEW)).toThrow('EISDIR');
    });
  });
});
