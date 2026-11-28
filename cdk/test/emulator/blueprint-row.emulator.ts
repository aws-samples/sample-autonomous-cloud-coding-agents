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
 * The RepoTable row a Blueprint writes, against the AWS Emulator (ADR-013 Tier 2a).
 *
 * A Blueprint's custom resource makes one UpdateItem call for the create and the
 * update event. The test stands in for the AwsCustomResource provider only: it
 * reads that call from the synthesized template and sends its parameters.
 *
 * Runs only through `jest.emulator.config.js` (see ./harness).
 */

import { randomUUID } from 'node:crypto';
import { type AttributeValue, DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Blueprint, type BlueprintProps } from '../../src/constructs/blueprint';
import { RepoTable } from '../../src/constructs/repo-table';
import { makeClient } from '../../src/handlers/shared/ua';
import { emulatorTables } from './harness';

// The table name is unique to this file's run.
const TABLE_NAME = `emu-${randomUUID().slice(0, 8)}-repos`;

const ddb = makeClient(DynamoDBClient);

/** A repository no other test has written, so tests need no cleanup between them. */
const newRepo = (): string => `acme/${randomUUID()}`;

/**
 * Send the call that a Blueprint for `repo` makes on create and on update.
 * @param repo - the repository the Blueprint registers.
 * @param props - what the Blueprint declares.
 * @returns the timestamp the call carries.
 */
async function write(repo: string, props: Partial<BlueprintProps> = {}): Promise<AttributeValue> {
  const stack = new Stack(new App(), 'Blueprints');
  new Blueprint(stack, 'Blueprint', { repo, repoTable: Table.fromTableName(stack, 'RepoTable', TABLE_NAME), ...props });
  // With a literal table name the property is a JSON string, not an Fn::Join.
  const { parameters } = JSON.parse(Object.values(Template.fromStack(stack).findResources('Custom::AWS'))[0].Properties.Update);
  await ddb.send(new UpdateItemCommand(parameters));
  return parameters.ExpressionAttributeValues[':now'];
}

/**
 * Read a repository's row.
 * @param repo - the repository.
 * @returns the stored attributes, or undefined when there is no row.
 */
async function row(repo: string): Promise<Record<string, AttributeValue> | undefined> {
  const { Item } = await ddb.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { repo: { S: repo } }, ConsistentRead: true }));
  return Item;
}

describe('Blueprint row against the AWS Emulator', () => {
  emulatorTables((stack) => {
    new RepoTable(stack, 'Repos', { tableName: TABLE_NAME });
  });
  afterAll(() => ddb.destroy());

  test('a repository with no row gets an active one', async () => {
    const repo = newRepo();

    const now = await write(repo);

    expect(await row(repo)).toEqual({ repo: { S: repo }, status: { S: 'active' }, onboarded_at: now, updated_at: now });
  });

  test('a row that an offboard left becomes active again, loses ttl and keeps its settings and onboarded_at', async () => {
    const repo = newRepo();
    const kept = {
      repo: { S: repo },
      model_id: { S: 'us.anthropic.claude-sonnet-4-6' },
      max_turns: { N: '150' },
      onboarded_at: { S: '2024-01-01T00:00:00.000Z' },
    };
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        ...kept,
        status: { S: 'removed' },
        updated_at: { S: '2024-06-01T00:00:00.000Z' },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) },
      },
    }));

    const now = await write(repo);

    expect(await row(repo)).toEqual({ ...kept, status: { S: 'active' }, updated_at: now });
  });

  test('the settings a Blueprint declares are written', async () => {
    const repo = newRepo();

    await write(repo, { agent: { maxTurns: 50 }, pipeline: { buildCommand: 'npm run build' } });

    expect(await row(repo)).toMatchObject({ max_turns: { N: '50' }, build_command: { S: 'npm run build' } });
  });

  test('a stored asset list survives a Blueprint that does not declare it, and one that declares it as [] removes it', async () => {
    const repo = newRepo();
    const pins = { L: [{ S: 'registry://mcp_server/acme/pdf-tools@^1.4.1' }] };
    await ddb.send(new PutItemCommand({ TableName: TABLE_NAME, Item: { repo: { S: repo }, status: { S: 'active' }, mcp_servers: pins } }));

    await write(repo);
    expect(await row(repo)).toMatchObject({ mcp_servers: pins });

    await write(repo, { assets: { mcpServers: [] } });
    expect(await row(repo)).not.toHaveProperty('mcp_servers');
  });
});
