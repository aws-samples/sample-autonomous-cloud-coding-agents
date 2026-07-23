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
import { CliError } from './errors';

const REQUEST_TIMEOUT_MS = 5000;
const FORGE_WEBTRIGGER_SUFFIX = '.webtrigger.atlassian.app';
export const JIRA_APP_ACTOR_MIN_SECRET_LENGTH = 32;

export interface JiraAppActorIdentity {
  readonly account_id: string;
  readonly account_type: 'app';
  readonly display_name: string;
  readonly site_url: string;
}

export function validateJiraAppActorProxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('Forge proxy URL must be a valid HTTPS URL.');
  }
  if (
    url.protocol !== 'https:'
    || !url.hostname.endsWith(FORGE_WEBTRIGGER_SUFFIX)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.startsWith('/public/')
  ) {
    throw new CliError(
      'Forge proxy URL must be a v2 installation URL like '
      + '`https://<installation>.webtrigger.atlassian.app/public/<id>`.',
    );
  }
  return url.toString();
}

export function signJiraAppActorRequest(
  sharedSecret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${crypto
    .createHmac('sha256', sharedSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

function jiraSiteOrigin(value: string, description: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid');
    return url.origin;
  } catch {
    throw new CliError(`${description} must be a valid HTTPS Jira site URL.`);
  }
}

export async function probeJiraAppActor(args: {
  readonly proxyUrl: string;
  readonly sharedSecret: string;
  readonly cloudId: string;
  readonly siteUrl: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<JiraAppActorIdentity> {
  const proxyUrl = validateJiraAppActorProxyUrl(args.proxyUrl);
  if (args.sharedSecret.length < JIRA_APP_ACTOR_MIN_SECRET_LENGTH) {
    throw new CliError('Forge proxy shared secret must be at least 32 characters.');
  }

  const body = JSON.stringify({
    version: 1,
    operation: 'identity',
    cloud_id: args.cloudId,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (args.fetchImpl ?? fetch)(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bgagent-Timestamp': timestamp,
        'X-Bgagent-Signature': signJiraAppActorRequest(args.sharedSecret, timestamp, body),
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new CliError(
      `Forge app identity probe failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new CliError(`Forge app identity probe returned non-JSON: HTTP ${response.status}.`);
  }
  if (!response.ok) {
    throw new CliError(
      `Forge app identity probe failed: HTTP ${response.status} ${JSON.stringify(parsed).slice(0, 200)}. `
      + 'Verify the web-trigger URL, BGAGENT_PROXY_SECRET, app installation, and Jira scopes.',
    );
  }
  const value = parsed as Partial<JiraAppActorIdentity>;
  if (
    value.account_type !== 'app'
    || typeof value.account_id !== 'string'
    || value.account_id.length === 0
    || typeof value.display_name !== 'string'
    || value.display_name.length === 0
    || typeof value.site_url !== 'string'
    || value.site_url.length === 0
  ) {
    throw new CliError(
      'Forge identity probe did not return a Jira app actor. '
      + 'Refusing to configure a credential that could attribute writes to a human.',
    );
  }
  const actualSite = jiraSiteOrigin(value.site_url, 'Forge identity site_url');
  const expectedSite = jiraSiteOrigin(args.siteUrl, 'Stored Jira tenant site_url');
  if (actualSite !== expectedSite) {
    throw new CliError(
      `Forge app is installed on '${actualSite}', not the requested Jira tenant '${expectedSite}'.`,
    );
  }
  return value as JiraAppActorIdentity;
}
