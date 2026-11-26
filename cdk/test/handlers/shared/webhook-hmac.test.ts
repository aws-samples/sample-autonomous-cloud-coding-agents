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
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}));

import { cachedSecrets, hmacSha256Equals, verifyWithRefetch } from '../../../src/handlers/shared/webhook-hmac';

const TEXTS = { empty: 'empty', notFound: 'not found', fetchFailed: 'fetch failed' };
const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:webhook';
const FIVE_MINUTES_MS = 5 * 60 * 1000;

beforeEach(() => {
  smSend.mockReset();
});

describe('verifyWithRefetch', () => {
  test('rejects a signature that matches neither the cached secret nor the fresh one', async () => {
    smSend
      .mockResolvedValueOnce({ SecretString: 'rotated-out' })
      .mockResolvedValueOnce({ SecretString: 'rotated-in' });
    const body = '{"action":"create"}';
    const signature = crypto.createHmac('sha256', 'neither').update(body).digest('hex');

    const verified = await verifyWithRefetch(cachedSecrets(TEXTS), SECRET_ID, (secret) => hmacSha256Equals('Test', secret, body, signature));

    expect(verified).toBe(false);
    expect(smSend).toHaveBeenCalledTimes(2);
  });
});

describe('cachedSecrets', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reads the secret again once the entry is five minutes old', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    smSend
      .mockResolvedValueOnce({ SecretString: 'first' })
      .mockResolvedValueOnce({ SecretString: 'second' });
    const secrets = cachedSecrets(TEXTS);

    await expect(secrets.get(SECRET_ID)).resolves.toBe('first');
    now.mockReturnValue(FIVE_MINUTES_MS - 1);
    await expect(secrets.get(SECRET_ID)).resolves.toBe('first');
    now.mockReturnValue(FIVE_MINUTES_MS);
    await expect(secrets.get(SECRET_ID)).resolves.toBe('second');
    expect(smSend).toHaveBeenCalledTimes(2);
  });
});
