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

const ddbSend = jest.fn();
const smSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  ScanCommand: jest.fn((input: Record<string, unknown>) => ({ _type: 'Scan', input })),
  UpdateCommand: jest.fn((input: Record<string, unknown>) => ({ _type: 'Update', input })),
  DeleteCommand: jest.fn((input: Record<string, unknown>) => ({ _type: 'Delete', input })),
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearRegistry';

import { handler } from '../../src/handlers/linear-remove-workspace';

const ADMIN = 'cognito-admin-sub';

const REMOVABLE_ROW = '#status = :active OR (#status = :revoked AND (attribute_not_exists(revoked_reason) OR revoked_reason <> :reason))';

// DynamoDB evaluates AND before OR: without the parentheses the `installed_at` clause binds to the revoked half only.
const SAME_INSTALLATION = `(${REMOVABLE_ROW}) AND installed_at = :installed`;
const NO_INSTALLATION_RECORDED = `(${REMOVABLE_ROW}) AND attribute_not_exists(installed_at)`;

const INSTALLED = '2026-11-01T09:00:00.000Z';

function makeEvent(opts: {
  slug?: string;
  userId?: string;
  query?: Record<string, string>;
} = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'DELETE',
    isBase64Encoded: false,
    path: `/v1/linear/workspaces/${opts.slug ?? 'acme'}`,
    pathParameters: opts.slug === undefined ? { slug: 'acme' } : { slug: opts.slug },
    queryStringParameters: opts.query ?? null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: opts.userId
      ? ({ authorizer: { claims: { sub: opts.userId } } } as unknown as APIGatewayProxyEvent['requestContext'])
      : ({} as APIGatewayProxyEvent['requestContext']),
    resource: '',
  };
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    linear_workspace_id: 'ws-uuid-1',
    workspace_slug: 'acme',
    oauth_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-AbCd',
    installed_by_platform_user_id: ADMIN,
    installed_at: INSTALLED,
    status: 'active',
    ...overrides,
  };
}

/**
 * DynamoDB applies a Scan's FilterExpression after `Limit`: `Limit` bounds the
 * items examined, not the items matched, and `LastEvaluatedKey` comes back
 * whenever unexamined rows remain, even when the page matched nothing.
 * `pageSize` stands for the 1 MB page boundary of a scan that sends no `Limit`.
 */
function routeDdb(opts: {
  registryRow?: Record<string, unknown> | null;
  registryRows?: Record<string, unknown>[];
  pageSize?: number;
} = {}) {
  const rows: Record<string, unknown>[] = opts.registryRows
    ?? (opts.registryRow === undefined
      ? [activeRow()]
      : (opts.registryRow === null ? [] : [opts.registryRow]));

  ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
      const values = (cmd.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      const start = Number((cmd.input.ExclusiveStartKey as { _idx?: number } | undefined)?._idx ?? 0);
      const limit = (cmd.input.Limit as number | undefined) ?? opts.pageSize;
      const end = limit === undefined ? rows.length : Math.min(rows.length, start + limit);
      const examined = rows.slice(start, end);
      const matched = examined.filter((r) => r.workspace_slug === values[':slug'] && (
        r.status === values[':active']
        || (values[':revoked'] !== undefined && r.status === values[':revoked'] && r.revoked_reason !== values[':reason'])
      ));
      const more = end < rows.length;
      return Promise.resolve({
        Items: matched,
        ...(more ? { LastEvaluatedKey: { _idx: end } } : {}),
      });
    }
    return Promise.resolve({});
  });
}

function routeDdbWithAWriteAfterTheScan(read: Record<string, unknown>, written: Record<string, unknown>) {
  const registry = [read];
  routeDdb({ registryRows: registry });
  const baseImpl = ddbSend.getMockImplementation()!;
  ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
    const answer = baseImpl(cmd);
    if (cmd._type === 'Scan') registry[0] = written;
    const values = (cmd.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    if (cmd._type !== 'Update' || values[':revoked'] !== 'revoked') return answer;

    const [row] = registry;
    const removable = row.status === values[':active']
      || (row.status === values[':revoked'] && row.revoked_reason !== values[':reason']);
    const sameInstallation = cmd.input.ConditionExpression !== SAME_INSTALLATION
      || row.installed_at === values[':installed'];
    if (!removable || !sameInstallation) {
      return Promise.reject(
        Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }),
      );
    }
    registry[0] = { ...row, status: values[':revoked'], revoked_reason: values[':reason'] };
    return answer;
  });
  return registry;
}

function findRevoke() {
  return ddbSend.mock.calls.find(
    ([c]) => c._type === 'Update'
      && c.input.TableName === 'LinearRegistry'
      && (c.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[':revoked'] === 'revoked',
  );
}

function findMarker() {
  return ddbSend.mock.calls.find(
    ([c]) => c._type === 'Update'
      && String(c.input.UpdateExpression ?? '').includes('secret_deletion_failed'),
  );
}

function expectNothingRemoved() {
  expect(smSend).not.toHaveBeenCalled();
  expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Update' || c._type === 'Delete')).toHaveLength(0);
}

describe('linear-remove-workspace handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    smSend.mockResolvedValue({});
  });

  test('401s without a Cognito JWT', async () => {
    const result = await handler(makeEvent({ slug: 'acme' }));
    expect(result.statusCode).toBe(401);
  });

  test('400s on an invalid slug', async () => {
    const result = await handler(makeEvent({ slug: 'a', userId: ADMIN }));
    expect(result.statusCode).toBe(400);
  });

  test('404s when the workspace is not in the registry', async () => {
    routeDdb({ registryRow: null });
    const result = await handler(makeEvent({ slug: 'ghost', userId: ADMIN }));
    expect(result.statusCode).toBe(404);
  });

  test('403s when the caller is not the workspace admin', async () => {
    routeDdb();
    const result = await handler(makeEvent({ slug: 'acme', userId: 'not-the-admin' }));
    expect(result.statusCode).toBe(403);
    expect(smSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Update' || c._type === 'Delete')).toHaveLength(0);
  });

  test('happy path: revokes the registry row and deletes the secret (default flags)', async () => {
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    const updateCall = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(updateCall![0].input.Key).toEqual({ linear_workspace_id: 'ws-uuid-1' });
    expect(updateCall![0].input.ExpressionAttributeValues).toMatchObject({
      ':revoked': 'revoked',
      ':reason': 'admin_removed',
      ':uid': ADMIN,
      ':installed': INSTALLED,
    });
    expect(updateCall![0].input.ConditionExpression).toBe(SAME_INSTALLATION);
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Delete')).toHaveLength(0);

    const secretCall = smSend.mock.calls.find(([c]) => c._type === 'DeleteSecret');
    expect(secretCall).toBeTruthy();
    expect(secretCall![0].input).toEqual({
      SecretId: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-AbCd',
      ForceDeleteWithoutRecovery: true,
    });

    const body = JSON.parse(result.body) as { data: { status: string; secret: string } };
    expect(body.data.status).toBe('revoked');
    expect(body.data.secret).toBe('deleted');
  });

  test('--purge deletes the registry row (after a fail-closed revoke) and reports purged', async () => {
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(200);

    const updateCall = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(updateCall![0].input.ExpressionAttributeValues).toMatchObject({ ':revoked': 'revoked' });
    const deleteCall = ddbSend.mock.calls.find(([c]) => c._type === 'Delete');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall![0].input.Key).toEqual({ linear_workspace_id: 'ws-uuid-1' });

    const body = JSON.parse(result.body) as { data: { status: string } };
    expect(body.data.status).toBe('purged');
  });

  test('secret-already-gone is idempotent (ResourceNotFoundException swallowed)', async () => {
    routeDdb();
    smSend.mockReset();
    smSend.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }),
    );

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { data: { secret: string; status: string; provider_name?: string } };
    expect(body.data.status).toBe('revoked');
    expect(body.data.secret).toBe('absent');
    expect(body.data).not.toHaveProperty('provider_name');
  });

  test('never touches a project-mapping table (mapping cleanup dropped)', async () => {
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    const nonRegistry = ddbSend.mock.calls.filter(
      ([c]) => c.input?.TableName !== 'LinearRegistry',
    );
    expect(nonRegistry).toHaveLength(0);

    const body = JSON.parse(result.body) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty('mappings_removed');
  });

  test('B1 regression: finds a live workspace that is not the first registry row (two active rows, target second)', async () => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-other', workspace_slug: 'other' }),
        activeRow({ linear_workspace_id: 'ws-acme', workspace_slug: 'acme' }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    const revoke = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(revoke![0].input.Key).toEqual({ linear_workspace_id: 'ws-acme' });

    const body = JSON.parse(result.body) as { data: { linear_workspace_id: string } };
    expect(body.data.linear_workspace_id).toBe('ws-acme');
  });

  test('registry scan follows LastEvaluatedKey across pages (no Limit)', async () => {
    let scans = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
        scans += 1;
        if (scans === 1) {
          return Promise.resolve({ Items: [], LastEvaluatedKey: { _idx: 1 } });
        }
        return Promise.resolve({ Items: [activeRow()] });
      }
      return Promise.resolve({});
    });
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(scans).toBe(2);
    const secondScan = ddbSend.mock.calls.filter(
      ([c]) => c._type === 'Scan' && c.input.TableName === 'LinearRegistry',
    )[1];
    expect(secondScan![0].input.ExclusiveStartKey).toEqual({ _idx: 1 });
    const firstScan = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Scan' && c.input.TableName === 'LinearRegistry',
    );
    expect(firstScan![0].input.Limit).toBeUndefined();
  });

  test('a workspace this endpoint already removed is treated as not-found (fail-closed, no re-revoke)', async () => {
    routeDdb({ registryRow: activeRow({ status: 'revoked', revoked_reason: 'admin_removed' }) });
    smSend.mockReset();
    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(404);
    expect(smSend).not.toHaveBeenCalled();
  });

  test.each([
    ['Linear rejected its refresh token', 'refresh_token_rejected'],
    ['the vault asked for consent', 'vault_consent_required'],
    ['an operator revoked it by hand, with no reason', undefined],
  ])('removes a workspace that is revoked because %s: its secret is still there', async (_why, revokedReason) => {
    routeDdb({ registryRow: activeRow({ status: 'revoked', revoked_reason: revokedReason }) });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    expect(findRevoke()![0].input.Key).toEqual({ linear_workspace_id: 'ws-uuid-1' });
    expect(findRevoke()![0].input.ExpressionAttributeValues).toMatchObject({ ':reason': 'admin_removed', ':uid': ADMIN });
    expect(smSend.mock.calls.map(([c]) => c.input)).toEqual([{
      SecretId: 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-AbCd',
      ForceDeleteWithoutRecovery: true,
    }]);
    expect(JSON.parse(result.body).data).toMatchObject({ status: 'revoked', secret: 'deleted' });
  });

  test('403s for a caller who is not the admin of a workspace revoked for a dead grant', async () => {
    routeDdb({ registryRow: activeRow({ status: 'revoked', revoked_reason: 'refresh_token_rejected' }) });
    const result = await handler(makeEvent({ slug: 'acme', userId: 'not-the-admin' }));
    expect(result.statusCode).toBe(403);
    expect(smSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Update' || c._type === 'Delete')).toHaveLength(0);
  });

  // A Linear workspace can give up its urlKey and another can take it, so one slug can name a revoked row and an active one.
  test.each([
    ['on the same scan page', undefined],
    ['on a later scan page', 1],
  ])('an active workspace wins over a dead row that still carries its slug (%s)', async (_where, pageSize) => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-dead', status: 'revoked', revoked_reason: 'refresh_token_rejected' }),
        activeRow({ linear_workspace_id: 'ws-live' }),
      ],
      pageSize,
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(findRevoke()![0].input.Key).toEqual({ linear_workspace_id: 'ws-live' });
    expect(JSON.parse(result.body).data.linear_workspace_id).toBe('ws-live');
  });

  test('a dead row is still the one removed when the pages after it hold no active row for the slug', async () => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-dead', status: 'revoked', revoked_reason: 'refresh_token_rejected' }),
        activeRow({ linear_workspace_id: 'ws-other', workspace_slug: 'other' }),
      ],
      pageSize: 1,
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(findRevoke()![0].input.Key).toEqual({ linear_workspace_id: 'ws-dead' });
  });

  test.each([
    ['on one scan page', undefined, undefined],
    ['on two scan pages', 1, undefined],
    ['with purge=true', undefined, { purge: 'true' }],
  ])('409s and removes nothing when two active rows carry the slug (%s)', async (_how, pageSize, query) => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-first' }),
        activeRow({ linear_workspace_id: 'ws-second' }),
      ],
      pageSize,
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query }));

    expect(result.statusCode).toBe(409);
    const { error } = JSON.parse(result.body) as { error: { code: string; message: string } };
    expect(error.code).toBe('WORKSPACE_SLUG_AMBIGUOUS');
    expect(error.message).toContain('ws-first');
    expect(error.message).toContain('ws-second');
    expectNothingRemoved();
  });

  test.each([
    ["another admin's row is read first", ['someone-else', ADMIN]],
    ["the caller's row is read first", [ADMIN, 'someone-else']],
  ])('409s for the admin of one of two active rows (%s)', async (_order, [installerOfFirst, installerOfSecond]) => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-first', installed_by_platform_user_id: installerOfFirst }),
        activeRow({ linear_workspace_id: 'ws-second', installed_by_platform_user_id: installerOfSecond }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(result.statusCode).toBe(409);
    const { error } = JSON.parse(result.body) as { error: { code: string; message: string } };
    expect(error.code).toBe('WORKSPACE_SLUG_AMBIGUOUS');
    expect(error.message).toContain('ws-first');
    expect(error.message).toContain('ws-second');
    expectNothingRemoved();
  });

  test('the 409 names each of three active rows, and not a dead row that carries the slug too', async () => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-dead', status: 'revoked', revoked_reason: 'refresh_token_rejected' }),
        activeRow({ linear_workspace_id: 'ws-first' }),
        activeRow({ linear_workspace_id: 'ws-second' }),
        activeRow({ linear_workspace_id: 'ws-third' }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain('ws-first');
    expect(result.body).toContain('ws-second');
    expect(result.body).toContain('ws-third');
    expect(result.body).not.toContain('ws-dead');
    expectNothingRemoved();
  });

  test("403s for the admin of a dead row when the active row that carries the slug is another admin's", async () => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-dead', status: 'revoked', revoked_reason: 'refresh_token_rejected' }),
        activeRow({ linear_workspace_id: 'ws-live', installed_by_platform_user_id: 'someone-else' }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(result.statusCode).toBe(403);
    expectNothingRemoved();
  });

  test('403s, without naming the rows, for a caller who installed none of the active rows that carry the slug', async () => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-first' }),
        activeRow({ linear_workspace_id: 'ws-second' }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: 'not-the-admin' }));

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN');
    expect(result.body).not.toContain('ws-first');
    expect(result.body).not.toContain('ws-second');
    expectNothingRemoved();
  });

  test('with no active row for the slug, the dead row read first is removed and the other is left as it is', async () => {
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-dead-1', status: 'revoked', revoked_reason: 'refresh_token_rejected' }),
        activeRow({ linear_workspace_id: 'ws-dead-2', status: 'revoked', revoked_reason: 'refresh_token_rejected' }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(result.statusCode).toBe(200);
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Update').map(([c]) => c.input.Key))
      .toEqual([{ linear_workspace_id: 'ws-dead-1' }]);
  });

  test('the registry scan fail-closes on status via the FilterExpression (pins the filter to the handler)', async () => {
    routeDdb({ registryRow: null });
    await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    const scanCall = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Scan' && c.input.TableName === 'LinearRegistry',
    );
    expect(scanCall![0].input.FilterExpression).toBe(`workspace_slug = :slug AND (${REMOVABLE_ROW})`);
    expect(scanCall![0].input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(scanCall![0].input.ExpressionAttributeValues).toEqual({
      ':slug': 'acme',
      ':active': 'active',
      ':revoked': 'revoked',
      ':reason': 'admin_removed',
    });
    expect(scanCall![0].input.ConsistentRead).toBe(true);
  });

  test('a real (non-idempotent) secret-delete error 500s SECRET_DELETE_FAILED and marks the row', async () => {
    routeDdb();
    smSend.mockReset();
    smSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as { error: { code: string } };
    expect(body.error.code).toBe('SECRET_DELETE_FAILED');

    const revokeUpdate = findRevoke();
    expect(revokeUpdate).toBeTruthy();
    const marker = findMarker();
    expect(marker).toBeTruthy();
    expect(marker![0].input.ExpressionAttributeValues).toMatchObject({
      ':t': true,
      ':e': 'AccessDeniedException',
      ':arn': 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-AbCd',
    });
  });

  test('B3 regression: --purge + secret-delete failure keeps the row and marks it (no leaked credential)', async () => {
    routeDdb();
    smSend.mockReset();
    smSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as { error: { code: string } };
    expect(body.error.code).toBe('SECRET_DELETE_FAILED');

    expect(findRevoke()).toBeTruthy();
    expect(findMarker()).toBeTruthy();
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Delete')).toHaveLength(0);
  });

  test('--purge deletes the row only AFTER the secret is confirmed gone (revoke → delete-secret → delete-row)', async () => {
    routeDdb();
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(200);

    const ddbTypes = ddbSend.mock.calls.map(([c]) => c._type);
    const updateIdx = ddbTypes.indexOf('Update');
    const deleteIdx = ddbTypes.indexOf('Delete');
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(updateIdx);
    expect(smSend).toHaveBeenCalledTimes(1);

    const body = JSON.parse(result.body) as { data: { status: string } };
    expect(body.data.status).toBe('purged');
  });

  test('a registry row with no oauth_secret_arn deletes the secret by its deterministic name', async () => {
    routeDdb({ registryRow: activeRow({ oauth_secret_arn: undefined }) });
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(smSend).toHaveBeenCalledTimes(1);
    // Secrets Manager accepts the name of a secret as `SecretId`.
    expect(smSend.mock.calls[0][0].input).toEqual({
      SecretId: 'bgagent-linear-oauth-acme',
      ForceDeleteWithoutRecovery: true,
    });
    const body = JSON.parse(result.body) as { data: { secret: string } };
    expect(body.data.secret).toBe('deleted');
  });

  test("a vault-managed row with no secret reports secret: 'not_applicable' and echoes provider_name", async () => {
    routeDdb({
      registryRow: activeRow({
        oauth_secret_arn: undefined,
        provider_name: 'bgagent-linear-oauth-acme',
        vault_user_id: 'vault-user-1',
      }),
    });
    smSend.mockReset();
    smSend.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }),
    );

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { data: { secret: string; provider_name?: string } };
    expect(body.data.secret).toBe('not_applicable');
    expect(body.data.provider_name).toBe('bgagent-linear-oauth-acme');
  });

  test("a vault row that DID record an ARN reports 'absent', not 'not_applicable'", async () => {
    routeDdb({ registryRow: activeRow({ provider_name: 'bgagent-linear-oauth-acme' }) });
    smSend.mockReset();
    smSend.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }),
    );

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { data: { secret: string; provider_name?: string } };
    expect(body.data.secret).toBe('absent');
    expect(body.data.provider_name).toBe('bgagent-linear-oauth-acme');
  });

  test('a lost race (row already removed at write time) 404s and never deletes the secret', async () => {
    routeDdb();
    const baseImpl = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Update') {
        return Promise.reject(
          Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' }),
        );
      }
      return baseImpl(cmd);
    });
    smSend.mockReset();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(smSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Delete')).toHaveLength(0);
  });

  test.each([
    ['revoked for a dead grant', { status: 'revoked', revoked_reason: 'refresh_token_rejected' }],
    ['active', {}],
  ])('a workspace read as %s and set up again before the revoke keeps its new registration and its secret', async (_as, read) => {
    const setUpAgain = activeRow({ installed_at: '2026-11-18T10:00:05.000Z' });
    const registry = routeDdbWithAWriteAfterTheScan(activeRow(read), setUpAgain);

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(registry).toEqual([setUpAgain]);
    expect(smSend).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
      message: expect.stringContaining('set up again'),
    });
  });

  test('a row that carries no installed_at is revoked on condition that it still carries none', async () => {
    // DynamoDB rejects a request that binds an expression attribute value no expression uses.
    routeDdb({ registryRow: activeRow({ installed_at: undefined }) });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(findRevoke()![0].input.ConditionExpression).toBe(NO_INSTALLATION_RECORDED);
    expect(findRevoke()![0].input.ExpressionAttributeValues).not.toHaveProperty(':installed');
  });

  test('a non-conditional Update failure surfaces as a 500 and never reaches the secret delete', async () => {
    routeDdb();
    const baseImpl = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Update') {
        return Promise.reject(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
      }
      return baseImpl(cmd);
    });
    smSend.mockReset();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(500);
    expect(smSend).not.toHaveBeenCalled();
  });

  test('the registry scan is bounded: a never-matching paginating scan 500s instead of burning the timeout', async () => {
    let scans = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'Scan') {
        scans += 1;
        return Promise.resolve({ Items: [], LastEvaluatedKey: { _idx: scans } });
      }
      return Promise.resolve({});
    });
    smSend.mockReset();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(500);
    expect(scans).toBe(20);
    expect(smSend).not.toHaveBeenCalled();
  });

  test('the page cap also stops a scan that has read an active row: the pages left unread can hold a second one', async () => {
    let scans = 0;
    ddbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'Scan') {
        scans += 1;
        return Promise.resolve({ Items: scans === 1 ? [activeRow()] : [], LastEvaluatedKey: { _idx: scans } });
      }
      return Promise.resolve({});
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(result.statusCode).toBe(500);
    expect(scans).toBe(20);
    expectNothingRemoved();
  });

  test('a --purge row delete failure after a successful secret delete 500s (does not report purged)', async () => {
    routeDdb();
    const baseImpl = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Delete') {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
      }
      return baseImpl(cmd);
    });
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(500);
    expect(findRevoke()).toBeTruthy();
    expect(smSend).toHaveBeenCalledTimes(1);
  });

  test('a failing marker write does not mask the SECRET_DELETE_FAILED error', async () => {
    routeDdb();
    const baseImpl = ddbSend.getMockImplementation()!;
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Update' && String(cmd.input.UpdateExpression ?? '').includes('secret_deletion_failed')) {
        return Promise.reject(new Error('marker write failed'));
      }
      return baseImpl(cmd);
    });
    smSend.mockReset();
    smSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as { error: { code: string } };
    expect(body.error.code).toBe('SECRET_DELETE_FAILED');
  });
});

describe('linear-remove-workspace handler without its registry table configured', () => {
  test('500s on a missing LINEAR_WORKSPACE_REGISTRY_TABLE_NAME instead of an opaque SDK error', async () => {
    const saved = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
    delete process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;
    try {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../src/handlers/linear-remove-workspace') as typeof import('../../src/handlers/linear-remove-workspace');
      ddbSend.mockReset();
      smSend.mockReset();
      const result = await mod.handler(makeEvent({ slug: 'acme', userId: ADMIN }));
      expect(result.statusCode).toBe(500);
      expect(ddbSend).not.toHaveBeenCalled();
      expect(smSend).not.toHaveBeenCalled();
    } finally {
      process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = saved;
      jest.resetModules();
    }
  });
});
