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

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

const mockSmSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSmSend })),
  CreateSecretCommand: jest.fn((input: unknown) => ({ _type: 'CreateSecret', input })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.WEBHOOK_TABLE_NAME = 'Webhooks';

import { handler } from '../../src/handlers/create-webhook';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ name: 'My CI Webhook' }),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/webhooks',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/webhooks',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: { claims: { sub: 'user-123' } },
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
      path: '/v1/webhooks',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/webhooks',
      stage: 'v1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockDdbSend.mockResolvedValue({});
  mockSmSend.mockResolvedValue({});
});

describe('create-webhook handler', () => {
  test('creates webhook successfully', async () => {
    const event = makeEvent();
    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.webhook_id).toBeDefined();
    expect(body.data.name).toBe('My CI Webhook');
    expect(body.data.secret).toBeDefined();
    expect(body.data.secret.length).toBe(64); // 32 bytes hex
    expect(mockSmSend).toHaveBeenCalledTimes(1); // CreateSecret (with inline tags)
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  test('returns 401 when not authenticated', async () => {
    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('returns 400 for missing body', async () => {
    const event = makeEvent({ body: null });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 400 for invalid name', async () => {
    const event = makeEvent({ body: JSON.stringify({ name: '-invalid' }) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for missing name', async () => {
    const event = makeEvent({ body: JSON.stringify({}) });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('returns 500 when Secrets Manager fails', async () => {
    mockSmSend.mockRejectedValueOnce(new Error('SM error'));
    const event = makeEvent();
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
  });

  test('rolls back secret when DynamoDB write fails', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DDB error'));
    const event = makeEvent();
    const result = await handler(event);
    expect(result.statusCode).toBe(500);
    // SM should have 2 calls: CreateSecret + DeleteSecret (rollback)
    expect(mockSmSend).toHaveBeenCalledTimes(2);
  });
});
