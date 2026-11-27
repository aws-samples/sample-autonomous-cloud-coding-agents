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

/** Owner-only read/write — credentials must never be group/world readable. */
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
 * cannot be read or parsed is reported with its path and the reason, not as missing:
 * `bgagent configure` would replace a file that may only need a repair.
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

/** Save CLI configuration. */
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
 *  user at ``bgagent login`` rather than surfacing a raw ``SyntaxError``. */
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

/** Remove cached credentials, e.g. when the CLI is re-pointed at another stack's user pool. */
export function clearCredentials(): void {
  fs.rmSync(credentialsPath(), { force: true });
}

/**
 * What a file system answers when a file cannot be replaced although it may still be
 * written. EACCES, EPERM, EROFS: its directory takes no new file, or lets none be renamed
 * there. EBUSY, EXDEV: the file is a mount point (a single file mounted into a
 * container), or the rename would cross file systems. ENOENT: no file can be created
 * beside it, as beside /dev/fd/1 on macOS, which /dev/stdout leads to. ENAMETOOLONG: its
 * name or its path is too long to take the suffix of the temporary file.
 */
const CANNOT_REPLACE = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'EXDEV', 'ENOENT', 'ENAMETOOLONG']);

const ROOT_UID = 0;

/**
 * Write a file that only its owner may read, whether it is new or already there.
 *
 * Another bgagent process may be reading the file, so the content goes to a temporary file
 * beside it and a rename puts that in place: a reader gets the old file or the new one,
 * never a truncated one (#1080). A symbolic link is resolved first, so the file it names
 * is the one replaced and the link stays a link.
 *
 * Three kinds of target are written in place instead: a file that cannot be replaced
 * (CANNOT_REPLACE), a device such as /dev/null or a FIFO, and a symbolic link that does
 * not resolve to a regular file. For a file written this way the race of #1080 remains:
 * a reader can still get it truncated.
 *
 * The path may be one the user chose in a directory that others can write to, as with
 * `replay --output` in /tmp. These rules are applied to what is found at the path before
 * anything is written:
 * - a symbolic link, a FIFO, a socket or a directory is refused unless it belongs to the
 *   user, to root or to the owner of its directory; so is one that has a second name, a
 *   hard link. A device is written whoever it belongs to: only a privileged user can make
 *   one. Only the entry at the path is held to this, not what a link there leads to
 *   (refuseEntryOfAnotherUser);
 * - a regular file that cannot be replaced is written in place only if it is the user's
 *   own or the user is root, and it is made owner-only before the content goes in
 *   (mayWriteInPlace);
 * - where nothing was found and the file cannot be put in place by a rename, it is
 *   created exclusively, so an entry that appeared since is not written through.
 * Where there are no user ids (Windows), nothing is refused for its owner or its names,
 * and a file that cannot be replaced is written in place whoever it belongs to. On every
 * system, an entry that someone put under the temporary name is neither written through
 * nor removed (replaceFile).
 *
 * The entry is looked at first and used afterwards, by its name: a link is resolved then,
 * and a write in place, except for the exclusive creation, lands in whatever is under the
 * name by then and follows a link that was put there in between. In a directory with the
 * sticky bit, as /tmp has, only the owner of an entry, the owner of the directory and
 * root can put something else under its name. What is resolved or written in place can
 * therefore be exchanged there only by the user, by root or by the owner of the
 * directory, with one exception: the file of another user that root writes in place can
 * be exchanged by its owner. In a directory that others can write to and that has no
 * sticky bit, anyone who may write to it can exchange any entry, the user's own file
 * included, and can remove the temporary file, which makes the replacement fail and
 * brings on the write in place.
 *
 * A process killed between the write and the rename leaves the temporary file,
 * `<file>.<pid>.<uuid>.tmp`, beside the file it was to replace: owner-only, holding the
 * content that was being written. Nothing removes it later.
 */
export function writeSecretFile(file: string, content: string | Uint8Array): void {
  prepareSecretFile(file)(content);
}

export function prepareSecretFile(file: string): (content: string | Uint8Array) => void {
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
  const found = target;
  if (!found || found.isFile()) {
    return (content) => {
      try {
        replaceFile(destination, content);
      } catch (err) {
        if (!CANNOT_REPLACE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
        // In place, by the rules above: nothing was there, or it is a file this user may write.
        if (!found) {
          fs.writeFileSync(destination, content, { mode: SECRET_FILE_MODE, flag: 'wx' });
        } else if (mayWriteInPlace(found)) {
          fs.chmodSync(destination, SECRET_FILE_MODE);
          fs.writeFileSync(destination, content, { mode: SECRET_FILE_MODE });
        } else {
          throw err;
        }
      }
    };
  }
  // A device, a FIFO, or a link that does not resolve to a regular file: a rename would
  // replace the node or the link itself. writeFileSync only honors `mode` when CREATING
  // the file, so chmod what the path resolves to, if that is a regular file.
  return (content) => {
    fs.writeFileSync(file, content, { mode: SECRET_FILE_MODE });
    if (fs.statSync(file).isFile()) {
      fs.chmodSync(file, SECRET_FILE_MODE);
    }
  };
}

/**
 * Refuse an entry that is not a regular file if it belongs to another user or has a
 * second name. In a directory that others can write to, anyone can put a link there to
 * send the content elsewhere or a FIFO to read it, and can put a link in the place of a
 * FIFO, a socket or a directory of their own after it was looked at. A device is not
 * held to this: only a privileged user can make one, so a device at the path is not
 * something that another user put there. Two rules, neither of which applies where
 * there are no user ids (Windows):
 * - the entry belongs to the user, to root or to the owner of the directory it is in.
 *   Linux refuses any other link or FIFO itself in a sticky world-writable directory
 *   where fs.protected_symlinks and fs.protected_fifos are set; this rule holds in every
 *   directory.
 * - the entry has one name only. A second name (a hard link) can be given to an entry of
 *   someone else's, and its owner then does not tell who put it there: macOS lets a user
 *   do that with a symbolic link of root's, and Linux does unless fs.protected_hardlinks
 *   is set. A directory is not held to this: its link count is not a count of names.
 * Only the entry at the path itself is examined, not what a link leads to.
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

/**
 * Whether a regular file that cannot be replaced may be written in place: the user's own,
 * and for root any file, because a file mounted into a container often belongs to a user
 * of the host. The file of another user is left alone. In a directory with the sticky
 * bit, such as /tmp, its owner can put something else under its name at any moment, a
 * link for example, and the write would go there; to the user's own file only root and
 * the owner of the directory can do that. Root has no such protection: the owner of a
 * file that root writes in place can still put a link under its name, and the write
 * follows it. Where there are no user ids (Windows), any file.
 */
function mayWriteInPlace(stats: fs.Stats): boolean {
  const user = process.geteuid?.();
  return user === undefined || user === ROOT_UID || stats.uid === user;
}

/**
 * Put `content` in the place of `file` in one step. The temporary file is created
 * exclusively, under a name that cannot be guessed and with its final mode. After a
 * failure it is removed if it can be, and it is this call's own to remove: an entry that
 * someone else put under that name makes the open fail, and is neither written through
 * nor removed. The error thrown is the first one. An error of what follows it, the close
 * after a failed write or the removal, is not reported: if the removal fails, the
 * temporary file stays, owner-only.
 */
function replaceFile(file: string, content: string | Uint8Array): void {
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
