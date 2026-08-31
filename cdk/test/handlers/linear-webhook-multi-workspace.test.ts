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

/**
 * Per-workspace webhook signing-secret tests for the Linear webhook handler.
 *
 * Lives in a separate file from `linear-webhook.test.ts` because the
 * handler reads `LINEAR_WORKSPACE_REGISTRY_TABLE_NAME` at module-load
 * time. Setting it here before the import gives us the multi-workspace
 * code path; the sibling test file leaves it unset to exercise the
 * single-workspace back-compat path.
 */

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  class ConditionalCheckFailedExceptionMock extends Error {
    constructor(opts: { message: string; $metadata?: unknown }) {
      super(opts.message);
      this.name = 'ConditionalCheckFailedException';
    }
  }
  return {
    DynamoDBClient: jest.fn(() => ({})),
    ConditionalCheckFailedException: ConditionalCheckFailedExceptionMock,
  };
});
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

process.env.LINEAR_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/linear/webhook-stack';
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = 'LinearDedup';
process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'linear-processor';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearWorkspaceRegistry';

import { handler } from '../../src/handlers/linear-webhook';
import { invalidateLinearOauthCache } from '../../src/handlers/shared/linear-oauth-resolver';
import { invalidateLinearSecretCache } from '../../src/handlers/shared/linear-verify';

const STACK_WIDE_SECRET = 'lin_wh_stackwide_AAAAAAAAAAAAAAAAAA';
const WORKSPACE_A_SECRET = 'lin_wh_workspaceA_BBBBBBBBBBBBBBBBBB';
const WORKSPACE_B_SECRET = 'lin_wh_workspaceB_CCCCCCCCCCCCCCCCCC';
const WORKSPACE_A_ID = 'org-aaa';
const WORKSPACE_B_ID = 'org-bbb';
const WORKSPACE_A_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-A';
const WORKSPACE_B_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-B';

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeEvent(body: string, signature: string): APIGatewayProxyEvent {
  return {
    body,
    headers: { 'Linear-Signature': signature },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/linear/webhook',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function payloadFor(orgId: string): string {
  return JSON.stringify({
    action: 'create',
    type: 'Issue',
    webhookTimestamp: Date.now(),
    webhookId: 'wh-1',
    organizationId: orgId,
    data: { id: 'issue-1', labels: [{ id: 'lbl-1', name: 'bgagent' }] },
  });
}

interface StoredOauthFixture {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly workspace_id: string;
  readonly workspace_slug: string;
  readonly installed_at: string;
  readonly updated_at: string;
  readonly installed_by_platform_user_id: string;
  readonly webhook_signing_secret?: string;
}

function makeStoredOauth(overrides: Partial<StoredOauthFixture> = {}): StoredOauthFixture {
  return {
    access_token: 'lin_oauth_xxx',
    refresh_token: 'lin_refresh_xxx',
    expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    scope: 'read write app:assignable app:mentionable',
    client_id: 'cid',
    client_secret: 'csec',
    workspace_id: 'org-default',
    workspace_slug: 'acme',
    installed_at: '2026-05-19T08:00:00Z',
    updated_at: '2026-05-19T08:00:00Z',
    installed_by_platform_user_id: 'cog-sub',
    ...overrides,
  };
}

/**
 * Wire the SM mock to respond by SecretId. Tests configure the
 * per-workspace OAuth secrets and the stack-wide signing secret on a
 * single mock so the receiver can fall through cleanly.
 */
function configureSecretsManager(secrets: Record<string, string | object>) {
  smSend.mockImplementation((cmd: { input: { SecretId: string } }) => {
    const id = cmd.input.SecretId;
    const value = secrets[id];
    if (value === undefined) {
      const err = new Error(`SecretId not mocked: ${id}`);
      (err as Error & { name: string }).name = 'ResourceNotFoundException';
      return Promise.reject(err);
    }
    return Promise.resolve({
      SecretString: typeof value === 'string' ? value : JSON.stringify(value),
    });
  });
}

/**
 * Wire DDB to return registry rows by `linear_workspace_id`.
 * Workspaces not listed return `Item: undefined` (registry miss).
 */
function configureRegistry(rows: Record<string, { oauth_secret_arn: string; status: string; workspace_slug: string }>) {
  ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Get') {
      const key = cmd.input.Key as { linear_workspace_id?: string } | undefined;
      const workspaceId = key?.linear_workspace_id;
      const item = workspaceId ? rows[workspaceId] : undefined;
      return Promise.resolve(item ? { Item: { linear_workspace_id: workspaceId, ...item } } : { Item: undefined });
    }
    if (cmd._type === 'Put') {
      // Dedup PutItem — succeed.
      return Promise.resolve({});
    }
    if (cmd._type === 'Delete') {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

describe('linear-webhook handler — multi-workspace signature verification', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    lambdaSend.mockReset();
    invalidateLinearSecretCache(process.env.LINEAR_WEBHOOK_SECRET_ARN!);
    invalidateLinearOauthCache(WORKSPACE_A_ID, WORKSPACE_A_SECRET_ARN);
    invalidateLinearOauthCache(WORKSPACE_B_ID, WORKSPACE_B_SECRET_ARN);
    lambdaSend.mockResolvedValue({});
  });

  test('verifies workspace A using its per-workspace signing secret', async () => {
    configureRegistry({
      [WORKSPACE_A_ID]: { oauth_secret_arn: WORKSPACE_A_SECRET_ARN, status: 'active', workspace_slug: 'acme-A' },
    });
    configureSecretsManager({
      [WORKSPACE_A_SECRET_ARN]: makeStoredOauth({
        workspace_id: WORKSPACE_A_ID,
        workspace_slug: 'acme-A',
        webhook_signing_secret: WORKSPACE_A_SECRET,
      }),
    });
    const body = payloadFor(WORKSPACE_A_ID);
    const result = await handler(makeEvent(body, sign(WORKSPACE_A_SECRET, body)));
    expect(result.statusCode).toBe(200);
    // Processor was invoked → signature passed.
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test('verifies workspace B using its DIFFERENT per-workspace signing secret', async () => {
    configureRegistry({
      [WORKSPACE_B_ID]: { oauth_secret_arn: WORKSPACE_B_SECRET_ARN, status: 'active', workspace_slug: 'acme-B' },
    });
    configureSecretsManager({
      [WORKSPACE_B_SECRET_ARN]: makeStoredOauth({
        workspace_id: WORKSPACE_B_ID,
        workspace_slug: 'acme-B',
        webhook_signing_secret: WORKSPACE_B_SECRET,
      }),
    });
    const body = payloadFor(WORKSPACE_B_ID);
    const result = await handler(makeEvent(body, sign(WORKSPACE_B_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test('rejects workspace A signed with workspace B\'s secret (per-workspace mismatch is fatal)', async () => {
    // The CRITICAL test: an attacker who learns workspace B's signing
    // secret (or replays a workspace B event) cannot dispatch as
    // workspace A by claiming A's orgId. The receiver locks the
    // per-workspace path once it finds A's secret and refuses to fall
    // back to the stack-wide secret.
    configureRegistry({
      [WORKSPACE_A_ID]: { oauth_secret_arn: WORKSPACE_A_SECRET_ARN, status: 'active', workspace_slug: 'acme-A' },
    });
    configureSecretsManager({
      [WORKSPACE_A_SECRET_ARN]: makeStoredOauth({
        workspace_id: WORKSPACE_A_ID,
        workspace_slug: 'acme-A',
        webhook_signing_secret: WORKSPACE_A_SECRET,
      }),
      [process.env.LINEAR_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor(WORKSPACE_A_ID);
    // Sign with WORKSPACE_B_SECRET — wrong secret for A.
    const result = await handler(makeEvent(body, sign(WORKSPACE_B_SECRET, body)));
    expect(result.statusCode).toBe(401);
    // Lambda must NOT be invoked.
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('falls back to stack-wide secret when registry has no row for the orgId', async () => {
    // Single-workspace back-compat: an old install written before the
    // per-workspace flow has no registry row keyed on its orgId. The
    // receiver falls through to the stack-wide secret and verifies
    // with that. Existing single-workspace deployments keep working.
    configureRegistry({}); // empty — registry miss
    configureSecretsManager({
      [process.env.LINEAR_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor('org-not-onboarded');
    const result = await handler(makeEvent(body, sign(STACK_WIDE_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test('falls back to stack-wide secret when per-workspace bundle has no webhook_signing_secret field', async () => {
    // Migration mid-state: workspace was onboarded under the old flow
    // (no signing secret on its OAuth bundle), but later got registered.
    // Until the user runs `bgagent linear update-webhook-secret` to
    // populate `webhook_signing_secret` on the OAuth bundle, the
    // stack-wide secret remains the source of truth for that workspace.
    configureRegistry({
      [WORKSPACE_A_ID]: { oauth_secret_arn: WORKSPACE_A_SECRET_ARN, status: 'active', workspace_slug: 'acme-A' },
    });
    configureSecretsManager({
      [WORKSPACE_A_SECRET_ARN]: makeStoredOauth({
        workspace_id: WORKSPACE_A_ID,
        // No webhook_signing_secret field — pre-migration bundle.
      }),
      [process.env.LINEAR_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor(WORKSPACE_A_ID);
    const result = await handler(makeEvent(body, sign(STACK_WIDE_SECRET, body)));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test('rejects when registry status is not active even if per-workspace secret matches', async () => {
    // Revoked workspaces shouldn't trigger tasks. The stack-wide
    // signing secret here does not match the per-workspace secret, so
    // even without the no-fallback rule the request would fail — this
    // test only asserts that `revoked` flips to a 401.
    configureRegistry({
      [WORKSPACE_A_ID]: { oauth_secret_arn: WORKSPACE_A_SECRET_ARN, status: 'revoked', workspace_slug: 'acme-A' },
    });
    configureSecretsManager({
      [WORKSPACE_A_SECRET_ARN]: makeStoredOauth({
        workspace_id: WORKSPACE_A_ID,
        webhook_signing_secret: WORKSPACE_A_SECRET,
      }),
      [process.env.LINEAR_WEBHOOK_SECRET_ARN!]: STACK_WIDE_SECRET,
    });
    const body = payloadFor(WORKSPACE_A_ID);
    const result = await handler(makeEvent(body, sign(WORKSPACE_A_SECRET, body)));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('revoked workspace rejected even when the stack-wide secret matches the request', async () => {
    // Critical security test: `setup` mirrors the first workspace's
    // signing secret into the stack-wide one. If a workspace later gets
    // revoked, the stack-wide secret still matches its requests. Without
    // a distinct `revoked` outcome the receiver would silently fall
    // through to the stack-wide fallback and re-grant access. A revoked
    // workspace whose orgId is in the registry MUST fail closed — this test
    // pins the no-fallback rule.
    // verification regardless of how the request is signed.
    configureRegistry({
      [WORKSPACE_A_ID]: { oauth_secret_arn: WORKSPACE_A_SECRET_ARN, status: 'revoked', workspace_slug: 'acme-A' },
    });
    configureSecretsManager({
      [WORKSPACE_A_SECRET_ARN]: makeStoredOauth({
        workspace_id: WORKSPACE_A_ID,
        webhook_signing_secret: WORKSPACE_A_SECRET,
      }),
      // Stack-wide secret == workspace A's secret (the bypass scenario).
      [process.env.LINEAR_WEBHOOK_SECRET_ARN!]: WORKSPACE_A_SECRET,
    });
    const body = payloadFor(WORKSPACE_A_ID);
    const result = await handler(makeEvent(body, sign(WORKSPACE_A_SECRET, body)));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('infra error during per-workspace lookup surfaces as 500 (no silent stack-wide downgrade)', async () => {
    // A DDB throttle on the registry table (or a Secrets Manager 5xx)
    // must NOT collapse to the stack-wide fallback path — that would
    // silently downgrade a per-workspace-secured workspace to stack-
    // wide verification under load. Strict lookups bubble the error so
    // the receiver returns 500 and Linear retries (delivery is
    // best-effort with retries; brief unavailability is preferable to
    // a security-relevant downgrade).
    ddbSend.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'Get') {
        const err = new Error('Throttled');
        (err as Error & { name: string }).name = 'ProvisionedThroughputExceededException';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });
    configureSecretsManager({
      [process.env.LINEAR_WEBHOOK_SECRET_ARN!]: WORKSPACE_A_SECRET,
    });
    const body = payloadFor(WORKSPACE_A_ID);
    const result = await handler(makeEvent(body, sign(WORKSPACE_A_SECRET, body)));
    expect(result.statusCode).toBe(500);
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});
