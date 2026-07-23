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

import crypto from 'node:crypto';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const TRANSITION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function response(statusCode, body = '') {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function headerValue(headers, wanted) {
  const entry = Object.entries(headers ?? {})
    .find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export function computeSignature(secret, timestamp, body) {
  return `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

function authenticRequest(event, secret, nowSeconds) {
  if (!secret || secret.length < 32) return false;
  const timestamp = headerValue(event.headers, 'x-bgagent-timestamp');
  const supplied = headerValue(event.headers, 'x-bgagent-signature');
  if (!timestamp || !supplied || !/^\d+$/.test(timestamp)) return false;

  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(nowSeconds - sentAt) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const expected = computeSignature(secret, timestamp, event.body ?? '');
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function parsePayload(event) {
  if (event.method !== 'POST') return { error: response(405, { error: 'method_not_allowed' }) };
  const body = event.body ?? '';
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { error: response(413, { error: 'payload_too_large' }) };
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || value.version !== 1) {
      return { error: response(400, { error: 'invalid_payload' }) };
    }
    if (typeof value.cloud_id !== 'string' || value.cloud_id.length === 0) {
      return { error: response(400, { error: 'cloud_id_required' }) };
    }
    return { value };
  } catch {
    return { error: response(400, { error: 'invalid_json' }) };
  }
}

async function jiraResponse(result) {
  const body = await result.text();
  return response(result.status, body);
}

async function identityResponse(identityResult, serverInfoResult) {
  if (!identityResult.ok) return jiraResponse(identityResult);
  if (!serverInfoResult.ok) return jiraResponse(serverInfoResult);
  const identity = await identityResult.json();
  const serverInfo = await serverInfoResult.json();
  return response(200, {
    account_id: identity.accountId,
    account_type: identity.accountType,
    display_name: identity.displayName,
    site_url: serverInfo.baseUrl,
  });
}

export function createProxyHandler({
  requestJira,
  route,
  secretProvider = () => process.env.BGAGENT_PROXY_SECRET ?? '',
  nowProvider = () => Math.floor(Date.now() / 1000),
}) {
  return async function proxyHandler(event) {
    const secret = secretProvider();
    if (!secret || secret.length < 32) {
      console.error('BGAGENT_PROXY_SECRET is missing or shorter than 32 characters');
      return response(503, { error: 'proxy_not_configured' });
    }
    if (!authenticRequest(event, secret, nowProvider())) {
      return response(401, { error: 'invalid_signature' });
    }

    const parsed = parsePayload(event);
    if (parsed.error) return parsed.error;
    const payload = parsed.value;

    try {
      switch (payload.operation) {
        case 'identity': {
          const [identityResult, serverInfoResult] = await Promise.all([
            requestJira(
              route`/rest/api/3/myself`,
              { headers: { Accept: 'application/json' } },
            ),
            requestJira(
              route`/rest/api/3/serverInfo`,
              { headers: { Accept: 'application/json' } },
            ),
          ]);
          return identityResponse(identityResult, serverInfoResult);
        }
        case 'comment':
          if (!ISSUE_KEY_RE.test(payload.issue_key ?? '') || !payload.body) {
            return response(400, { error: 'invalid_comment_request' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}/comment`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body: payload.body }),
            },
          ));
        case 'get_transitions':
          if (!ISSUE_KEY_RE.test(payload.issue_key ?? '')) {
            return response(400, { error: 'invalid_issue_key' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}?fields=status&expand=transitions`,
            { headers: { Accept: 'application/json' } },
          ));
        case 'transition':
          if (
            !ISSUE_KEY_RE.test(payload.issue_key ?? '')
            || !TRANSITION_ID_RE.test(payload.transition_id ?? '')
          ) {
            return response(400, { error: 'invalid_transition_request' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}/transitions`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ transition: { id: payload.transition_id } }),
            },
          ));
        default:
          return response(400, { error: 'unsupported_operation' });
      }
    } catch (error) {
      console.error('Jira app-actor proxy request failed', {
        operation: payload.operation,
        error: error instanceof Error ? error.message : String(error),
      });
      return response(502, { error: 'jira_request_failed' });
    }
  };
}
