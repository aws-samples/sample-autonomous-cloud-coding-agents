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
 * What `bgagent repo onboard` does to a row of RepoTable, against an AWS
 * Emulator (ADR-013 Tier 2a).
 *
 * A mocked test sees the update expression the CLI sends. Only DynamoDB says
 * what that expression leaves in the row: the attributes the command does not
 * name, among them one the CLI has no type for, must come back as they were.
 *
 * The table is declared by hand with the key of `cdk/src/constructs/repo-table.ts`.
 * TTL is not enabled, so `ttl` is an ordinary attribute here.
 *
 * Named `*.emulator.ts`; runs only through `jest.emulator.config.js`
 * (`mise run test:integration`).
 */

import { CreateTableCommand, DeleteTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient, lowLevelClient } from '../../src/dynamo-clients';
import { onboardRepo } from '../../src/repo-onboard';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
/** The emulator holds a new table in CREATING for 3 s; Jest's default for a hook is 5 s. */
const SETUP_TIMEOUT_MS = 30_000;
/** Shorter than the hook, so a table that never becomes ACTIVE reports itself instead of a bare hook timeout. */
const TABLE_WAIT_SECONDS = 20;

describe('bgagent repo onboard against a RepoTable row', () => {
  const tableName = `bgagent-cli-emulator-repo-${Date.now().toString(36)}`;
  const ddb = lowLevelClient(REGION);
  const rows = documentClient(REGION);

  async function storedRow(repo: string): Promise<Record<string, unknown> | undefined> {
    return (await rows.send(new GetCommand({ TableName: tableName, Key: { repo }, ConsistentRead: true }))).Item;
  }

  beforeAll(async () => {
    await ddb.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'repo', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'repo', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    await waitUntilTableExists({ client: ddb, maxWaitTime: TABLE_WAIT_SECONDS, minDelay: 1 }, { TableName: tableName });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await ddb.send(new DeleteTableCommand({ TableName: tableName }));
    ddb.destroy();
  });

  test('a removed row comes back active with every attribute the command does not name', async () => {
    const kept = {
      repo: 'acme/removed',
      onboarded_at: '2025-01-01T00:00:00.000Z',
      build_command: 'npm run build',
      mcp_servers: ['registry://mcp_server/acme/aws-knowledge@^1.0.0'],
      cedar_policy_modules: ['registry://cedar_policy_module/acme/guard@^1.0.0'],
      written_by_a_later_release: { nested: ['kept'] },
    };
    const removed = {
      ...kept,
      status: 'removed',
      updated_at: '2025-06-01T00:00:00.000Z',
      ttl: Math.floor(Date.now() / 1000) + 86400,
      model_id: 'global.anthropic.claude-opus-5-5',
    };
    await rows.send(new PutCommand({ TableName: tableName, Item: removed }));

    const { config, previous } = await onboardRepo(REGION, tableName, kept.repo, {
      set: { max_turns: 150 },
      unset: ['model_id'],
    });

    const stored = await storedRow(kept.repo);
    // Exactly these attributes: `ttl` and `model_id` are gone.
    expect(stored).toEqual({ ...kept, status: 'active', updated_at: expect.any(String), max_turns: 150 });
    expect(stored?.updated_at).not.toBe(removed.updated_at);
    expect(config).toEqual(stored);
    expect(previous).toEqual(removed);
  });

  test('a repository without a row gets an active one', async () => {
    const { config, previous } = await onboardRepo(REGION, tableName, 'acme/new');

    const stored = await storedRow('acme/new');
    expect(stored).toEqual({
      repo: 'acme/new',
      status: 'active',
      onboarded_at: expect.any(String),
      updated_at: stored?.onboarded_at,
    });
    expect(config).toEqual(stored);
    expect(previous).toBeUndefined();
  });
});
