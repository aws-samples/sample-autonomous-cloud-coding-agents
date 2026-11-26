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

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  GetCommand: jest.fn(),
}));

const mockPoolKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mockKeyId = 'pool-key-1';
const mockDownloadKeys = jest.fn().mockRejectedValue(new Error('this test must not download signing keys'));

jest.mock('aws-jwt-verify', () => {
  const actual = jest.requireActual('aws-jwt-verify');
  const { SimpleJwksCache } = jest.requireActual('aws-jwt-verify/jwk');
  return {
    CognitoJwtVerifier: {
      create: (options: unknown) => {
        const verifier = actual.CognitoJwtVerifier.create(options, {
          jwksCache: new SimpleJwksCache({ fetcher: { fetch: mockDownloadKeys } }),
        });
        verifier.cacheJwks({
          keys: [{ ...mockPoolKeys.publicKey.export({ format: 'jwk' }), kid: mockKeyId, alg: 'RS256', use: 'sig' }],
        });
        return verifier;
      },
    },
  };
});

process.env.API_KEY_TABLE_NAME = 'ApiKeys';
process.env.API_KEY_REQUIRED_SCOPE = 'webhooks:manage';
process.env.USER_POOL_ID = 'us-east-1_pool';
process.env.APP_CLIENT_ID = 'cli-client';

import { handler } from '../../src/handlers/api-key-authorizer';

const POOL_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';

function idToken(claims: Record<string, unknown> = {}, signingKey: crypto.KeyObject = mockPoolKeys.privateKey): string {
  const encode = (part: object): string => Buffer.from(JSON.stringify(part)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const signed = [
    encode({ alg: 'RS256', kid: mockKeyId }),
    encode({ iss: POOL_ISSUER, sub: 'user-1', aud: 'cli-client', token_use: 'id', iat: now, exp: now + 3600, ...claims }),
  ].join('.');
  return `${signed}.${crypto.sign('sha256', Buffer.from(signed), signingKey).toString('base64url')}`;
}

async function authorize(token: string): Promise<{ effect: string; principalId: string; logged: string }> {
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const result = await handler({
    type: 'REQUEST',
    methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/v1/GET/webhooks',
    headers: { Authorization: `Bearer ${token}` },
  } as unknown as APIGatewayRequestAuthorizerEvent);
  const logged = stdout.mock.calls.join('');
  stdout.mockRestore();
  return { effect: result.policyDocument.Statement[0].Effect, principalId: result.principalId, logged };
}

describe('api-key-authorizer — Cognito tokens accepted on the JWT path', () => {
  afterEach(() => {
    expect(mockDownloadKeys).not.toHaveBeenCalled();
  });

  test('Allow for an id token that the CLI app client of the pool issued', async () => {
    expect(await authorize(idToken())).toMatchObject({ effect: 'Allow', principalId: 'user-1' });
  });

  test('Deny for an id token that another app client of the pool issued', async () => {
    const { effect, logged } = await authorize(idToken({ aud: 'another-client' }));
    expect(effect).toBe('Deny');
    expect(logged).toContain('not allowed: another-client');
  });

  test('Deny for an access token', async () => {
    const { effect, logged } = await authorize(idToken({ token_use: 'access', aud: undefined, client_id: 'cli-client' }));
    expect(effect).toBe('Deny');
    expect(logged).toContain('Token use not allowed: access');
  });

  test('Deny for a token of another user pool', async () => {
    const otherPool = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other';
    const { effect, logged } = await authorize(idToken({ iss: otherPool }));
    expect(effect).toBe('Deny');
    expect(logged).toContain('issuer not configured');
  });

  test('Deny for an expired token', async () => {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const { effect, logged } = await authorize(idToken({ iat: hourAgo - 3600, exp: hourAgo }));
    expect(effect).toBe('Deny');
    expect(logged).toContain('Token expired');
  });

  test('Deny for a token that the pool did not sign', async () => {
    const otherKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { effect, logged } = await authorize(idToken({}, otherKeys.privateKey));
    expect(effect).toBe('Deny');
    expect(logged).toContain('Invalid signature');
  });
});
