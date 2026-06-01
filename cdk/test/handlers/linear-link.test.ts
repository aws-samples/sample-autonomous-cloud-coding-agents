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

process.env.LINEAR_USER_MAPPING_TABLE_NAME = 'LinearMap';

import { handler } from '../../src/handlers/linear-link';

function makeEvent(body: unknown, userId?: string): APIGatewayProxyEvent {
  return {
    body: body === null ? null : JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/linear/link',
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

describe('linear-link handler', () => {
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
    ddbSend.mockResolvedValueOnce({ Item: { linear_identity: 'pending#XYZ', status: 'consumed' } });
    const result = await handler(makeEvent({ code: 'XYZ123' }, 'cognito-user-1'));
    expect(result.statusCode).toBe(404);
  });

  test('writes confirmed mapping and deletes pending record on success', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          linear_identity: 'pending#link-3f8b4a2c',
          status: 'pending',
          linear_workspace_id: 'workspace-uuid-1',
          linear_user_id: 'user-uuid-1',
        },
      })
      .mockResolvedValueOnce({}) // Put (confirmed mapping)
      .mockResolvedValueOnce({}); // Delete (pending)

    const result = await handler(makeEvent({ code: 'link-3f8b4a2c' }, 'cognito-user-1'));
    expect(result.statusCode).toBe(200);
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.linear_identity).toBe('workspace-uuid-1#user-uuid-1');
    expect(putCall![0].input.Item.platform_user_id).toBe('cognito-user-1');
    expect(putCall![0].input.Item.status).toBe('active');

    const deleteCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Delete');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall![0].input.Key.linear_identity).toBe('pending#link-3f8b4a2c');
  });

  test('dry_run returns the linked identity without writing or deleting', async () => {
    // The dry-run branch is the safety rail behind `bgagent linear link`'s
    // confirmation prompt: the CLI calls this first to render "you're
    // about to link X" before the teammate accepts. It must return the
    // identity payload AND must not touch DDB beyond the GetCommand.
    ddbSend.mockResolvedValueOnce({
      Item: {
        linear_identity: 'pending#link-3f8b4a2c',
        status: 'pending',
        linear_workspace_id: 'workspace-uuid-1',
        linear_workspace_slug: 'acme',
        linear_user_id: 'user-uuid-1',
        linear_user_name: 'Ada Lovelace',
        linear_user_email: 'ada@example.com',
      },
    });

    const result = await handler(makeEvent({ code: 'link-3f8b4a2c', dry_run: true }, 'cognito-user-1'));

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body) as {
      data: {
        dry_run: boolean;
        linear_user_email: string;
        linear_user_name: string;
        linear_workspace_slug: string;
      };
    };
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.linear_user_email).toBe('ada@example.com');
    expect(parsed.data.linear_user_name).toBe('Ada Lovelace');
    expect(parsed.data.linear_workspace_slug).toBe('acme');

    // Critical: the dry-run path must not write the confirmed mapping
    // nor delete the pending row. Only the initial Get should fire.
    expect(ddbSend.mock.calls.filter(([cmd]) => cmd._type === 'Put')).toHaveLength(0);
    expect(ddbSend.mock.calls.filter(([cmd]) => cmd._type === 'Delete')).toHaveLength(0);
  });

  test('dry_run still 404s when the code is invalid (preview must not leak existence)', async () => {
    // Same 404 behaviour as the real link path — a teammate trying to
    // probe for valid codes should not learn anything from dry-run.
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent({ code: 'link-deadbeef', dry_run: true }, 'cognito-user-1'));
    expect(result.statusCode).toBe(404);
    expect(ddbSend.mock.calls.filter(([cmd]) => cmd._type === 'Put')).toHaveLength(0);
  });

  test('preserves code case and trims whitespace (codes are case-sensitive)', async () => {
    // Codes generated by `bgagent linear invite-user` use a lowercase
    // alphabet (see generateInviteCode in cli/src/commands/linear.ts).
    // Earlier behaviour uppercased the code, which would have broken
    // round-tripping. The handler now trims whitespace only.
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          linear_identity: 'pending#link-3f8b4a2c',
          status: 'pending',
          linear_workspace_id: 'w',
          linear_user_id: 'u',
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(makeEvent({ code: '  link-3f8b4a2c  ' }, 'cognito-user-1'));
    const getCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Get');
    expect(getCall![0].input.Key.linear_identity).toBe('pending#link-3f8b4a2c');
  });
});
