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

import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

process.env.WEBHOOK_TABLE_NAME = 'Webhooks';

import { handler } from '../../src/handlers/webhook-authorizer';

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api-id/v1/POST/webhooks/tasks';

function makeEvent(overrides: Partial<APIGatewayRequestAuthorizerEvent> = {}): APIGatewayRequestAuthorizerEvent {
  return {
    type: 'REQUEST',
    methodArn: METHOD_ARN,
    resource: '/webhooks/tasks',
    path: '/v1/webhooks/tasks',
    httpMethod: 'POST',
    headers: {
      'X-Webhook-Id': 'wh-123',
      'X-Webhook-Signature': 'sha256=abcdef',
    },
    multiValueHeaders: {},
    pathParameters: {},
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    stageVariables: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: {},
      httpMethod: 'POST',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test/1.0',
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
      path: '/v1/webhooks/tasks',
      protocol: 'HTTPS',
      requestId: 'req-123',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/webhooks/tasks',
      stage: 'v1',
    },
    ...overrides,
  } as APIGatewayRequestAuthorizerEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockResolvedValue({
    Item: { webhook_id: 'wh-123', user_id: 'user-abc', status: 'active', name: 'test' },
  });
});

describe('webhook-authorizer handler', () => {
  test('returns Allow for active webhook with required headers', async () => {
    const event = makeEvent();
    const result = await handler(event);
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(result.context?.userId).toBe('user-abc');
    expect(result.context?.webhookId).toBe('wh-123');
  });

  test('returns Deny when headers are missing', async () => {
    const event = makeEvent({ headers: {} });
    const result = await handler(event);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('returns Deny when X-Webhook-Signature is missing', async () => {
    const event = makeEvent({
      headers: { 'X-Webhook-Id': 'wh-123' },
    });
    const result = await handler(event);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('returns Deny when webhook is not found', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    const event = makeEvent();
    const result = await handler(event);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('returns Deny when webhook is revoked', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: { webhook_id: 'wh-123', user_id: 'user-abc', status: 'revoked' },
    });
    const event = makeEvent();
    const result = await handler(event);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('returns Deny on unexpected DynamoDB error', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DDB error'));
    const event = makeEvent();
    const result = await handler(event);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });
});
