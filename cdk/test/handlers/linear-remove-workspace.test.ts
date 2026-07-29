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
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME = 'LinearRegistry';
process.env.LINEAR_PROJECT_MAPPING_TABLE_NAME = 'LinearProjectMapping';

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
 * only has to declare the data it cares about (the registry row + any
 * project mappings). The real handler enforces the `status='active'` filter
 * on the registry scan, so this router mirrors that: a seeded row is only
 * returned by the registry scan when its status is 'active'.
 */
function routeDdb(opts: {
  registryRow?: Record<string, unknown> | null;
  mappingRows?: Record<string, unknown>[];
} = {}) {
  const registryRow = opts.registryRow === undefined ? activeRow() : opts.registryRow;
  const mappingRows = opts.mappingRows ?? [];
  ddbSend.mockImplementation((cmd: { _type: string; input: { TableName: string } }) => {
    if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
      const active = registryRow && registryRow.status === 'active' ? [registryRow] : [];
      return Promise.resolve({ Items: active });
    }
    if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearProjectMapping') {
      return Promise.resolve({ Items: mappingRows });
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

  test('--purge deletes the registry row entirely instead of flipping status', async () => {
    routeDdb();

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { purge: 'true' } }));
    expect(result.statusCode).toBe(200);

    const deleteCall = ddbSend.mock.calls.find(([c]) => c._type === 'Delete');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall![0].input.Key).toEqual({ linear_workspace_id: 'ws-uuid-1' });
    // No Update when purging.
    expect(ddbSend.mock.calls.filter(([c]) => c._type === 'Update')).toHaveLength(0);

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

  test('deletes project mappings carrying linear_workspace_id when --keep-mappings is absent', async () => {
    routeDdb({
      mappingRows: [
        { linear_project_id: 'proj-1', linear_workspace_id: 'ws-uuid-1' },
        { linear_project_id: 'proj-2', linear_workspace_id: 'ws-uuid-1' },
      ],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);

    const mappingDeletes = ddbSend.mock.calls.filter(
      ([c]) => c._type === 'Delete' && c.input.TableName === 'LinearProjectMapping',
    );
    expect(mappingDeletes).toHaveLength(2);
    const body = JSON.parse(result.body) as { data: { mappings_removed: number } };
    expect(body.data.mappings_removed).toBe(2);
  });

  test('--keep-mappings leaves the project mapping table untouched', async () => {
    routeDdb({
      mappingRows: [{ linear_project_id: 'proj-1', linear_workspace_id: 'ws-uuid-1' }],
    });

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN, query: { keep_mappings: 'true' } }));
    expect(result.statusCode).toBe(200);

    // No scan/delete against the mapping table.
    const mappingTouches = ddbSend.mock.calls.filter(
      ([c]) => c.input?.TableName === 'LinearProjectMapping',
    );
    expect(mappingTouches).toHaveLength(0);
    const body = JSON.parse(result.body) as { data: { mappings_removed: number } };
    expect(body.data.mappings_removed).toBe(0);
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

  test('deletes mappings across paginated scan pages (LastEvaluatedKey)', async () => {
    // The Lambda timeout is raised specifically for paginated cleanup; assert
    // the loop follows LastEvaluatedKey and sums the count across pages.
    let mappingScan = 0;
    ddbSend.mockReset();
    ddbSend.mockImplementation((cmd: { _type: string; input: { TableName: string } }) => {
      if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearRegistry') {
        return Promise.resolve({ Items: [activeRow()] });
      }
      if (cmd._type === 'Scan' && cmd.input.TableName === 'LinearProjectMapping') {
        mappingScan += 1;
        if (mappingScan === 1) {
          return Promise.resolve({
            Items: [{ linear_project_id: 'proj-1', linear_workspace_id: 'ws-uuid-1' }],
            LastEvaluatedKey: { linear_project_id: 'proj-1' },
          });
        }
        return Promise.resolve({
          Items: [{ linear_project_id: 'proj-2', linear_workspace_id: 'ws-uuid-1' }],
        });
      }
      return Promise.resolve({});
    });
    smSend.mockReset();
    smSend.mockResolvedValue({});

    const result = await handler(makeEvent({ slug: 'acme', userId: ADMIN }));
    expect(result.statusCode).toBe(200);
    const mappingDeletes = ddbSend.mock.calls.filter(
      ([c]) => c._type === 'Delete' && c.input.TableName === 'LinearProjectMapping',
    );
    expect(mappingDeletes).toHaveLength(2);
    const body = JSON.parse(result.body) as { data: { mappings_removed: number } };
    expect(body.data.mappings_removed).toBe(2);
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
