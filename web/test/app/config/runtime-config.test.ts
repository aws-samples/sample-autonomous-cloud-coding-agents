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

import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig, parseRuntimeConfig, RuntimeConfigError } from '../../../src/app/config/runtime-config';

const VALID = {
  apiBaseUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
  region: 'us-east-1',
  auth: {
    mode: 'cognito',
    userPoolId: 'us-east-1_AbCdEf',
    userPoolClientId: 'client123',
    domain: 'https://factory.auth.us-east-1.amazoncognito.com',
  },
};

describe('parseRuntimeConfig', () => {
  it('accepts a complete Cognito configuration', () => {
    expect(parseRuntimeConfig(VALID, false)).toEqual(VALID);
  });

  it('rejects mock sign-in unless running in mock mode', () => {
    const mock = { apiBaseUrl: 'http://127.0.0.1:5173/mock-api/v1', region: 'us-east-1', auth: { mode: 'mock' } };
    expect(() => parseRuntimeConfig(mock, false)).toThrow(/only available in local mock mode/);
    expect(parseRuntimeConfig(mock, true).auth.mode).toBe('mock');
  });

  it('defaults to rejecting mock sign-in in non-mock builds', () => {
    expect(() => parseRuntimeConfig({ ...VALID, auth: { mode: 'mock' } })).toThrow(RuntimeConfigError);
  });

  it.each([
    ['non-object', 'x'],
    ['missing auth', { ...VALID, auth: undefined }],
    ['unknown auth mode', { ...VALID, auth: { mode: 'basic' } }],
    ['missing client id', { ...VALID, auth: { ...VALID.auth, userPoolClientId: '' } }],
    ['plain-http API', { ...VALID, apiBaseUrl: 'http://abc.example/v1' }],
    ['relative API URL', { ...VALID, apiBaseUrl: '/v1' }],
    ['plain-http login domain', { ...VALID, auth: { ...VALID.auth, domain: 'http://login.example' } }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseRuntimeConfig(value, false)).toThrow(RuntimeConfigError);
  });
});

describe('loadRuntimeConfig', () => {
  it('reports a missing config file', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }));
    await expect(loadRuntimeConfig(fetchImpl)).rejects.toThrow(/HTTP 404/);
  });

  it('reports invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{', { status: 200 }));
    await expect(loadRuntimeConfig(fetchImpl)).rejects.toThrow(/not valid JSON/);
  });

  it('fetches /config.json without caching', async () => {
    const fetchImpl = vi.fn(async () => Response.json(VALID));
    await loadRuntimeConfig(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
  });
});
