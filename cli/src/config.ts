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
import { CliError } from './errors';
import { CliConfig, Credentials } from './types';

const CONFIG_DIR_ENV = 'BGAGENT_CONFIG_DIR';
const CONFIG_FILE = 'config.json';
const CREDENTIALS_FILE = 'credentials.json';

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

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Load CLI configuration. Throws if not configured. */
export function loadConfig(): CliConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new CliError('Not configured. Run `bgagent configure` first.');
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as CliConfig;
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
    return null;
  }
}

/** Load cached credentials. Returns null if no credentials file exists. */
export function loadCredentials(): Credentials | null {
  const p = credentialsPath();
  if (!fs.existsSync(p)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Credentials;
}

/** Save credentials with restricted permissions. */
export function saveCredentials(creds: Credentials): void {
  ensureConfigDir();
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}
