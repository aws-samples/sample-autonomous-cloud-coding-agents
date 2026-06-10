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

import {
  getGitHubWebhookSecret,
  invalidateGitHubWebhookSecretCache,
  verifyGitHubRequest,
  verifyGitHubSignature,
} from '../../../src/handlers/shared/github-webhook-verify';

const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:123:secret:gh-webhook';
const SECRET_VALUE = 'super-secret';

function signed(body: string, key = SECRET_VALUE): string {
  return 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex');
}

describe('verifyGitHubSignature', () => {
  test('accepts a valid sha256 signature', () => {
    const body = '{"hello":"world"}';
    expect(verifyGitHubSignature(SECRET_VALUE, signed(body), body)).toBe(true);
  });

  test('rejects when signature mismatches', () => {
    const body = '{"hello":"world"}';
    expect(verifyGitHubSignature('wrong', signed(body), body)).toBe(false);
  });

  test('rejects header missing the sha256= prefix (e.g. legacy sha1=)', () => {
    const body = '{"hello":"world"}';
    const sha1 = 'sha1=' + crypto.createHmac('sha1', SECRET_VALUE).update(body).digest('hex');
    expect(verifyGitHubSignature(SECRET_VALUE, sha1, body)).toBe(false);
  });

  test('rejects when provided digest is the wrong byte length (timingSafeEqual would throw)', () => {
    const body = '{"hello":"world"}';
    expect(verifyGitHubSignature(SECRET_VALUE, 'sha256=deadbeef', body)).toBe(false);
  });

  test('rejects when the body has been tampered', () => {
    const sig = signed('{"hello":"world"}');
    expect(verifyGitHubSignature(SECRET_VALUE, sig, '{"hello":"WORLD"}')).toBe(false);
  });

  // theagenticguy PR-241 review B2: the headline empty-secret fail-open guard.
  // HMAC('', body) was previously accepted by `crypto.createHmac` and would
  // pass `timingSafeEqual` if the attacker computed the same HMAC.
  test('rejects empty webhookSecret even with a syntactically-valid signature', () => {
    const body = '{"hello":"world"}';
    const empty = 'sha256=' + crypto.createHmac('sha256', '').update(body).digest('hex');
    expect(verifyGitHubSignature('', empty, body)).toBe(false);
  });

  test('rejects whitespace-only webhookSecret', () => {
    const body = '{"hello":"world"}';
    const ws = 'sha256=' + crypto.createHmac('sha256', '   ').update(body).digest('hex');
    expect(verifyGitHubSignature('   ', ws, body)).toBe(false);
  });
});

describe('getGitHubWebhookSecret', () => {
  beforeEach(() => {
    smSend.mockReset();
    invalidateGitHubWebhookSecretCache(SECRET_ID);
  });

  test('returns the secret string and caches it', async () => {
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    const v1 = await getGitHubWebhookSecret(SECRET_ID);
    const v2 = await getGitHubWebhookSecret(SECRET_ID);
    expect(v1).toBe(SECRET_VALUE);
    expect(v2).toBe(SECRET_VALUE);
    expect(smSend).toHaveBeenCalledTimes(1);
  });

  test('forceRefresh bypasses the cache', async () => {
    smSend
      .mockResolvedValueOnce({ SecretString: SECRET_VALUE })
      .mockResolvedValueOnce({ SecretString: 'rotated' });
    await getGitHubWebhookSecret(SECRET_ID);
    const v2 = await getGitHubWebhookSecret(SECRET_ID, true);
    expect(v2).toBe('rotated');
    expect(smSend).toHaveBeenCalledTimes(2);
  });

  test('returns null and drops cache entry when SecretString is missing', async () => {
    smSend.mockResolvedValueOnce({});
    expect(await getGitHubWebhookSecret(SECRET_ID)).toBeNull();
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    expect(await getGitHubWebhookSecret(SECRET_ID)).toBe(SECRET_VALUE);
    expect(smSend).toHaveBeenCalledTimes(2);
  });

  // theagenticguy PR-241 review B2: empty-secret fails closed at the
  // fetch layer, not just the verify layer. An operator who wrote `""`
  // out of band must not have it cached and used.
  test('returns null when SecretString is the empty string', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '' });
    expect(await getGitHubWebhookSecret(SECRET_ID)).toBeNull();
  });

  test('returns null when SecretString is whitespace-only', async () => {
    smSend.mockResolvedValueOnce({ SecretString: '   \n\t  ' });
    expect(await getGitHubWebhookSecret(SECRET_ID)).toBeNull();
  });

  test('returns null on ResourceNotFoundException', async () => {
    const err = new Error('not found') as Error & { name: string };
    err.name = 'ResourceNotFoundException';
    smSend.mockRejectedValueOnce(err);
    expect(await getGitHubWebhookSecret(SECRET_ID)).toBeNull();
  });

  test('rethrows on transient SM errors so callers can fail-closed', async () => {
    smSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(getGitHubWebhookSecret(SECRET_ID)).rejects.toThrow('throttled');
  });
});

describe('verifyGitHubRequest (cache + transparent re-fetch)', () => {
  beforeEach(() => {
    smSend.mockReset();
    invalidateGitHubWebhookSecretCache(SECRET_ID);
  });

  test('verifies on first try when cached secret matches', async () => {
    smSend.mockResolvedValueOnce({ SecretString: SECRET_VALUE });
    const body = '{"event":"deployment_status"}';
    expect(await verifyGitHubRequest(SECRET_ID, signed(body), body)).toBe(true);
  });

  test('re-fetches and retries on signature mismatch (post-rotation path)', async () => {
    smSend
      .mockResolvedValueOnce({ SecretString: 'old-secret' })
      .mockResolvedValueOnce({ SecretString: 'new-secret' });
    const body = '{"event":"deployment_status"}';
    const sig = signed(body, 'new-secret');
    expect(await verifyGitHubRequest(SECRET_ID, sig, body)).toBe(true);
    expect(smSend).toHaveBeenCalledTimes(2);
  });

  test('returns false when refresh returns identical secret (no real rotation)', async () => {
    smSend
      .mockResolvedValueOnce({ SecretString: 'old-secret' })
      .mockResolvedValueOnce({ SecretString: 'old-secret' });
    const body = '{"event":"deployment_status"}';
    const sig = signed(body, 'definitely-not-the-secret');
    expect(await verifyGitHubRequest(SECRET_ID, sig, body)).toBe(false);
  });

  test('returns false when the stored secret is empty (B2 end-to-end)', async () => {
    smSend
      .mockResolvedValueOnce({ SecretString: '' })
      .mockResolvedValueOnce({ SecretString: '' });
    const body = '{"event":"deployment_status"}';
    // An attacker who knows the secret is empty would compute HMAC('', body).
    const forged = 'sha256=' + crypto.createHmac('sha256', '').update(body).digest('hex');
    expect(await verifyGitHubRequest(SECRET_ID, forged, body)).toBe(false);
  });
});
