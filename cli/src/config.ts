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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliError } from './errors';
import { CliConfig, Credentials } from './types';

const CONFIG_DIR_ENV = 'BGAGENT_CONFIG_DIR';
const CONFIG_FILE = 'config.json';
const CREDENTIALS_FILE = 'credentials.json';

const SECRET_FILE_MODE = 0o600;

/** Returns the config directory path (~/.bgagent or BGAGENT_CONFIG_DIR). */
export function getConfigDir(): string {
  return process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), '.bgagent');
}

function configPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE);
}

function credentialsPath(): string {
  return path.join(getConfigDir(), CREDENTIALS_FILE);
}

/** Create the config directory, owner-only, unless it exists. */
export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load CLI configuration. Throws if not configured: there is no config file. A file that
 * cannot be read or parsed is reported with its path and the reason, not as missing.
 */
export function loadConfig(): CliConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new CliError('Not configured. Run `bgagent configure` first.');
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CliConfig;
  } catch (err) {
    throw new CliError(
      `Cannot read the config file ${p}: ${(err as Error).message}. `
      + 'Fix or remove the file, or run `bgagent configure` to replace it.',
    );
  }
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
}

/** Load existing CLI config if present, else return null (no error). */
export function tryLoadConfig(): CliConfig | null {
  const p = configPath();
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CliConfig;
  } catch {
    return null; // nosemgrep: ts-silent-success-masking -- corrupt config file treated as absent; caller falls back to configure flow
  }
}

/** Load cached credentials. Returns null if no credentials file exists.
 *  A corrupt (non-JSON) credentials file throws a ``CliError`` pointing the
 *  user at ``bgagent login``. */
export function loadCredentials(): Credentials | null {
  const p = credentialsPath();
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Credentials;
  } catch {
    throw new CliError('Credentials file is corrupt. Run `bgagent login` to re-authenticate.');
  }
}

export function clearCredentials(): void {
  fs.rmSync(credentialsPath(), { force: true });
}

/**
 * What a file system answers when a file cannot be replaced although it may still be
 * written. EACCES, EPERM, EROFS: its directory takes no new file, or lets none be renamed
 * there. EBUSY, EXDEV: the file is a mount point (a single file mounted into a
 * container), or the rename would cross file systems. ENOENT: no file can be created
 * beside it. ENAMETOOLONG: its name or its path is too long to take the suffix of the
 * temporary file.
 */
const CANNOT_REPLACE = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'EXDEV', 'ENOENT', 'ENAMETOOLONG']);

const ROOT_UID = 0;

/**
 * Write a file that only its owner may read, whether it is new or already there.
 *
 * The content goes to a temporary file beside it and a rename puts that in place: a
 * reader gets the old file or the new one, never a truncated one (#1080). A symbolic
 * link is resolved first, so the file it names is the one replaced and the link stays a
 * link.
 *
 * Three kinds of target are written in place instead: a file that cannot be replaced
 * (CANNOT_REPLACE), a device such as /dev/null or a FIFO, and a symbolic link that does
 * not resolve to a regular file. For a file written this way the race of #1080 remains:
 * a reader can still get it truncated.
 *
 * These rules are applied to what is found at the path before anything is written:
 * - a symbolic link, a FIFO, a socket or a directory is refused unless it belongs to the
 *   user, to root or to the owner of its directory; so is one that has a second name, a
 *   hard link. A device is written whoever it belongs to. Only the entry at the path is
 *   held to this, not what a link there leads to;
 * - a regular file that cannot be replaced is written in place only if it is the user's
 *   own or the user is root, and it is made owner-only before the content goes in;
 * - where nothing was found and the file cannot be put in place by a rename, it is
 *   created exclusively, so an entry that appeared since is not written through.
 * Where there are no user ids (Windows), nothing is refused for its owner or its names,
 * and a file that cannot be replaced is written in place whoever it belongs to.
 *
 * A process killed between the write and the rename leaves the temporary file,
 * `<file>.<pid>.<uuid>.tmp`, beside the file it was to replace: owner-only, holding the
 * content that was being written. Nothing removes it later.
 */
export function writeSecretFile(file: string, content: string): void {
  let destination = file;
  let target = fs.lstatSync(file, { throwIfNoEntry: false });
  if (target && !target.isFile()) refuseEntryOfAnotherUser(file, target);
  if (target?.isSymbolicLink()) {
    try {
      destination = fs.realpathSync(file);
      target = fs.lstatSync(destination);
    } catch {
      // The link leads nowhere, or to a file that has no path: written through it below.
    }
  }
  if (!target || target.isFile()) {
    try {
      replaceFile(destination, content);
    } catch (err) {
      if (!CANNOT_REPLACE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      if (!target) {
        fs.writeFileSync(destination, content, { mode: SECRET_FILE_MODE, flag: 'wx' });
      } else if (mayWriteInPlace(target)) {
        fs.chmodSync(destination, SECRET_FILE_MODE);
        fs.writeFileSync(destination, content, { mode: SECRET_FILE_MODE });
      } else {
        throw err;
      }
    }
    return;
  }
  // writeFileSync only honors `mode` when CREATING the file.
  fs.writeFileSync(file, content, { mode: SECRET_FILE_MODE });
  if (fs.statSync(file).isFile()) {
    fs.chmodSync(file, SECRET_FILE_MODE);
  }
}

/**
 * A hard link can be given to an entry of someone else's, whose owner then does not tell
 * who put it there: Linux allows that unless fs.protected_hardlinks is set. The link
 * count of a directory is not a count of names.
 */
function refuseEntryOfAnotherUser(entry: string, stats: fs.Stats): void {
  const user = process.geteuid?.();
  if (user === undefined || stats.isCharacterDevice() || stats.isBlockDevice()) return;
  const known = stats.uid === user || stats.uid === ROOT_UID || stats.uid === fs.statSync(path.dirname(entry)).uid;
  const oneName = stats.nlink <= 1 || stats.isDirectory();
  if (known && oneName) return;
  const kind = stats.isSymbolicLink() ? 'symbolic link' : stats.isFIFO() ? 'FIFO' : 'entry';
  const reason = known ? 'has more than one name, so someone else may have put it there' : 'belongs to another user';
  throw new CliError(`Refusing to write to ${entry}: the ${kind} there ${reason}. Remove it, or choose another path.`);
}

function mayWriteInPlace(stats: fs.Stats): boolean {
  const user = process.geteuid?.();
  return user === undefined || user === ROOT_UID || stats.uid === user;
}

function replaceFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', SECRET_FILE_MODE);
  try {
    try {
      fs.writeFileSync(fd, content);
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // The error of the write is the one to report.
      }
      throw err;
    }
    fs.closeSync(fd);
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The error of the write, of the close or of the rename is the one to report.
    }
    throw err;
  }
}

/** Save credentials with restricted permissions. */
export function saveCredentials(creds: Credentials): void {
  ensureConfigDir();
  writeSecretFile(credentialsPath(), JSON.stringify(creds, null, 2) + '\n');
}
