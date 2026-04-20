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
import { verifySlackSignature } from '../../../src/handlers/shared/slack-verify';

describe('verifySlackSignature', () => {
  const signingSecret = 'test-signing-secret-abc123';

  function makeSignature(timestamp: string, body: string): string {
    const basestring = `v0:${timestamp}:${body}`;
    return 'v0=' + crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');
  }

  function currentTimestamp(): string {
    return String(Math.floor(Date.now() / 1000));
  }

  test('accepts valid signature with current timestamp', () => {
    const ts = currentTimestamp();
    const body = 'token=abc&command=/bgagent&text=help';
    const sig = makeSignature(ts, body);

    expect(verifySlackSignature(signingSecret, sig, ts, body)).toBe(true);
  });

  test('rejects invalid signature', () => {
    const ts = currentTimestamp();
    const body = 'token=abc&command=/bgagent&text=help';
    const sig = 'v0=0000000000000000000000000000000000000000000000000000000000000000';

    expect(verifySlackSignature(signingSecret, sig, ts, body)).toBe(false);
  });

  test('rejects stale timestamp (older than 5 minutes)', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 400);
    const body = 'test-body';
    const sig = makeSignature(staleTs, body);

    expect(verifySlackSignature(signingSecret, sig, staleTs, body)).toBe(false);
  });

  test('rejects non-numeric timestamp', () => {
    expect(verifySlackSignature(signingSecret, 'v0=abc', 'not-a-number', 'body')).toBe(false);
  });

  test('rejects signature with wrong length', () => {
    const ts = currentTimestamp();
    expect(verifySlackSignature(signingSecret, 'v0=short', ts, 'body')).toBe(false);
  });

  test('rejects modified body', () => {
    const ts = currentTimestamp();
    const body = 'original-body';
    const sig = makeSignature(ts, body);

    expect(verifySlackSignature(signingSecret, sig, ts, 'tampered-body')).toBe(false);
  });
});
