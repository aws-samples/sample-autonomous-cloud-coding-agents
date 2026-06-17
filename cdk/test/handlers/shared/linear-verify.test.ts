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

import {
  getLinearSecret,
  invalidateLinearSecretCache,
  isWebhookTimestampFresh,
  MAX_WEBHOOK_TIMESTAMP_AGE_MS,
  verifyLinearRequest,
  verifyLinearSignature,
} from '../../../src/handlers/shared/linear-verify';

const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:123:secret:linear-webhook';
const SECRET_VALUE = 'super-secret';

function signed(body: string, key = SECRET_VALUE): string {
  return crypto.createHmac('sha256', key).update(body).digest('hex');
}

describe('verifyLinearSignature', () => {
  test('accepts a valid signature', () => {
    const body = '{"action":"create"}';
    expect(verifyLinearSignature(SECRET_VALUE, signed(body), body)).toBe(true);
  });

  test('rejects when signature mismatches', () => {
    const body = '{"action":"create"}';
    expect(verifyLinearSignature('wrong', signed(body), body)).toBe(false);
  });

  test('rejects when the body has been tampered', () => {
    const sig = signed('{"action":"create"}');
    expect(verifyLinearSignature(SECRET_VALUE, sig, '{"action":"CREATE"}')).toBe(false);
  });

  test('rejects when provided digest is the wrong byte length (timingSafeEqual would throw)', () => {
    const body = '{"action":"create"}';
    expect(verifyLinearSignature(SECRET_VALUE, 'deadbeef', body)).toBe(false);
  });

  // Empty-secret fail-open guard, mirroring verifyGitHubSignature (B2):
  // HMAC('', body) is computable by anyone — an empty secret must never
  // produce an accepted signature.
  test('rejects empty webhookSecret even with a matching empty-key HMAC', () => {
    const body = '{"action":"create"}';
    const forged = crypto.createHmac('sha256', '').update(body).digest('hex');
    expect(verifyLinearSignature('', forged, body)).toBe(false);
  });

  test('rejects whitespace-only webhookSecret', () => {
    const body = '{"action":"create"}';
    const forged = crypto.createHmac('sha256', '   ').update(body).digest('hex');
    expect(verifyLinearSignature('   ', forged, body)).toBe(false);
  });
});

describe('getLinearSecret', () => {
  beforeEach(() => {
    smSend.mockReset();
    invalidateLinearSecretCache(SECRET_ID);
  });

  test('returns the secret and caches it', async () => {
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    await expect(getLinearSecret(SECRET_ID)).resolves.toBe(SECRET_VALUE);
    // Second call served from cache — no second SM call.
    await expect(getLinearSecret(SECRET_ID)).resolves.toBe(SECRET_VALUE);
    expect(smSend).toHaveBeenCalledTimes(1);
  });

  test('returns null when SecretString is missing', async () => {
    smSend.mockResolvedValueOnce({});
    await expect(getLinearSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('returns null when SecretString is the empty string', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '' });
    await expect(getLinearSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('returns null when SecretString is whitespace-only', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '   ' });
    await expect(getLinearSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('returns null on ResourceNotFoundException', async () => {
    smSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
    await expect(getLinearSecret(SECRET_ID)).resolves.toBeNull();
  });

  test('rethrows other Secrets Manager errors', async () => {
    smSend.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(getLinearSecret(SECRET_ID)).rejects.toThrow('throttled');
  });

  test('forceRefresh bypasses the cache', async () => {
    smSend.mockResolvedValueOnce({ SecretString: 'old' });
    smSend.mockResolvedValueOnce({ SecretString: 'new' });
    await expect(getLinearSecret(SECRET_ID)).resolves.toBe('old');
    await expect(getLinearSecret(SECRET_ID, true)).resolves.toBe('new');
    expect(smSend).toHaveBeenCalledTimes(2);
  });
});

describe('verifyLinearRequest', () => {
  beforeEach(() => {
    smSend.mockReset();
    invalidateLinearSecretCache(SECRET_ID);
  });

  test('verifies against the cached secret', async () => {
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    const body = '{"action":"create"}';
    await expect(verifyLinearRequest(SECRET_ID, signed(body), body)).resolves.toBe(true);
  });

  test('re-fetches once after rotation and verifies with the fresh secret', async () => {
    const body = '{"action":"create"}';
    smSend.mockResolvedValueOnce({ SecretString: 'rotated-out' });
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    await expect(verifyLinearRequest(SECRET_ID, signed(body), body)).resolves.toBe(true);
    expect(smSend).toHaveBeenCalledTimes(2);
  });

  test('returns false when the fresh secret matches the cached one (no rotation)', async () => {
    const body = '{"action":"create"}';
    smSend.mockResolvedValueOnce({ SecretString: 'wrong' });
    smSend.mockResolvedValueOnce({ SecretString: 'wrong' });
    await expect(verifyLinearRequest(SECRET_ID, signed(body), body)).resolves.toBe(false);
  });

  test('returns false when the stored secret is empty (end-to-end fail-closed)', async () => {
    const body = '{"action":"create"}';
    // An attacker who knows the secret is empty would send HMAC('', body).
    const forged = crypto.createHmac('sha256', '').update(body).digest('hex');
    smSend.mockResolvedValue({ SecretString: '' });
    await expect(verifyLinearRequest(SECRET_ID, forged, body)).resolves.toBe(false);
  });
});

describe('isWebhookTimestampFresh', () => {
  test('accepts a current timestamp', () => {
    expect(isWebhookTimestampFresh(Date.now())).toBe(true);
  });

  test('rejects a timestamp older than the replay window', () => {
    expect(isWebhookTimestampFresh(Date.now() - MAX_WEBHOOK_TIMESTAMP_AGE_MS - 1000)).toBe(false);
  });

  test('rejects a far-future timestamp', () => {
    expect(isWebhookTimestampFresh(Date.now() + MAX_WEBHOOK_TIMESTAMP_AGE_MS + 1000)).toBe(false);
  });

  test('rejects undefined and non-finite values', () => {
    expect(isWebhookTimestampFresh(undefined)).toBe(false);
    expect(isWebhookTimestampFresh(NaN)).toBe(false);
    expect(isWebhookTimestampFresh(Infinity)).toBe(false);
  });
});
