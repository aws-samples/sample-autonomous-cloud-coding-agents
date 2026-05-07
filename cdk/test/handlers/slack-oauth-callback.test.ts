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
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

class MockResourceNotFoundException extends Error {
  constructor() { super('not found'); this.name = 'ResourceNotFoundException'; }
}
class MockInvalidRequestException extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidRequestException'; }
}

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
  CreateSecretCommand: jest.fn((input: unknown) => ({ _type: 'CreateSecret', input })),
  UpdateSecretCommand: jest.fn((input: unknown) => ({ _type: 'UpdateSecret', input })),
  RestoreSecretCommand: jest.fn((input: unknown) => ({ _type: 'RestoreSecret', input })),
  ResourceNotFoundException: MockResourceNotFoundException,
  InvalidRequestException: MockInvalidRequestException,
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CLIENT_ID_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/client_id-1';
process.env.SLACK_CLIENT_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/client_secret-1';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-oauth-callback';

function makeEvent(code?: string): APIGatewayProxyEvent {
  return {
    body: null,
    headers: { Host: 'api.example.com' },
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/slack/oauth/callback',
    pathParameters: null,
    queryStringParameters: code ? { code } : null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: { stage: 'v1' } as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

describe('slack-oauth-callback handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_CLIENT_ID_SECRET_ARN!);
    invalidateSlackSecretCache(process.env.SLACK_CLIENT_SECRET_ARN!);
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue') {
        if (cmd.input?.SecretId === process.env.SLACK_CLIENT_ID_SECRET_ARN) {
          return Promise.resolve({ SecretString: 'client-id-123' });
        }
        if (cmd.input?.SecretId === process.env.SLACK_CLIENT_SECRET_ARN) {
          return Promise.resolve({ SecretString: 'client-secret-xyz' });
        }
      }
      return Promise.resolve({});
    });
  });

  test('400s when code is missing', async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(400);
  });

  test('500s when client ID secret is not populated', async () => {
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_CLIENT_ID_SECRET_ARN) {
        return Promise.resolve({ SecretString: undefined });
      }
      return Promise.resolve({});
    });
    invalidateSlackSecretCache(process.env.SLACK_CLIENT_ID_SECRET_ARN!);
    const result = await handler(makeEvent('code123'));
    expect(result.statusCode).toBe(500);
  });

  test('400s when Slack rejects the token exchange', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'invalid_code' }),
    });
    const result = await handler(makeEvent('badcode'));
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('invalid_code');
  });

  test('successful install creates secret + records installation', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        access_token: 'xoxb-new',
        team: { id: 'T_new', name: 'New Team' },
        bot_user_id: 'B_1',
        app_id: 'A_1',
        scope: 'chat:write',
        authed_user: { id: 'U_installer' },
      }),
    });
    // First call: UpdateSecret → RNF; then CreateSecret succeeds
    smSend.mockImplementationOnce(() => Promise.resolve({ SecretString: 'client-id-123' })); // GetSecretValue for CLIENT_ID
    smSend.mockImplementationOnce(() => Promise.resolve({ SecretString: 'client-secret-xyz' })); // GetSecretValue for CLIENT_SECRET
    smSend.mockImplementationOnce(() => Promise.reject(new MockResourceNotFoundException())); // UpdateSecret
    smSend.mockImplementationOnce(() => Promise.resolve({})); // CreateSecret
    ddbSend.mockResolvedValueOnce({}); // Put installation

    const result = await handler(makeEvent('goodcode'));
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('New Team');
    // Installation record was written
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.team_id).toBe('T_new');
    expect(putCall![0].input.Item.status).toBe('active');
  });

  test('restores deleted secret before updating (re-install after uninstall)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        access_token: 'xoxb-reinstall',
        team: { id: 'T_re', name: 'Re Team' },
      }),
    });
    smSend.mockImplementationOnce(() => Promise.resolve({ SecretString: 'client-id-123' })); // CLIENT_ID
    smSend.mockImplementationOnce(() => Promise.resolve({ SecretString: 'client-secret-xyz' })); // CLIENT_SECRET
    // UpdateSecret throws InvalidRequestException with "marked for deletion"
    smSend.mockImplementationOnce(() => Promise.reject(new MockInvalidRequestException('Secret is marked for deletion')));
    smSend.mockImplementationOnce(() => Promise.resolve({})); // RestoreSecret
    smSend.mockImplementationOnce(() => Promise.resolve({})); // UpdateSecret (second try)
    ddbSend.mockResolvedValueOnce({});

    const result = await handler(makeEvent('code'));
    expect(result.statusCode).toBe(200);
    const restoreCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'RestoreSecret');
    expect(restoreCalled).toBe(true);
  });
});
