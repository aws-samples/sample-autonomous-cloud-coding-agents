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

/**
 * The rows the endpoint may tear down, as it has to put it to DynamoDB in the
 * scan filter and again in the condition of the revoke: active, or revoked by
 * anything but this endpoint. Spelled out rather than imported, so that a
 * change to the handler's expression fails here.
 */
const REMOVABLE_ROW = '#status = :active OR (#status = :revoked AND (attribute_not_exists(revoked_reason) OR revoked_reason <> :reason))';

/**
 * The condition of the revoke: a row to remove that is still the installation the
 * scan read. `setup` and `add-workspace` write `installed_at` anew each time; a row
 * read without one has to be without one still. The parentheses carry the meaning:
 * DynamoDB evaluates AND before OR, so without them the clause would belong to the
 * revoked half of `REMOVABLE_ROW`, and an active row would pass whatever its
 * installation.
 */
const SAME_INSTALLATION = `(${REMOVABLE_ROW}) AND installed_at = :installed`;
const NO_INSTALLATION_RECORDED = `(${REMOVABLE_ROW}) AND attribute_not_exists(installed_at)`;

/** `installed_at` of the fixture row: the time `setup` recorded for its installation. */
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
 * Route DDB commands by type + table rather than by call order, so a test
 * only has to declare the registry contents it cares about.
 *
 * The registry scan double models *real* DynamoDB filtered-Scan semantics —
 * this is what makes B1 (`Limit: 1` on a filtered scan) observable and the
 * two-active-workspaces regression expressible:
 *   1. `Limit` bounds the items *examined* (the raw page slice), NOT the
 *      items matched — DynamoDB applies the FilterExpression AFTER slicing.
 *   2. `ExclusiveStartKey` advances a page cursor over the seeded rows.
 *   3. `LastEvaluatedKey` is returned whenever unexamined rows remain, even
 *      if this page matched nothing.
 * The seeded rows are held in table order; the handler's filter is applied to
 * the examined slice, as far as the values the scan binds say what it asks
 * for: the slug, an active status, and, when `:revoked` is bound too, a row
 * revoked for any reason but `:reason` (or for none). The exact expression is
 * pinned by a test below. A handler that examines only one arbitrary row
 * (Limit: 1) and never follows the key can therefore miss a matching row that
 * sits on a later page. `pageSize` puts a page boundary (DynamoDB's 1 MB)
 * between seeded rows for a scan that sends no `Limit`.
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
      // Apply the handler's FilterExpression to the examined slice only.
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

/**
 * `routeDdb` for a registry of one row that another command rewrites between this
 * handler's read and its revoke: `written` takes the place of `read` once the scan
 * has answered. The revoke is then answered as DynamoDB answers it, on the row as
 * it is by then: it needs a removable row, and under `SAME_INSTALLATION` the
 * `installed_at` that the revoke binds. Returns the registry, to read what became
 * of the row.
 */
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

/**
 * Find the revoke Update by the value bound to `:revoked`, not by a
 * `JSON.stringify(...).includes('revoked')` substring — the literal "revoked"
 * appears in three *attribute names* the same command writes (`revoked_at`,
 * `revoked_reason`, `revoked_by_platform_user_id`), so a stringify match would
 * still pass if the status were never set at all.
 */
function findRevoke() {
  return ddbSend.mock.calls.find(
    ([c]) => c._type === 'Update'
      && c.input.TableName === 'LinearRegistry'
      && (c.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[':revoked'] === 'revoked',
  );
}

/** Find the orphaned-secret marker Update by its UpdateExpression target. */
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
    // Must NOT have deleted the secret or written the row.
    expect(smSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Update' || c._type === 'Delete')).toHaveLength(0);
  });

  test('happy path: revokes the registry row and deletes the secret (default flags)', async () => {
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    // Registry row flipped to revoked, NOT deleted, by default. Asserted on
    // the individual attribute values rather than a JSON.stringify substring:
    // 'revoked' also appears in the attribute *names* (`revoked_at`,
    // `revoked_reason`, `revoked_by_platform_user_id`), so a stringify match
    // passes even if `:revoked` were never bound to the status.
    const updateCall = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(updateCall![0].input.Key).toEqual({ linear_workspace_id: 'ws-uuid-1' });
    expect(updateCall![0].input.ExpressionAttributeValues).toMatchObject({
      ':revoked': 'revoked',
      // Terminal, and deliberately NOT `vault_consent_required` — that is the
      // one revoked reason the OAuth resolver re-probes instead of refusing.
      ':reason': 'admin_removed',
      ':uid': ADMIN,
      ':installed': INSTALLED,
    });
    // The revoke is conditional on the row still being one this endpoint has
    // not removed, so two concurrent DELETEs can't both believe they won (a
    // filtered Scan is a TOCTOU on its own; only the condition settles it),
    // and on its still being the installation that the scan read.
    expect(updateCall![0].input.ConditionExpression).toBe(SAME_INSTALLATION);
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Delete')).toHaveLength(0);

    // Secret deleted — and asserted on *what* was deleted and *how*. A bare
    // "a DeleteSecret happened" would pass on a wrong SecretId, and without
    // ForceDeleteWithoutRecovery the secret lingers for a 7-30 day recovery
    // window while the caller is told teardown is done.
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

    // The row is revoked first (fail-closed) and then hard-deleted — so both
    // an Update and a Delete land on the registry row on the purge path.
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
    // Row still revoked; the secret this row *recorded* was already gone, so
    // teardown is genuinely complete → `absent`, not `not_applicable`.
    expect(body.data.status).toBe('revoked');
    expect(body.data.secret).toBe('absent');
    expect(body.data).not.toHaveProperty('provider_name');
  });

  test('never touches a project-mapping table (mapping cleanup dropped)', async () => {
    // Mapping cleanup was removed: mapping rows carry no workspace id, so
    // they can't be attributed to a workspace. The handler must not scan or
    // delete any mapping table, and the response carries no mapping count.
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    // The only table the handler touches is the registry.
    const nonRegistry = ddbSend.mock.calls.filter(
      ([c]) => c.input?.TableName !== 'LinearRegistry',
    );
    expect(nonRegistry).toHaveLength(0);

    const body = JSON.parse(result.body) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty('mappings_removed');
  });

  test('B1 regression: finds a live workspace that is not the first registry row (two active rows, target second)', async () => {
    // Two active rows on one shared stack (the normal multi-workspace state).
    // The double models real filtered-Scan semantics: with a `Limit: 1` scan
    // it would examine only the first row (`ws-other`), filter it out, and
    // return `[]` + a LastEvaluatedKey — so the old `Limit: 1` handler that
    // read only `Items[0]` and never followed the key would 404 the live
    // target. The fixed handler sends no Limit, so the filter matches the
    // second row and the revoke lands on it. This test 404s before the fix
    // and passes after.
    routeDdb({
      registryRows: [
        activeRow({ linear_workspace_id: 'ws-other', workspace_slug: 'other' }),
        activeRow({ linear_workspace_id: 'ws-acme', workspace_slug: 'acme' }),
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    // The revoke landed on the *target* row, not the first-examined one.
    const revoke = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(revoke![0].input.Key).toEqual({ linear_workspace_id: 'ws-acme' });

    const body = JSON.parse(result.body) as { data: { linear_workspace_id: string } };
    expect(body.data.linear_workspace_id).toBe('ws-acme');
  });

  test('registry scan follows LastEvaluatedKey across pages (no Limit)', async () => {
    // Directly asserts the handler paginates. We hand-roll the Scan double
    // (rather than reuse routeDdb) so we can split the registry across two
    // pages: page one is empty but carries a continuation key, and the target
    // sits on page two. A handler that reads only `Items[0]` on the first
    // page and ignores LastEvaluatedKey 404s here.
    let scans = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
        scans += 1;
        if (scans === 1) {
          // Page 1: empty (no matching row) + a continuation key. An empty
          // page plus a LastEvaluatedKey is exactly the shape that catches a
          // non-paginating handler.
          return Promise.resolve({ Items: [], LastEvaluatedKey: { _idx: 1 } });
        }
        // Page 2: the target.
        return Promise.resolve({ Items: [activeRow()] });
      }
      return Promise.resolve({});
    });
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(scans).toBe(2);
    // The second scan carried the continuation key from page one.
    const secondScan = ddbSend.mock.calls.filter(
      ([c]) => c._type === 'Scan' && c.input.TableName === 'LinearRegistry',
    )[1];
    expect(secondScan![0].input.ExclusiveStartKey).toEqual({ _idx: 1 });
    // No `Limit` on a filtered registry scan (that was the B1 bug).
    const firstScan = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Scan' && c.input.TableName === 'LinearRegistry',
    );
    expect(firstScan![0].input.Limit).toBeUndefined();
  });

  test('a workspace this endpoint already removed is treated as not-found (fail-closed, no re-revoke)', async () => {
    // The registry scan leaves out a row revoked with `admin_removed`, the
    // reason this endpoint writes, so it simply doesn't match. The 404 does
    // not distinguish removed from missing, and avoids a second destructive pass.
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
    // Revoking a row for a dead grant deletes nothing, so the secret with the
    // OAuth client secret and the signing secret is still in Secrets Manager.
    // Answering 404 here left it there with no way to remove it.
    routeDdb({ registryRow: activeRow({ status: 'revoked', revoked_reason: revokedReason }) });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    // Marked as an admin removal, which is terminal: a `vault_consent_required`
    // row would otherwise turn active again when the vault next answers.
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

  test.each([
    ['on the same scan page', undefined],
    ['on a later scan page', 1],
  ])('an active workspace wins over a dead row that still carries its slug (%s)', async (_where, pageSize) => {
    // A Linear workspace can give up its urlKey and another can take it, so one
    // slug can name a revoked row and an active one. The admin means the live
    // one; removing the dead one and reporting success would leave it running.
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

  // ─── One slug, several active rows (#883) ───────────────────────────────
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
    // Assert the handler itself sends the status filter — the revoke-oracle
    // prevention property lives in this filter, not in the test router.
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
    // Read-your-writes: a default eventually-consistent Scan can hand back a
    // row a just-completed setup (or a peer removal) has already changed.
    // Same reasoning as `shared/jira-tenant-registry.ts:32-46`.
    expect(scanCall![0].input.ConsistentRead).toBe(true);
  });

  test('a real (non-idempotent) secret-delete error 500s SECRET_DELETE_FAILED and marks the row', async () => {
    // The row is revoked first (fail-closed holds), but the live OAuth secret
    // could not be deleted. This must NOT be masked as success, and must not
    // be an opaque 500 — the operator needs to know a credential leaked.
    routeDdb();
    smSend.mockReset();
    smSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as { error: { code: string } };
    expect(body.error.code).toBe('SECRET_DELETE_FAILED');

    // The registry row was still revoked (Update ran before the secret step)...
    const revokeUpdate = findRevoke();
    expect(revokeUpdate).toBeTruthy();
    // ...and a durable secret-deletion-failed marker was persisted, naming the
    // exact SecretId that was attempted so the orphan is findable.
    const marker = findMarker();
    expect(marker).toBeTruthy();
    expect(marker![0].input.ExpressionAttributeValues).toMatchObject({
      ':t': true,
      ':e': 'AccessDeniedException',
      ':arn': 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent-linear-oauth-acme-AbCd',
    });
  });

  test('B3 regression: --purge + secret-delete failure keeps the row and marks it (no leaked credential)', async () => {
    // On --purge the row is revoked first (an Update, NOT a delete), the
    // secret delete fails, and the --purge row delete must NOT run — so the
    // durable orphaned-secret marker survives and the credential is
    // discoverable. Before the reorder fix the row was deleted up-front and
    // the marker was skipped, leaking the secret with no record.
    routeDdb();
    smSend.mockReset();
    smSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as { error: { code: string } };
    expect(body.error.code).toBe('SECRET_DELETE_FAILED');

    // The row was revoked (Update), the marker was persisted, and — crucially
    // — no Delete ran, so the row (and its marker) survives on the --purge path.
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

    // Order: registry Update (revoke) → DeleteSecret → registry Delete (purge).
    const ddbTypes = ddbSend.mock.calls.map(([c]) => c._type);
    const updateIdx = ddbTypes.indexOf('Update');
    const deleteIdx = ddbTypes.indexOf('Delete');
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(updateIdx);
    expect(smSend).toHaveBeenCalledTimes(1);

    const body = JSON.parse(result.body) as { data: { status: string } };
    expect(body.data.status).toBe('purged');
  });

  // ─── B1: a row with no recorded ARN must still be torn down ─────────────
  test('a registry row with no oauth_secret_arn deletes the secret by its deterministic name', async () => {
    // The old handler skipped the secret delete entirely when the row had no
    // `oauth_secret_arn`, silently leaving a live Linear OAuth secret behind
    // and reporting success. The name is deterministic
    // (`bgagent-linear-oauth-<slug>`) and `SecretId` accepts a name, so there
    // is nothing to guess — and the IAM grant is over that *name* prefix
    // (`linear-integration.ts`), which is what makes this permitted.
    routeDdb({ registryRow: activeRow({ oauth_secret_arn: undefined }) });
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(smSend).toHaveBeenCalledTimes(1);
    expect(smSend.mock.calls[0][0].input).toEqual({
      SecretId: 'bgagent-linear-oauth-acme',
      ForceDeleteWithoutRecovery: true,
    });
    const body = JSON.parse(result.body) as { data: { secret: string } };
    expect(body.data.secret).toBe('deleted');
  });

  test("a vault-managed row with no secret reports secret: 'not_applicable' and echoes provider_name", async () => {
    // The distinction the boolean erased. `absent` says "teardown finished";
    // `not_applicable` says "this workspace's credential lives in an AgentCore
    // provider that this endpoint did not delete" — a live, self-refreshing
    // Linear grant that outlives even `cdk destroy`. Same observable AWS calls,
    // opposite operational meaning.
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
    // `bgagent linear setup` writes `oauth_secret_arn` unconditionally
    // (cli/src/commands/linear.ts), so vault rows normally carry BOTH
    // a provider name and an ARN. "vault-managed ⇒ no secret" would therefore be
    // wrong: only a vault row with no ARN of its own is `not_applicable`. The
    // provider follow-up is still reported, because that is driven by
    // `provider_name`, not by the secret outcome.
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

  // ─── Concurrency + scan bounds ──────────────────────────────────────────
  test('a lost race (row already removed at write time) 404s and never deletes the secret', async () => {
    // The filtered Scan and the Update are two round trips, so a peer DELETE
    // can land in between. The ConditionExpression is what catches that;
    // without it both callers would "succeed" and the second would delete a
    // secret the first already accounted for.
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
    // Nothing destructive may follow a lost race.
    expect(smSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Delete')).toHaveLength(0);
  });

  test.each([
    ['revoked for a dead grant', { status: 'revoked', revoked_reason: 'refresh_token_rejected' }],
    ['active', {}],
  ])('a workspace read as %s and set up again before the revoke keeps its new registration and its secret', async (_as, read) => {
    // `bgagent linear setup` stores the new token in the workspace's secret and
    // then puts the whole row anew: active, with the time of this installation. A
    // revoke that asks only for a removable row finds one in it, and the delete
    // that follows takes the secret with the token just stored.
    const setUpAgain = activeRow({ installed_at: '2026-11-18T10:00:05.000Z' });
    const registry = routeDdbWithAWriteAfterTheScan(activeRow(read), setUpAgain);

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));

    expect(registry).toEqual([setUpAgain]);
    expect(smSend).not.toHaveBeenCalled();
    // Nothing was removed, and the answer says so instead of calling the
    // workspace absent: it is registered, by the setup that has just finished.
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
      message: expect.stringContaining('set up again'),
    });
  });

  test('a row that carries no installed_at is revoked on condition that it still carries none', async () => {
    // The CLI has recorded `installed_at` in every row it has written, so such a
    // row was written by hand. A setup adds the attribute, which takes the row out
    // of the condition. No `:installed` is bound here: DynamoDB requires a bound
    // value to be used by the expressions of the request.
    routeDdb({ registryRow: activeRow({ installed_at: undefined }) });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(findRevoke()![0].input.ConditionExpression).toBe(NO_INSTALLATION_RECORDED);
    expect(findRevoke()![0].input.ExpressionAttributeValues).not.toHaveProperty(':installed');
  });

  test('a non-conditional Update failure surfaces as a 500 and never reaches the secret delete', async () => {
    // Only ConditionalCheckFailedException means "someone else won". Any other
    // Update error (throttle, IAM, table gone) must NOT be swallowed into a
    // 404, and must not let the secret delete run against a row that is still
    // active — that would leave a workspace whose token resolves but whose
    // credential is gone.
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
    // An unbounded `do { ... } while (!row && key)` on a large registry can
    // spend the whole 10s Lambda budget and die with an opaque timeout. A
    // clean 500 that names the cap is diagnosable; a timeout is not.
    let scans = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'Scan') {
        scans += 1;
        // Always empty, always another page.
        return Promise.resolve({ Items: [], LastEvaluatedKey: { _idx: scans } });
      }
      return Promise.resolve({});
    });
    smSend.mockReset();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(500);
    // Bounded, and the bound is the handler's MAX_SCAN_PAGES (20).
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
    // The secret is already destroyed at this point, so the workspace cannot
    // authenticate — but the row is still there as `revoked`. Reporting 200
    // `purged` would claim a row deletion that never happened.
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
    // The revoke still landed, so the workspace is fail-closed regardless.
    expect(findRevoke()).toBeTruthy();
    expect(smSend).toHaveBeenCalledTimes(1);
  });

  test('a failing marker write does not mask the SECRET_DELETE_FAILED error', async () => {
    // The marker is best-effort telemetry; if persisting it also fails, the
    // caller must still get the loud, specific error rather than an opaque
    // 500 from the marker's own rejection.
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
    // The env var is read at module scope as `string | undefined` (matching
    // every other reader of it) and guarded once inside the handler. A `!`
    // would assert away a deploy misconfiguration and surface it as
    // `TableName: undefined` from the SDK, several frames from the cause.
    // Re-imported in isolation because the read happens at module load.
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
      // It fails before any AWS call — no scan against an undefined table.
      expect(ddbSend).not.toHaveBeenCalled();
      expect(smSend).not.toHaveBeenCalled();
    } finally {
      process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = saved;
      jest.resetModules();
    }
  });
});
