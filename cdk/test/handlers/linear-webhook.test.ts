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

import * as crypto from 'crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  class ConditionalCheckFailedExceptionMock extends Error {
    constructor(opts: { message: string; $metadata?: unknown }) {
      super(opts.message);
      this.name = 'ConditionalCheckFailedException';
    }
  }
  return {
    DynamoDBClient: jest.fn(() => ({})),
    ConditionalCheckFailedException: ConditionalCheckFailedExceptionMock,
  };
});
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

process.env.LINEAR_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/linear/webhook-XYZ';
process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME = 'LinearDedup';
process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'linear-processor';

import { handler } from '../../src/handlers/linear-webhook';
import { invalidateLinearSecretCache } from '../../src/handlers/shared/linear-verify';

const WEBHOOK_SECRET = 'test-linear-webhook-secret';

function sign(body: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function makeEvent(body: string, signature?: string): APIGatewayProxyEvent {
  const headers: Record<string, string> = {};
  if (signature !== undefined) headers['Linear-Signature'] = signature;
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/linear/webhook',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function issueCreatePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'create',
    type: 'Issue',
    webhookTimestamp: Date.now(),
    webhookId: 'wh-1',
    organizationId: 'org-1',
    data: { id: 'issue-1', labels: [{ id: 'lbl-1', name: 'bgagent' }] },
    ...overrides,
  });
}

describe('linear-webhook handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    lambdaSend.mockReset();
    smSend.mockReset();
    invalidateLinearSecretCache(process.env.LINEAR_WEBHOOK_SECRET_ARN!);
    smSend.mockResolvedValue({ SecretString: WEBHOOK_SECRET });
  });

  test('400s when body is missing', async () => {
    const result = await handler(makeEvent('', sign('')));
    expect(result.statusCode).toBe(400);
  });

  test('401s when Linear-Signature header is missing', async () => {
    const body = issueCreatePayload();
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(401);
  });

  test('401s when signature is invalid', async () => {
    const body = issueCreatePayload();
    const result = await handler(makeEvent(body, 'deadbeef'));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('401s when webhookTimestamp is stale', async () => {
    // 5 minutes old — far outside the 60s replay window.
    const body = JSON.stringify({
      action: 'create',
      type: 'Issue',
      webhookTimestamp: Date.now() - 5 * 60 * 1000,
      webhookId: 'wh-1',
      organizationId: 'org-1',
      data: { id: 'issue-1', labels: [{ id: 'lbl-1', name: 'bgagent' }] },
    });
    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('ignores non-Issue event types with 200', async () => {
    const body = JSON.stringify({
      action: 'create',
      type: 'Comment',
      webhookTimestamp: Date.now(),
      webhookId: 'wh-2',
      data: { id: 'cmt-1' },
    });
    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(200);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('400s when data.id is missing on an Issue event', async () => {
    const body = JSON.stringify({
      action: 'create',
      type: 'Issue',
      webhookTimestamp: Date.now(),
      webhookId: 'wh-3',
      organizationId: 'org-1',
      data: {},
    });
    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(400);
  });

  test('verified Issue event dedups and invokes processor', async () => {
    const FRESH_TS = Date.now();
    const body = issueCreatePayload({ webhookTimestamp: FRESH_TS });
    ddbSend.mockResolvedValueOnce({}); // conditional Put succeeds
    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent(body, sign(body)));

    expect(result.statusCode).toBe(200);
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.dedup_key).toBe(`issue-1#create#${FRESH_TS}`);
    expect(putCall![0].input.ConditionExpression).toContain('attribute_not_exists');

    // The TTL must outlast Linear's full retry horizon (first at +1m, then
    // +1h, then +6h — ~7h total). Anything shorter lets the +1h/+6h retries
    // land after the dedup row expires and double-dispatch the task.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = putCall![0].input.Item.ttl as number;
    expect(ttl - nowSeconds).toBeGreaterThanOrEqual(7 * 60 * 60);

    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const invokeCall = lambdaSend.mock.calls[0][0];
    expect(invokeCall._type).toBe('Invoke');
    expect(invokeCall.input.FunctionName).toBe('linear-processor');
    expect(invokeCall.input.InvocationType).toBe('Event');
    const decoded = JSON.parse(new TextDecoder().decode(invokeCall.input.Payload));
    expect(decoded.raw_body).toBe(body);
  });

  test('distinct deliveries for the same issue both dispatch', async () => {
    // Linear reuses `webhookId` across deliveries from the same webhook
    // config, so two separate events (label-off-then-on) share the webhookId
    // but differ in webhookTimestamp. The dedup primitive must include
    // timestamp so distinct events are not collapsed.
    const FRESH_TS = Date.now();
    const FRESH_TS_2 = FRESH_TS + 1000;
    const body1 = issueCreatePayload({ webhookTimestamp: FRESH_TS });
    const body2 = issueCreatePayload({ webhookTimestamp: FRESH_TS_2 });
    ddbSend.mockResolvedValue({});
    lambdaSend.mockResolvedValue({});

    await handler(makeEvent(body1, sign(body1)));
    await handler(makeEvent(body2, sign(body2)));

    const putCalls = ddbSend.mock.calls.filter(([cmd]) => cmd._type === 'Put');
    expect(putCalls).toHaveLength(2);
    expect(putCalls[0][0].input.Item.dedup_key).toBe(`issue-1#create#${FRESH_TS}`);
    expect(putCalls[1][0].input.Item.dedup_key).toBe(`issue-1#create#${FRESH_TS_2}`);
    expect(lambdaSend).toHaveBeenCalledTimes(2);
  });

  test('dedup hit returns 200 without re-invoking processor', async () => {
    const body = issueCreatePayload();
    ddbSend.mockRejectedValueOnce(new ConditionalCheckFailedException({
      $metadata: {},
      message: 'Conditional check failed',
    }));

    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.deduped).toBe(true);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('returns 500 and rolls back dedup row if processor invoke fails', async () => {
    const FRESH_TS = Date.now();
    const body = issueCreatePayload({ webhookTimestamp: FRESH_TS });
    // 1st ddbSend: PutCommand (dedup reservation) succeeds
    // 2nd ddbSend: DeleteCommand (rollback after invoke failure) succeeds
    ddbSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    lambdaSend.mockRejectedValueOnce(new Error('Lambda throttle'));

    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(500);

    // Dedup row must be deleted so Linear's +1m/+1h/+6h retries can try again —
    // otherwise a transient Lambda failure silently drops the task for 8h.
    const deleteCalls = ddbSend.mock.calls.filter((c) => c[0]._type === 'Delete');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0].input.TableName).toBe('LinearDedup');
    expect(deleteCalls[0][0].input.Key.dedup_key).toBe(`issue-1#create#${FRESH_TS}`);
  });

  test('returns 500 even if dedup rollback also fails (does not mask invoke error)', async () => {
    const body = issueCreatePayload();
    ddbSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('DDB unavailable'));
    lambdaSend.mockRejectedValueOnce(new Error('Lambda throttle'));

    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(500);
  });

  test('400s on malformed JSON with a valid signature', async () => {
    const body = 'not-json-{';
    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(400);
  });
});
