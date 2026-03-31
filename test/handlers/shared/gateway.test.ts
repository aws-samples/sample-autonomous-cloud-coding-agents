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

import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  buildChannelMetadata,
  buildWebhookChannelMetadata,
  extractUserId,
  extractWebhookContext,
  generateBranchName,
} from '../../../src/handlers/shared/gateway';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-abc-123' } },
      httpMethod: 'GET',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test-agent/1.0',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      path: '/',
      protocol: 'HTTPS',
      requestId: 'req-123',
      requestTimeEpoch: 0,
      resourceId: 'resource-id',
      resourcePath: '/',
      stage: 'v1',
    },
    ...overrides,
  };
}

describe('extractUserId', () => {
  test('extracts sub from Cognito claims', () => {
    const event = makeEvent();
    expect(extractUserId(event)).toBe('user-abc-123');
  });

  test('returns null when authorizer is missing', () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    expect(extractUserId(event)).toBeNull();
  });

  test('returns null when claims are missing', () => {
    const event = makeEvent();
    event.requestContext.authorizer = {};
    expect(extractUserId(event)).toBeNull();
  });

  test('returns null when sub is not a string', () => {
    const event = makeEvent();
    event.requestContext.authorizer = { claims: { sub: 123 } };
    expect(extractUserId(event)).toBeNull();
  });
});

describe('generateBranchName', () => {
  test('generates correct pattern with description', () => {
    const result = generateBranchName('01ABC', 'Fix authentication bug');
    expect(result).toBe('bgagent/01ABC/fix-authentication-bug');
  });

  test('uses "task" slug when description is absent', () => {
    expect(generateBranchName('01ABC')).toBe('bgagent/01ABC/task');
    expect(generateBranchName('01ABC', '')).toBe('bgagent/01ABC/task');
    expect(generateBranchName('01ABC', undefined)).toBe('bgagent/01ABC/task');
  });

  test('slugifies special characters', () => {
    const result = generateBranchName('01ABC', 'Fix the bug! (issue #42)');
    expect(result).toBe('bgagent/01ABC/fix-the-bug-issue-42');
  });

  test('truncates slug to 50 characters', () => {
    const longDescription = 'a'.repeat(100);
    const result = generateBranchName('01ABC', longDescription);
    const slug = result.split('/')[2];
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  test('removes leading and trailing hyphens from slug', () => {
    const result = generateBranchName('01ABC', '---hello---');
    expect(result).toBe('bgagent/01ABC/hello');
  });
});

describe('buildChannelMetadata', () => {
  test('extracts source IP and user agent', () => {
    const event = makeEvent();
    const meta = buildChannelMetadata(event);
    expect(meta.source_ip).toBe('1.2.3.4');
    expect(meta.user_agent).toBe('test-agent/1.0');
    expect(meta.api_request_id).toBe('req-123');
  });
});

describe('extractWebhookContext', () => {
  test('extracts userId and webhookId from REQUEST authorizer context', () => {
    const event = makeEvent();
    event.requestContext.authorizer = { userId: 'user-abc', webhookId: 'wh-123' };
    const ctx = extractWebhookContext(event);
    expect(ctx).toEqual({ userId: 'user-abc', webhookId: 'wh-123' });
  });

  test('returns null when authorizer is missing', () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    expect(extractWebhookContext(event)).toBeNull();
  });

  test('returns null when userId is missing', () => {
    const event = makeEvent();
    event.requestContext.authorizer = { webhookId: 'wh-123' };
    expect(extractWebhookContext(event)).toBeNull();
  });

  test('returns null when webhookId is missing', () => {
    const event = makeEvent();
    event.requestContext.authorizer = { userId: 'user-abc' };
    expect(extractWebhookContext(event)).toBeNull();
  });

  test('returns null when userId is not a string', () => {
    const event = makeEvent();
    event.requestContext.authorizer = { userId: 123, webhookId: 'wh-123' };
    expect(extractWebhookContext(event)).toBeNull();
  });
});

describe('buildWebhookChannelMetadata', () => {
  test('includes webhook_id and request context', () => {
    const event = makeEvent();
    const meta = buildWebhookChannelMetadata(event, 'wh-123');
    expect(meta.webhook_id).toBe('wh-123');
    expect(meta.source_ip).toBe('1.2.3.4');
    expect(meta.user_agent).toBe('test-agent/1.0');
    expect(meta.api_request_id).toBe('req-123');
  });
});
