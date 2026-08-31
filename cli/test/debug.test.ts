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

import { debug, isVerbose, redactSensitive, setVerbose } from '../src/debug';

describe('redactSensitive', () => {
  test('redacts the one-time webhook secret in a response body', () => {
    const body = {
      webhook_id: 'wh-1',
      secret: 'whsec_supersecret',
      url: 'https://api.example.com/webhooks/wh-1',
    };
    expect(redactSensitive(body)).toEqual({
      webhook_id: 'wh-1',
      secret: '[REDACTED]',
      url: 'https://api.example.com/webhooks/wh-1',
    });
  });

  test('redacts nested and array-wrapped sensitive fields', () => {
    const body = {
      data: [{ access_token: 'tok-1', name: 'a' }, { refresh_token: 'tok-2' }],
      oauth: { client_secret: 'cs-1', client_id: 'ci-1' },
    };
    expect(redactSensitive(body)).toEqual({
      data: [{ access_token: '[REDACTED]', name: 'a' }, { refresh_token: '[REDACTED]' }],
      oauth: { client_secret: '[REDACTED]', client_id: 'ci-1' },
    });
  });

  test('matches field names case-insensitively', () => {
    expect(redactSensitive({ Authorization: 'Bearer abc' })).toEqual({
      Authorization: '[REDACTED]',
    });
  });

  test('does not redact non-sensitive fields like next_token', () => {
    const body = { next_token: 'page-cursor', items: [] };
    expect(redactSensitive(body)).toEqual({ next_token: 'page-cursor', items: [] });
  });

  test('passes through primitives and null unchanged', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });

  test('does not mutate the input object', () => {
    const body = { secret: 'keep-me' };
    redactSensitive(body);
    expect(body.secret).toBe('keep-me');
  });
});

describe('debug / setVerbose', () => {
  afterEach(() => {
    setVerbose(false);
    jest.restoreAllMocks();
  });

  test('debug is silent when verbose is off', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    setVerbose(false);
    debug('hidden');
    expect(spy).not.toHaveBeenCalled();
  });

  test('debug writes to stderr when verbose is on', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    debug('shown');
    expect(spy).toHaveBeenCalledWith('[DEBUG] shown');
  });
});
