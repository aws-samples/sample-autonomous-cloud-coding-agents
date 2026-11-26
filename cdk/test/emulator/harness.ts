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
 * The emulator keeps state in memory and has no reset route. Each test file
 * therefore names its tables uniquely, and each test writes under a user id of
 * its own.
 */

import {
  type AttributeDefinition, CreateTableCommand, DeleteTableCommand, DynamoDBClient, type GlobalSecondaryIndex,
  UpdateTableCommand, waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const SETUP_TIMEOUT_MS = 30_000;

const TABLE_WAIT_SECONDS = 20;

/**
 * Give the enclosing `describe` the DynamoDB tables that `declare` adds to a
 * stack: created on the emulator before its tests and deleted after them.
 *
 * The CreateTable inputs are read from the synthesized template, so key schema
 * and indexes are the constructs' own.
 *
 * Streams and point-in-time recovery are not carried over. Neither is TTL: the
 * emulator deletes an expired item within a second where AWS takes up to days.
 * @param declare - instantiates the table constructs under test, each with an explicit `tableName`.
 * @param seed - writes the rows every test in the file needs, once the tables are ACTIVE.
 * @param withoutIndexes - per table name, index names to leave out: the table as it was before a
 *   deploy added them. The table or another index must still use their key attributes.
 * @returns a function that adds one of those indexes, as that deploy does, from the construct's definition.
 */
export function emulatorTables(
  declare: (stack: Stack) => void,
  seed?: () => Promise<unknown>,
  withoutIndexes: Record<string, string[]> = {},
): (tableName: string, indexName: string) => Promise<void> {
  let ddb: DynamoDBClient | undefined;
  const created: string[] = [];
  const declared: Record<string, { AttributeDefinitions: AttributeDefinition[]; GlobalSecondaryIndexes?: GlobalSecondaryIndex[] }> = {};

  beforeAll(async () => {
    const stack = new Stack(new App(), 'EmulatorTables');
    declare(stack);
    ddb = new DynamoDBClient({});
    for (const [logicalId, { Properties: table }] of Object.entries(Template.fromStack(stack).findResources('AWS::DynamoDB::Table'))) {
      if (typeof table.TableName !== 'string') {
        throw new Error(`Table ${logicalId} has no literal tableName; pass one to its construct so the handler environment can name it.`);
      }
      declared[table.TableName] = table;
      await ddb.send(new CreateTableCommand({
        TableName: table.TableName,
        AttributeDefinitions: table.AttributeDefinitions,
        KeySchema: table.KeySchema,
        GlobalSecondaryIndexes: table.GlobalSecondaryIndexes
          ?.filter((index: { IndexName: string }) => !withoutIndexes[table.TableName]?.includes(index.IndexName)),
        BillingMode: table.BillingMode,
      }));
      created.push(table.TableName);
    }
    for (const TableName of created) {
      await waitUntilTableExists({ client: ddb, maxWaitTime: TABLE_WAIT_SECONDS, minDelay: 1 }, { TableName });
    }
    await seed?.();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const TableName of created) await ddb?.send(new DeleteTableCommand({ TableName }));
    ddb?.destroy();
  });

  return async (tableName, indexName) => {
    const { AttributeDefinitions, GlobalSecondaryIndexes } = declared[tableName];
    const Create = GlobalSecondaryIndexes?.find((index) => index.IndexName === indexName);
    await ddb?.send(new UpdateTableCommand({ TableName: tableName, AttributeDefinitions, GlobalSecondaryIndexUpdates: [{ Create }] }));
  };
}

/**
 * An API Gateway proxy event as the Cognito authorizer would deliver it.
 * @param userId - the authenticated caller (`claims.sub`).
 * @param overrides - request parts the call under test needs (body, headers, path or query parameters).
 * @returns the event.
 */
export function apiEvent(userId: string, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/tasks',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/tasks',
    requestContext: {
      authorizer: { claims: { sub: userId } },
      identity: { sourceIp: '127.0.0.1', userAgent: 'jest' },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    ...overrides,
  };
}
