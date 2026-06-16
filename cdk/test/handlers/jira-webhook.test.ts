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

process.env.JIRA_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/jira/webhook-XYZ';
process.env.JIRA_WEBHOOK_DEDUP_TABLE_NAME = 'JiraDedup';
process.env.JIRA_WEBHOOK_PROCESSOR_FUNCTION_NAME = 'jira-processor';

import { handler } from '../../src/handlers/jira-webhook';
import { invalidateJiraSecretCache } from '../../src/handlers/shared/jira-verify';

const WEBHOOK_SECRET = 'test-jira-webhook-secret';

/**
 * Atlassian sends `X-Hub-Signature: sha256=<hex>` — verify the signature
 * helper accepts both the prefixed form (production) and bare hex
 * (defensive). Tests exercise the prefixed form because that's what
 * Atlassian actually delivers.
 */
function sign(body: string): string {
  const hex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return `sha256=${hex}`;
}

function makeEvent(body: string, signature?: string): APIGatewayProxyEvent {
  const headers: Record<string, string> = {};
  if (signature !== undefined) headers['X-Hub-Signature'] = signature;
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/jira/webhook',
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
    webhookEvent: 'jira:issue_created',
    timestamp: Date.now(),
    issue: {
      id: '10001',
      key: 'ENG-42',
      fields: {
        labels: ['bgagent'],
        project: { id: 'p1', key: 'ENG' },
      },
    },
    ...overrides,
  });
}

describe('jira-webhook handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    lambdaSend.mockReset();
    smSend.mockReset();
    invalidateJiraSecretCache(process.env.JIRA_WEBHOOK_SECRET_ARN!);
    smSend.mockResolvedValue({ SecretString: WEBHOOK_SECRET });
  });

  test('400s when body is missing', async () => {
    const result = await handler(makeEvent('', sign('')));
    expect(result.statusCode).toBe(400);
  });

  test('401s when X-Hub-Signature header is missing', async () => {
    const body = issueCreatePayload();
    const result = await handler(makeEvent(body));
    expect(result.statusCode).toBe(401);
  });

  test('401s when signature is invalid', async () => {
    const body = issueCreatePayload();
    const result = await handler(makeEvent(body, 'sha256=deadbeef'));
    expect(result.statusCode).toBe(401);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('ignores non-Issue webhookEvent types with 200', async () => {
    const body = JSON.stringify({
      webhookEvent: 'comment_created',
      timestamp: Date.now(),
      comment: { id: 'c-1' },
    });
    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(200);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('400s when issue.id or issue.key is missing on a verified Issue event', async () => {
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      timestamp: Date.now(),
      issue: { fields: {} },
    });
    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(400);
  });

  test('verified Issue event dedups and invokes processor', async () => {
    const FRESH_TS = Date.now();
    const body = issueCreatePayload({ timestamp: FRESH_TS });
    ddbSend.mockResolvedValueOnce({}); // conditional Put succeeds
    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent(body, sign(body)));

    expect(result.statusCode).toBe(200);
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.dedup_key).toBe(`ENG-42#jira:issue_created#${FRESH_TS}`);
    expect(putCall![0].input.ConditionExpression).toContain('attribute_not_exists');

    // 8h dedup window — comfortably over Atlassian's retry horizon.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = putCall![0].input.Item.ttl as number;
    expect(ttl - nowSeconds).toBeGreaterThanOrEqual(7 * 60 * 60);

    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const invokeCall = lambdaSend.mock.calls[0][0];
    expect(invokeCall._type).toBe('Invoke');
    expect(invokeCall.input.FunctionName).toBe('jira-processor');
    expect(invokeCall.input.InvocationType).toBe('Event');
    const decoded = JSON.parse(new TextDecoder().decode(invokeCall.input.Payload));
    expect(decoded.raw_body).toBe(body);
  });

  test('distinct deliveries for the same issue both dispatch (timestamp distinguishes them)', async () => {
    // Atlassian doesn't expose a per-delivery message id; the dedup primitive
    // includes the envelope timestamp so a label-off-then-on pair both fire.
    const FRESH_TS = Date.now();
    const FRESH_TS_2 = FRESH_TS + 1000;
    const body1 = issueCreatePayload({ timestamp: FRESH_TS });
    const body2 = issueCreatePayload({ timestamp: FRESH_TS_2 });
    ddbSend.mockResolvedValue({});
    lambdaSend.mockResolvedValue({});

    await handler(makeEvent(body1, sign(body1)));
    await handler(makeEvent(body2, sign(body2)));

    const putCalls = ddbSend.mock.calls.filter(([cmd]) => cmd._type === 'Put');
    expect(putCalls).toHaveLength(2);
    expect(putCalls[0][0].input.Item.dedup_key).toBe(`ENG-42#jira:issue_created#${FRESH_TS}`);
    expect(putCalls[1][0].input.Item.dedup_key).toBe(`ENG-42#jira:issue_created#${FRESH_TS_2}`);
    expect(lambdaSend).toHaveBeenCalledTimes(2);
  });

  test('400s a base64-encoded body before verifying (HMAC is over the raw string)', async () => {
    const body = issueCreatePayload();
    const event = makeEvent(body, sign(body));
    (event as { isBase64Encoded: boolean }).isBase64Encoded = true;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('accepts a verified Issue event with no timestamp (replay check skipped, not fail-open-rejected)', async () => {
    // Atlassian timestamps are advisory (not signed), so a missing one can't
    // be treated as fatal. The delivery still dispatches; the dedup key
    // collapses to `…#unknown`.
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      issue: { id: '10001', key: 'ENG-42', fields: { labels: ['bgagent'], project: { id: 'p1', key: 'ENG' } } },
    });
    ddbSend.mockResolvedValueOnce({});
    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent(body, sign(body)));

    expect(result.statusCode).toBe(200);
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall![0].input.Item.dedup_key).toBe('ENG-42#jira:issue_created#unknown');
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test('flags stack-wide verification to the processor (verified_via_stack_wide:true)', async () => {
    // No per-tenant registry configured here → verification rides the
    // stack-wide secret, which the processor must not trust for cloudId.
    const body = issueCreatePayload();
    ddbSend.mockResolvedValueOnce({});
    lambdaSend.mockResolvedValueOnce({});

    await handler(makeEvent(body, sign(body)));

    const invokeCall = lambdaSend.mock.calls[0][0];
    const decoded = JSON.parse(new TextDecoder().decode(invokeCall.input.Payload));
    expect(decoded.verified_via_stack_wide).toBe(true);
  });

  test('dedup hit returns 200 with deduped:true', async () => {
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
    const body = issueCreatePayload({ timestamp: FRESH_TS });
    // 1st ddbSend: PutCommand (dedup reservation) succeeds
    // 2nd ddbSend: DeleteCommand (rollback after invoke failure) succeeds
    ddbSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    lambdaSend.mockRejectedValueOnce(new Error('Lambda throttle'));

    const result = await handler(makeEvent(body, sign(body)));
    expect(result.statusCode).toBe(500);

    // Dedup row must be deleted so Atlassian's retry can try again —
    // otherwise a transient Lambda failure silently drops the task.
    const deleteCalls = ddbSend.mock.calls.filter((c) => c[0]._type === 'Delete');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0].input.TableName).toBe('JiraDedup');
    expect(deleteCalls[0][0].input.Key.dedup_key).toBe(`ENG-42#jira:issue_created#${FRESH_TS}`);
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

  test('accepts bare hex signature (no sha256= prefix) for back-compat / non-standard callers', async () => {
    // A few Atlassian deployments and proxies strip the algorithm prefix.
    // verifyJiraSignature intentionally accepts both shapes; this test
    // pins that down so a future refactor doesn't accidentally drop it.
    const body = issueCreatePayload();
    const bareHex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    ddbSend.mockResolvedValueOnce({});
    lambdaSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent(body, bareHex));
    expect(result.statusCode).toBe(200);
  });
});
