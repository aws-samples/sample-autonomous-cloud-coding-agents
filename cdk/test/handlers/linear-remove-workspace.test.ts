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
 * The seeded rows are held in table order; the handler's filter (slug +
 * `status='active'`) is applied to the examined slice. A handler that
 * examines only one arbitrary row (Limit: 1) and never follows the key can
 * therefore miss a matching row that sits on a later page.
 */
function routeDdb(opts: {
  registryRow?: Record<string, unknown> | null;
  registryRows?: Record<string, unknown>[];
} = {}) {
  const rows: Record<string, unknown>[] = opts.registryRows
    ?? (opts.registryRow === undefined
      ? [activeRow()]
      : (opts.registryRow === null ? [] : [opts.registryRow]));

  ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
      const slug = (cmd.input.ExpressionAttributeValues as Record<string, unknown>)?.[':slug'];
      const start = Number((cmd.input.ExclusiveStartKey as { _idx?: number } | undefined)?._idx ?? 0);
      const limit = cmd.input.Limit as number | undefined;
      const end = limit === undefined ? rows.length : Math.min(rows.length, start + limit);
      const examined = rows.slice(start, end);
      // Apply the handler's FilterExpression to the examined slice only.
      const matched = examined.filter((r) => r.status === 'active' && r.workspace_slug === slug);
      const more = end < rows.length;
      return Promise.resolve({
        Items: matched,
        ...(more ? { LastEvaluatedKey: { _idx: end } } : {}),
      });
    }
    return Promise.resolve({});
  });
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

    // Registry row flipped to revoked, NOT deleted, by default.
    const updateCall = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(updateCall![0].input.Key).toEqual({ linear_workspace_id: 'ws-uuid-1' });
    expect(JSON.stringify(updateCall![0].input)).toContain('revoked');
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Delete')).toHaveLength(0);

    // Secret deleted.
    const secretCall = smSend.mock.calls.find(([c]) => c._type === 'DeleteSecret');
    expect(secretCall).toBeTruthy();

    const body = JSON.parse(result.body) as { data: { status: string; secret_deleted: boolean } };
    expect(body.data.status).toBe('revoked');
    expect(body.data.secret_deleted).toBe(true);
  });

  test('--purge deletes the registry row (after a fail-closed revoke) and reports purged', async () => {
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(200);

    // The row is revoked first (fail-closed) and then hard-deleted — so both
    // an Update and a Delete land on the registry row on the purge path.
    const updateCall = ddbSend.mock.calls.find(([c]) => c._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(JSON.stringify(updateCall![0].input)).toContain('revoked');
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
    const body = JSON.parse(result.body) as { data: { secret_deleted: boolean; status: string } };
    // Row still revoked; secret was already gone → reported as not-deleted-now.
    expect(body.data.status).toBe('revoked');
    expect(body.data.secret_deleted).toBe(false);
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
    // Directly asserts the handler paginates: the double emits one row per
    // page (via a Limit) only if Limit is set; with no Limit it returns all
    // rows on page one. Emulate a multi-page registry by forcing paging
    // regardless of Limit so a single-shot scan would miss the target.
    let scans = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation((cmd: { _type: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
        scans += 1;
        if (scans === 1) {
          // Page 1: a non-matching row + a continuation key. A handler that
          // reads only `Items[0]` and ignores LastEvaluatedKey 404s here.
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

  test('already-revoked workspace is treated as not-found (fail-closed, no re-revoke)', async () => {
    // The registry scan filters on status='active', so an already-revoked
    // row simply doesn't match — the router models that by returning no
    // items for a non-active seed. 404 keeps the endpoint from acting as a
    // revoke-oracle and avoids a second destructive pass.
    routeDdb({ registryRow: activeRow({ status: 'revoked' }) });
    smSend.mockReset();
    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(404);
    expect(smSend).not.toHaveBeenCalled();
  });

  test('the registry scan fail-closes on status via the FilterExpression (pins the filter to the handler)', async () => {
    // Assert the handler itself sends #status = :active — the revoke-oracle
    // prevention property lives in this filter, not in the test router.
    routeDdb({ registryRow: null });
    await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    const scanCall = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Scan' && c.input.TableName === 'LinearRegistry',
    );
    expect(scanCall![0].input.FilterExpression).toContain('#status');
    expect(scanCall![0].input.ExpressionAttributeValues).toMatchObject({ ':active': 'active' });
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
    const revokeUpdate = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Update'
        && c.input.TableName === 'LinearRegistry'
        && JSON.stringify(c.input).includes('revoked'),
    );
    expect(revokeUpdate).toBeTruthy();
    // ...and a durable secret-deletion-failed marker was persisted.
    const marker = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Update' && JSON.stringify(c.input).includes('secret_deletion_failed'),
    );
    expect(marker).toBeTruthy();
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
    const marker = ddbSend.mock.calls.find(
      ([c]) => c._type === 'Update' && JSON.stringify(c.input).includes('secret_deletion_failed'),
    );
    expect(marker).toBeTruthy();
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

  test('a registry row with no oauth_secret_arn skips the secret delete', async () => {
    routeDdb({ registryRow: activeRow({ oauth_secret_arn: undefined }) });
    smSend.mockReset();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    expect(smSend).not.toHaveBeenCalled();
    const body = JSON.parse(result.body) as { data: { secret_deleted: boolean } };
    expect(body.data.secret_deleted).toBe(false);
  });
});
