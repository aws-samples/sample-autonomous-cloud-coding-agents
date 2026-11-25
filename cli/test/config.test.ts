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
import { loadConfig, loadCredentials, saveConfig, saveCredentials } from '../src/config';
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

    // Not "Not configured": that sends the user to `bgagent configure`, which replaces a file
    // that may only need a repair, without a word that the file was there.
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
      // 0o600 = owner read+write only (octal 600 = decimal 384)
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    });

    test('tightens a credentials file that already exists with loose permissions', () => {
      // Restored from a backup, copied from another machine, or created by
      // another tool: the file is there before the first save, world-readable.
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

  // One bgagent process saves a refreshed token while others read the file (#1080).
  describe('writing the credentials file', () => {
    const OLD = { id_token: 'old-id', refresh_token: 'old-refresh', token_expiry: '2026-01-01T00:00:00.000Z' };
    const NEW = { id_token: 'new-id', refresh_token: 'new-refresh', token_expiry: '2026-02-01T00:00:00.000Z' };
    // `import * as fs` is a read-only view of the module, here and in config.ts: a spy goes on the module itself.
    const nodeFs = jest.requireActual<typeof fs>('fs');

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('replaces the file in one step, so a reader gets the old login or the new one', () => {
      saveCredentials(OLD);
      const rename = fs.renameSync;
      const atRename: unknown[] = [];
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce((from, to) => {
        // A rename is one step only within a file system: the new file waits beside the old one,
        // whole and owner-only, while a reader still gets the old login.
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

    test('keeps the old file and leaves no temporary file when the replacement fails', () => {
      saveCredentials(OLD);
      jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename failed'); });

      expect(() => saveCredentials(NEW)).toThrow('rename failed');

      expect(loadCredentials()).toEqual(OLD);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('refuses a temporary name that is taken instead of writing through it', () => {
      // A path the user chose can be in a directory that others may write to: a link
      // planted under the temporary name must not send the secret where it points.
      const victim = path.join(tmpDir, 'victim');
      fs.writeFileSync(victim, 'untouched');
      const write = fs.writeFileSync;
      jest.spyOn(nodeFs, 'writeFileSync').mockImplementationOnce((file, data, options) => {
        fs.symlinkSync(victim, String(file));
        write(file, data, options);
      });

      expect(() => saveCredentials(NEW)).toThrow('EEXIST');

      expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
    });

    test('gives every save a temporary file of its own, so two can run at once', () => {
      // The process id alone does not tell two saves apart: containers that share the
      // directory can give the same one to both.
      const rename = fs.renameSync;
      const renames = jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce((from, to) => {
        // Another save, start to finish, while this one waits to rename.
        saveCredentials(OLD);
        rename(from, to);
      });

      saveCredentials(NEW);

      expect(renames).toHaveBeenCalledTimes(2);
      expect(loadCredentials()).toEqual(NEW);
      expect(fs.readdirSync(tmpDir)).toEqual(['credentials.json']);
    });

    test('writes through a symbolic link instead of replacing it', () => {
      // A dotfiles setup keeps credentials.json elsewhere and links to it.
      const link = path.join(tmpDir, 'credentials.json');
      const elsewhere = path.join(tmpDir, 'elsewhere.json');
      fs.writeFileSync(elsewhere, '{}');
      fs.chmodSync(elsewhere, 0o644);
      fs.symlinkSync(elsewhere, link);

      saveCredentials(NEW);

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(elsewhere, 'utf-8'))).toEqual(NEW);
      expect(fs.statSync(elsewhere).mode % 0o1000).toBe(0o600);
    });
  });
});
