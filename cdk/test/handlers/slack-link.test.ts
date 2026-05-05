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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';

import { handler } from '../../src/handlers/slack-link';

function makeEvent(body: unknown, userId?: string): APIGatewayProxyEvent {
  return {
    body: body === null ? null : JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/link',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: userId
      ? ({ authorizer: { claims: { sub: userId } } } as unknown as APIGatewayProxyEvent['requestContext'])
      : ({} as APIGatewayProxyEvent['requestContext']),
    resource: '',
  };
}

describe('slack-link handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
  });

  test('401s without a Cognito JWT', async () => {
    const result = await handler(makeEvent({ code: 'ABC123' }));
    expect(result.statusCode).toBe(401);
  });

  test('400s without a code in the body', async () => {
    const result = await handler(makeEvent({}, 'cognito-user-1'));
    expect(result.statusCode).toBe(400);
  });

  test('404s when code is not found', async () => {
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent({ code: 'XYZ123' }, 'cognito-user-1'));
    expect(result.statusCode).toBe(404);
  });

  test('404s when code exists but status is not pending', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { slack_identity: 'pending#XYZ', status: 'consumed' } });
    const result = await handler(makeEvent({ code: 'XYZ123' }, 'cognito-user-1'));
    expect(result.statusCode).toBe(404);
  });

  test('writes confirmed mapping and deletes pending record on success', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          slack_identity: 'pending#ABC123',
          status: 'pending',
          slack_team_id: 'T1',
          slack_user_id: 'U_slack',
        },
      })
      .mockResolvedValueOnce({}) // Put (confirmed mapping)
      .mockResolvedValueOnce({}); // Delete (pending)

    const result = await handler(makeEvent({ code: 'abc123' }, 'cognito-user-1'));
    expect(result.statusCode).toBe(200);
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.slack_identity).toBe('T1#U_slack');
    expect(putCall![0].input.Item.platform_user_id).toBe('cognito-user-1');

    const deleteCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Delete');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall![0].input.Key.slack_identity).toBe('pending#ABC123');
  });

  test('normalizes the code (uppercase, trimmed)', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: { slack_identity: 'pending#ABC123', status: 'pending', slack_team_id: 'T1', slack_user_id: 'U1' },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(makeEvent({ code: '  abc123  ' }, 'cognito-user-1'));
    const getCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Get');
    expect(getCall![0].input.Key.slack_identity).toBe('pending#ABC123');
  });
});
