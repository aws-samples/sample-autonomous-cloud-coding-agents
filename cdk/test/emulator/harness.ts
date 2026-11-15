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
 * Shared setup for the emulator-backed handler tests (ADR-013 Tier 2a).
 *
 * These suites run real handler code in-process and let its AWS calls go over
 * the wire to an AWS Emulator (https://github.com/aws/aws-emulator). Nothing
 * here configures an endpoint: the SDK clients the handlers already build pick
 * up AWS_ENDPOINT_URL, AWS_REGION and the emulator's credentials file from the
 * environment, and Node trusts its certificate through NODE_EXTRA_CA_CERTS.
 *
 * The files are named `*.emulator.ts`, which the unit configuration does not
 * match. They run only through `jest.emulator.config.js`
 * (`mise run test:integration`), which refuses to start unless that
 * environment is the emulator's and the emulator answers.
 *
 * The emulator keeps state in memory and has no reset route. Each test file
 * therefore names its tables uniquely (so files can share one instance, run in
 * parallel and be re-run without a restart), and each test writes under a user
 * id of its own (so tests need no cleanup between them).
 */

import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/** Timeout for table setup (ms). The emulator alone holds a new table in CREATING for 3 s; Jest's default is 5 s. */
const SETUP_TIMEOUT_MS = 30_000;

/** How long to wait for a new table to become ACTIVE (seconds). Shorter than the hook, so its own error is the one shown. */
const TABLE_WAIT_SECONDS = 20;

/**
 * Give the enclosing `describe` the DynamoDB tables that `declare` adds to a
 * stack: created on the emulator before its tests and deleted after them.
 *
 * The CreateTable inputs are read from the synthesized template, so key schema
 * and indexes are the constructs' own. A handler that queries an index its
 * construct no longer declares fails here instead of after a deploy.
 *
 * Streams and point-in-time recovery are not carried over. Neither is TTL, on
 * purpose: the emulator deletes an expired item within a second where AWS takes
 * up to days, so with TTL on, code that forgets to compare `ttl` with the clock
 * looks correct here.
 * @param declare - instantiates the table constructs under test, each with an explicit `tableName`.
 * @param seed - writes the rows every test in the file needs, once the tables are ACTIVE.
 */
export function emulatorTables(declare: (stack: Stack) => void, seed?: () => Promise<unknown>): void {
  let ddb: DynamoDBClient | undefined;
  const created: string[] = [];

  beforeAll(async () => {
    const stack = new Stack(new App(), 'EmulatorTables');
    declare(stack);
    ddb = new DynamoDBClient({});
    for (const [logicalId, { Properties: table }] of Object.entries(Template.fromStack(stack).findResources('AWS::DynamoDB::Table'))) {
      if (typeof table.TableName !== 'string') {
        throw new Error(`Table ${logicalId} has no literal tableName; pass one to its construct so the handler environment can name it.`);
      }
      await ddb.send(new CreateTableCommand({
        TableName: table.TableName,
        AttributeDefinitions: table.AttributeDefinitions,
        KeySchema: table.KeySchema,
        GlobalSecondaryIndexes: table.GlobalSecondaryIndexes,
        BillingMode: table.BillingMode,
      }));
      created.push(table.TableName);
    }
    // Create them all before waiting: the CREATING window then costs one wait, not one per table.
    for (const TableName of created) {
      await waitUntilTableExists({ client: ddb, maxWaitTime: TABLE_WAIT_SECONDS, minDelay: 1 }, { TableName });
    }
    await seed?.();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const TableName of created) await ddb?.send(new DeleteTableCommand({ TableName }));
    ddb?.destroy();
  });
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
