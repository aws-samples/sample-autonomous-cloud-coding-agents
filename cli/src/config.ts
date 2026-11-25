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
 * Write a file that only its owner may read, whether it is new or already there.
 * Another bgagent process may be reading it, so the content goes to a temporary file
 * that replaces the target in one step: a reader gets the old file or the new one,
 * never a truncated one (#1080).
 */
export function writeSecretFile(file: string, content: string): void {
  const target = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!target || target.isFile()) {
    // Created exclusively, under a name that cannot be guessed: a path the user chose may
    // be in a directory that others can write to, and a link planted there is not followed.
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, content, { mode: SECRET_FILE_MODE, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return;
  }
  // A device such as /dev/null, a FIFO or a symbolic link is written in place: a rename
  // would replace the node or the link itself. writeFileSync only honors `mode` when
  // CREATING the file, so chmod what the path resolves to, if that is a regular file.
  fs.writeFileSync(file, content, { mode: SECRET_FILE_MODE });
  if (fs.statSync(file).isFile()) {
    fs.chmodSync(file, SECRET_FILE_MODE);
  }
}

/** Save credentials with restricted permissions. */
export function saveCredentials(creds: Credentials): void {
  ensureConfigDir();
  writeSecretFile(credentialsPath(), JSON.stringify(creds, null, 2) + '\n');
}
