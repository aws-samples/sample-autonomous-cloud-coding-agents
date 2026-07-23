/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  this software and associated documentation files (the "Software"), to deal in
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSignature, createProxyHandler } from '../src/proxy.js';

const SECRET = 'a'.repeat(64);
const NOW = 1_800_000_000;

function route(strings, ...values) {
  return strings.reduce(
    (result, part, index) => result + part + (index < values.length ? encodeURIComponent(values[index]) : ''),
    '',
  );
}

function jiraResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function event(payload, overrides = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(NOW);
  return {
    method: 'POST',
    body,
    headers: {
      'X-Bgagent-Timestamp': [timestamp],
      'X-Bgagent-Signature': [computeSignature(SECRET, timestamp, body)],
    },
    ...overrides,
  };
}

function handler(requestJira) {
  return createProxyHandler({
    requestJira,
    route,
    secretProvider: () => SECRET,
    nowProvider: () => NOW,
  });
}

test('posts comments through Jira as the app actor', async () => {
  const calls = [];
  const invoke = handler(async (...args) => {
    calls.push(args);
    return jiraResponse(201, '{"id":"10001"}');
  });
  const result = await invoke(event({
    version: 1,
    operation: 'comment',
    cloud_id: 'cloud-1',
    issue_key: 'ENG-42',
    body: { type: 'doc', version: 1, content: [] },
  }));

  assert.equal(result.statusCode, 201);
  assert.equal(calls[0][0], '/rest/api/3/issue/ENG-42/comment');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    body: { type: 'doc', version: 1, content: [] },
  });
});

test('rejects invalid and stale signatures before Jira is called', async () => {
  let calls = 0;
  const invoke = handler(async () => {
    calls += 1;
    return jiraResponse(200, '{}');
  });
  const invalid = event(
    { version: 1, operation: 'identity', cloud_id: 'cloud-1' },
    { headers: { 'X-Bgagent-Timestamp': [String(NOW)], 'X-Bgagent-Signature': ['sha256=bad'] } },
  );
  assert.equal((await invoke(invalid)).statusCode, 401);

  const stale = event({ version: 1, operation: 'identity', cloud_id: 'cloud-1' });
  stale.headers['X-Bgagent-Timestamp'] = [String(NOW - 301)];
  assert.equal((await invoke(stale)).statusCode, 401);
  assert.equal(calls, 0);
});

test('allows only the explicit operation set', async () => {
  const invoke = handler(async () => jiraResponse(200, '{}'));
  const result = await invoke(event({
    version: 1,
    operation: 'arbitrary_rest_call',
    cloud_id: 'cloud-1',
  }));
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /unsupported_operation/);
});

test('returns the app identity used by api.asApp', async () => {
  const calls = [];
  const invoke = handler(async (path) => {
    calls.push(path);
    if (path === '/rest/api/3/myself') {
      return jiraResponse(200, JSON.stringify({
        accountId: 'app-account-1',
        accountType: 'app',
        displayName: 'bgagent',
      }));
    }
    return jiraResponse(200, JSON.stringify({
      baseUrl: 'https://acme.atlassian.net',
    }));
  });
  const result = await invoke(event({
    version: 1,
    operation: 'identity',
    cloud_id: 'cloud-1',
  }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    account_id: 'app-account-1',
    account_type: 'app',
    display_name: 'bgagent',
    site_url: 'https://acme.atlassian.net',
  });
  assert.deepEqual(calls.sort(), ['/rest/api/3/myself', '/rest/api/3/serverInfo'].sort());
});
