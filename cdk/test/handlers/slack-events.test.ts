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
import type { APIGatewayProxyEvent } from 'aws-lambda';

// --- Mocks ---
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
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
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-XYZ';
process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME = 'cmd-processor';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-events';

const SIGNING_SECRET = 'test-signing-secret';

function sign(body: string, timestamp: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
}

function currentTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeEvent(body: string, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/events',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function signedEvent(body: string, retryNum?: string, retryReason?: string): APIGatewayProxyEvent {
  const ts = currentTs();
  const headers: Record<string, string> = {
    'X-Slack-Signature': sign(body, ts),
    'X-Slack-Request-Timestamp': ts,
  };
  if (retryNum) headers['X-Slack-Retry-Num'] = retryNum;
  if (retryReason) headers['X-Slack-Retry-Reason'] = retryReason;
  return makeEvent(body, headers);
}

/** JSON bodies of the calls made to one Slack Web API method, in call order. */
function slackCalls(method: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === `https://slack.com/api/${method}`)
    .map(([, opts]) => JSON.parse((opts as { body: string }).body));
}

describe('slack-events handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    lambdaSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    // Default: signing secret fetched on demand
    smSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetSecretValue') return Promise.resolve({ SecretString: SIGNING_SECRET });
      return Promise.resolve({});
    });
  });

  test('400s when body is missing', async () => {
    const event = makeEvent(null as unknown as string);
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('answers url_verification challenge with valid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ challenge: 'abc123' });
  });

  test('rejects url_verification with invalid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const ts = currentTs();
    const event = makeEvent(body, {
      'X-Slack-Signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
      'X-Slack-Request-Timestamp': ts,
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('answers url_verification with a 500 and no challenge when signing secret missing', async () => {
    smSend.mockImplementation(() => Promise.resolve({ SecretString: undefined }));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'initial' });
    const result = await handler(makeEvent(body, {}));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Internal configuration error' });
  });

  test('rejects non-url_verification when signing secret missing', async () => {
    smSend.mockImplementation(() => Promise.resolve({ SecretString: undefined }));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
    const result = await handler(makeEvent(body, {}));
    expect(result.statusCode).toBe(500);
  });

  test('refuses an unsigned url_verification when the signing secret is scheduled for deletion', async () => {
    // The secret exists and cannot be read, so the
    // request cannot be verified and must not be answered.
    smSend.mockImplementation(() => Promise.reject(Object.assign(
      new Error("You can't perform this operation on the secret because it was marked for deletion."),
      { name: 'InvalidRequestException' },
    )));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });

    const result = await handler(makeEvent(body, {}));

    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('abc123');
  });

  test('drops non-critical retries without reprocessing', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> hi', ts: '1.0' },
    });
    const result = await handler(signedEvent(body, '1'));
    expect(result.statusCode).toBe(200);
    // No lambda invocation because the retry is short-circuited
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('processes the first retry of a mention whose first delivery got an HTTP error', async () => {
    // The first delivery was answered 5xx or 429 (Secrets Manager throttled the
    // signing-secret read, API Gateway throttled the request). This handler
    // answers a mention with a non-2xx status only when it did not invoke the
    // processor, so nothing was submitted: the retry is the user's request.
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockResolvedValueOnce({});
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> hi', ts: '1.0' },
    });
    const result = await handler(signedEvent(body, '1', 'http_error'));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  test.each([
    // The first delivery may have been processed, only too slowly for Slack.
    ['1', 'http_timeout'],
    ['1', 'unknown_error'],
    // The reason describes the attempt before this one, not the first delivery:
    // that one may have been processed and then timed out.
    ['2', 'http_error'],
  ])('drops retry %s of a mention with reason %s without reprocessing', async (retryNum, retryReason) => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> hi', ts: '1.0' },
    });
    const result = await handler(signedEvent(body, retryNum, retryReason));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('reprocesses retries for app_uninstalled (security-critical)', async () => {
    ddbSend.mockResolvedValueOnce({}); // UpdateCommand
    smSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetSecretValue') return Promise.resolve({ SecretString: SIGNING_SECRET });
      if (cmd._type === 'DeleteSecret') return Promise.resolve({});
      return Promise.resolve({});
    });
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_revoke',
      event: { type: 'app_uninstalled' },
    });
    const result = await handler(signedEvent(body, '2'));
    expect(result.statusCode).toBe(200);
    // DDB was updated (status→revoked) even though this is a retry
    expect(ddbSend).toHaveBeenCalledTimes(1);
    // And the secret deletion happened
    const deleteCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'DeleteSecret');
    expect(deleteCalled).toBe(true);
  });

  test('does not delete bot token if DDB revocation update failed', async () => {
    ddbSend.mockRejectedValueOnce(new Error('ddb throttle'));
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_revoke',
      event: { type: 'tokens_revoked' },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(500);
    // Critical invariant: don't delete secret if install is still "active" in DDB
    const deleteCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'DeleteSecret');
    expect(deleteCalled).toBe(false);
  });

  test('forwards app_mention to command processor with :eyes: reaction', async () => {
    // First fetch is reactions.add for :eyes:, returns { ok: true }
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockResolvedValueOnce({});
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      // Bot token lookup
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix the bug in org/repo#42',
        ts: '1234.0001',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(payload.source).toBe('mention');
    expect(payload.text).toContain('submit');
    expect(payload.text).toContain('org/repo#42');
    expect(payload.channel_id).toBe('C1');
    // Reactions.add was called
    const reactionCall = fetchMock.mock.calls.find(([url]) => String(url).includes('reactions.add'));
    expect(reactionCall).toBeTruthy();
  });

  test('app_mention without repo is forwarded to the processor (channel-default fallback)', async () => {
    // The events handler no longer answers no-repo mentions inline — it forwards
    // them so the processor can apply the channel's onboarded default repo (and,
    // only if there is none, reply with guidance). The whole text is forwarded
    // as the submit description.
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> just a question', ts: '1.0' },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    // Forwarded to the processor rather than answered inline.
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const invokePayload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(invokePayload.text).toBe('submit just a question');
    // No inline "Please include a repo" reply from the events handler.
    const postedReply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(postedReply).toBeFalsy();
  });

  test.each([
    // A slash word need not be a repo, and the first one need not be the
    // repo: the processor decides, it can ask what is onboarded.
    ['<@BOT> fix the CI/CD pipeline', 'submit fix the CI/CD pipeline'],
    ['<@BOT> make the client/server handshake retry in acme/api#7', 'submit make the client/server handshake retry in acme/api#7'],
    // Line breaks and indentation are part of what the user wrote.
    ['<@BOT> fix this in org/repo:\n  line two', 'submit fix this in org/repo:\n  line two'],
  ])('forwards the text of a mention as written: %j', async (text, forwarded) => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockResolvedValueOnce({});
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text, ts: '1.0' },
    });

    await handler(signedEvent(body));

    const [invokeCmd] = lambdaSend.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload)).text).toBe(forwarded);
  });

  describe('a mention written as a reply inside a thread', () => {
    // ts is the mention itself, thread_ts the first message of the thread,
    // which somebody else may have written.
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> fix A in acme/api', ts: '200.0002', thread_ts: '100.0001' },
    });

    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
        if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
          return Promise.resolve({ SecretString: SIGNING_SECRET });
        }
        return Promise.resolve({ SecretString: 'xoxb-bot' });
      });
    });

    test('gets the :eyes: reaction itself and is forwarded with both timestamps', async () => {
      lambdaSend.mockResolvedValueOnce({});

      const result = await handler(signedEvent(body));

      expect(result.statusCode).toBe(200);
      expect(slackCalls('reactions.add')).toEqual([{ channel: 'C1', timestamp: '200.0002', name: 'eyes' }]);
      const [invokeCmd] = lambdaSend.mock.calls[0];
      const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
      expect(payload.mention_thread_ts).toBe('100.0001');
      expect(payload.mention_message_ts).toBe('200.0002');
    });

    test('is marked :x: itself when forwarding fails, with the reply in its thread', async () => {
      lambdaSend.mockRejectedValueOnce(new Error('lambda outage'));

      await handler(signedEvent(body));

      expect(slackCalls('reactions.remove')).toEqual([{ channel: 'C1', timestamp: '200.0002', name: 'eyes' }]);
      expect(slackCalls('reactions.add')).toEqual([
        { channel: 'C1', timestamp: '200.0002', name: 'eyes' },
        { channel: 'C1', timestamp: '200.0002', name: 'x' },
      ]);
      expect(slackCalls('chat.postMessage')).toEqual([expect.objectContaining({ channel: 'C1', thread_ts: '100.0001' })]);
    });
  });

  test('a top-level mention is forwarded with its own ts as thread and as message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockResolvedValueOnce({});
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> fix A in acme/api', ts: '200.0002' },
    });

    await handler(signedEvent(body));

    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(payload.mention_thread_ts).toBe('200.0002');
    expect(payload.mention_message_ts).toBe('200.0002');
  });

  test('app_mention with Lambda invoke failure swaps :eyes: to :x:', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockRejectedValueOnce(new Error('lambda outage'));
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix org/repo',
        ts: '1.0',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200); // Still 200 — Slack retries give a second chance
    // Should have swapped reaction: remove :eyes:, add :x:, then post error message
    const removeCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('reactions.remove') && String((opts as { body: string }).body).includes('eyes'),
    );
    const addCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('reactions.add') && String((opts as { body: string }).body).includes('"name":"x"'),
    );
    const errorReply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Something went wrong'),
    );
    expect(removeCall).toBeTruthy();
    expect(addCall).toBeTruthy();
    expect(errorReply).toBeTruthy();
  });
});
