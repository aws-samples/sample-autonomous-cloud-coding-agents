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

// A signing secret must attest WHICH tenant sent a delivery, because the processor
// routes from identifiers in the body. Two secrets fail that: the stack-wide one, which
// is bound to no workspace, and a per-workspace one that is a copy of another
// workspace's. Both are only dangerous once a second tenant exists to impersonate,
// which is what these tests pivot on.
//
// A separate file from linear-webhook.test.ts because the registry table name is read
// into a module-level const at import time, and these cases need it set.
import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
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

const REGISTRY = 'LinearWorkspaceRegistry';
const OAUTH_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme';
const STACK_WIDE_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/linear/webhook-XYZ';
process.env.LINEAR_WEBHOOK_SECRET_ARN = STACK_WIDE_ARN;
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = 'LinearDedup';
process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'linear-processor';
process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = REGISTRY;

import { handler } from '../../src/handlers/linear-webhook';
import { _resetCachesForTesting } from '../../src/handlers/shared/linear-oauth-resolver';
import { _resetActiveWorkspaceCountCache, invalidateLinearSecretCache } from '../../src/handlers/shared/linear-verify';

const OWN_SECRET = 'lin_wh_acmeOwnSecret';
const STACK_WIDE_SECRET = 'lin_wh_firstWorkspaceSecret';
const WS_ACME = 'org-acme';

function bundle(signingSecret: string): string {
  return JSON.stringify({
    access_token: '',
    refresh_token: '',
    expires_at: '',
    scope: '',
    client_id: 'cid',
    client_secret: 'csec',
    workspace_id: WS_ACME,
    workspace_slug: 'acme',
    installed_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    installed_by_platform_user_id: 'u-1',
    webhook_signing_secret: signingSecret,
  });
}

function body(): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    organizationId: WS_ACME,
    webhookTimestamp: Date.now(),
    data: { id: 'issue-1', identifier: 'ABC-1', title: 't', projectId: 'proj-1' },
  });
}

function event(raw: string, key: string): APIGatewayProxyEvent {
  return {
    body: raw,
    headers: { 'linear-signature': crypto.createHmac('sha256', key).update(raw).digest('hex') },
    httpMethod: 'POST',
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Wire DynamoDB for a registry holding `activeCount` workspaces.
 *
 * `Get` answers the row for the workspace under test; `Scan` answers the count. `Put` is
 * the dedup claim, which must succeed or the receiver stops before verification matters.
 */
function withRegistry(opts: { activeCount: number; row?: Record<string, unknown> | null }) {
  const selfRow = opts.row === undefined
    ? { linear_workspace_id: WS_ACME, workspace_slug: 'acme', oauth_secret_arn: OAUTH_ARN, status: 'active' }
    : opts.row;
  // `activeCount` is the total the Scan reports. A workspace with no registry row of its
  // own still shares the stack with the others, so the count must not shrink with it —
  // getting this wrong is what made the multi-workspace fallback case look like it
  // passed when the receiver had only ever seen one workspace.
  const otherCount = opts.activeCount - (selfRow ? 1 : 0);
  const others = Array.from({ length: Math.max(0, otherCount) }, (_, i) => ({
    linear_workspace_id: `org-other-${i}`, status: 'active',
  }));

  ddbSend.mockImplementation((cmd: { _type: string }) => {
    if (cmd._type === 'Get') return Promise.resolve({ Item: selfRow ?? undefined });
    if (cmd._type === 'Scan') {
      return Promise.resolve({
        Items: [...(selfRow ? [{ linear_workspace_id: WS_ACME, status: 'active' }] : []), ...others],
      });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateLinearSecretCache();
  _resetCachesForTesting();
  _resetActiveWorkspaceCountCache();
  smSend.mockImplementation((cmd: { _type: string; input: { SecretId?: string } }) => {
    if (cmd.input.SecretId === STACK_WIDE_ARN) return Promise.resolve({ SecretString: STACK_WIDE_SECRET });
    return Promise.resolve({ SecretString: bundle(OWN_SECRET) });
  });
  lambdaSend.mockResolvedValue({});
});

describe('a secret shared with another workspace is not proof of this one', () => {
  test('rejects when the row does not record the secret as its own and a second tenant exists', async () => {
    withRegistry({ activeCount: 2 });

    const res = await handler(event(body(), OWN_SECRET));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/not its own/);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('accepts the very same request once ownership is recorded', async () => {
    // The signature, the secret and the body are identical to the case above — only the
    // provenance flag differs. That isolates the flag as the thing being tested rather
    // than some incidental difference in the request.
    withRegistry({
      activeCount: 2,
      row: {
        linear_workspace_id: WS_ACME,
        workspace_slug: 'acme',
        oauth_secret_arn: OAUTH_ARN,
        status: 'active',
        webhook_secret_owned: true,
      },
    });

    const res = await handler(event(body(), OWN_SECRET));

    expect(res.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalled();
  });

  test('accepts an unrecorded provenance on a single-workspace stack', async () => {
    // Absent provenance is the normal state for every row written before it existed.
    // With one tenant the same secret cannot cross a boundary, so rejecting here would
    // break healthy installs to no benefit.
    withRegistry({ activeCount: 1 });

    const res = await handler(event(body(), OWN_SECRET));

    expect(res.statusCode).toBe(200);
  });
});

describe('the stack-wide fallback cannot name a tenant among several', () => {
  test('refuses the fallback when more than one workspace is active', async () => {
    // No per-workspace secret for this workspace, so verification falls through — and on
    // a multi-tenant stack the stack-wide secret cannot say who sent this.
    withRegistry({ activeCount: 2, row: null });

    const res = await handler(event(body(), STACK_WIDE_SECRET));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/Per-workspace signing secret required/);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('keeps the fallback working for a single-workspace install', async () => {
    withRegistry({ activeCount: 1, row: null });

    const res = await handler(event(body(), STACK_WIDE_SECRET));

    expect(res.statusCode).toBe(200);
  });

  test('tells the processor the fallback is what verified the delivery', async () => {
    withRegistry({ activeCount: 1, row: null });

    await handler(event(body(), STACK_WIDE_SECRET));

    const invoked = lambdaSend.mock.calls[0][0] as { input: { Payload: Uint8Array } };
    const forwarded = JSON.parse(new TextDecoder().decode(invoked.input.Payload)) as Record<string, unknown>;
    expect(forwarded.verified_via_stack_wide).toBe(true);
  });

  test('reports false when a per-workspace secret verified the delivery', async () => {
    // The processor binds the workspace only on the stack-wide path, so a false positive
    // here would make it discard a correctly attested organizationId and rebind it.
    withRegistry({
      activeCount: 1,
      row: {
        linear_workspace_id: WS_ACME,
        workspace_slug: 'acme',
        oauth_secret_arn: OAUTH_ARN,
        status: 'active',
        webhook_secret_owned: true,
      },
    });

    await handler(event(body(), OWN_SECRET));

    const invoked = lambdaSend.mock.calls[0][0] as { input: { Payload: Uint8Array } };
    const forwarded = JSON.parse(new TextDecoder().decode(invoked.input.Payload)) as Record<string, unknown>;
    expect(forwarded.verified_via_stack_wide).toBe(false);
  });
});
