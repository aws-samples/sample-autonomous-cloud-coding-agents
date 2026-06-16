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

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
}));

// The per-tenant verification path delegates the registry-row and OAuth-secret
// lookups to the resolver's *strict* helpers (which rethrow on infra error).
// Mock them so each verifyJiraRequestForTenant branch is driven directly.
const getRegistryRowStrict = jest.fn();
const getOauthSecretStrict = jest.fn();
jest.mock('../../../src/handlers/shared/jira-oauth-resolver', () => ({
  getRegistryRowStrict: (...args: unknown[]) => getRegistryRowStrict(...args),
  getOauthSecretStrict: (...args: unknown[]) => getOauthSecretStrict(...args),
}));

import {
  CLOCK_SKEW_ALLOWANCE_MS,
  getJiraSecret,
  invalidateJiraSecretCache,
  isWebhookTimestampFresh,
  MAX_WEBHOOK_EVENT_AGE_MS,
  verifyJiraRequest,
  verifyJiraRequestForTenant,
  verifyJiraSignature,
} from '../../../src/handlers/shared/jira-verify';

const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/jira/webhook';
const SECRET_VALUE = 'super-secret';
const REGISTRY_TABLE = 'JiraWorkspaceRegistry';
const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
const TENANT_SECRET = 'per-tenant-signing-secret';
const TENANT_OAUTH_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-jira-oauth-tenant';

/** Produce the `sha256=<hex>` header Atlassian sends, signed with `key`. */
function signedHeader(body: string, key = SECRET_VALUE): string {
  return `sha256=${crypto.createHmac('sha256', key).update(body).digest('hex')}`;
}

function rawHex(body: string, key: string): string {
  return crypto.createHmac('sha256', key).update(body).digest('hex');
}

describe('verifyJiraSignature', () => {
  const body = '{"webhookEvent":"jira:issue_created"}';

  test('accepts a valid sha256=-prefixed signature', () => {
    expect(verifyJiraSignature(SECRET_VALUE, signedHeader(body), body)).toBe(true);
  });

  test('accepts a bare hex digest (no algorithm prefix)', () => {
    expect(verifyJiraSignature(SECRET_VALUE, rawHex(body, SECRET_VALUE), body)).toBe(true);
  });

  test('rejects when the secret is wrong', () => {
    expect(verifyJiraSignature('wrong', signedHeader(body), body)).toBe(false);
  });

  test('rejects when the body has been tampered', () => {
    const sig = signedHeader(body);
    expect(verifyJiraSignature(SECRET_VALUE, sig, '{"webhookEvent":"jira:issue_deleted"}')).toBe(false);
  });

  test('rejects when the provided digest is the wrong byte length (timingSafeEqual would throw)', () => {
    expect(verifyJiraSignature(SECRET_VALUE, 'sha256=deadbeef', body)).toBe(false);
  });

  test('does NOT strip a non-sha256 prefix, so a sha1= header fails', () => {
    // The code only strips `sha256=`; a `sha1=`-prefixed value is compared
    // literally and must not validate.
    expect(verifyJiraSignature(SECRET_VALUE, `sha1=${rawHex(body, SECRET_VALUE)}`, body)).toBe(false);
  });

  // Empty/whitespace-secret fail-open guard: HMAC('', body) is computable by
  // anyone, so an empty signing secret must never produce an accepted
  // signature even when the attacker signs with that same empty key.
  test('rejects an empty webhookSecret even with a matching empty-key HMAC', () => {
    const forged = rawHex(body, '');
    expect(verifyJiraSignature('', forged, body)).toBe(false);
  });

  test('rejects a whitespace-only webhookSecret', () => {
    const forged = rawHex(body, '   ');
    expect(verifyJiraSignature('   ', forged, body)).toBe(false);
  });
});

describe('getJiraSecret', () => {
  beforeEach(() => {
    smSend.mockReset();
    invalidateJiraSecretCache(SECRET_ID);
  });

  test('returns the secret and caches it', async () => {
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    await expect(getJiraSecret(SECRET_ID)).resolves.toBe(SECRET_VALUE);
    // Second call served from cache — no second SM call.
    await expect(getJiraSecret(SECRET_ID)).resolves.toBe(SECRET_VALUE);
    expect(smSend).toHaveBeenCalledTimes(1);
  });

  test('returns null when SecretString is missing', async () => {
    smSend.mockResolvedValueOnce({});
    await expect(getJiraSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('returns null when SecretString is the empty string', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '' });
    await expect(getJiraSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('returns null when SecretString is whitespace-only', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '   ' });
    await expect(getJiraSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('returns null on ResourceNotFoundException', async () => {
    smSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
    await expect(getJiraSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('rethrows other Secrets Manager errors', async () => {
    smSend.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(getJiraSecret(SECRET_ID)).rejects.toThrow('throttled');
  });

  test('forceRefresh bypasses the cache', async () => {
    smSend.mockResolvedValueOnce({ SecretString: 'old' });
    smSend.mockResolvedValueOnce({ SecretString: 'new' });
    await expect(getJiraSecret(SECRET_ID)).resolves.toBe('old');
    await expect(getJiraSecret(SECRET_ID, true)).resolves.toBe('new');
    expect(smSend).toHaveBeenCalledTimes(2);
  });
});

describe('verifyJiraRequest (stack-wide secret)', () => {
  beforeEach(() => {
    smSend.mockReset();
    invalidateJiraSecretCache(SECRET_ID);
  });

  test('verifies against the cached secret', async () => {
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    const body = '{"webhookEvent":"jira:issue_created"}';
    await expect(verifyJiraRequest(SECRET_ID, signedHeader(body), body)).resolves.toBe(true);
  });

  test('re-fetches once after rotation and verifies with the fresh secret', async () => {
    const body = '{"webhookEvent":"jira:issue_created"}';
    smSend.mockResolvedValueOnce({ SecretString: 'rotated-out' });
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    await expect(verifyJiraRequest(SECRET_ID, signedHeader(body), body)).resolves.toBe(true);
    expect(smSend).toHaveBeenCalledTimes(2);
  });

  test('returns false when the fresh secret matches the cached one (no rotation)', async () => {
    const body = '{"webhookEvent":"jira:issue_created"}';
    smSend.mockResolvedValueOnce({ SecretString: 'wrong' });
    smSend.mockResolvedValueOnce({ SecretString: 'wrong' });
    await expect(verifyJiraRequest(SECRET_ID, signedHeader(body), body)).resolves.toBe(false);
  });

  test('returns false when the stored secret is empty (end-to-end fail-closed)', async () => {
    const body = '{"webhookEvent":"jira:issue_created"}';
    // An attacker who knows the secret is empty would send HMAC('', body).
    const forged = `sha256=${rawHex(body, '')}`;
    smSend.mockResolvedValue({ SecretString: '' });
    await expect(verifyJiraRequest(SECRET_ID, forged, body)).resolves.toBe(false);
  });
});

describe('verifyJiraRequestForTenant (multi-tenant trust boundary)', () => {
  const body = '{"webhookEvent":"jira:issue_created","cloudId":"x"}';

  beforeEach(() => {
    smSend.mockReset();
    getRegistryRowStrict.mockReset();
    getOauthSecretStrict.mockReset();
  });

  test("returns 'no-per-tenant-secret' when the tenant has no registry row", async () => {
    getRegistryRowStrict.mockResolvedValueOnce(null);
    await expect(
      verifyJiraRequestForTenant(REGISTRY_TABLE, CLOUD_ID, signedHeader(body, TENANT_SECRET), body),
    ).resolves.toBe('no-per-tenant-secret');
    // Must not even look at the OAuth secret when there's no row.
    expect(getOauthSecretStrict).not.toHaveBeenCalled();
  });

  test("returns 'revoked' when the registry row status is not active", async () => {
    getRegistryRowStrict.mockResolvedValueOnce({
      jira_cloud_id: CLOUD_ID,
      site_url: 'https://x.atlassian.net',
      oauth_secret_arn: TENANT_OAUTH_ARN,
      status: 'revoked',
    });
    await expect(
      verifyJiraRequestForTenant(REGISTRY_TABLE, CLOUD_ID, signedHeader(body, TENANT_SECRET), body),
    ).resolves.toBe('revoked');
    expect(getOauthSecretStrict).not.toHaveBeenCalled();
  });

  test("returns 'no-per-tenant-secret' when the OAuth bundle has no webhook_signing_secret", async () => {
    getRegistryRowStrict.mockResolvedValueOnce({
      jira_cloud_id: CLOUD_ID,
      site_url: 'https://x.atlassian.net',
      oauth_secret_arn: TENANT_OAUTH_ARN,
      status: 'active',
    });
    getOauthSecretStrict.mockResolvedValueOnce({ access_token: 'a' /* no webhook_signing_secret */ });
    await expect(
      verifyJiraRequestForTenant(REGISTRY_TABLE, CLOUD_ID, signedHeader(body, TENANT_SECRET), body),
    ).resolves.toBe('no-per-tenant-secret');
  });

  test("returns 'verified' for a signature that matches the per-tenant secret", async () => {
    getRegistryRowStrict.mockResolvedValueOnce({
      jira_cloud_id: CLOUD_ID,
      site_url: 'https://x.atlassian.net',
      oauth_secret_arn: TENANT_OAUTH_ARN,
      status: 'active',
    });
    getOauthSecretStrict.mockResolvedValueOnce({ webhook_signing_secret: TENANT_SECRET });
    await expect(
      verifyJiraRequestForTenant(REGISTRY_TABLE, CLOUD_ID, signedHeader(body, TENANT_SECRET), body),
    ).resolves.toBe('verified');
  });

  test("returns 'mismatch' for a wrong signature against an active tenant (no stack-wide fallback)", async () => {
    getRegistryRowStrict.mockResolvedValueOnce({
      jira_cloud_id: CLOUD_ID,
      site_url: 'https://x.atlassian.net',
      oauth_secret_arn: TENANT_OAUTH_ARN,
      status: 'active',
    });
    getOauthSecretStrict.mockResolvedValueOnce({ webhook_signing_secret: TENANT_SECRET });
    await expect(
      verifyJiraRequestForTenant(REGISTRY_TABLE, CLOUD_ID, signedHeader(body, 'attacker-secret'), body),
    ).resolves.toBe('mismatch');
  });

  test('propagates (does not swallow) a strict registry-lookup infra error', async () => {
    // The strict helper rethrows so a transient DDB throttle can't silently
    // downgrade a per-tenant-secured tenant to the stack-wide secret.
    getRegistryRowStrict.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(
      verifyJiraRequestForTenant(REGISTRY_TABLE, CLOUD_ID, signedHeader(body, TENANT_SECRET), body),
    ).rejects.toThrow('throttled');
  });
});

describe('isWebhookTimestampFresh', () => {
  test('accepts a current timestamp', () => {
    expect(isWebhookTimestampFresh(Date.now())).toBe(true);
  });

  test('rejects a timestamp older than the replay window', () => {
    expect(isWebhookTimestampFresh(Date.now() - MAX_WEBHOOK_EVENT_AGE_MS - 1000)).toBe(false);
  });

  test('accepts a slightly-future timestamp within the clock-skew allowance', () => {
    expect(isWebhookTimestampFresh(Date.now() + CLOCK_SKEW_ALLOWANCE_MS - 1000)).toBe(true);
  });

  test('rejects a far-future timestamp beyond the clock-skew allowance', () => {
    // One-sided window: a crafted far-future timestamp must be rejected
    // (Math.abs would have let it through).
    expect(isWebhookTimestampFresh(Date.now() + CLOCK_SKEW_ALLOWANCE_MS + 60_000)).toBe(false);
  });

  test('rejects undefined and non-finite values', () => {
    expect(isWebhookTimestampFresh(undefined)).toBe(false);
    expect(isWebhookTimestampFresh(NaN)).toBe(false);
    expect(isWebhookTimestampFresh(Infinity)).toBe(false);
  });
});
