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

import {
  probeJiraAppActor,
  signJiraAppActorRequest,
  validateJiraAppActorProxyUrl,
} from '../src/jira-app-actor';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('Jira app actor setup helpers', () => {
  test('accepts only Forge v2 installation web-trigger URLs', () => {
    expect(validateJiraAppActorProxyUrl(
      'https://install.webtrigger.atlassian.app/public/trigger',
    )).toBe('https://install.webtrigger.atlassian.app/public/trigger');
    expect(() => validateJiraAppActorProxyUrl('https://attacker.example/public/trigger'))
      .toThrow(/Forge proxy URL/);
    expect(() => validateJiraAppActorProxyUrl(
      'https://install.webtrigger.atlassian.app/public/trigger?redirect=evil',
    )).toThrow(/Forge proxy URL/);
    expect(() => validateJiraAppActorProxyUrl('not a URL'))
      .toThrow(/valid HTTPS URL/);
    expect(() => validateJiraAppActorProxyUrl(
      'http://install.webtrigger.atlassian.app/public/trigger',
    )).toThrow(/Forge proxy URL/);
  });

  test('signs the exact timestamp and request body', () => {
    expect(signJiraAppActorRequest('secret', '123', '{"a":1}')).toBe(
      'sha256=979e3c2c30ebc0b46dd7165b75ee282921dd508ff4a0b4a4e072ba27b16970ae',
    );
  });

  test('probes and returns a verified Jira app account', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {
      account_id: 'app-1',
      account_type: 'app',
      display_name: 'bgagent',
      site_url: 'https://acme.atlassian.net',
    }));

    const identity = await probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(identity.display_name).toBe('bgagent');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Bgagent-Signature'])
      .toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(init.body as string)).toEqual({
      version: 1,
      operation: 'identity',
      cloud_id: 'cloud-1',
    });
  });

  test('rejects a human identity and app permission errors', async () => {
    const humanFetch = jest.fn().mockResolvedValue(response(200, {
      account_id: 'human-1',
      account_type: 'atlassian',
      display_name: 'Setup User',
    }));
    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: humanFetch as unknown as typeof fetch,
    })).rejects.toThrow(/did not return a Jira app actor/);

    const deniedFetch = jest.fn().mockResolvedValue(response(403, { error: 'forbidden' }));
    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: deniedFetch as unknown as typeof fetch,
    })).rejects.toThrow(/HTTP 403/);
  });

  test('rejects a Forge installation from a different Jira tenant', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {
      account_id: 'app-1',
      account_type: 'app',
      display_name: 'bgagent',
      site_url: 'https://other.atlassian.net',
    }));

    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/not the requested Jira tenant/);
  });

  test('rejects short secrets and proxy network failures', async () => {
    const fetchImpl = jest.fn();
    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 'too-short',
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/at least 32 characters/);
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/network unavailable/);
  });

  test('rejects non-JSON and invalid site responses', async () => {
    const nonJsonFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid JSON');
      },
    } as Response);
    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: nonJsonFetch as unknown as typeof fetch,
    })).rejects.toThrow(/returned non-JSON/);

    const invalidSiteFetch = jest.fn().mockResolvedValue(response(200, {
      account_id: 'app-1',
      account_type: 'app',
      display_name: 'bgagent',
      site_url: 'not a URL',
    }));
    await expect(probeJiraAppActor({
      proxyUrl: 'https://install.webtrigger.atlassian.app/public/trigger',
      sharedSecret: 's'.repeat(64),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      fetchImpl: invalidSiteFetch as unknown as typeof fetch,
    })).rejects.toThrow(/site_url must be a valid HTTPS Jira site URL/);
  });
});
