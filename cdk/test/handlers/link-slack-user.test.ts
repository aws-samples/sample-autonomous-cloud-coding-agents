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

import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';

import { handler } from '../../src/handlers/link-slack-user';

function makeEvent(body: unknown): APIGatewayProxyEvent {
  return {
    body: body === null ? null : JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/notifications/slack/link',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/notifications/slack/link',
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: { claims: { sub: 'user-alice' } },
      httpMethod: 'POST',
      identity: {} as never,
      path: '/v1/notifications/slack/link',
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/notifications/slack/link',
      stage: 'v1',
    },
  } as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockSend.mockReset();
  ulidCounter = 0;
});

describe('link-slack-user', () => {
  test('401 when no Cognito claims', async () => {
    const event = makeEvent({ slack_user_id: 'U12345', slack_link_token: 'tok' });
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  test('400 on invalid JSON body', async () => {
    const res = await handler(makeEvent(null));
    expect(res.statusCode).toBe(400);
  });

  test('400 on missing fields', async () => {
    const res = await handler(makeEvent({ slack_user_id: 'U12345' }));
    expect(res.statusCode).toBe(400);
  });

  test('400 on bad slack_user_id shape', async () => {
    const res = await handler(
      makeEvent({ slack_user_id: 'bad id with spaces!', slack_link_token: 'tok' }),
    );
    expect(res.statusCode).toBe(400);
  });

  test('201 on successful mapping', async () => {
    mockSend.mockResolvedValue({});
    const res = await handler(makeEvent({ slack_user_id: 'U12345', slack_link_token: 'tok' }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.slack_user_id).toBe('U12345');
    expect(body.data.created_at).toBeDefined();

    const putCall = mockSend.mock.calls[0][0].input;
    expect(putCall.TableName).toBe('SlackMap');
    expect(putCall.ConditionExpression).toBe('attribute_not_exists(slack_user_id)');
    expect(putCall.Item.slack_user_id).toBe('U12345');
    expect(putCall.Item.cognito_sub).toBe('user-alice');
  });

  test('409 when mapping already exists', async () => {
    const err = new Error('ConditionalCheckFailedException');
    (err as { name: string }).name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(err);
    const res = await handler(makeEvent({ slack_user_id: 'U12345', slack_link_token: 'tok' }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('REQUEST_ALREADY_DECIDED');
  });

  test('500 on unexpected DDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('boom'));
    const res = await handler(makeEvent({ slack_user_id: 'U12345', slack_link_token: 'tok' }));
    expect(res.statusCode).toBe(500);
  });

  test('trims whitespace from slack_user_id', async () => {
    mockSend.mockResolvedValue({});
    await handler(makeEvent({ slack_user_id: '  U12345  ', slack_link_token: 'tok' }));
    const putCall = mockSend.mock.calls[0][0].input;
    expect(putCall.Item.slack_user_id).toBe('U12345');
  });
});
