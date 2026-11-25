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
import * as os from 'os';
import * as path from 'path';
import { CliError } from './errors';
import { CliConfig, Credentials } from './types';

const CONFIG_DIR_ENV = 'BGAGENT_CONFIG_DIR';
const CONFIG_FILE = 'config.json';
const CREDENTIALS_FILE = 'credentials.json';

/** Owner-only read/write — credentials must never be group/world readable. */
const SECRET_FILE_MODE = 0o600;
const CONFIG_FILE_MODE = 0o644;
const PERMISSION_MODULUS = 0o10000;

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
  const p = configPath();
  const existing = fs.statSync(p, { throwIfNoEntry: false });
  replaceFile(p, JSON.stringify(config, null, 2) + '\n', CONFIG_FILE_MODE, existing && existing.mode % PERMISSION_MODULUS);
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

/** Write a file that only its owner may read, whether it is new or already there. */
export function writeSecretFile(file: string, content: string): void {
  replaceFile(file, content, SECRET_FILE_MODE, SECRET_FILE_MODE);
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

function replaceFile(file: string, content: string, createMode: number, setMode?: number): void {
  const target = regularFileTarget(file);
  if (!target) {
    fs.writeFileSync(file, content, { mode: createMode });
    return;
  }

  const temp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode: createMode, flag: 'wx' });
    if (setMode !== undefined) {
      fs.chmodSync(temp, setMode);
    }
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Save credentials with restricted permissions. */
export function saveCredentials(creds: Credentials): void {
  ensureConfigDir();
  writeSecretFile(credentialsPath(), JSON.stringify(creds, null, 2) + '\n');
}
