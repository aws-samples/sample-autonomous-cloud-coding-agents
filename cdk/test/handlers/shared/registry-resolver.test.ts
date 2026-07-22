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

import * as fs from 'fs';
import * as path from 'path';
import {
  isRegistryRef,
  parseRef,
  RegistryResolutionError,
  resolveAll,
  resolveRef,
  type RegistryQueryClient,
} from '../../../src/handlers/shared/registry-resolver';
import type { RegistryAssetRecord, RegistryAssetStatus } from '../../../src/handlers/shared/types';

// --- test helpers ------------------------------------------------------------

/** Build a minimal catalog row for the given version/status. */
function row(
  version: string,
  status: RegistryAssetStatus,
  overrides: Partial<RegistryAssetRecord> = {},
): RegistryAssetRecord {
  return {
    pk: 'mcp_server#acme/pdf-tools',
    sk: version,
    kind: 'mcp_server',
    namespace: 'acme',
    name: 'pdf-tools',
    version,
    descriptor: { summary: 's', permissions: [] },
    artifact_ref: `mcp_server/acme/pdf-tools/${version}/artifact`,
    status,
    publisher: 'sub-1',
    created_at: '2026-07-20T00:00:00Z',
    status_history: [],
    ...overrides,
  };
}

/** A query client that returns the given rows for every query. */
function clientReturning(rows: RegistryAssetRecord[]): RegistryQueryClient {
  return { send: jest.fn().mockResolvedValue({ Items: rows }) };
}

const TABLE = 'RegistryAssets';

// --- parseRef / grammar ------------------------------------------------------

describe('parseRef', () => {
  test('parses a caret-pinned snake_case kind', () => {
    expect(parseRef('registry://mcp_server/acme/pdf-tools@^1.4.1')).toEqual({
      kind: 'mcp_server',
      namespace: 'acme',
      name: 'pdf-tools',
      constraint: '^1.4.1',
    });
  });

  test.each([
    'registry://mcp_server/acme/pdf-tools@1.4.1',
    'registry://cedar_policy_module/acme/guard@~2.0.0',
    'registry://skill/acme/refactor@^1.0.0',
    'registry://mcp_server/acme/pdf-tools@1.4.1-rc.1',
  ])('accepts valid ref %s', (ref) => {
    expect(() => parseRef(ref)).not.toThrow();
    expect(isRegistryRef(ref)).toBe(true);
  });

  test.each([
    ['legacy 2-segment', 'registry://skill/x-v1'],
    ['hyphen kind (shipped-regex form)', 'registry://mcp-server/acme/pdf-tools'],
    ['unpinned 3-segment', 'registry://mcp_server/acme/pdf-tools'],
    ['floating latest', 'registry://mcp_server/acme/pdf-tools@latest'],
    ['range operator', 'registry://mcp_server/acme/pdf-tools@>=1.0.0'],
    ['wildcard', 'registry://mcp_server/acme/pdf-tools@1.x'],
    ['wrong scheme', 'http://evil/acme/x@1.0.0'],
    ['uppercase kind', 'registry://MCP_Server/acme/x@1.0.0'],
  ])('rejects %s', (_label, ref) => {
    expect(() => parseRef(ref)).toThrow(RegistryResolutionError);
    expect(isRegistryRef(ref)).toBe(false);
  });

  test('rejects a syntactically-fine but unknown kind', () => {
    expect(() => parseRef('registry://not_a_kind/acme/x@1.0.0')).toThrow(/unknown kind/);
  });

  test('parse failure carries INVALID_REGISTRY_REF', () => {
    try {
      parseRef('registry://skill/x-v1');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryResolutionError);
      expect((e as RegistryResolutionError).reason).toBe('INVALID_REGISTRY_REF');
    }
  });
});

// --- resolveRef: semver + status --------------------------------------------

describe('resolveRef', () => {
  test('selects the highest version satisfying a caret constraint', async () => {
    const client = clientReturning([
      row('1.0.0', 'approved'),
      row('1.2.0', 'approved'),
      row('1.9.0', 'approved'),
      row('2.0.0', 'approved'), // outside ^1.0.0
    ]);
    const resolved = await resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', {
      client,
      tableName: TABLE,
    });
    expect(resolved.version).toBe('1.9.0');
    expect(resolved.warnings).toEqual([]);
  });

  test('ranks by semver, not lexicographically (1.10.0 > 1.9.0)', async () => {
    const client = clientReturning([row('1.9.0', 'approved'), row('1.10.0', 'approved')]);
    const resolved = await resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', {
      client,
      tableName: TABLE,
    });
    expect(resolved.version).toBe('1.10.0');
  });

  test('tilde constraint stays within the minor', async () => {
    const client = clientReturning([
      row('1.2.3', 'approved'),
      row('1.2.9', 'approved'),
      row('1.3.0', 'approved'), // outside ~1.2.3
    ]);
    const resolved = await resolveRef('registry://mcp_server/acme/pdf-tools@~1.2.3', {
      client,
      tableName: TABLE,
    });
    expect(resolved.version).toBe('1.2.9');
  });

  test('exact constraint matches only that version', async () => {
    const client = clientReturning([row('1.4.0', 'approved'), row('1.4.1', 'approved')]);
    const resolved = await resolveRef('registry://mcp_server/acme/pdf-tools@1.4.0', {
      client,
      tableName: TABLE,
    });
    expect(resolved.version).toBe('1.4.0');
  });

  test('prereleases are excluded from a plain range', async () => {
    const client = clientReturning([row('1.4.1-rc.1', 'approved'), row('1.4.0', 'approved')]);
    const resolved = await resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', {
      client,
      tableName: TABLE,
    });
    expect(resolved.version).toBe('1.4.0');
  });

  test('deprecated highest match resolves with a DEPRECATED warning', async () => {
    const client = clientReturning([row('1.0.0', 'approved'), row('1.2.0', 'deprecated')]);
    const resolved = await resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', {
      client,
      tableName: TABLE,
    });
    expect(resolved.version).toBe('1.2.0');
    expect(resolved.warnings).toEqual(['DEPRECATED']);
  });

  test('removed highest match fails with REMOVED', async () => {
    const client = clientReturning([row('1.2.0', 'removed')]);
    await expect(
      resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', { client, tableName: TABLE }),
    ).rejects.toMatchObject({ reason: 'REMOVED' });
  });

  test('submitted-only highest match fails with NO_MATCHING_VERSION', async () => {
    const client = clientReturning([row('1.2.0', 'submitted')]);
    await expect(
      resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', { client, tableName: TABLE }),
    ).rejects.toMatchObject({ reason: 'NO_MATCHING_VERSION' });
  });

  test('no version in range fails with NO_MATCHING_VERSION', async () => {
    const client = clientReturning([row('2.0.0', 'approved')]);
    await expect(
      resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', { client, tableName: TABLE }),
    ).rejects.toMatchObject({ reason: 'NO_MATCHING_VERSION' });
  });

  test('empty catalog fails with NO_MATCHING_VERSION', async () => {
    const client = clientReturning([]);
    await expect(
      resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', { client, tableName: TABLE }),
    ).rejects.toMatchObject({ reason: 'NO_MATCHING_VERSION' });
  });

  test('invalid ref never touches the catalog', async () => {
    const send = jest.fn().mockResolvedValue({ Items: [] });
    const client: RegistryQueryClient = { send };
    await expect(
      resolveRef('registry://skill/x-v1', { client, tableName: TABLE }),
    ).rejects.toMatchObject({ reason: 'INVALID_REGISTRY_REF' });
    expect(send).not.toHaveBeenCalled();
  });

  test('missing table name fails closed', async () => {
    const client = clientReturning([row('1.0.0', 'approved')]);
    await expect(
      resolveRef('registry://mcp_server/acme/pdf-tools@^1.0.0', { client, tableName: '' }),
    ).rejects.toBeInstanceOf(RegistryResolutionError);
  });
});

// --- resolveAll --------------------------------------------------------------

describe('resolveAll', () => {
  test('groups resolved assets by kind', async () => {
    const client: RegistryQueryClient = {
      send: jest.fn((command: { input: { ExpressionAttributeValues: { ':pk': string } } }) => {
        const pk = command.input.ExpressionAttributeValues[':pk'];
        if (pk === 'mcp_server#acme/pdf-tools') {
          return Promise.resolve({ Items: [row('1.0.0', 'approved')] });
        }
        return Promise.resolve({
          Items: [
            {
              ...row('2.0.0', 'approved'),
              pk: 'skill#acme/refactor',
              kind: 'skill',
              namespace: 'acme',
              name: 'refactor',
              version: '2.0.0',
            },
          ],
        });
      }),
    };
    const bundle = await resolveAll(
      ['registry://mcp_server/acme/pdf-tools@^1.0.0', 'registry://skill/acme/refactor@^2.0.0'],
      { client, tableName: TABLE },
    );
    expect(bundle.mcp_servers).toHaveLength(1);
    expect(bundle.skills).toHaveLength(1);
    expect(bundle.cedar_policy_modules).toHaveLength(0);
  });

  test('one bad ref rejects the whole bundle (fail-closed)', async () => {
    const client = clientReturning([]);
    await expect(
      resolveAll(
        ['registry://mcp_server/acme/pdf-tools@^1.0.0', 'registry://skill/x-v1'],
        { client, tableName: TABLE },
      ),
    ).rejects.toBeInstanceOf(RegistryResolutionError);
  });

  test('empty ref list yields an empty bundle', async () => {
    const bundle = await resolveAll([], { tableName: TABLE });
    expect(bundle).toEqual({ mcp_servers: [], cedar_policy_modules: [], skills: [] });
  });

  test('a resolvable but loader-less reserved kind is refused (fail-closed)', async () => {
    // capability is a declared grammar kind with no MVP loader (REGISTRY.md §2).
    // Even if the catalog somehow holds an approved row, resolveAll must refuse
    // rather than drop it silently.
    const client: RegistryQueryClient = {
      send: jest.fn().mockResolvedValue({
        Items: [
          {
            ...row('1.0.0', 'approved'),
            pk: 'capability#acme/wf',
            kind: 'capability',
            namespace: 'acme',
            name: 'wf',
          },
        ],
      }),
    };
    await expect(
      resolveAll(['registry://capability/acme/wf@^1.0.0'], { client, tableName: TABLE }),
    ).rejects.toMatchObject({ reason: 'INVALID_REGISTRY_REF' });
  });
});

// --- parity corpus (grammar side) -------------------------------------------

describe('registry-resolution grammar parity corpus', () => {
  const corpusDir = path.resolve(__dirname, '../../../../contracts/registry-resolution');
  const files = fs.readdirSync(corpusDir).filter((f) => f.startsWith('grammar-') && f.endsWith('.json'));

  test('corpus dir is present and non-empty', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s — parseRef agrees with fixture verdict', (file) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf-8'));
    expect(isRegistryRef(fixture.ref)).toBe(fixture.expected.valid);
    if (fixture.expected.valid && fixture.expected.parsed) {
      expect(parseRef(fixture.ref)).toEqual(fixture.expected.parsed);
    }
  });
});
