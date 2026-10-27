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

/**
 * Deployment-specific settings, read at startup from `/config.json`.
 *
 * The CDK stack writes this file next to the bundle, so one prebuilt bundle
 * serves every deployment (no per-customer rebuild). None of these values are
 * secrets: the Cognito app client is a public client without a secret.
 */
interface CognitoAuthConfig {
  readonly mode: 'cognito';
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  /** Managed login domain, e.g. `https://my-factory.auth.us-east-1.amazoncognito.com`. */
  readonly domain: string;
}

interface MockAuthConfig {
  readonly mode: 'mock';
}

export interface RuntimeConfig {
  /** REST API base URL including the stage, e.g. `https://abc.execute-api.us-east-1.amazonaws.com/v1`. */
  readonly apiBaseUrl: string;
  /** Console-only API (issue picker). Absent on deployments without it; the picker then stays hidden. */
  readonly consoleApiBaseUrl?: string;
  readonly region: string;
  readonly auth: CognitoAuthConfig | MockAuthConfig;
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeConfigError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function requireHttpsUrl(value: string, where: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError(`${where} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') {
    throw new RuntimeConfigError(`${where} must use https`);
  }
  return value;
}

/**
 * Validates untrusted JSON into a RuntimeConfig. Fails closed: anything
 * unexpected, including mock auth outside a mock-mode dev build, is rejected.
 */
export function parseRuntimeConfig(value: unknown, allowMock: boolean = __MOCK__): RuntimeConfig {
  if (typeof value !== 'object' || value === null) {
    throw new RuntimeConfigError('config must be a JSON object');
  }
  const source = value as Record<string, unknown>;
  const auth = source.auth;
  if (typeof auth !== 'object' || auth === null) {
    throw new RuntimeConfigError('config.auth must be an object');
  }
  const authSource = auth as Record<string, unknown>;

  if (authSource.mode === 'mock') {
    if (!allowMock) throw new RuntimeConfigError('mock sign-in is only available in local mock mode');
    return {
      apiBaseUrl: requireString(source, 'apiBaseUrl', 'config'),
      ...(source.consoleApiBaseUrl === undefined ? {} : { consoleApiBaseUrl: requireString(source, 'consoleApiBaseUrl', 'config') }),
      region: requireString(source, 'region', 'config'),
      auth: { mode: 'mock' },
    };
  }
  if (authSource.mode !== 'cognito') {
    throw new RuntimeConfigError('config.auth.mode must be "cognito"');
  }
  return {
    apiBaseUrl: requireHttpsUrl(requireString(source, 'apiBaseUrl', 'config'), 'config.apiBaseUrl'),
    ...(source.consoleApiBaseUrl === undefined
      ? {}
      : { consoleApiBaseUrl: requireHttpsUrl(requireString(source, 'consoleApiBaseUrl', 'config'), 'config.consoleApiBaseUrl') }),
    region: requireString(source, 'region', 'config'),
    auth: {
      mode: 'cognito',
      userPoolId: requireString(authSource, 'userPoolId', 'config.auth'),
      userPoolClientId: requireString(authSource, 'userPoolClientId', 'config.auth'),
      domain: requireHttpsUrl(requireString(authSource, 'domain', 'config.auth'), 'config.auth.domain'),
    },
  };
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  const res = await fetchImpl('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new RuntimeConfigError(`could not load /config.json (HTTP ${res.status})`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RuntimeConfigError('/config.json is not valid JSON');
  }
  return parseRuntimeConfig(body);
}
