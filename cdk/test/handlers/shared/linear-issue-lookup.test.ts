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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
}));

const resolveLinearOauthTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveLinearOauthTokenMock(...args),
}));

import {
  extractLinearIdentifier,
  extractLinearIdentifierFromBranch,
  findLinearIssueByIdentifier,
} from '../../../src/handlers/shared/linear-issue-lookup';

const REGISTRY = 'LinearWorkspaceRegistry';

interface RegistryRow {
  linear_workspace_id: string;
  workspace_slug: string;
  team_keys?: string[];
}

function scanResultRows(rows: RegistryRow[]): { Items: Record<string, unknown>[] } {
  return { Items: rows.map((r) => ({ ...r, status: 'active' })) };
}

function mockGraphqlOnce(found: { id: string; identifier: string } | null, status = 200): jest.SpyInstance {
  const fetchMock = jest.spyOn(global, 'fetch') as unknown as jest.SpyInstance;
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (found
      ? { data: { issueVcsBranchSearch: found } }
      : { data: { issueVcsBranchSearch: null } }),
  } as unknown as Response);
  return fetchMock;
}

describe('extractLinearIdentifier', () => {
  test('matches an identifier in plain text', () => {
    expect(extractLinearIdentifier('Fix bug ABCA-42 today')).toBe('ABCA-42');
  });

  test('returns the FIRST identifier when multiple are present', () => {
    expect(extractLinearIdentifier('See ABCA-1 and PLAT-99')).toBe('ABCA-1');
  });

  test('handles identifiers with single-letter team keys', () => {
    expect(extractLinearIdentifier('Closes A-7')).toBe('A-7');
  });

  test('returns null on null/undefined input', () => {
    expect(extractLinearIdentifier(null)).toBeNull();
    expect(extractLinearIdentifier(undefined)).toBeNull();
    expect(extractLinearIdentifier('')).toBeNull();
  });

  test('rejects lowercase team keys (Linear keys are upper-case)', () => {
    expect(extractLinearIdentifier('abca-42')).toBeNull();
  });

  test('rejects identifiers with too many digits (regex bound)', () => {
    expect(extractLinearIdentifier('ABCA-123456789')).toBeNull();
  });

  test('subsequent calls are independent (g-flag lastIndex reset)', () => {
    const first = extractLinearIdentifier('first ABCA-1');
    const second = extractLinearIdentifier('second PLAT-2');
    expect(first).toBe('ABCA-1');
    expect(second).toBe('PLAT-2');
  });
});

describe('extractLinearIdentifierFromBranch', () => {
  test('pulls the canonical identifier from an ABCA task branch (lowercased slug)', () => {
    // bgagent/{taskId}/{slug} where slug = slugify("ABCA-151: Add lisbon-guide.html")
    expect(
      extractLinearIdentifierFromBranch('bgagent/01KTSK8XGXHRMT0JX44GYRPJG7/abca-151-add-lisbon-guidehtml'),
    ).toBe('ABCA-151');
  });

  test('the ULID task-id segment does not false-match before the identifier', () => {
    // The ULID has no dash, so it cannot produce a <KEY>-<n> match; the
    // first real match is the issue identifier in the slug.
    expect(
      extractLinearIdentifierFromBranch('bgagent/01KTSKET9040HDJP3P2QE15DXC/abca-152-link-lisbon-from-destinationsht'),
    ).toBe('ABCA-152');
  });

  test('returns null for a branch with no identifier', () => {
    expect(extractLinearIdentifierFromBranch('bgagent/01TASK/task')).toBeNull();
    expect(extractLinearIdentifierFromBranch('feature/some-thing')).toBeNull();
  });

  test('returns null on null/undefined/empty', () => {
    expect(extractLinearIdentifierFromBranch(null)).toBeNull();
    expect(extractLinearIdentifierFromBranch(undefined)).toBeNull();
    expect(extractLinearIdentifierFromBranch('')).toBeNull();
  });
});

describe('findLinearIssueByIdentifier', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    resolveLinearOauthTokenMock.mockReset();
    jest.restoreAllMocks();
  });

  test('returns null when registry scan fails', async () => {
    ddbSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await findLinearIssueByIdentifier('ABCA-1', REGISTRY);
    expect(result).toBeNull();
    expect(resolveLinearOauthTokenMock).not.toHaveBeenCalled();
  });

  test('returns null when no active workspaces are registered', async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    expect(await findLinearIssueByIdentifier('ABCA-1', REGISTRY)).toBeNull();
  });

  test('prefix-matches the workspace whose team_keys contain the identifier prefix', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-other', workspace_slug: 'other', team_keys: ['PLAT'] },
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['ABCA'] },
    ]));
    resolveLinearOauthTokenMock.mockResolvedValueOnce({ accessToken: 'tok-abca' });
    mockGraphqlOnce({ id: 'issue-uuid', identifier: 'ABCA-42' });

    const result = await findLinearIssueByIdentifier('ABCA-42', REGISTRY);

    expect(result).toEqual({
      issueId: 'issue-uuid',
      linearWorkspaceId: 'ws-abca',
      workspaceSlug: 'abca',
    });
    // Only the matching workspace's token was resolved — no scan-all.
    expect(resolveLinearOauthTokenMock).toHaveBeenCalledTimes(1);
    expect(resolveLinearOauthTokenMock).toHaveBeenCalledWith('ws-abca', REGISTRY);
  });

  test('prefix-match comparison is case-insensitive on identifier and team_keys', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['abca'] },
    ]));
    resolveLinearOauthTokenMock.mockResolvedValueOnce({ accessToken: 'tok-abca' });
    mockGraphqlOnce({ id: 'issue-uuid', identifier: 'ABCA-42' });

    const result = await findLinearIssueByIdentifier('ABCA-42', REGISTRY);
    expect(result?.issueId).toBe('issue-uuid');
  });

  test('falls through to scan-all when no workspace prefix-matches (legacy rows)', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-legacy-a', workspace_slug: 'legacy-a' }, // no team_keys
      { linear_workspace_id: 'ws-legacy-b', workspace_slug: 'legacy-b' }, // no team_keys
    ]));
    resolveLinearOauthTokenMock
      .mockResolvedValueOnce({ accessToken: 'tok-a' })
      .mockResolvedValueOnce({ accessToken: 'tok-b' });
    mockGraphqlOnce(null); // first workspace doesn't have the issue
    mockGraphqlOnce({ id: 'issue-uuid', identifier: 'ABCA-42' });

    const result = await findLinearIssueByIdentifier('ABCA-42', REGISTRY);

    expect(result?.linearWorkspaceId).toBe('ws-legacy-b');
    expect(resolveLinearOauthTokenMock).toHaveBeenCalledTimes(2);
  });

  test('falls back to scanning others when prefix-matched workspace returns no hit', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['ABCA'] },
      { linear_workspace_id: 'ws-other', workspace_slug: 'other', team_keys: ['PLAT'] },
    ]));
    resolveLinearOauthTokenMock
      .mockResolvedValueOnce({ accessToken: 'tok-abca' }) // prefix match
      .mockResolvedValueOnce({ accessToken: 'tok-other' }); // fallback iter
    mockGraphqlOnce(null); // ABCA workspace doesn't actually have it
    mockGraphqlOnce({ id: 'issue-uuid', identifier: 'ABCA-42' });

    const result = await findLinearIssueByIdentifier('ABCA-42', REGISTRY);
    expect(result?.linearWorkspaceId).toBe('ws-other');
    // Two resolves: prefix-match attempt + one fallback.
    expect(resolveLinearOauthTokenMock).toHaveBeenCalledTimes(2);
  });

  test('skips workspaces whose token resolver returns null', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-revoked', workspace_slug: 'rev', team_keys: ['ABCA'] },
      { linear_workspace_id: 'ws-good', workspace_slug: 'good', team_keys: ['PLAT'] },
    ]));
    resolveLinearOauthTokenMock
      .mockResolvedValueOnce(null) // prefix match has no usable token
      .mockResolvedValueOnce({ accessToken: 'tok-good' });
    // Only ONE GraphQL call — the prefix-matched workspace was skipped.
    mockGraphqlOnce({ id: 'issue-uuid', identifier: 'ABCA-42' });

    const result = await findLinearIssueByIdentifier('ABCA-42', REGISTRY);
    expect(result?.linearWorkspaceId).toBe('ws-good');
  });

  test('returns null when GraphQL returns a different identifier (fuzzy match guard)', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['ABCA'] },
    ]));
    resolveLinearOauthTokenMock.mockResolvedValueOnce({ accessToken: 'tok-abca' });
    // Linear's branch search is fuzzy — we asked for ABCA-42 but it
    // returned ABCA-43. Reject the near-neighbor.
    mockGraphqlOnce({ id: 'issue-uuid', identifier: 'ABCA-43' });

    expect(await findLinearIssueByIdentifier('ABCA-42', REGISTRY)).toBeNull();
  });

  test('returns null when GraphQL responds non-2xx', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['ABCA'] },
    ]));
    resolveLinearOauthTokenMock.mockResolvedValueOnce({ accessToken: 'tok-abca' });
    mockGraphqlOnce(null, 500);

    expect(await findLinearIssueByIdentifier('ABCA-42', REGISTRY)).toBeNull();
  });

  test('returns null when GraphQL fetch throws (network failure)', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['ABCA'] },
    ]));
    resolveLinearOauthTokenMock.mockResolvedValueOnce({ accessToken: 'tok-abca' });
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('socket hang up'));

    expect(await findLinearIssueByIdentifier('ABCA-42', REGISTRY)).toBeNull();
  });

  test('returns null when GraphQL response carries errors[]', async () => {
    ddbSend.mockResolvedValueOnce(scanResultRows([
      { linear_workspace_id: 'ws-abca', workspace_slug: 'abca', team_keys: ['ABCA'] },
    ]));
    resolveLinearOauthTokenMock.mockResolvedValueOnce({ accessToken: 'tok-abca' });
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'unauthorized' }] }),
    } as unknown as Response);

    expect(await findLinearIssueByIdentifier('ABCA-42', REGISTRY)).toBeNull();
  });
});
