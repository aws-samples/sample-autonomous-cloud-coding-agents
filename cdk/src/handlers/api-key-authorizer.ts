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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { hashApiKeySecret, parseApiKey, timingSafeHashEqual } from './shared/api-key';
import { logger } from './shared/logger';
import type { ApiKeyRecord } from './shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.API_KEY_TABLE_NAME!;

/**
 * Scope this authorizer instance gates. API keys must hold it; Cognito JWTs
 * (interactive users) are exempt — a logged-in user manages their own
 * resources under the existing user-scoped model. Configured per route group
 * so a Phase 2 instance can gate task routes with `tasks:read`.
 */
const REQUIRED_SCOPE = process.env.API_KEY_REQUIRED_SCOPE!;

// Verifier is created once per container and caches the pool JWKS across warm
// invocations. `tokenUse: 'id'` matches the id_token the bgagent CLI sends.
const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.APP_CLIENT_ID!,
});

function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      }],
    },
    ...(context && { context }),
  };
}

function header(event: APIGatewayRequestAuthorizerEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  return headers[name] ?? headers[name.toLowerCase()];
}

/**
 * Lambda REQUEST authorizer accepting EITHER a platform API key (`X-API-Key`)
 * OR a Cognito id token (`Authorization`). Returns `principalId = user_id` and
 * `context.userId`, which handlers read via `extractUserId` — identical to the
 * Cognito-authorizer path, so the webhook management handlers are unchanged.
 */
export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const methodArn = event.methodArn;
  const apiKeyHeader = header(event, 'X-API-Key');
  const authHeader = header(event, 'Authorization');

  try {
    if (apiKeyHeader) {
      return await authorizeApiKey(apiKeyHeader, methodArn);
    }
    if (authHeader) {
      return await authorizeJwt(authHeader, methodArn);
    }
    logger.warn('No credential presented (missing X-API-Key and Authorization)');
    return generatePolicy('anonymous', 'Deny', methodArn);
  } catch (err) {
    logger.error('Authorizer unexpected error', { error: String(err) });
    return generatePolicy('anonymous', 'Deny', methodArn);
  }
}

async function authorizeApiKey(
  presented: string,
  methodArn: string,
): Promise<APIGatewayAuthorizerResult> {
  const parsed = parseApiKey(presented);
  if (!parsed) {
    logger.warn('Malformed API key');
    return generatePolicy('anonymous', 'Deny', methodArn);
  }

  // Direct GetItem by partition key (strongly consistent) — a revoked key stops
  // authenticating immediately, no GSI eventual-consistency window.
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { key_id: parsed.keyId },
    ConsistentRead: true,
  }));

  const record = result.Item as ApiKeyRecord | undefined;
  if (!record || record.status !== 'active') {
    logger.warn('API key not found or revoked', { key_id: parsed.keyId });
    return generatePolicy(parsed.keyId, 'Deny', methodArn);
  }

  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    logger.warn('API key expired', { key_id: parsed.keyId });
    return generatePolicy(parsed.keyId, 'Deny', methodArn);
  }

  if (!timingSafeHashEqual(hashApiKeySecret(parsed.secret), record.key_hash)) {
    logger.warn('API key secret mismatch', { key_id: parsed.keyId });
    return generatePolicy(parsed.keyId, 'Deny', methodArn);
  }

  const scopes: readonly string[] = record.scopes;
  if (!scopes.includes(REQUIRED_SCOPE)) {
    logger.warn('API key missing required scope', {
      key_id: parsed.keyId,
      required_scope: REQUIRED_SCOPE,
    });
    return generatePolicy(record.user_id, 'Deny', methodArn);
  }

  return generatePolicy(record.user_id, 'Allow', methodArn, {
    userId: record.user_id,
    keyId: record.key_id,
    scopes: record.scopes.join(','),
  });
}

async function authorizeJwt(
  authHeader: string,
  methodArn: string,
): Promise<APIGatewayAuthorizerResult> {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    logger.warn('Empty Authorization header');
    return generatePolicy('anonymous', 'Deny', methodArn);
  }

  try {
    const payload = await jwtVerifier.verify(token);
    return generatePolicy(payload.sub, 'Allow', methodArn, { userId: payload.sub });
  } catch (err) {
    logger.warn('JWT verification failed', { error: String(err) });
    return generatePolicy('anonymous', 'Deny', methodArn);
  }
}
