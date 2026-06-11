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
 * Slack-button HITL approval tests for the interactions handler
 * (issue #112). Lives in a separate file from
 * `slack-interactions.test.ts` because the handler reads
 * `TASK_APPROVALS_TABLE_NAME` at module-load time — setting it here
 * before the import enables the approval path; the sibling file leaves
 * it unset to exercise the not-configured degradation.
 */

import * as crypto from 'crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  class TransactionCanceledExceptionMock extends Error {
    public CancellationReasons?: Array<{ Code?: string }>;
    constructor(opts: { message: string; CancellationReasons?: Array<{ Code?: string }> }) {
      super(opts.message);
      this.name = 'TransactionCanceledException';
      this.CancellationReasons = opts.CancellationReasons;
    }
  }
  return {
    DynamoDBClient: jest.fn(() => ({})),
    TransactionCanceledException: TransactionCanceledExceptionMock,
  };
});
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  TransactWriteCommand: jest.fn((input: unknown) => ({ _type: 'TransactWrite', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-A';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.TASK_APPROVALS_TABLE_NAME = 'TaskApprovals';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-interactions';

const SIGNING_SECRET = 'test-signing';
const TASK_ID = 'task-42';
const REQUEST_ID = '01JXAPPROVALREQUESTULID00';

function sign(body: string, ts: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
}

function makeInteractionEvent(payload: object): APIGatewayProxyEvent {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      'X-Slack-Signature': sign(body, ts),
      'X-Slack-Request-Timestamp': ts,
    },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/interactions',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function interactionPayload(actionId: string, userId = 'U1', teamId = 'T1'): object {
  return {
    type: 'block_actions',
    user: { id: userId, username: 'u', team_id: teamId },
    response_url: 'https://hooks.slack.com/response/xyz',
    trigger_id: 't.1',
    actions: [{ action_id: actionId, block_id: TASK_ID }],
    channel: { id: 'C1' },
  };
}

/** Latest body posted to the interaction response_url, or undefined. */
function lastEphemeralText(): string | undefined {
  const call = [...fetchMock.mock.calls].reverse().find(([url]) => {
    try {
      return new URL(String(url)).hostname === 'hooks.slack.com';
    } catch {
      return false;
    }
  });
  if (!call) return undefined;
  return (JSON.parse((call[1] as { body: string }).body) as { text: string }).text;
}

/**
 * Default DDB routing for the happy path:
 *  - Get on SlackMap → linked platform user
 *  - Get on TaskApprovals → PENDING low-severity row
 *  - Update (rate limit) → ok
 *  - TransactWrite → ok
 *  - Put (audit) → ok
 */
function configureHappyPath(severity = 'low', platformUserId = 'user-42') {
  ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
    if (cmd._type === 'Get') {
      const table = cmd.input.TableName;
      if (table === 'SlackMap') {
        return Promise.resolve({ Item: { platform_user_id: platformUserId, status: 'active' } });
      }
      if (table === 'TaskApprovals') {
        return Promise.resolve({
          Item: {
            task_id: TASK_ID,
            request_id: REQUEST_ID,
            status: 'PENDING',
            severity,
            user_id: platformUserId,
          },
        });
      }
      return Promise.resolve({ Item: undefined });
    }
    return Promise.resolve({});
  });
}

describe('slack-interactions — approve/deny buttons (issue #112)', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    smSend.mockResolvedValue({ SecretString: SIGNING_SECRET });
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });

  test('approve_action records the decision through the shared core and confirms ephemerally', async () => {
    configureHappyPath('low');
    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    // The decision transaction ran with the mapped platform user as the
    // ownership caller and APPROVED as the target status.
    const txn = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite');
    expect(txn).toBeTruthy();
    const items = (txn![0].input as { TransactItems: Array<{ Update: Record<string, any> }> }).TransactItems;
    expect(items[0].Update.Key).toEqual({ task_id: TASK_ID, request_id: REQUEST_ID });
    expect(items[0].Update.ExpressionAttributeValues[':decided']).toBe('APPROVED');
    expect(items[0].Update.ExpressionAttributeValues[':caller']).toBe('user-42');
    // Scope is one-shot from Slack — no scoped blanket approvals via buttons.
    expect(items[0].Update.ExpressionAttributeValues[':scope']).toBe('this_call');

    // Audit event written.
    const audit = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(audit).toBeTruthy();
    expect((audit![0].input as { Item: { event_type: string } }).Item.event_type)
      .toBe('approval_decision_recorded');

    expect(lastEphemeralText()).toContain('Approved');
  });

  test('deny_action records DENIED with the Slack-sourced reason', async () => {
    configureHappyPath('medium');
    const event = makeInteractionEvent(interactionPayload(`deny_action:${TASK_ID}:${REQUEST_ID}`));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    const txn = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite');
    expect(txn).toBeTruthy();
    const items = (txn![0].input as { TransactItems: Array<{ Update: Record<string, any> }> }).TransactItems;
    expect(items[0].Update.ExpressionAttributeValues[':decided']).toBe('DENIED');
    expect(items[0].Update.ExpressionAttributeValues[':reason']).toBe('Denied via Slack');
    expect(lastEphemeralText()).toContain('Denied');
  });

  test('high-severity gate is refused server-side even though the action_id is well-formed (§11.2 finding #4)', async () => {
    // The CRITICAL test: buttons never render on high-severity messages,
    // but that's UX. A forged/replayed action_id must be stopped by the
    // server-side severity re-check before any decision write.
    configureHappyPath('high');
    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    expect(ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')).toBeFalsy();
    expect(lastEphemeralText()).toContain('high');
    expect(lastEphemeralText()).toContain('CLI');
  });

  test('unlinked Slack account cannot decide (told to link first)', async () => {
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get' && cmd.input.TableName === 'SlackMap') {
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')).toBeFalsy();
    expect(lastEphemeralText()).toContain('not linked');
  });

  test('pending (half-linked) mapping rows are treated as unlinked', async () => {
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get' && cmd.input.TableName === 'SlackMap') {
        return Promise.resolve({ Item: { status: 'pending' } });
      }
      return Promise.resolve({});
    });
    const event = makeInteractionEvent(interactionPayload(`deny_action:${TASK_ID}:${REQUEST_ID}`));
    await handler(event);
    expect(ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')).toBeFalsy();
    expect(lastEphemeralText()).toContain('not linked');
  });

  test("non-owner's click fails the ownership condition and reads as not-found (no oracle)", async () => {
    configureHappyPath('low', 'mallory'); // mapping resolves, but the row belongs to user-42
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get') {
        const table = cmd.input.TableName;
        if (table === 'SlackMap') {
          return Promise.resolve({ Item: { platform_user_id: 'mallory', status: 'active' } });
        }
        if (table === 'TaskApprovals') {
          return Promise.resolve({
            Item: { task_id: TASK_ID, request_id: REQUEST_ID, status: 'PENDING', severity: 'low', user_id: 'user-42' },
          });
        }
      }
      if (cmd._type === 'TransactWrite') {
        // Ownership condition (user_id = :caller) fails on item 0.
        return Promise.reject(new TransactionCanceledException({
          message: 'cancelled',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        } as ConstructorParameters<typeof TransactionCanceledException>[0]));
      }
      return Promise.resolve({});
    });

    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    // Audit must not be written for a failed decision.
    expect(ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put')).toBeFalsy();
    expect(lastEphemeralText()).toContain('not found');
  });

  test('already-decided gate reads as not-found (same collapse as the HTTP path)', async () => {
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get') {
        const table = cmd.input.TableName;
        if (table === 'SlackMap') {
          return Promise.resolve({ Item: { platform_user_id: 'user-42', status: 'active' } });
        }
        if (table === 'TaskApprovals') {
          return Promise.resolve({
            Item: { task_id: TASK_ID, request_id: REQUEST_ID, status: 'APPROVED', severity: 'low', user_id: 'user-42' },
          });
        }
      }
      if (cmd._type === 'TransactWrite') {
        return Promise.reject(new TransactionCanceledException({
          message: 'cancelled',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        } as ConstructorParameters<typeof TransactionCanceledException>[0]));
      }
      return Promise.resolve({});
    });

    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    await handler(event);
    expect(lastEphemeralText()).toContain('not found');
  });

  test('task no longer awaiting approval is reported distinctly', async () => {
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get') {
        const table = cmd.input.TableName;
        if (table === 'SlackMap') {
          return Promise.resolve({ Item: { platform_user_id: 'user-42', status: 'active' } });
        }
        if (table === 'TaskApprovals') {
          return Promise.resolve({
            Item: { task_id: TASK_ID, request_id: REQUEST_ID, status: 'PENDING', severity: 'low', user_id: 'user-42' },
          });
        }
      }
      if (cmd._type === 'TransactWrite') {
        return Promise.reject(new TransactionCanceledException({
          message: 'cancelled',
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        } as ConstructorParameters<typeof TransactionCanceledException>[0]));
      }
      return Promise.resolve({});
    });

    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    await handler(event);
    expect(lastEphemeralText()).toContain('no longer awaiting');
  });

  test('rate-limit trip is surfaced ephemerally', async () => {
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get') {
        const table = cmd.input.TableName;
        if (table === 'SlackMap') {
          return Promise.resolve({ Item: { platform_user_id: 'user-42', status: 'active' } });
        }
        if (table === 'TaskApprovals') {
          return Promise.resolve({
            Item: { task_id: TASK_ID, request_id: REQUEST_ID, status: 'PENDING', severity: 'low', user_id: 'user-42' },
          });
        }
      }
      if (cmd._type === 'Update') {
        const err = new Error('limit');
        err.name = 'ConditionalCheckFailedException';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    await handler(event);
    expect(ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')).toBeFalsy();
    expect(lastEphemeralText()).toContain('Rate limit');
  });

  test('malformed action_id (missing request id) is rejected without any DDB access', async () => {
    const event = makeInteractionEvent(interactionPayload('approve_action:task-only'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(ddbSend.mock.calls.find(([cmd]) => cmd._type === 'TransactWrite')).toBeFalsy();
    expect(lastEphemeralText()).toContain('Malformed');
  });

  test('missing approvals row still goes through the decision core (no existence oracle at the Get)', async () => {
    // A Get miss on the approvals row must NOT short-circuit with a
    // distinct message — the severity check simply has nothing to gate
    // on, and the transaction's attribute_exists condition produces the
    // same "not found" as ownership/decided failures.
    ddbSend.mockImplementation((cmd: { _type?: string; input: Record<string, unknown> }) => {
      if (cmd._type === 'Get') {
        const table = cmd.input.TableName;
        if (table === 'SlackMap') {
          return Promise.resolve({ Item: { platform_user_id: 'user-42', status: 'active' } });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd._type === 'TransactWrite') {
        return Promise.reject(new TransactionCanceledException({
          message: 'cancelled',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        } as ConstructorParameters<typeof TransactionCanceledException>[0]));
      }
      return Promise.resolve({});
    });

    const event = makeInteractionEvent(interactionPayload(`approve_action:${TASK_ID}:${REQUEST_ID}`));
    await handler(event);
    expect(lastEphemeralText()).toContain('not found');
  });
});
