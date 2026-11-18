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

// Two halves. The pure identifier parsers, whose g-flagged regex `lastIndex`
// reset behavior is easy to regress, and `findLinearIssueByIdentifier`, with the
// registry scan, the token resolver and Linear's GraphQL endpoint mocked.

// The registry scan of the lookup.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  ScanCommand: jest.fn((input: unknown) => ({ input })),
}));

const resolveTokenMock = jest.fn();
jest.mock('../../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: (...args: unknown[]) => resolveTokenMock(...args),
}));

import {
  extractLinearIdentifier,
  extractLinearIdentifierFromBranch,
  findLinearIssueByIdentifier,
} from '../../../src/handlers/shared/linear-issue-lookup';

describe('extractLinearIdentifier', () => {
  test('returns null for null / undefined / empty input', () => {
    expect(extractLinearIdentifier(null)).toBeNull();
    expect(extractLinearIdentifier(undefined)).toBeNull();
    expect(extractLinearIdentifier('')).toBeNull();
  });

  test('extracts a Linear identifier from PR title shape', () => {
    expect(extractLinearIdentifier('feat(linear): ABCA-42 do the thing'))
      .toBe('ABCA-42');
  });

  test('extracts a Linear identifier from PR body shape', () => {
    expect(extractLinearIdentifier('Closes ABCA-42\n\nSummary…')).toBe('ABCA-42');
  });

  test('returns the FIRST identifier when multiple are present', () => {
    expect(extractLinearIdentifier('ABCA-42 supersedes PLAT-9')).toBe('ABCA-42');
  });

  test('does not match lowercase team key prefixes', () => {
    expect(extractLinearIdentifier('see issue abca-42 for details')).toBeNull();
  });

  test('does not match identifiers without a dash', () => {
    expect(extractLinearIdentifier('ABCA42')).toBeNull();
  });

  test('does not match identifiers with too long a number tail', () => {
    // Bound is 1-8 digits in the regex; 9+ shouldn't be admitted.
    expect(extractLinearIdentifier('ABCA-1234567890')).toBeNull();
  });

  // The regex is g-flagged and lives at module scope, which means
  // `RegExp.prototype.exec` carries `lastIndex` across calls. The
  // implementation explicitly resets it; this test pins the behavior so
  // nobody removes the reset thinking it's dead code.
  test('back-to-back calls do not skip due to leftover g-flag lastIndex', () => {
    // Run the same call twice — without the explicit reset, the second
    // call would start scanning from where the first call left off and
    // miss the leading identifier.
    expect(extractLinearIdentifier('ABCA-1 then ABCA-2')).toBe('ABCA-1');
    expect(extractLinearIdentifier('ABCA-1 then ABCA-2')).toBe('ABCA-1');
    expect(extractLinearIdentifier('ABCA-1 then ABCA-2')).toBe('ABCA-1');
  });

  test('back-to-back calls with different inputs each return their own first match', () => {
    expect(extractLinearIdentifier('first ABCA-1')).toBe('ABCA-1');
    expect(extractLinearIdentifier('second PLAT-9')).toBe('PLAT-9');
    expect(extractLinearIdentifier('third PLAT-9 ABCA-1')).toBe('PLAT-9');
    expect(extractLinearIdentifier(null)).toBeNull();
    expect(extractLinearIdentifier('fourth ABCA-1')).toBe('ABCA-1');
  });
});

describe('extractLinearIdentifierFromBranch', () => {
  test('pulls the canonical identifier from an agent task branch (lowercased slug)', () => {
    // Branch shape is bgagent/{taskId}/{slug}, where the slug is a slugified
    // "<identifier>: <issue title>" and so has lost the original casing.
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
  const REGISTRY = 'LinearWorkspaceRegistry';

  /** The active registry rows, in the order the Scan returns them. */
  function registryHolds(...rows: Array<{ id: string; teamKeys?: string[] }>): void {
    ddbSend.mockResolvedValue({
      Items: rows.map((row) => ({
        linear_workspace_id: row.id,
        workspace_slug: row.id.replace('ws-', ''),
        status: 'active',
        ...(row.teamKeys && { team_keys: row.teamKeys }),
      })),
    });
  }

  /** Linear's answer per workspace: the id of the issue it has under ENG-7, if it has one. */
  function linearHas(issueIdByWorkspace: Record<string, string>): jest.SpyInstance {
    return jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const workspace = (init!.headers as Record<string, string>).Authorization.replace('Bearer token-of-', '');
      const id = issueIdByWorkspace[workspace];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { issueVcsBranchSearch: id ? { id, identifier: 'ENG-7' } : null } }),
      } as Response;
    });
  }

  beforeEach(() => {
    ddbSend.mockReset();
    resolveTokenMock.mockReset().mockImplementation(async (workspaceId: string) => ({
      accessToken: `token-of-${workspaceId}`,
    }));
  });
  afterEach(() => jest.restoreAllMocks());

  test('asks the workspace that lists the team, and no other, when it has the issue', async () => {
    registryHolds({ id: 'ws-globex', teamKeys: ['OPS'] }, { id: 'ws-acme', teamKeys: ['ENG'] });
    const linear = linearHas({ 'ws-acme': 'issue-acme' });

    await expect(findLinearIssueByIdentifier('ENG-7', REGISTRY)).resolves.toEqual({
      issueId: 'issue-acme', linearWorkspaceId: 'ws-acme', workspaceSlug: 'acme',
    });
    expect(linear).toHaveBeenCalledTimes(1);
  });

  test('falls back to a workspace that does not list the team', async () => {
    // A row written before team keys were recorded, or a team added in Linear after
    // the workspace was registered.
    registryHolds({ id: 'ws-acme', teamKeys: ['ENG'] }, { id: 'ws-globex' });
    linearHas({ 'ws-globex': 'issue-globex' });

    await expect(findLinearIssueByIdentifier('ENG-7', REGISTRY)).resolves.toEqual({
      issueId: 'issue-globex', linearWorkspaceId: 'ws-globex', workspaceSlug: 'globex',
    });
  });

  test.each([
    ['both list the team', ['ENG']],
    ['neither records its teams', undefined],
  ])('returns null when two workspaces have the identifier and %s', async (_label, teamKeys) => {
    // An identifier is unique inside one workspace only. Taking the first workspace
    // that answers puts one tenant's preview on the other tenant's issue.
    registryHolds({ id: 'ws-acme', teamKeys }, { id: 'ws-globex', teamKeys });
    linearHas({ 'ws-acme': 'issue-acme', 'ws-globex': 'issue-globex' });

    await expect(findLinearIssueByIdentifier('ENG-7', REGISTRY)).resolves.toBeNull();
  });

  test('a 200 whose body is not JSON is a miss, not a rejection', async () => {
    registryHolds({ id: 'ws-acme', teamKeys: ['ENG'] });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);

    await expect(findLinearIssueByIdentifier('ENG-7', REGISTRY)).resolves.toBeNull();
  });

  test('gives up on a Linear that takes the request and never answers', async () => {
    registryHolds({ id: 'ws-acme', teamKeys: ['ENG'] });
    // The request's time limit, already run out: `AbortSignal.timeout` runs on a
    // timer that jest's fake timers do not drive.
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new Error('timed out')));
    jest.spyOn(global, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      // No answer ever comes: only the signal of the request ends the wait.
      if (init?.signal?.aborted) reject(init.signal.reason as Error);
    }));

    await expect(findLinearIssueByIdentifier('ENG-7', REGISTRY)).resolves.toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });
});
