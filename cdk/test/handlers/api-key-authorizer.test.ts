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
import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const mockJwtVerify = jest.fn();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: jest.fn(() => ({ verify: mockJwtVerify })) },
}));

process.env.API_KEY_TABLE_NAME = 'ApiKeys';
process.env.API_KEY_REQUIRED_SCOPE = 'webhooks:manage';
process.env.USER_POOL_ID = 'us-east-1_pool';
process.env.APP_CLIENT_ID = 'client-abc';

import { handler } from '../../src/handlers/api-key-authorizer';

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api-id/v1/POST/webhooks';
const KEY_ID = '01J000000000000000000KEYID';
const SECRET = 'a'.repeat(64);
const RAW_KEY = `bgak_${KEY_ID}_${SECRET}`;
const KEY_HASH = crypto.createHash('sha256').update(SECRET, 'utf8').digest('hex');

function activeRecord(overrides: Record<string, unknown> = {}) {
  return {
    Item: {
      key_id: KEY_ID,
      user_id: 'cognito+user-abc',
      name: 'ci',
      key_hash: KEY_HASH,
      scopes: ['webhooks:manage'],
      status: 'active',
      ...overrides,
    },
  };
}

function makeEvent(headers: Record<string, string>): APIGatewayRequestAuthorizerEvent {
  return {
    type: 'REQUEST',
    methodArn: METHOD_ARN,
    resource: '/webhooks',
    path: '/v1/webhooks',
    httpMethod: 'POST',
    headers,
    multiValueHeaders: {},
    pathParameters: {},
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    stageVariables: {},
    requestContext: {} as never,
  } as APIGatewayRequestAuthorizerEvent;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDdbSend.mockResolvedValue(activeRecord());
});

describe('api-key-authorizer — API key path', () => {
  test('Allow for a valid, scoped, active key; returns owner + context', async () => {
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(result.principalId).toBe('cognito+user-abc');
    expect(result.context?.userId).toBe('cognito+user-abc');
    expect(result.context?.keyId).toBe(KEY_ID);
    expect(result.context?.scopes).toBe('webhooks:manage');
  });

  test('reads the header case-insensitively', async () => {
    const result = await handler(makeEvent({ 'x-api-key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
  });

  test('does a strongly-consistent GetItem by key_id', async () => {
    await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    const sent = mockDdbSend.mock.calls[0][0];
    expect(sent.input.Key).toEqual({ key_id: KEY_ID });
    expect(sent.input.ConsistentRead).toBe(true);
  });

  test('Deny for a malformed key (no lookup performed)', async () => {
    const result = await handler(makeEvent({ 'X-API-Key': 'not-a-valid-key' }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('Deny for wrong prefix', async () => {
    const result = await handler(makeEvent({ 'X-API-Key': `xxxx_${KEY_ID}_${SECRET}` }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('Deny when the key is not found', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('Deny when the key is revoked', async () => {
    mockDdbSend.mockResolvedValueOnce(activeRecord({ status: 'revoked' }));
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('Deny when the secret does not match the stored hash', async () => {
    const wrong = `bgak_${KEY_ID}_${'b'.repeat(64)}`;
    const result = await handler(makeEvent({ 'X-API-Key': wrong }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('Deny when the key is expired', async () => {
    mockDdbSend.mockResolvedValueOnce(
      activeRecord({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    );
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('Allow when expires_at is in the future', async () => {
    mockDdbSend.mockResolvedValueOnce(
      activeRecord({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
  });

  test('Deny when the key lacks the required scope', async () => {
    mockDdbSend.mockResolvedValueOnce(activeRecord({ scopes: ['tasks:read'] }));
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('Deny (not throw) on an unexpected DynamoDB error', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DDB down'));
    const result = await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('does not attempt JWT verification when X-API-Key is present', async () => {
    await handler(makeEvent({ 'X-API-Key': RAW_KEY }));
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });
});

describe('api-key-authorizer — JWT path', () => {
  test('Allow for a valid Cognito JWT; principal is the sub', async () => {
    mockJwtVerify.mockResolvedValueOnce({ sub: 'cognito+jwt-user' });
    const result = await handler(makeEvent({ Authorization: 'jwt-token' }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(result.principalId).toBe('cognito+jwt-user');
    expect(result.context?.userId).toBe('cognito+jwt-user');
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('strips a Bearer prefix before verifying', async () => {
    mockJwtVerify.mockResolvedValueOnce({ sub: 'cognito+jwt-user' });
    await handler(makeEvent({ Authorization: 'Bearer jwt-token' }));
    expect(mockJwtVerify).toHaveBeenCalledWith('jwt-token');
  });

  test('Deny when JWT verification fails', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('bad signature'));
    const result = await handler(makeEvent({ Authorization: 'jwt-token' }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('Deny for an empty Authorization value', async () => {
    const result = await handler(makeEvent({ Authorization: '   ' }));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });
});

describe('api-key-authorizer — no credential', () => {
  test('Deny when neither header is present', async () => {
    const result = await handler(makeEvent({}));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  test('prefers the API key when both headers are present', async () => {
    await handler(makeEvent({ 'X-API-Key': RAW_KEY, 'Authorization': 'jwt-token' }));
    expect(mockDdbSend).toHaveBeenCalled();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });
});
